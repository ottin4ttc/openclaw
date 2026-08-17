import type Langfuse from "langfuse";
import type { LangfuseGenerationClient } from "langfuse";
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type { OpenClawPluginServiceContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { LangfusePluginConfig } from "./config.js";
import {
  NATIVE_CHILD_MAX_PENDING_DIAGNOSTICS,
  clearNativeChildPending,
  findNativeChildObservation,
  markNativeChildPending,
  nativeChildLineage,
  noteNativeChildPartial,
  noteNativeChildPendingJoin,
  noteNativeChildPostFinalization,
  rememberNativeChildProviderOwner,
  rememberNativeChildSpawnRole,
  nativeChildTurnKey,
} from "./native-child.js";
import { countToolCallsFromMessages } from "./observations.js";
import type { PromptManager } from "./prompt-manager.js";
import { redactObject, redactText } from "./redact.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import {
  readOpenTraceMarkerByCorrelation,
  readSessionMessagesByIdentity,
  writeObservationEvent,
  writeTraceMarker,
} from "./session.js";
import {
  completeProviderRequestUsageTotals,
  rememberRuntimeIdentity,
  resolveCurrentGeneration,
  runtimeMetadata,
  TraceContextMap,
} from "./trace-context.js";
import type { NativeChildObservation, TraceContextEntry } from "./trace-context.js";
import {
  generateObservationId,
  generateTraceId,
  qualifiedModel,
  extractConversation,
  extractLLMTurns,
  filterCurrentTurnMessages,
  usageDetailsFromUsage,
  isTranscriptOnlyAssistantMessage,
  truncatePayload,
  buildApiMessage,
  normalizeModelCallInput,
} from "./utils.js";

export interface DiagnosticsOptions {
  langfuse: Langfuse;
  contextMap: TraceContextMap;
  logger: PluginLogger | null;
  stateDir: string | null;
  redactEnabled: boolean;
  config: LangfusePluginConfig;
  promptManager: PromptManager | null;
  internalDiagnostics: OpenClawPluginServiceContext["internalDiagnostics"];
  onBeforeSdkEnqueue?: (
    traceId: string,
    observationId: string,
    eventType: SdkDeliveryEventType,
    source: string,
  ) => boolean;
  onTraceFinalized?: (
    entry: TraceContextEntry,
    agentId: string,
    sessionId: string,
  ) => Promise<void>;
  /**
   * The host diagnostic dispatcher accepts async listeners but does not await
   * them. Keep the plugin-local task visible to agent_end so its final trace
   * update cannot race ahead of runtime metadata and generation reconciliation.
   */
  onDiagnosticTask?: (task: Promise<void>, event: unknown) => void;
  onNativeChildDiagnostic?: (
    entry: TraceContextEntry,
    event: Extract<
      Parameters<DiagnosticListener>[0],
      { type: "codex.native_child.lifecycle" | "codex.native_child.status" }
    >,
  ) => void;
  onNativeChildDiagnosticBatchComplete?: (entry: TraceContextEntry) => void;
  onNativeChildPostFinalization?: (entry: TraceContextEntry) => void;
  resolveNativeChildParent?: (
    entry: TraceContextEntry,
    childThreadId: string,
    childTurnId: string,
    timestamp: number,
    source: string,
  ) => NativeChildObservation | undefined;
}

type DiagnosticRecord = Record<string, unknown>;
type DiagnosticListener = Parameters<
  NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>["onEvent"]
>[0];
type DiagnosticPrivateData = {
  errorMessage?: string;
  modelContent?: {
    inputMessages?: unknown;
    outputMessages?: unknown;
    systemPrompt?: string;
    toolDefinitions?: unknown;
  };
  toolContent?: {
    toolInput?: unknown;
    toolOutput?: unknown;
  };
};

type DiagnosticTraceEntryArgs = {
  langfuse: Langfuse;
  contextMap: TraceContextMap;
  config: LangfusePluginConfig;
  promptManager: PromptManager | null;
  diagEvt: DiagnosticRecord;
  sessionKey: string;
  agentId: string;
  key: string;
  stateDir: string | null;
  logger: PluginLogger | null;
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"];
  pendingTraceIdentities: Map<string, PendingDiagnosticTraceIdentity>;
};

type PendingDiagnosticTraceIdentity = {
  traceId: string;
  timestamp: number;
  tags: string[];
  traceMetadata: Record<string, unknown>;
  createdAt: number;
};

const PENDING_DIAGNOSTIC_TRACE_IDENTITY_TTL_MS = 5 * 60 * 1000;
const PENDING_DIAGNOSTIC_TRACE_IDENTITY_MAX_ENTRIES = 256;

function prunePendingDiagnosticTraceIdentities(
  pendingTraceIdentities: Map<string, PendingDiagnosticTraceIdentity>,
  now = Date.now(),
): void {
  for (const [key, identity] of pendingTraceIdentities) {
    if (now - identity.createdAt > PENDING_DIAGNOSTIC_TRACE_IDENTITY_TTL_MS) {
      pendingTraceIdentities.delete(key);
    }
  }
  while (pendingTraceIdentities.size >= PENDING_DIAGNOSTIC_TRACE_IDENTITY_MAX_ENTRIES) {
    const oldestKey = pendingTraceIdentities.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    pendingTraceIdentities.delete(oldestKey);
  }
}

function diagnosticSdkFailureKey(observationId: string, source: string): string {
  return `sdk:${source}:${observationId}`;
}

function clearDiagnosticSdkFailuresForObservation(
  entry: TraceContextEntry,
  observationId: string,
): void {
  const failures = entry.pendingObservationDeliveryFailures;
  if (!failures) {
    return;
  }
  const suffix = `:${observationId}`;
  for (const failure of failures) {
    if (failure.startsWith("sdk:") && failure.endsWith(suffix)) {
      failures.delete(failure);
    }
  }
}

function prepareDiagnosticSdkEnqueue(
  entry: TraceContextEntry,
  onBeforeSdkEnqueue: DiagnosticsOptions["onBeforeSdkEnqueue"] | undefined,
  observationId: string,
  eventType: SdkDeliveryEventType,
  source: string,
): boolean {
  const failureKey = diagnosticSdkFailureKey(observationId, source);
  if (onBeforeSdkEnqueue && !onBeforeSdkEnqueue(entry.traceId, observationId, eventType, source)) {
    (entry.pendingObservationDeliveryFailures ??= new Set()).add(failureKey);
    return false;
  }
  entry.pendingObservationDeliveryFailures?.delete(failureKey);
  return true;
}

function pendingDiagnosticTraceIdentityKey(key: string, diagEvt: DiagnosticRecord): string {
  return `${key}\u0000${
    diagnosticString(diagEvt.runId) ?? diagnosticString(diagEvt.callId) ?? "unknown"
  }`;
}

function diagnosticChannel(diagEvt: DiagnosticRecord): string {
  return String(diagEvt.channel ?? "");
}

function diagnosticString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function nativeChildDiagnosticMetadata(diagEvt: DiagnosticRecord): Record<string, string> {
  const nativeChildThreadId = diagnosticString(diagEvt.nativeChildThreadId);
  const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId);
  const parentTurnId = diagnosticString(diagEvt.parentTurnId);
  const triggeringProviderCallId = diagnosticString(diagEvt.triggeringProviderCallId);
  return {
    ...(nativeChildThreadId ? { nativeChildThreadId } : {}),
    ...(nativeChildTurnId ? { nativeChildTurnId } : {}),
    ...(parentTurnId ? { parentTurnId } : {}),
    ...(triggeringProviderCallId ? { triggeringProviderCallId } : {}),
  };
}

function providerGenerationForCall(
  entry: TraceContextEntry,
  providerCallId: string,
): LangfuseGenerationClient | undefined {
  const pending = entry.pendingGenerations.get(providerCallId);
  if (pending) {
    return pending;
  }
  const generationIndex =
    entry.providerRequestGenerationIndexes?.get(providerCallId) ??
    entry.providerRequestCallIndexes?.get(providerCallId);
  return generationIndex === undefined
    ? undefined
    : entry.completedGenerations.get(generationIndex);
}

function nativeChildGenerationName(
  _entry: TraceContextEntry,
  _childThreadId: string | undefined,
  fallbackIndex: number,
  _callId?: string,
): string {
  return `llm-call-${fallbackIndex}`;
}

function diagnosticRuntimeMetadata(diagEvt: DiagnosticRecord) {
  return {
    runtime: diagnosticString(diagEvt.runtime),
    runtimeEngine: diagnosticString(diagEvt.runtimeEngine),
    runtimeTransport: diagnosticString(diagEvt.transport),
  };
}

function diagnosticFallbackSessionKey(diagEvt: DiagnosticRecord): string {
  const sessionId = diagnosticString(diagEvt.sessionId) ?? "missing-session";
  const turnIdentity =
    diagnosticString(diagEvt.turnId) ??
    diagnosticString(diagEvt.turnKey) ??
    diagnosticString(diagEvt.messageId) ??
    diagnosticString(diagEvt.runId) ??
    diagnosticString(diagEvt.callId) ??
    diagnosticString(diagEvt.toolCallId) ??
    diagnosticString(diagEvt.seq) ??
    diagnosticString(diagEvt.ts) ??
    "missing-turn";
  return `diagnostic:${sessionId}:${turnIdentity}`;
}

function diagnosticSessionKey(diagEvt: DiagnosticRecord): string {
  return diagnosticString(diagEvt.sessionKey) ?? diagnosticFallbackSessionKey(diagEvt);
}

function diagnosticAgentId(diagEvt: DiagnosticRecord, sessionKey: string): string {
  const explicitAgentId = diagnosticString(diagEvt.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  return sessionKey.startsWith("agent:") ? (sessionKey.split(":")[1] ?? "unknown") : "unknown";
}

function getOrCreateDiagnosticTraceEntry(
  args: DiagnosticTraceEntryArgs,
): TraceContextEntry | undefined {
  const {
    langfuse,
    contextMap,
    config,
    promptManager,
    diagEvt,
    sessionKey,
    agentId,
    key,
    stateDir,
    logger,
    onBeforeSdkEnqueue,
    pendingTraceIdentities,
  } = args;
  const existing = contextMap.get(key);
  if (existing && !existing.finalized) {
    return existing;
  }

  // Preserve the recovery marker identity until the SDK can materialize the trace.
  const pendingKey = pendingDiagnosticTraceIdentityKey(key, diagEvt);
  let identity = pendingTraceIdentities.get(pendingKey);
  if (!identity) {
    prunePendingDiagnosticTraceIdentities(pendingTraceIdentities);
    const sessionId = String(diagEvt.sessionId ?? "");
    const persistedMarker = readOpenTraceMarkerByCorrelation(
      stateDir,
      agentId,
      sessionId,
      pendingKey,
    );
    const timestamp = persistedMarker?.timestamp ?? Date.now();
    const traceId = persistedMarker?.traceId ?? generateTraceId(sessionKey, timestamp);
    const tags = [agentId, diagnosticChannel(diagEvt), ...(config.tracing?.tags ?? [])].filter(
      Boolean,
    );
    const traceMetadata = {
      sessionId: diagEvt.sessionId,
      sessionKey,
      agentId,
      channel: diagEvt.channel,
      timestamp,
      source: "diagnostic-event",
    };
    if (
      !persistedMarker &&
      !writeTraceMarker(stateDir, agentId, sessionId, "start", traceId, logger, {
        correlationKey: pendingKey,
      })
    ) {
      return undefined;
    }
    identity = { traceId, timestamp, tags, traceMetadata, createdAt: Date.now() };
    pendingTraceIdentities.set(pendingKey, identity);
  }
  if (
    onBeforeSdkEnqueue &&
    !onBeforeSdkEnqueue(
      identity.traceId,
      identity.traceId,
      "trace-create",
      "diagnostic trace create",
    )
  ) {
    return undefined;
  }
  const trace = langfuse.trace({
    id: identity.traceId,
    name: agentId,
    sessionId: sessionKey,
    tags: identity.tags,
    metadata: identity.traceMetadata,
  });
  const runId = diagnosticString(diagEvt.runId);
  const entry: TraceContextEntry = {
    trace,
    traceId: identity.traceId,
    traceMetadata: identity.traceMetadata,
    llmCallCount: 0,
    toolCallCount: 0,
    pendingGenerations: new Map(),
    pendingGenIds: new Map(),
    completedGenerations: new Map(),
    providerRequestCallIndexes: new Map(),
    deferredProviderRequestCompletions: new Map(),
    pendingSpans: new Map(),
    completedSpanToolCallIds: new Set(),
    ...(runId ? { runIds: new Set([runId]) } : {}),
    createdAt: identity.timestamp,
    timestamp: identity.timestamp,
  };
  contextMap.create(key, entry);
  pendingTraceIdentities.delete(pendingKey);

  // Use the warmed cache synchronously so the first gateway generation can link its prompt.
  if (promptManager) {
    const promptContext = {
      agentId,
      channelId: diagnosticChannel(diagEvt),
      sessionKey,
    };
    const cached = promptManager.resolveSync(agentId, promptContext);
    if (cached) {
      entry.promptClient = cached.promptClient;
    } else {
      promptManager
        .resolve(agentId, promptContext)
        .then((result) => {
          if (result) {
            entry.promptClient = result.promptClient;
          }
        })
        .catch(() => {});
    }
  }

  return entry;
}

function isRealtimeModelCall(evt: DiagnosticRecord): boolean {
  // 7.1 provider-call diagnostics predate `scope`; only the Codex turn summary is
  // explicitly aggregate. Rejecting unscoped events would drop normal provider traces.
  return (
    (evt.type === "model.call.started" ||
      evt.type === "model.call.completed" ||
      evt.type === "model.call.error") &&
    evt.scope !== "turn-aggregate"
  );
}

function diagnosticNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticUsage(evt: DiagnosticRecord): Record<string, number> | undefined {
  const usage = evt.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  const inputTokens = diagnosticNumber(record.input_tokens);
  const cachedInputTokens =
    diagnosticNumber(record.cached_input_tokens) ??
    (record.input_tokens_details &&
    typeof record.input_tokens_details === "object" &&
    !Array.isArray(record.input_tokens_details)
      ? diagnosticNumber((record.input_tokens_details as Record<string, unknown>).cached_tokens)
      : undefined);
  if (inputTokens !== undefined) {
    normalized.input = Math.max(0, inputTokens - (cachedInputTokens ?? 0));
  } else if (diagnosticNumber(record.input) !== undefined) {
    normalized.input = diagnosticNumber(record.input) ?? 0;
  }
  const output = diagnosticNumber(record.output) ?? diagnosticNumber(record.output_tokens);
  if (output !== undefined) {
    normalized.output = output;
  }
  const total =
    diagnosticNumber(record.total) ??
    diagnosticNumber(record.totalTokens) ??
    diagnosticNumber(record.total_tokens);
  if (total !== undefined) {
    normalized.total = total;
  }
  const cacheRead = diagnosticNumber(record.cacheRead) ?? cachedInputTokens;
  if (cacheRead !== undefined) {
    normalized.cacheRead = cacheRead;
  }
  const cacheWrite = diagnosticNumber(record.cacheWrite);
  if (cacheWrite !== undefined) {
    normalized.cacheWrite = cacheWrite;
  }
  const reasoning =
    diagnosticNumber(record.reasoningTokens) ?? diagnosticNumber(record.reasoning_output_tokens);
  if (reasoning !== undefined) {
    normalized.reasoningTokens = reasoning;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function completeProviderRequestUsage(
  usage: Record<string, number> | undefined,
): Record<string, number> | undefined {
  const input = usage?.input;
  const output = usage?.output;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    typeof output !== "number" ||
    !Number.isFinite(output)
  ) {
    return undefined;
  }
  const explicitTotal = usage?.totalTokens ?? usage?.total;
  const cacheRead = usage?.cacheRead;
  const cacheWrite = usage?.cacheWrite;
  const reasoningTokens = usage?.reasoningTokens;
  const normalizedCacheRead =
    typeof cacheRead === "number" && Number.isFinite(cacheRead) ? cacheRead : 0;
  const normalizedCacheWrite =
    typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? cacheWrite : 0;
  const total =
    typeof explicitTotal === "number" && Number.isFinite(explicitTotal)
      ? explicitTotal
      : input + output + normalizedCacheRead + normalizedCacheWrite;
  return {
    input,
    output,
    total,
    ...(typeof cacheRead === "number" && Number.isFinite(cacheRead) ? { cacheRead } : {}),
    ...(typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? { cacheWrite } : {}),
    ...(typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens)
      ? { reasoningTokens }
      : {}),
  };
}

function updateAuthoritativeProviderUsage(
  entry: TraceContextEntry,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  const usage = completeProviderRequestUsageTotals(entry);
  if (!usage) {
    entry.authoritativeProviderUsage = undefined;
    return true;
  }
  if (!entry.finalized) {
    entry.authoritativeProviderUsage = usage;
    return true;
  }

  const nextMetadata = {
    ...objectRecord(entry.traceMetadata),
    ...runtimeMetadata(entry),
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(typeof usage.cacheRead === "number" ? { cacheReadInputTokens: usage.cacheRead } : {}),
      ...(typeof usage.cacheWrite === "number" ? { cacheWriteInputTokens: usage.cacheWrite } : {}),
      ...(typeof usage.reasoningTokens === "number"
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
      totalTokens: usage.total,
    },
  };
  if (
    !prepareDiagnosticSdkEnqueue(
      entry,
      onBeforeSdkEnqueue,
      entry.traceId,
      "trace-create",
      "diagnostic finalized usage trace update",
    )
  ) {
    return false;
  }
  entry.authoritativeProviderUsage = usage;
  entry.traceMetadata = nextMetadata;
  entry.trace.update({ metadata: nextMetadata });
  return true;
}

function commitProviderRequestTerminal(
  entry: TraceContextEntry,
  callId: string,
  usage: Record<string, number> | undefined,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  const completedCallIds = (entry.providerRequestCompletedCallIds ??= new Set());
  const usages = (entry.providerRequestUsages ??= new Map());
  const previousUsage = usages.get(callId);

  completedCallIds.add(callId);
  if (usage) {
    usages.set(callId, usage);
  }
  if (updateAuthoritativeProviderUsage(entry, onBeforeSdkEnqueue)) {
    return true;
  }

  completedCallIds.delete(callId);
  if (previousUsage) {
    usages.set(callId, previousUsage);
  } else {
    usages.delete(callId);
  }
  return false;
}

function commitOrQueueProviderRequestTerminal(
  entry: TraceContextEntry,
  callId: string,
  usage: Record<string, number> | undefined,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  if (commitProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue)) {
    entry.providerRequestPendingTerminalCommits?.delete(callId);
    return true;
  }
  (entry.providerRequestPendingTerminalCommits ??= new Map()).set(callId, usage);
  return false;
}

function retryPendingProviderRequestTerminal(
  entry: TraceContextEntry,
  callId: string,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  const pendingCommits = entry.providerRequestPendingTerminalCommits;
  if (!pendingCommits?.has(callId)) {
    return false;
  }
  commitOrQueueProviderRequestTerminal(
    entry,
    callId,
    pendingCommits.get(callId),
    onBeforeSdkEnqueue,
  );
  return true;
}

export function retryPendingProviderRequestTerminals(
  entry: TraceContextEntry,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  const pendingCommits = entry.providerRequestPendingTerminalCommits;
  if (!pendingCommits || pendingCommits.size === 0) {
    return true;
  }
  for (const [callId, usage] of pendingCommits) {
    commitOrQueueProviderRequestTerminal(entry, callId, usage, onBeforeSdkEnqueue);
  }
  return pendingCommits.size === 0;
}

function diagnosticModelContent(privateData: DiagnosticPrivateData | undefined) {
  return privateData?.modelContent;
}

function isCodexToolExecution(evt: DiagnosticRecord): boolean {
  return (
    (evt.toolOwner === "codex-rollout-trace" || evt.toolOwner === "codex-native-tool-lifecycle") &&
    (evt.type === "tool.execution.started" ||
      evt.type === "tool.execution.completed" ||
      evt.type === "tool.execution.error" ||
      evt.type === "tool.execution.blocked")
  );
}

function codexToolOutputErrorCategory(toolName: string, output: unknown): string | undefined {
  const leafToolName = toolName.split(".").at(-1);
  if (leafToolName !== "exec_command") {
    return undefined;
  }
  const record = objectRecord(output);
  const exitCode = record.exit_code ?? record.exitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) {
    return undefined;
  }
  return "codex_native_tool_nonzero_exit";
}

function codexSpawnAgentRole(toolName: string, input: unknown): string | undefined {
  if (toolName !== "collaboration.spawn_agent") {
    return undefined;
  }
  return diagnosticString(objectRecord(input)?.agent_type);
}

function recordCodexToolExecution(params: {
  entry: TraceContextEntry;
  lineageEntry: TraceContextEntry;
  diagEvt: DiagnosticRecord;
  privateData?: DiagnosticPrivateData;
  redactEnabled: boolean;
  stateDir: string | null;
  agentId: string;
  sessionId: string;
  logger: PluginLogger | null;
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"];
}): void {
  const {
    entry,
    lineageEntry,
    diagEvt,
    privateData,
    redactEnabled,
    stateDir,
    agentId,
    sessionId,
    logger,
    onBeforeSdkEnqueue,
  } = params;
  const toolCallId = String(diagEvt.toolCallId ?? "");
  const toolName = String(diagEvt.toolName ?? "");
  if (!toolCallId || !toolName) {
    return;
  }
  const rawInput = privateData?.toolContent?.toolInput;
  const spawnAgentRole = codexSpawnAgentRole(toolName, rawInput);
  if (spawnAgentRole) {
    rememberNativeChildSpawnRole(lineageEntry, toolCallId, spawnAgentRole);
  }
  if (entry.diagnosticCorrectedSpanToolCallIds?.has(toolCallId)) {
    return;
  }
  const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
  const isStart = diagEvt.type === "tool.execution.started";
  const endTime = isStart ? undefined : eventDate(diagEvt, "endTimeMs");
  const startTime =
    typeof diagEvt.startTimeMs === "number"
      ? eventDate(diagEvt, "startTimeMs")
      : endTime
        ? new Date(Math.max(0, endTime.getTime() - durationMs))
        : eventDate(diagEvt, "endTimeMs");
  const existingSpan = entry.pendingSpans.get(toolCallId) ?? entry.completedSpans?.get(toolCallId);
  const input = truncatePayload(redactObject(rawInput, redactEnabled));
  const output = truncatePayload(redactObject(privateData?.toolContent?.toolOutput, redactEnabled));
  const source = privateData?.toolContent ? "diagnostic-tool-content" : "diagnostic-tool-lifecycle";
  const spanId = generateObservationId(entry.traceId, "span", toolCallId);
  const nativeChildThreadId = diagnosticString(diagEvt.nativeChildThreadId);
  const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId);
  const triggeringProviderCallId = diagnosticString(diagEvt.triggeringProviderCallId);
  const providerGeneration = triggeringProviderCallId
    ? providerGenerationForCall(entry, triggeringProviderCallId)
    : undefined;
  const recordedProviderOwner = triggeringProviderCallId
    ? nativeChildLineage(lineageEntry).providerCallOwners.get(triggeringProviderCallId)
    : undefined;
  const nativeChildOwnerKey =
    nativeChildThreadId && nativeChildTurnId
      ? nativeChildTurnKey(nativeChildThreadId, nativeChildTurnId)
      : undefined;
  const providerOwnerMismatch =
    nativeChildOwnerKey !== undefined &&
    recordedProviderOwner !== undefined &&
    recordedProviderOwner !== nativeChildOwnerKey;
  if (providerOwnerMismatch) {
    noteNativeChildPartial(lineageEntry, "provider_owner_mismatch");
  }
  const provenProviderParent = nativeChildThreadId
    ? recordedProviderOwner === nativeChildOwnerKey
      ? providerGeneration
      : undefined
    : providerGeneration;
  const triggeringProviderGenerationIndex = triggeringProviderCallId
    ? (entry.providerRequestGenerationIndexes?.get(triggeringProviderCallId) ??
      entry.providerRequestCallIndexes?.get(triggeringProviderCallId))
    : undefined;
  // Child ownership without provider-call ownership is a valid, but partial,
  // hierarchy only after the native-child parent was actually resolved.
  const partialParenting = Boolean(
    nativeChildThreadId && entry.actorKind === "native-child" && !provenProviderParent,
  );
  if (partialParenting) {
    noteNativeChildPartial(lineageEntry, "partial_parenting");
  }
  if (nativeChildThreadId && triggeringProviderCallId && !provenProviderParent) {
    noteNativeChildPendingJoin(lineageEntry);
  }
  const spanArgs = {
    id: spanId,
    name: `tool:${toolName}`,
    startTime,
    ...(input !== undefined ? { input } : {}),
    metadata: {
      toolName,
      toolCallId,
      source,
      ...nativeChildDiagnosticMetadata(diagEvt),
      ...(partialParenting ? { partial_parenting: true } : {}),
    },
  };
  if (!existingSpan) {
    const ledgerWritten = writeObservationEvent(
      stateDir,
      agentId,
      sessionId,
      {
        e: "span-start",
        traceId: entry.traceId,
        id: spanId,
        tool: toolName,
        toolCallId,
        ts: startTime.toISOString(),
      },
      logger,
    );
    if (!ledgerWritten) {
      entry.observationLedgerIncomplete = true;
      logger?.warn?.(
        `Langfuse: buffered diagnostic tool observation because identity ledger append failed (traceId=${entry.traceId}, toolCallId=${toolCallId})`,
      );
      return;
    }
  }
  const currentGeneration = nativeChildThreadId ? undefined : resolveCurrentGeneration(entry);
  let span = existingSpan;
  if (!existingSpan) {
    if (
      !prepareDiagnosticSdkEnqueue(
        entry,
        onBeforeSdkEnqueue,
        spanId,
        "span-create",
        "diagnostic tool span",
      )
    ) {
      return;
    }
    span = provenProviderParent
      ? provenProviderParent.span(spanArgs)
      : currentGeneration
        ? currentGeneration.span(spanArgs)
        : entry.trace.span(spanArgs);
    entry.pendingSpans.set(toolCallId, span);
    if (provenProviderParent && triggeringProviderGenerationIndex !== undefined) {
      (entry.toolParentCallIndexes ??= new Map()).set(
        toolCallId,
        triggeringProviderGenerationIndex,
      );
    }
    entry.toolCallCount += 1;
  }
  if (isStart) {
    return;
  }
  if (!span) {
    return;
  }
  // Codex records exec dispatch as completed even when the command exits non-zero.
  // Preserve the transcript-visible failure instead of reporting a successful Langfuse span.
  const outputErrorCategory = codexToolOutputErrorCategory(toolName, output);
  const isError =
    diagEvt.type === "tool.execution.error" ||
    diagEvt.type === "tool.execution.blocked" ||
    outputErrorCategory !== undefined;
  const sdkFailureKey = diagnosticSdkFailureKey(spanId, "diagnostic tool span update");
  const endLedgerAlreadyWritten = entry.pendingObservationDeliveryFailures?.has(sdkFailureKey);
  if (!endLedgerAlreadyWritten) {
    const endLedgerWritten = writeObservationEvent(
      stateDir,
      agentId,
      sessionId,
      {
        e: "span-end",
        traceId: entry.traceId,
        id: spanId,
        ts: (endTime ?? new Date()).toISOString(),
      },
      logger,
    );
    if (!endLedgerWritten) {
      entry.observationLedgerIncomplete = true;
      return;
    }
  }
  if (
    !prepareDiagnosticSdkEnqueue(
      entry,
      onBeforeSdkEnqueue,
      spanId,
      "span-update",
      "diagnostic tool span update",
    )
  ) {
    return;
  }
  span.update({
    startTime,
    ...(endTime ? { endTime } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    metadata: {
      toolName,
      toolCallId,
      durationMs,
      source,
      ...nativeChildDiagnosticMetadata(diagEvt),
      ...(partialParenting ? { partial_parenting: true } : {}),
      ...(isError ? { isError: true } : {}),
    },
    ...(isError
      ? {
          level: "ERROR" as const,
          statusMessage: String(
            diagEvt.errorCategory ?? outputErrorCategory ?? "tool_execution_error",
          ),
        }
      : {}),
  });
  entry.pendingSpans.delete(toolCallId);
  (entry.completedSpans ??= new Map()).set(toolCallId, span);
  entry.completedSpanToolCallIds.add(toolCallId);
  (entry.diagnosticCorrectedSpanToolCallIds ??= new Set()).add(toolCallId);
}

type PreparedProviderRequestInput = {
  generationInput?: unknown;
  nextMessages?: unknown[];
  projection: "first-prompt" | "full-request" | "proven-prefix" | "ws-delta-linked" | "unavailable";
  requestForm?: "full" | "ws-delta";
};

function generationInputFromModelContent(
  entry: TraceContextEntry,
  callId: string,
  providerRequestIndex: number,
  diagEvt: DiagnosticRecord,
  model: string | undefined,
  modelContent: DiagnosticPrivateData["modelContent"] | undefined,
  redactEnabled: boolean,
): PreparedProviderRequestInput {
  const requestForm =
    diagEvt.requestForm === "full" || diagEvt.requestForm === "ws-delta"
      ? diagEvt.requestForm
      : undefined;
  const inputMessages = Array.isArray(modelContent?.inputMessages)
    ? modelContent.inputMessages
    : modelContent?.inputMessages === undefined
      ? []
      : [modelContent.inputMessages];
  const cachedInput = entry.providerRequestInputs?.get(callId);
  const cachedProjection = entry.providerRequestInputProjections?.get(callId);
  if (cachedInput !== undefined || cachedProjection) {
    return {
      ...(cachedInput !== undefined ? { generationInput: cachedInput } : {}),
      projection: cachedProjection?.projection ?? "unavailable",
      requestForm: cachedProjection?.requestForm ?? requestForm,
    };
  }
  if (providerRequestIndex === 1 && typeof entry.rootInput === "string") {
    const normalized = normalizeModelCallInput({
      model,
      messages: inputMessages,
      firstGenerationInput: entry.rootInput,
      redactEnabled,
    });
    return {
      ...(normalized.generationInput !== undefined
        ? { generationInput: normalized.generationInput }
        : {}),
      ...(inputMessages.length > 0 ? { nextMessages: [...inputMessages] } : {}),
      projection: "first-prompt",
      requestForm,
    };
  }
  if (!modelContent || modelContent.inputMessages === undefined) {
    return { projection: "unavailable", requestForm };
  }
  if (providerRequestIndex === 1) {
    return {
      nextMessages: [...inputMessages],
      projection: "unavailable",
      requestForm,
    };
  }
  if (requestForm === "ws-delta") {
    const expectedResponseIdHash = entry.providerRequestResponseIdHashes?.get(
      providerRequestIndex - 1,
    );
    if (
      typeof diagEvt.previousResponseIdHash !== "string" ||
      diagEvt.previousResponseIdHash !== expectedResponseIdHash
    ) {
      return { projection: "unavailable", requestForm };
    }
    const normalized = normalizeModelCallInput({
      model,
      messages: inputMessages,
      previousMessages: [],
      redactEnabled,
    });
    return {
      ...(normalized.generationInput !== undefined
        ? { generationInput: normalized.generationInput }
        : {}),
      nextMessages: [...(entry.previousProviderRequestInputMessages ?? []), ...inputMessages],
      projection: "ws-delta-linked",
      requestForm,
    };
  }
  const normalized = normalizeModelCallInput({
    model,
    messages: inputMessages,
    previousMessages: entry.previousProviderRequestInputMessages,
    redactEnabled,
  });
  if (normalized.projection === "full-request") {
    return {
      nextMessages: normalized.nextMessages,
      projection: "unavailable",
      requestForm,
    };
  }
  return {
    ...(normalized.generationInput !== undefined
      ? { generationInput: normalized.generationInput }
      : {}),
    nextMessages: normalized.nextMessages,
    projection: normalized.projection,
    requestForm,
  };
}

function commitProviderRequestInput(
  entry: TraceContextEntry,
  callId: string,
  prepared: PreparedProviderRequestInput,
): void {
  if (prepared.nextMessages) {
    entry.previousProviderRequestInputMessages = prepared.nextMessages;
  }
  if (prepared.generationInput !== undefined) {
    (entry.providerRequestInputs ??= new Map()).set(callId, prepared.generationInput);
  }
  (entry.providerRequestInputProjections ??= new Map()).set(callId, {
    projection: prepared.projection,
    ...(prepared.requestForm ? { requestForm: prepared.requestForm } : {}),
  });
}

function providerRequestProjectionMetadata(
  diagEvt: DiagnosticRecord,
  prepared: PreparedProviderRequestInput,
): Record<string, unknown> {
  return {
    ...providerRequestIdentityMetadata(diagEvt),
    ...(prepared.requestForm ? { requestForm: prepared.requestForm } : {}),
    inputProjection: prepared.projection,
    ...(typeof diagEvt.previousResponseIdHash === "string"
      ? { previousResponseIdHash: diagEvt.previousResponseIdHash }
      : {}),
  };
}

function providerRequestIdentityMetadata(diagEvt: DiagnosticRecord): Record<string, unknown> {
  const callId = diagnosticString(diagEvt.callId);
  return {
    ...(callId ? { providerRequestCallId: callId } : {}),
    ...(typeof diagEvt.upstreamRequestIdHash === "string"
      ? { upstreamRequestIdHash: diagEvt.upstreamRequestIdHash }
      : {}),
  };
}

function noteInputProjectionUnavailable(entry: TraceContextEntry, callId: string): void {
  const reconciliation = (entry.observationReconciliation ??= { required: true, reasons: [] });
  if (
    reconciliation.reasons.some(
      (reason) =>
        reason.reason === "input_projection_unavailable" &&
        reason.source === `provider-request:${callId}`,
    )
  ) {
    return;
  }
  reconciliation.reasons = [
    ...reconciliation.reasons,
    {
      reason: "input_projection_unavailable",
      source: `provider-request:${callId}`,
      count: 1,
    },
  ].slice(-8);
}

function generationOutputFromModelContent(
  modelContent: DiagnosticPrivateData["modelContent"] | undefined,
  redactEnabled: boolean,
): unknown | undefined {
  return modelContent?.outputMessages !== undefined
    ? truncatePayload(redactObject(modelContent.outputMessages, redactEnabled))
    : undefined;
}

function eventDate(
  evt: DiagnosticRecord,
  timeField: "startTimeMs" | "endTimeMs" = "endTimeMs",
): Date {
  const explicitTime = evt[timeField];
  if (typeof explicitTime === "number") {
    return new Date(explicitTime);
  }
  if (typeof evt.sourceTimestampMs === "number") {
    return new Date(evt.sourceTimestampMs);
  }
  return typeof evt.ts === "number" ? new Date(evt.ts) : new Date();
}

function diagnosticSourceOrder(evt: DiagnosticRecord): number | undefined {
  for (const key of [
    "providerRequestIndex",
    "sourceOrder",
    "rolloutSourceOrder",
    "sourceIndex",
  ] as const) {
    const value = evt[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^[0-9]+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function claimProviderRequestIndex(
  entry: TraceContextEntry,
  callId: string,
  diagEvt: DiagnosticRecord,
): number {
  if (!entry.providerRequestCallIndexes) {
    entry.providerRequestCallIndexes = new Map();
  }
  const existingIndex = entry.providerRequestCallIndexes.get(callId);
  if (existingIndex) {
    return existingIndex;
  }
  const nextIndex = diagnosticSourceOrder(diagEvt) ?? entry.providerRequestCallIndexes.size + 1;
  entry.providerRequestCallCount = entry.providerRequestCallIndexes.size + 1;
  entry.providerRequestCallIndexes.set(callId, nextIndex);
  entry.llmCallCount = Math.max(entry.llmCallCount, nextIndex);
  entry.authoritativeProviderUsage = undefined;
  return nextIndex;
}

type ClaimedHookGeneration = {
  generation: LangfuseGenerationClient;
  observationId: string;
};

function claimExistingHookGenerationForProviderRequest(
  entry: TraceContextEntry,
  callId: string,
  providerRequestIndex: number,
): ClaimedHookGeneration | null {
  if (entry.hasProviderRequestGenerations || entry.llmCallCount < providerRequestIndex) {
    return null;
  }
  const canonicalGenId = generateObservationId(entry.traceId, "gen", providerRequestIndex);
  const completedGen = entry.completedGenerations.get(providerRequestIndex);
  const pendingGen = [...entry.pendingGenerations.entries()].find(
    ([runId]) => entry.pendingGenIds.get(runId) === canonicalGenId,
  )?.[1];
  const existingGen = completedGen ?? pendingGen;
  if (!existingGen) {
    return null;
  }
  const genId = completedGen
    ? (entry.completedGenerationIds?.get(providerRequestIndex) ?? canonicalGenId)
    : canonicalGenId;
  entry.providerRequestAugmentedHookGenerations = true;
  (entry.providerRequestGenerationIndexes ??= new Map()).set(callId, providerRequestIndex);
  entry.pendingGenerations.set(callId, existingGen);
  entry.pendingGenIds.set(callId, genId);
  entry.currentGenerationId = genId;
  return { generation: existingGen, observationId: genId };
}

function removePendingGenerationAliases(
  entry: TraceContextEntry,
  generation: LangfuseGenerationClient,
  genId: string | undefined,
): void {
  for (const [pendingKey, pendingGeneration] of entry.pendingGenerations) {
    if (pendingGeneration === generation || entry.pendingGenIds.get(pendingKey) === genId) {
      entry.pendingGenerations.delete(pendingKey);
      entry.pendingGenIds.delete(pendingKey);
    }
  }
}

function isHookOrJsonlOwnedTrace(entry: TraceContextEntry): boolean {
  return entry.llmCallCount > 0 && !entry.hasProviderRequestGenerations;
}

function hasOwnedGenerationSlot(entry: TraceContextEntry, providerRequestIndex: number): boolean {
  const genId = generateObservationId(entry.traceId, "gen", providerRequestIndex);
  return (
    entry.completedGenerations.has(providerRequestIndex) ||
    [...entry.pendingGenIds.values()].includes(genId)
  );
}

type ProviderRequestGenerationClaim = {
  index: number;
  rollback: () => void;
};

function claimProviderRequestGenerationIndex(
  entry: TraceContextEntry,
  callId: string,
  providerRequestIndex: number,
): ProviderRequestGenerationClaim {
  const generationIndexes = (entry.providerRequestGenerationIndexes ??= new Map());
  const existingIndex = generationIndexes.get(callId);
  if (existingIndex !== undefined) {
    return { index: existingIndex, rollback: () => undefined };
  }
  const previousLlmCallCount = entry.llmCallCount;
  const previousHasProviderRequestGenerations = entry.hasProviderRequestGenerations;
  const claimedIndexes = new Set(generationIndexes.values());
  let generationIndex = providerRequestIndex;
  while (claimedIndexes.has(generationIndex) || hasOwnedGenerationSlot(entry, generationIndex)) {
    generationIndex = Math.max(generationIndex + 1, entry.llmCallCount + 1);
  }
  generationIndexes.set(callId, generationIndex);
  entry.llmCallCount = Math.max(entry.llmCallCount, generationIndex);
  entry.hasProviderRequestGenerations = true;
  return {
    index: generationIndex,
    rollback: () => {
      if (generationIndexes.get(callId) !== generationIndex) {
        return;
      }
      generationIndexes.delete(callId);
      entry.llmCallCount = previousLlmCallCount;
      entry.hasProviderRequestGenerations = previousHasProviderRequestGenerations;
    },
  };
}

function providerRequestGenerationIndex(
  entry: TraceContextEntry,
  callId: string,
  providerRequestIndex: number,
): number {
  return entry.providerRequestGenerationIndexes?.get(callId) ?? providerRequestIndex;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactAndTruncateText(text: string, redactEnabled: boolean): unknown {
  return truncatePayload(redactText(text, redactEnabled));
}

function generationInputPayload(messages: unknown, redactEnabled: boolean): unknown {
  return normalizeModelCallInput({
    messages: Array.isArray(messages) ? messages : [messages],
    previousMessages: [],
    redactEnabled,
  }).generationInput;
}

function isDiagnosticOwnedTrace(entry: TraceContextEntry): boolean {
  return objectRecord(entry.traceMetadata).source === "diagnostic-event";
}

function usageValue(usage: Record<string, unknown>, key: string): number | undefined {
  const value = usage[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageMatches(
  eventUsage: Record<string, unknown>,
  recordedUsage: Record<string, unknown>,
): boolean {
  for (const key of ["input", "output"] as const) {
    const eventValue = usageValue(eventUsage, key);
    const recordedValue = usageValue(recordedUsage, key);
    if (eventValue === undefined || recordedValue === undefined || eventValue !== recordedValue) {
      return false;
    }
  }
  const eventTotal = usageValue(eventUsage, "total") ?? usageValue(eventUsage, "totalTokens");
  const recordedTotal =
    usageValue(recordedUsage, "total") ?? usageValue(recordedUsage, "totalTokens");
  if (eventTotal === undefined || recordedTotal === undefined || eventTotal !== recordedTotal) {
    return false;
  }
  for (const key of ["cacheRead", "cacheWrite"] as const) {
    const eventValue = usageValue(eventUsage, key);
    const recordedValue = usageValue(recordedUsage, key);
    if (eventValue !== undefined && recordedValue !== undefined && eventValue !== recordedValue) {
      return false;
    }
  }
  return true;
}

function recordedUsagesForEntry(entry: TraceContextEntry): Record<string, unknown>[] {
  return [
    entry.storedUsage,
    entry.finalizedUsage,
    entry.authoritativeProviderUsage,
    ...(entry.providerRequestUsages?.values() ?? []),
  ]
    .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined)
    .map((usage) => objectRecord(usage));
}

function entryHasRecordedUsageMatch(entry: TraceContextEntry, diagEvt: DiagnosticRecord): boolean {
  const eventUsages = [diagEvt.usage, diagEvt.lastCallUsage]
    .filter((usage) => usage !== undefined)
    .map((usage) => objectRecord(usage));
  return eventUsages.some((eventUsage) =>
    recordedUsagesForEntry(entry).some((usage) => usageMatches(eventUsage, usage)),
  );
}

function isLateAggregateForFinalizedHook(
  entry: TraceContextEntry | undefined,
  diagEvt: DiagnosticRecord,
): entry is TraceContextEntry {
  if (!entry?.finalized || isDiagnosticOwnedTrace(entry)) {
    return false;
  }
  if (!entryHasRecordedUsageMatch(entry, diagEvt)) {
    return false;
  }
  const provider = diagnosticString(diagEvt.provider);
  const model = diagnosticString(diagEvt.model);
  const eventModel = model ? qualifiedModel(provider, model) : undefined;
  const entryModel = entry.lastModel
    ? qualifiedModel(entry.lastProvider ?? provider, entry.lastModel)
    : undefined;
  return (
    (!provider || !entry.lastProvider || provider === entry.lastProvider) &&
    (!eventModel || !entryModel || eventModel === entryModel)
  );
}

function updateProviderRequestTraceStats(
  entry: TraceContextEntry,
  diagEvt: DiagnosticRecord,
  sessionKey: string,
  agentId: string,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  const existingMetadata = objectRecord(entry.traceMetadata);
  const existingStats = objectRecord(existingMetadata.stats);
  const nextMetadata = {
    ...existingMetadata,
    ...runtimeMetadata(entry),
    sessionKey,
    agentId,
    channelId: diagEvt.channel,
    stats: {
      ...existingStats,
      llmCallCount: entry.llmCallCount,
      toolCallCount: entry.toolCallCount,
    },
    lastModel: {
      provider: String(diagEvt.provider ?? ""),
      model: String(diagEvt.model ?? ""),
    },
  };
  entry.traceMetadata = nextMetadata;
  if (
    !prepareDiagnosticSdkEnqueue(
      entry,
      onBeforeSdkEnqueue,
      entry.traceId,
      "trace-create",
      "diagnostic provider-request trace stats",
    )
  ) {
    return false;
  }
  entry.trace.update({ metadata: nextMetadata });
  return true;
}

function publishModelContextMetadata(
  entry: TraceContextEntry,
  onBeforeSdkEnqueue?: DiagnosticsOptions["onBeforeSdkEnqueue"],
): boolean {
  if (
    entry.modelContextMetadataPublished ||
    !entry.modelContextMetadata ||
    Object.keys(entry.modelContextMetadata).length === 0
  ) {
    return true;
  }
  if (
    !prepareDiagnosticSdkEnqueue(
      entry,
      onBeforeSdkEnqueue,
      entry.traceId,
      "trace-create",
      "diagnostic model context trace update",
    )
  ) {
    return false;
  }
  entry.modelContextMetadataPublished = true;
  entry.trace.update({
    metadata: {
      ...objectRecord(entry.traceMetadata),
      ...runtimeMetadata(entry),
    },
  });
  return true;
}

async function finalizeDiagnosticTraceEntry(
  entry: TraceContextEntry,
  onTraceFinalized?: DiagnosticsOptions["onTraceFinalized"],
  agentId?: string,
  sessionId?: string,
): Promise<void> {
  if (!isDiagnosticOwnedTrace(entry) || entry.deliveryFinalized || entry.finalizationInProgress) {
    return;
  }
  entry.finalized = true;
  await onTraceFinalized?.(entry, agentId ?? "unknown", sessionId ?? "");
}

function deferProviderRequestCompletion(
  entry: TraceContextEntry,
  providerRequestIndex: number,
  diagEvt: DiagnosticRecord,
  input: unknown,
  modelContent: DiagnosticPrivateData["modelContent"] | undefined,
  privateData: DiagnosticPrivateData | undefined,
  redactEnabled: boolean,
): void {
  if (!entry.deferredProviderRequestCompletions) {
    entry.deferredProviderRequestCompletions = new Map();
  }
  const usage = diagnosticUsage(diagEvt);
  const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
  const endTime = eventDate(diagEvt, "endTimeMs");
  const explicitStartTime =
    typeof diagEvt.startTimeMs === "number" ? eventDate(diagEvt, "startTimeMs") : undefined;
  const usageDetails = usageDetailsFromUsage(usage);
  const output = generationOutputFromModelContent(modelContent, redactEnabled);
  const baseMetadata = {
    durationMs,
    ...diagnosticRuntimeMetadata(diagEvt),
    scope: diagEvt.scope,
    usageSource: diagEvt.usageSource,
    ...providerRequestIdentityMetadata(diagEvt),
    requestPayloadBytes: diagEvt.requestPayloadBytes,
    responseStreamBytes: diagEvt.responseStreamBytes,
    timeToFirstByteMs: diagEvt.timeToFirstByteMs,
    ...nativeChildDiagnosticMetadata(diagEvt),
  };
  entry.deferredProviderRequestCompletions.set(providerRequestIndex, {
    endTime,
    startTime:
      explicitStartTime ?? (durationMs > 0 ? new Date(endTime.getTime() - durationMs) : undefined),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(usageDetails ? { usageDetails } : {}),
    ...(diagEvt.type === "model.call.error"
      ? {
          level: "ERROR",
          statusMessage: redactText(
            privateData?.errorMessage ?? String(diagEvt.errorCategory ?? "model_call_error"),
            redactEnabled,
          ),
          metadata: {
            ...baseMetadata,
            errorCategory: diagEvt.errorCategory,
            failureKind: diagEvt.failureKind,
          },
        }
      : { metadata: baseMetadata }),
  });
}

/**
 * Subscribe to diagnostic events for gateway mode tracing.
 * Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
 * but it does emit model.usage diagnostic events after each LLM call.
 * Returns an unsubscribe function, or null if diagnostic runtime events are unavailable.
 */
export async function subscribeDiagnosticEvents(
  opts: DiagnosticsOptions,
): Promise<(() => void) | null> {
  const {
    langfuse,
    contextMap,
    logger,
    stateDir,
    redactEnabled,
    config,
    promptManager,
    internalDiagnostics,
    onBeforeSdkEnqueue,
    onTraceFinalized,
    onNativeChildDiagnostic,
    onNativeChildDiagnosticBatchComplete,
    onNativeChildPostFinalization,
    resolveNativeChildParent,
  } = opts;
  if (config.tracing?.enabled === false) {
    return null;
  }
  if (!internalDiagnostics) {
    logger?.warn?.(
      "Langfuse: gateway model/tool diagnostics are unavailable; set " +
        "plugins.entries.openclaw-langfuse.hooks.allowConversationAccess=true to authorize them",
    );
    return null;
  }
  const pendingTraceIdentities = new Map<string, PendingDiagnosticTraceIdentity>();
  const nativeChildDiagnosticDepth = new WeakMap<TraceContextEntry, number>();

  function publishNativeChildExecutionContext(
    lineageEntry: TraceContextEntry,
    childThreadId: string,
    childTurnId: string,
    diagEvt: DiagnosticRecord,
  ): void {
    const promptStats = diagEvt.promptStats;
    if (!promptStats || typeof promptStats !== "object" || Array.isArray(promptStats)) {
      noteNativeChildPartial(lineageEntry, "child_context_unavailable");
      return;
    }
    const boundedPromptStats = Object.fromEntries(
      Object.entries(promptStats).filter(
        ([, value]) => typeof value === "number" || typeof value === "string",
      ),
    );
    if (Object.keys(boundedPromptStats).length === 0) {
      noteNativeChildPartial(lineageEntry, "child_context_unavailable");
      return;
    }
    const observation = findNativeChildObservation(lineageEntry, childThreadId, childTurnId);
    if (!observation) {
      noteNativeChildPartial(lineageEntry, "child_observation_unavailable");
      return;
    }
    const callId = diagnosticString(diagEvt.callId);
    if (!callId) {
      noteNativeChildPartial(lineageEntry, "child_context_unavailable");
      return;
    }
    const callIds = (observation.executionContextCallIds ??= new Set());
    if (callIds.has(callId)) {
      return;
    }
    const previousLatestSummary = observation.latestExecutionContextSummary;
    const requestSummary = {
      source: "codex-rollout-request",
      ...(typeof diagEvt.provider === "string" ? { provider: diagEvt.provider } : {}),
      ...(typeof diagEvt.model === "string" ? { model: diagEvt.model } : {}),
      promptStats: boundedPromptStats,
    };
    callIds.add(callId);
    observation.firstExecutionContextSummary ??= requestSummary;
    observation.latestExecutionContextSummary = requestSummary;
    if (typeof diagEvt.model === "string") {
      observation.model = diagEvt.model;
    }
    const summary = {
      source: "codex-rollout-request",
      requestCount: callIds.size,
      firstRequest: observation.firstExecutionContextSummary,
      latestRequest: observation.latestExecutionContextSummary,
    };
    const childEntry = observation.traceEntry;
    if (
      !prepareDiagnosticSdkEnqueue(
        childEntry,
        onBeforeSdkEnqueue,
        childEntry.traceId,
        "trace-create",
        "child execution context",
      )
    ) {
      callIds.delete(callId);
      if (callIds.size === 0) {
        observation.firstExecutionContextSummary = undefined;
        observation.latestExecutionContextSummary = undefined;
      } else {
        observation.latestExecutionContextSummary = previousLatestSummary;
      }
      noteNativeChildPartial(lineageEntry, "child_delivery_rejected");
      return;
    }
    childEntry.traceMetadata = {
      ...childEntry.traceMetadata,
      executionContextSummary: summary,
    };
    childEntry.trace.update({ input: summary, metadata: childEntry.traceMetadata });
  }

  function publishNativeChildTraceOutput(
    lineageEntry: TraceContextEntry,
    observation: NativeChildObservation | undefined,
    output: unknown,
  ): void {
    if (!observation) {
      return;
    }
    const childEntry = observation.traceEntry;
    if (
      !prepareDiagnosticSdkEnqueue(
        childEntry,
        onBeforeSdkEnqueue,
        childEntry.traceId,
        "trace-create",
        "child generation output",
      )
    ) {
      noteNativeChildPartial(lineageEntry, "child_delivery_rejected");
      return;
    }
    childEntry.trace.update({ output });
    observation.traceOutputPublished = true;
  }

  async function drainPendingNativeChildDiagnostics(
    entry: TraceContextEntry,
    childThreadId: string,
    childTurnId?: string,
  ): Promise<void> {
    const pending = entry.pendingNativeChildDiagnostics;
    if (!pending || pending.length === 0) {
      return;
    }
    const ready = pending.filter(
      (item) =>
        item.childThreadId === childThreadId &&
        (!childTurnId || !item.childTurnId || item.childTurnId === childTurnId),
    );
    if (ready.length === 0) {
      return;
    }
    const readySet = new Set(ready);
    entry.pendingNativeChildDiagnostics = pending.filter((item) => !readySet.has(item));
    for (const item of ready) {
      await diagnosticListener(
        item.event as Parameters<DiagnosticListener>[0],
        item.metadata as Parameters<DiagnosticListener>[1],
        item.privateData as Parameters<DiagnosticListener>[2],
      );
    }
    clearNativeChildPending(entry, childThreadId);
  }

  function deferPendingNativeChildDiagnostic(
    entry: TraceContextEntry,
    item: NonNullable<TraceContextEntry["pendingNativeChildDiagnostics"]>[number],
  ): void {
    const pending = (entry.pendingNativeChildDiagnostics ??= []);
    if (pending.length >= NATIVE_CHILD_MAX_PENDING_DIAGNOSTICS) {
      const state = nativeChildLineage(entry);
      state.droppedEvents += 1;
      noteNativeChildPartial(entry, "pending_diagnostic_limit");
      return;
    }
    markNativeChildPending(entry, item.childThreadId);
    pending.push(item);
  }

  const diagnosticListener = async (
    evt: Parameters<DiagnosticListener>[0],
    _metadata: Parameters<DiagnosticListener>[1],
    privateData: Parameters<DiagnosticListener>[2],
  ): Promise<void> => {
    let diagnosticRootEntry: TraceContextEntry | undefined;
    try {
      if (!langfuse || !contextMap) {
        return;
      }
      const nativeChildDiagnostic =
        evt.type === "codex.native_child.lifecycle" || evt.type === "codex.native_child.status";
      const codexToolExecution = isCodexToolExecution(evt);
      if (
        evt.type !== "model.usage" &&
        !isRealtimeModelCall(evt) &&
        !codexToolExecution &&
        !nativeChildDiagnostic
      ) {
        return;
      }

      // Diagnostic events are filtered above, but the host union intentionally
      // grows as new diagnostics are added. Read optional extension fields
      // through the plugin's runtime-checked record boundary.
      const diagEvt = evt as unknown as DiagnosticRecord;
      const modelContent = diagnosticModelContent(privateData);
      const generationOutput = generationOutputFromModelContent(modelContent, redactEnabled);
      const sessionKey = diagnosticSessionKey(diagEvt);
      const agentId = diagnosticAgentId(diagEvt, sessionKey);
      const key = TraceContextMap.key(agentId, sessionKey);
      const realtimeModelCall = isRealtimeModelCall(diagEvt);
      const realtimeModelCallId = realtimeModelCall
        ? (diagnosticString(diagEvt.callId) ?? diagnosticString(diagEvt.runId))
        : undefined;
      const diagnosticRunId = diagnosticString(diagEvt.runId);

      const existingEntry = contextMap.get(key);
      const matchingRunEntry = diagnosticRunId
        ? (contextMap.findActive(sessionKey, { runId: diagnosticRunId }) ??
          contextMap.findRecent(sessionKey, { runId: diagnosticRunId }))
        : undefined;
      const matchingModelCallEntry = realtimeModelCallId
        ? (contextMap.findActive(sessionKey, { runId: realtimeModelCallId }) ??
          contextMap.findRecent(sessionKey, { runId: realtimeModelCallId }))
        : undefined;
      const activeEntry =
        existingEntry && !existingEntry.finalized
          ? existingEntry
          : contextMap.findActive(sessionKey);
      const lateAggregateEntry =
        diagEvt.type === "model.usage"
          ? contextMap.findRecentFinalized(sessionKey, (candidate) =>
              isLateAggregateForFinalizedHook(candidate, diagEvt),
            )
          : undefined;
      const matchingLateAggregateEntry =
        !matchingRunEntry &&
        lateAggregateEntry &&
        (!activeEntry ||
          (recordedUsagesForEntry(activeEntry).length > 0 &&
            !entryHasRecordedUsageMatch(activeEntry, diagEvt)))
          ? lateAggregateEntry
          : undefined;
      const reusableEntry =
        matchingRunEntry ?? matchingModelCallEntry ?? matchingLateAggregateEntry ?? activeEntry;
      const rootEntry =
        nativeChildDiagnostic && !reusableEntry
          ? undefined
          : (reusableEntry ??
            (() => {
              if (existingEntry?.finalized && !realtimeModelCall) {
                contextMap.delete(key);
              }
              return getOrCreateDiagnosticTraceEntry({
                langfuse,
                contextMap,
                config,
                promptManager,
                diagEvt,
                sessionKey,
                agentId,
                key,
                stateDir,
                logger,
                onBeforeSdkEnqueue,
                pendingTraceIdentities,
              });
            })());

      if (!rootEntry) {
        logger?.warn?.(
          `Langfuse: skipped diagnostic trace because the SDK delivery tracker rejected its root enqueue (agent=${agentId})`,
        );
        return;
      }
      diagnosticRootEntry = rootEntry;
      nativeChildDiagnosticDepth.set(
        rootEntry,
        (nativeChildDiagnosticDepth.get(rootEntry) ?? 0) + 1,
      );
      rememberRuntimeIdentity(rootEntry, {
        runtime: diagEvt.runtime,
        runtimeEngine: diagEvt.runtimeEngine,
        transport: diagEvt.transport,
        runtimeTransport: diagEvt.runtimeTransport,
      });
      const nativeChildThreadId = diagnosticString(
        diagEvt.nativeChildThreadId ?? diagEvt.childThreadId,
      );
      const nativeChildTurnId = diagnosticString(diagEvt.nativeChildTurnId ?? diagEvt.childTurnId);
      const existingChildObservation =
        nativeChildThreadId && nativeChildTurnId
          ? findNativeChildObservation(rootEntry, nativeChildThreadId, nativeChildTurnId)
          : undefined;
      const admissionEntry = existingChildObservation?.traceEntry ?? rootEntry;
      const pendingDetachedChildTurn = Boolean(
        nativeChildDiagnostic &&
        nativeChildThreadId &&
        nativeChildTurnId &&
        diagnosticString(diagEvt.triggeringToolCallId) &&
        nativeChildLineage(rootEntry).pendingChildThreads.has(nativeChildThreadId),
      );
      const diagnosticSequence = diagnosticNumber(diagEvt.seq);
      const acceptedByFinalizationBarrier =
        admissionEntry.diagnosticAdmissionClosed === true &&
        diagnosticSequence !== undefined &&
        admissionEntry.finalizationDiagnosticSequence !== undefined &&
        diagnosticSequence <= admissionEntry.finalizationDiagnosticSequence;
      if (
        !pendingDetachedChildTurn &&
        (admissionEntry.deliveryFinalized ||
          (admissionEntry.diagnosticAdmissionClosed && !acceptedByFinalizationBarrier))
      ) {
        if (nativeChildDiagnostic) {
          // The captured cursor is the final admissible event. Recording a later
          // child fact would materialize lineage outside this turn's drain window.
          noteNativeChildPostFinalization(rootEntry);
          onNativeChildPostFinalization?.(rootEntry);
        }
        return;
      }

      if (nativeChildDiagnostic) {
        onNativeChildDiagnostic?.(
          rootEntry,
          evt as Extract<
            Parameters<DiagnosticListener>[0],
            { type: "codex.native_child.lifecycle" | "codex.native_child.status" }
          >,
        );
        const lifecycle = evt as Extract<
          Parameters<DiagnosticListener>[0],
          { type: "codex.native_child.lifecycle" }
        >;
        if (lifecycle.type === "codex.native_child.lifecycle") {
          await drainPendingNativeChildDiagnostics(
            rootEntry,
            lifecycle.childThreadId,
            lifecycle.childTurnId,
          );
        }
        return;
      }

      if (codexToolExecution) {
        let toolEntry = rootEntry;
        if (nativeChildThreadId && nativeChildTurnId && resolveNativeChildParent) {
          const nativeChildParent = resolveNativeChildParent(
            rootEntry,
            nativeChildThreadId,
            nativeChildTurnId,
            diagnosticNumber(diagEvt.startTimeMs) ??
              diagnosticNumber(diagEvt.endTimeMs) ??
              Date.now(),
            "diagnostic_tool",
          );
          if (!nativeChildParent) {
            noteNativeChildPartial(rootEntry, "child_observation_unavailable");
            deferPendingNativeChildDiagnostic(rootEntry, {
              event: evt,
              metadata: _metadata,
              privateData,
              childThreadId: nativeChildThreadId,
              childTurnId: nativeChildTurnId,
            });
            return;
          }
          toolEntry = nativeChildParent.traceEntry;
        } else if (nativeChildThreadId) {
          noteNativeChildPartial(rootEntry, "child_turn_identity_unavailable");
          return;
        }
        recordCodexToolExecution({
          entry: toolEntry,
          lineageEntry: rootEntry,
          diagEvt,
          privateData,
          redactEnabled,
          stateDir,
          agentId,
          sessionId: String(diagEvt.sessionId ?? ""),
          logger,
          onBeforeSdkEnqueue,
        });
        const triggeringToolCallId = diagnosticString(diagEvt.toolCallId);
        if (triggeringToolCallId && resolveNativeChildParent) {
          for (const [childThreadId, toolCallId] of nativeChildLineage(rootEntry)
            .childTriggeringToolCallIds) {
            if (toolCallId !== triggeringToolCallId) {
              continue;
            }
            const childTurnId =
              nativeChildLineage(rootEntry).currentChildTurnIds.get(childThreadId);
            if (!childTurnId) {
              continue;
            }
            const nativeChildParent = resolveNativeChildParent(
              rootEntry,
              childThreadId,
              childTurnId,
              diagnosticNumber(diagEvt.startTimeMs) ??
                diagnosticNumber(diagEvt.endTimeMs) ??
                Date.now(),
              "diagnostic_spawn_tool",
            );
            if (nativeChildParent) {
              await drainPendingNativeChildDiagnostics(rootEntry, childThreadId, childTurnId);
            }
          }
        }
        return;
      }

      if (realtimeModelCall) {
        const callId = realtimeModelCallId ?? "";
        if (!callId) {
          return;
        }
        const nativeChildParent =
          nativeChildThreadId && nativeChildTurnId
            ? resolveNativeChildParent?.(
                rootEntry,
                nativeChildThreadId,
                nativeChildTurnId,
                diagnosticNumber(diagEvt.startTimeMs) ??
                  diagnosticNumber(diagEvt.endTimeMs) ??
                  Date.now(),
                "diagnostic_provider",
              )
            : undefined;
        if (
          nativeChildThreadId &&
          nativeChildTurnId &&
          !rememberNativeChildProviderOwner(
            rootEntry,
            callId,
            nativeChildThreadId,
            nativeChildTurnId,
          )
        ) {
          noteNativeChildPartial(rootEntry, "provider_owner_unavailable");
        }
        if (nativeChildThreadId && !nativeChildTurnId) {
          noteNativeChildPartial(rootEntry, "child_turn_identity_unavailable");
          return;
        }
        if (nativeChildThreadId && nativeChildTurnId && !nativeChildParent) {
          noteNativeChildPartial(rootEntry, "child_observation_unavailable");
          deferPendingNativeChildDiagnostic(rootEntry, {
            event: evt,
            metadata: _metadata,
            privateData,
            childThreadId: nativeChildThreadId,
            childTurnId: nativeChildTurnId,
          });
          return;
        }
        if (nativeChildThreadId && nativeChildTurnId && nativeChildParent) {
          publishNativeChildExecutionContext(
            rootEntry,
            nativeChildThreadId,
            nativeChildTurnId,
            diagEvt,
          );
        }
        const entry = nativeChildParent?.traceEntry ?? rootEntry;
        const providerRequestIndex = claimProviderRequestIndex(entry, callId, diagEvt);
        if (typeof diagEvt.responseIdHash === "string") {
          (entry.providerRequestResponseIdHashes ??= new Map()).set(
            providerRequestIndex,
            diagEvt.responseIdHash,
          );
        }
        const completedCallIds = (entry.providerRequestCompletedCallIds ??= new Set());
        const terminalAlreadySeen = completedCallIds.has(callId);
        const terminalUsage =
          diagEvt.type === "model.call.started"
            ? undefined
            : completeProviderRequestUsage(diagnosticUsage(diagEvt));

        if (
          diagEvt.type !== "model.call.started" &&
          entry.providerRequestPendingTerminalCommits?.has(callId)
        ) {
          const traceStatsFailureKey = diagnosticSdkFailureKey(
            entry.traceId,
            "diagnostic provider-request trace stats",
          );
          if (
            entry.pendingObservationDeliveryFailures?.has(traceStatsFailureKey) &&
            !updateProviderRequestTraceStats(
              entry,
              diagEvt,
              sessionKey,
              agentId,
              onBeforeSdkEnqueue,
            )
          ) {
            return;
          }
          retryPendingProviderRequestTerminal(entry, callId, onBeforeSdkEnqueue);
          return;
        }

        if (diagEvt.type !== "model.call.started" && terminalAlreadySeen) {
          logger?.debug?.(
            `Langfuse: ignored duplicate provider-request terminal (agent=${agentId}, callId=${callId})`,
          );
          return;
        }

        if (diagEvt.type === "model.call.started" && terminalAlreadySeen) {
          const preparedGenerationInput = generationInputFromModelContent(
            entry,
            callId,
            providerRequestIndex,
            diagEvt,
            diagnosticString(diagEvt.model),
            modelContent,
            redactEnabled,
          );
          if (preparedGenerationInput.projection === "unavailable") {
            noteInputProjectionUnavailable(entry, callId);
          }
          if (!publishModelContextMetadata(entry, onBeforeSdkEnqueue)) {
            return;
          }
          commitProviderRequestInput(entry, callId, preparedGenerationInput);
          const generationInput = preparedGenerationInput.generationInput;
          const completedGenIndex = providerRequestGenerationIndex(
            entry,
            callId,
            providerRequestIndex,
          );
          const completedGen = entry.completedGenerations.get(completedGenIndex);
          if (!completedGen) {
            return;
          }
          const completedGenId =
            entry.completedGenerationIds?.get(completedGenIndex) ??
            generateObservationId(entry.traceId, "gen", completedGenIndex);
          if (
            !prepareDiagnosticSdkEnqueue(
              entry,
              onBeforeSdkEnqueue,
              completedGenId,
              "generation-update",
              "diagnostic late provider-request start update",
            )
          ) {
            return;
          }
          completedGen.update({
            model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
            startTime: eventDate(diagEvt, "startTimeMs"),
            ...(generationInput !== undefined ? { input: generationInput } : {}),
            metadata: {
              provider: String(diagEvt.provider ?? ""),
              api: diagEvt.api,
              transport: diagEvt.transport,
              ...diagnosticRuntimeMetadata(diagEvt),
              scope: diagEvt.scope,
              usageSource: diagEvt.usageSource,
              promptStats: diagEvt.promptStats,
              upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
              ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
              lateStart: true,
            },
          });
          return;
        }

        const preparedGenerationInput = generationInputFromModelContent(
          entry,
          callId,
          providerRequestIndex,
          diagEvt,
          diagnosticString(diagEvt.model),
          modelContent,
          redactEnabled,
        );
        if (preparedGenerationInput.projection === "unavailable") {
          noteInputProjectionUnavailable(entry, callId);
        }
        if (!publishModelContextMetadata(entry, onBeforeSdkEnqueue)) {
          return;
        }
        commitProviderRequestInput(entry, callId, preparedGenerationInput);
        const generationInput = preparedGenerationInput.generationInput;

        if (diagEvt.type === "model.call.started") {
          if (entry.pendingGenerations.has(callId)) {
            return;
          }
          const claimed = claimExistingHookGenerationForProviderRequest(
            entry,
            callId,
            providerRequestIndex,
          );
          if (claimed) {
            if (
              !prepareDiagnosticSdkEnqueue(
                entry,
                onBeforeSdkEnqueue,
                claimed.observationId,
                "generation-update",
                "diagnostic provider-request claimed generation update",
              )
            ) {
              return;
            }
            claimed.generation.update({
              model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
              startTime: eventDate(diagEvt, "startTimeMs"),
              ...(generationInput !== undefined ? { input: generationInput } : {}),
              metadata: {
                provider: String(diagEvt.provider ?? ""),
                api: diagEvt.api,
                transport: diagEvt.transport,
                ...diagnosticRuntimeMetadata(diagEvt),
                scope: diagEvt.scope,
                usageSource: diagEvt.usageSource,
                promptStats: diagEvt.promptStats,
                upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
                ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
              },
            });
            logger?.debug?.(
              `Langfuse: linked provider-request diagnostic to existing hook generation (agent=${agentId}, callId=${callId})`,
            );
            return;
          }
          const finalizedGenIndex = entry.finalized ? providerRequestIndex : undefined;
          const finalizedGen = finalizedGenIndex
            ? entry.completedGenerations.get(finalizedGenIndex)
            : undefined;
          if (
            isHookOrJsonlOwnedTrace(entry) &&
            hasOwnedGenerationSlot(entry, providerRequestIndex)
          ) {
            logger?.debug?.(
              `Langfuse: skipped provider-request start without matching hook generation (agent=${agentId}, callId=${callId}, index=${providerRequestIndex})`,
            );
            return;
          }
          if (finalizedGen && finalizedGenIndex) {
            (entry.providerRequestGenerationIndexes ??= new Map()).set(callId, finalizedGenIndex);
            entry.hasProviderRequestGenerations = true;
            entry.pendingGenerations.set(callId, finalizedGen);
            entry.pendingGenIds.set(
              callId,
              generateObservationId(entry.traceId, "gen", finalizedGenIndex),
            );
            return;
          }
          const generationClaim = claimProviderRequestGenerationIndex(
            entry,
            callId,
            providerRequestIndex,
          );
          if (
            !updateProviderRequestTraceStats(
              entry,
              diagEvt,
              sessionKey,
              agentId,
              onBeforeSdkEnqueue,
            )
          ) {
            generationClaim.rollback();
            return;
          }
          const genIndex = generationClaim.index;
          const genId = generateObservationId(entry.traceId, "gen", genIndex);
          const ledgerWritten = writeObservationEvent(
            stateDir,
            agentId,
            String(diagEvt.sessionId ?? ""),
            {
              e: "gen-start",
              traceId: entry.traceId,
              id: genId,
              llmCall: genIndex,
              model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
              ts: eventDate(diagEvt, "startTimeMs").toISOString(),
            },
            logger,
          );
          if (!ledgerWritten) {
            entry.observationLedgerIncomplete = true;
            logger?.warn?.(
              `Langfuse: buffered provider-request generation because identity ledger append failed (traceId=${entry.traceId}, callId=${callId})`,
            );
            return;
          }
          if (
            !prepareDiagnosticSdkEnqueue(
              entry,
              onBeforeSdkEnqueue,
              genId,
              "generation-create",
              "diagnostic provider-request generation",
            )
          ) {
            return;
          }
          const gen = entry.trace.generation({
            id: genId,
            name: nativeChildGenerationName(entry, nativeChildThreadId, genIndex, callId),
            model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
            startTime: eventDate(diagEvt, "startTimeMs"),
            ...(generationInput !== undefined ? { input: generationInput } : {}),
            metadata: {
              provider: String(diagEvt.provider ?? ""),
              api: diagEvt.api,
              transport: diagEvt.transport,
              ...diagnosticRuntimeMetadata(diagEvt),
              scope: diagEvt.scope,
              usageSource: diagEvt.usageSource,
              promptStats: diagEvt.promptStats,
              upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
              ...nativeChildDiagnosticMetadata(diagEvt),
              ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
          });
          entry.pendingGenerations.set(callId, gen);
          entry.pendingGenIds.set(callId, genId);
          if (!nativeChildThreadId) {
            entry.currentGenerationId = genId;
          }
          return;
        }

        let gen = entry.pendingGenerations.get(callId);
        if (!gen) {
          const claimed = claimExistingHookGenerationForProviderRequest(
            entry,
            callId,
            providerRequestIndex,
          );
          if (claimed) {
            gen = claimed.generation;
          }
        }
        if (!gen) {
          const finalizedGenIndex = entry.finalized ? providerRequestIndex : undefined;
          const finalizedGen = finalizedGenIndex
            ? entry.completedGenerations.get(finalizedGenIndex)
            : undefined;
          const allocatedGenIndex = entry.providerRequestGenerationIndexes?.get(callId);
          const completedProviderGen =
            allocatedGenIndex !== undefined
              ? entry.completedGenerations.get(allocatedGenIndex)
              : undefined;
          if (completedProviderGen && allocatedGenIndex !== undefined) {
            gen = completedProviderGen;
            entry.pendingGenIds.set(
              callId,
              generateObservationId(entry.traceId, "gen", allocatedGenIndex),
            );
          } else if (finalizedGen && finalizedGenIndex) {
            gen = finalizedGen;
            (entry.providerRequestGenerationIndexes ??= new Map()).set(callId, finalizedGenIndex);
            entry.pendingGenIds.set(
              callId,
              generateObservationId(entry.traceId, "gen", finalizedGenIndex),
            );
          } else if (
            isHookOrJsonlOwnedTrace(entry) &&
            hasOwnedGenerationSlot(entry, providerRequestIndex)
          ) {
            deferProviderRequestCompletion(
              entry,
              providerRequestIndex,
              diagEvt,
              generationInput,
              modelContent,
              privateData,
              redactEnabled,
            );
            logger?.debug?.(
              `Langfuse: deferred provider-request completion without matching hook generation (agent=${agentId}, callId=${callId}, index=${providerRequestIndex})`,
            );
            commitOrQueueProviderRequestTerminal(entry, callId, terminalUsage, onBeforeSdkEnqueue);
            return;
          } else {
            const generationClaim = claimProviderRequestGenerationIndex(
              entry,
              callId,
              providerRequestIndex,
            );
            if (
              !updateProviderRequestTraceStats(
                entry,
                diagEvt,
                sessionKey,
                agentId,
                onBeforeSdkEnqueue,
              )
            ) {
              generationClaim.rollback();
              return;
            }
          }
          const generationIndex = providerRequestGenerationIndex(
            entry,
            callId,
            providerRequestIndex,
          );
          const genId =
            finalizedGenIndex && finalizedGen
              ? generateObservationId(entry.traceId, "gen", finalizedGenIndex)
              : generateObservationId(entry.traceId, "gen", generationIndex);
          const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
          const endTime = eventDate(diagEvt, "endTimeMs");
          const syntheticStartTime =
            typeof diagEvt.startTimeMs === "number"
              ? eventDate(diagEvt, "startTimeMs")
              : new Date(Math.max(0, endTime.getTime() - durationMs));
          if (!gen) {
            const ledgerWritten = writeObservationEvent(
              stateDir,
              agentId,
              String(diagEvt.sessionId ?? ""),
              {
                e: "gen-start",
                traceId: entry.traceId,
                id: genId,
                llmCall: generationIndex,
                model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
                ts: syntheticStartTime.toISOString(),
              },
              logger,
            );
            if (!ledgerWritten) {
              entry.observationLedgerIncomplete = true;
              logger?.warn?.(
                `Langfuse: buffered terminal-only provider-request generation because identity ledger append failed (traceId=${entry.traceId}, callId=${callId})`,
              );
              return;
            }
            if (
              !prepareDiagnosticSdkEnqueue(
                entry,
                onBeforeSdkEnqueue,
                genId,
                "generation-create",
                "diagnostic terminal-only provider-request generation",
              )
            ) {
              return;
            }
            clearDiagnosticSdkFailuresForObservation(entry, genId);
            gen = entry.trace.generation({
              id: genId,
              name: nativeChildGenerationName(entry, nativeChildThreadId, generationIndex, callId),
              model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
              startTime: syntheticStartTime,
              ...(generationInput !== undefined ? { input: generationInput } : {}),
              metadata: {
                provider: String(diagEvt.provider ?? ""),
                api: diagEvt.api,
                transport: diagEvt.transport,
                ...diagnosticRuntimeMetadata(diagEvt),
                scope: diagEvt.scope,
                orphanedStart: true,
                ...nativeChildDiagnosticMetadata(diagEvt),
                ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
            });
          }
          entry.pendingGenIds.set(callId, genId);
          if (!nativeChildThreadId) {
            entry.currentGenerationId = genId;
          }
        }

        const usage = diagnosticUsage(diagEvt);
        const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
        const endTime = eventDate(diagEvt, "endTimeMs");
        const startTime =
          typeof diagEvt.startTimeMs === "number"
            ? eventDate(diagEvt, "startTimeMs")
            : new Date(Math.max(0, endTime.getTime() - durationMs));
        const usageDetails = usageDetailsFromUsage(usage);
        const genId = entry.pendingGenIds.get(callId);
        const terminalLedgerFailureKey = `provider-request:${genId ?? callId}:gen-end`;
        if (genId) {
          const endLedgerWritten = writeObservationEvent(
            stateDir,
            agentId,
            String(diagEvt.sessionId ?? ""),
            { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
            logger,
          );
          if (!endLedgerWritten) {
            (entry.pendingObservationDeliveryFailures ??= new Set()).add(terminalLedgerFailureKey);
            return;
          }
          entry.pendingObservationDeliveryFailures?.delete(terminalLedgerFailureKey);
        }
        if (
          !prepareDiagnosticSdkEnqueue(
            entry,
            onBeforeSdkEnqueue,
            genId ?? entry.traceId,
            "generation-update",
            "diagnostic provider-request generation update",
          )
        ) {
          return;
        }
        if (genId) {
          clearDiagnosticSdkFailuresForObservation(entry, genId);
        }
        if (diagEvt.type === "model.call.error") {
          gen.update({
            startTime,
            endTime,
            ...(generationInput !== undefined ? { input: generationInput } : {}),
            ...(generationOutput !== undefined ? { output: generationOutput } : {}),
            ...(usageDetails ? { usageDetails } : {}),
            level: "ERROR",
            statusMessage: redactText(
              privateData?.errorMessage ?? String(diagEvt.errorCategory ?? "model_call_error"),
              redactEnabled,
            ),
            metadata: {
              durationMs,
              ...diagnosticRuntimeMetadata(diagEvt),
              scope: diagEvt.scope,
              usageSource: diagEvt.usageSource,
              errorCategory: diagEvt.errorCategory,
              failureKind: diagEvt.failureKind,
              requestPayloadBytes: diagEvt.requestPayloadBytes,
              responseStreamBytes: diagEvt.responseStreamBytes,
              timeToFirstByteMs: diagEvt.timeToFirstByteMs,
              ...nativeChildDiagnosticMetadata(diagEvt),
              ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
            },
          });
        } else {
          gen.update({
            startTime,
            endTime,
            ...(generationInput !== undefined ? { input: generationInput } : {}),
            ...(generationOutput !== undefined ? { output: generationOutput } : {}),
            ...(usageDetails ? { usageDetails } : {}),
            metadata: {
              durationMs,
              ...diagnosticRuntimeMetadata(diagEvt),
              scope: diagEvt.scope,
              usageSource: diagEvt.usageSource,
              requestPayloadBytes: diagEvt.requestPayloadBytes,
              responseStreamBytes: diagEvt.responseStreamBytes,
              timeToFirstByteMs: diagEvt.timeToFirstByteMs,
              ...nativeChildDiagnosticMetadata(diagEvt),
              ...providerRequestProjectionMetadata(diagEvt, preparedGenerationInput),
            },
          });
        }
        if (generationOutput !== undefined) {
          publishNativeChildTraceOutput(rootEntry, nativeChildParent, generationOutput);
        }
        const genIndex = providerRequestGenerationIndex(entry, callId, providerRequestIndex);
        entry.completedGenerations.set(genIndex, gen);
        if (genId) {
          (entry.completedGenerationIds ??= new Map()).set(genIndex, genId);
        }
        removePendingGenerationAliases(entry, gen, genId);
        (entry.providerRequestPendingTerminalCommits ??= new Map()).set(callId, terminalUsage);
        if (
          !updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId, onBeforeSdkEnqueue)
        ) {
          return;
        }
        retryPendingProviderRequestTerminal(entry, callId, onBeforeSdkEnqueue);
        return;
      }

      const entry = rootEntry;
      // If agent_end already finalized this entry (created generations from JSONL),
      // skip aggregate usage events so finalized metadata is not overwritten.
      if (entry.finalized) {
        logger?.debug?.(
          `Langfuse: skipping diagnostic handler — agent_end already finalized (agent=${agentId})`,
        );
        return;
      }

      // Read the canonical transcript and filter to the current turn only.
      const sessionId = String(diagEvt.sessionId ?? "");
      const allEntries =
        sessionId && sessionKey !== "unknown"
          ? await readSessionMessagesByIdentity({ agentId, sessionId, sessionKey }, logger)
          : [];
      if (!entry.modelContextMetadata && allEntries.length > 0) {
        const canonicalContextMessages = allEntries
          .filter(
            (candidate) =>
              !isTranscriptOnlyAssistantMessage(
                candidate.message as Parameters<typeof isTranscriptOnlyAssistantMessage>[0],
              ),
          )
          .map((candidate) => buildApiMessage(candidate.message))
          .filter((message) => (message as Record<string, unknown>).role !== "system");
        const normalizedContext = normalizeModelCallInput({
          model: diagnosticString(diagEvt.model),
          systemPrompt: entry.systemPrompt,
          messages: canonicalContextMessages,
          redactEnabled,
        });
        entry.modelContextMetadata = normalizedContext.traceMetadata;
        entry.priorConversation = normalizedContext.priorConversation;
        entry.traceMetadata = {
          ...objectRecord(entry.traceMetadata),
          ...normalizedContext.traceMetadata,
        };
      }
      // agent_end can finalize while transcript I/O is in flight. Recheck before
      // creating observations so the late aggregate cannot duplicate hook output.
      if (entry.finalized) {
        logger?.debug?.(
          `Langfuse: skipping diagnostic handler — agent_end finalized during transcript read (agent=${agentId})`,
        );
        return;
      }
      const messages = filterCurrentTurnMessages(allEntries.map((e) => e.message));
      const messagesForLlm = messages.filter(
        (message) =>
          !isTranscriptOnlyAssistantMessage(
            message as Parameters<typeof isTranscriptOnlyAssistantMessage>[0],
          ),
      );
      const turn = extractConversation(messagesForLlm);

      const diagnosticToolCallCount = countToolCallsFromMessages(messages);
      if (diagnosticToolCallCount > entry.toolCallCount) {
        entry.toolCallCount = diagnosticToolCallCount;
      }

      if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
        if (!entry.finalized) {
          const existingMetadata = objectRecord(entry.traceMetadata);
          const existingStats = objectRecord(existingMetadata.stats);
          const nextMetadata = {
            ...existingMetadata,
            ...runtimeMetadata(entry),
            sessionKey,
            agentId,
            channelId: diagEvt.channel,
            trigger: "diagnostic",
            timestamp: entry.timestamp,
            aggregateUsage: diagEvt.usage,
            aggregateUsageSource: diagEvt.usageSource,
            stats: {
              ...existingStats,
              messageCount: messages.length,
              llmCallCount: entry.llmCallCount,
              toolCallCount: entry.toolCallCount,
            },
          };
          entry.traceMetadata = nextMetadata;
          if (
            !prepareDiagnosticSdkEnqueue(
              entry,
              onBeforeSdkEnqueue,
              entry.traceId,
              "trace-create",
              "diagnostic provider-request trace update",
            )
          ) {
            return;
          }
          entry.trace.update({
            output: turn.output
              ? truncatePayload(redactText(turn.output, redactEnabled))
              : undefined,
            metadata: nextMetadata,
          });
        }
        await finalizeDiagnosticTraceEntry(
          entry,
          onTraceFinalized,
          agentId,
          String(diagEvt.sessionId ?? ""),
        );
        logger?.info?.(
          `Langfuse: skipped aggregate diagnostic generation because provider-request generations exist (agent=${agentId}, model=${diagEvt.model})`,
        );
        return;
      }

      const usage = diagEvt.usage as Record<string, number> | undefined;
      const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - durationMs);
      const llmTurns = extractLLMTurns(messagesForLlm);
      const aggregateUsageDetails = usageDetailsFromUsage(usage);
      const aggregateDescribesSingleCall =
        llmTurns.length <= 1 && entry.llmCallCount <= 1 && entry.pendingGenerations.size <= 1;

      // Hook-owned generations remain authoritative even after llm_output moved them
      // out of the pending map. Only create diagnostic fallback generations when no
      // hook generation exists for this turn.
      if (entry.llmCallCount > 0) {
        if (
          aggregateDescribesSingleCall &&
          entry.pendingGenerations.size === 0 &&
          entry.completedGenerations.size === 1
        ) {
          const completedGeneration = entry.completedGenerations.entries().next().value as
            | [number, LangfuseGenerationClient]
            | undefined;
          if (completedGeneration) {
            const [generationIndex, generation] = completedGeneration;
            const generationId =
              entry.completedGenerationIds?.get(generationIndex) ??
              generateObservationId(entry.traceId, "gen", generationIndex);
            if (
              prepareDiagnosticSdkEnqueue(
                entry,
                onBeforeSdkEnqueue,
                generationId,
                "generation-update",
                "diagnostic aggregate completed generation update",
              )
            ) {
              generation.update({
                ...(aggregateUsageDetails ? { usageDetails: aggregateUsageDetails } : {}),
                metadata: { durationMs },
              });
            }
          }
        }
        for (const [runId, gen] of entry.pendingGenerations) {
          const genId = entry.pendingGenIds.get(runId);
          if (
            !genId ||
            !writeObservationEvent(
              stateDir,
              agentId,
              sessionId,
              { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
              logger,
            )
          ) {
            entry.observationLedgerIncomplete = true;
            continue;
          }
          if (
            !prepareDiagnosticSdkEnqueue(
              entry,
              onBeforeSdkEnqueue,
              genId,
              "generation-update",
              "diagnostic aggregate generation update",
            )
          ) {
            continue;
          }
          gen.update({
            endTime,
            output: turn.output ? redactAndTruncateText(turn.output, redactEnabled) : undefined,
            ...(aggregateDescribesSingleCall && aggregateUsageDetails
              ? { usageDetails: aggregateUsageDetails }
              : {}),
            metadata: aggregateDescribesSingleCall ? { durationMs } : {},
          });
          entry.pendingGenerations.delete(runId);
          entry.pendingGenIds.delete(runId);
        }
      } else if (llmTurns.length === 0) {
        // llm_input didn't fire — create generations from diagnostic event + JSONL.
        // Each assistant message in the session = one LLM call.
        // Fallback: no parseable turns, create single generation as before
        const generationIndex = entry.llmCallCount + 1;
        const genInput = generationInputPayload(turn.input, redactEnabled);
        const genOutput = turn.output
          ? redactAndTruncateText(turn.output, redactEnabled)
          : undefined;
        const genId = generateObservationId(entry.traceId, "gen", generationIndex);
        if (
          !writeObservationEvent(
            stateDir,
            agentId,
            sessionId,
            {
              e: "gen-start",
              traceId: entry.traceId,
              id: genId,
              llmCall: generationIndex,
              model: qualifiedModel(
                String(diagEvt.provider ?? ""),
                String(diagEvt.model ?? "unknown"),
              ),
              ts: startTime.toISOString(),
            },
            logger,
          )
        ) {
          entry.observationLedgerIncomplete = true;
          return;
        }
        if (
          !prepareDiagnosticSdkEnqueue(
            entry,
            onBeforeSdkEnqueue,
            genId,
            "generation-create",
            "diagnostic fallback generation",
          )
        ) {
          return;
        }
        const gen = entry.trace.generation({
          id: genId,
          name: `llm-call-${generationIndex}`,
          model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "unknown")),
          startTime,
          input: genInput,
          metadata: {
            provider: String(diagEvt.provider ?? ""),
            ...diagnosticRuntimeMetadata(diagEvt),
            durationMs,
            cacheRead: usage?.cacheRead,
            cacheWrite: usage?.cacheWrite,
            lastUserInput: turn.lastUserText
              ? redactText(turn.lastUserText, redactEnabled)
              : undefined,
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
        });
        entry.llmCallCount = generationIndex;
        const pendingKey = `diagnostic-fallback:${genId}`;
        entry.pendingGenerations.set(pendingKey, gen);
        entry.pendingGenIds.set(pendingKey, genId);
        if (
          !writeObservationEvent(
            stateDir,
            agentId,
            sessionId,
            { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
            logger,
          )
        ) {
          entry.observationLedgerIncomplete = true;
          return;
        }
        if (
          !prepareDiagnosticSdkEnqueue(
            entry,
            onBeforeSdkEnqueue,
            genId,
            "generation-update",
            "diagnostic fallback generation update",
          )
        ) {
          return;
        }
        const fallbackUsageDetails = usageDetailsFromUsage(usage);
        gen.update({
          endTime,
          output: genOutput,
          ...(fallbackUsageDetails ? { usageDetails: fallbackUsageDetails } : {}),
        });
        entry.pendingGenerations.delete(pendingKey);
        entry.pendingGenIds.delete(pendingKey);
      } else {
        // Create a generation for each LLM turn
        for (let i = 0; i < llmTurns.length; i++) {
          const llmTurn = llmTurns[i];
          if (!llmTurn) {
            continue;
          }
          entry.llmCallCount += 1;
          const isLast = i === llmTurns.length - 1;
          const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
          const turnModel = qualifiedModel(
            String(diagEvt.provider ?? ""),
            String(diagEvt.model ?? "unknown"),
          );

          const turnInput = llmTurn.inputMessages.map((message) =>
            buildApiMessage(message as Record<string, unknown>),
          );
          const boundedGenInput = generationInputPayload(turnInput, redactEnabled);
          const genOutput = llmTurn.assistantText
            ? redactAndTruncateText(llmTurn.assistantText, redactEnabled)
            : undefined;

          if (
            !writeObservationEvent(
              stateDir,
              agentId,
              sessionId,
              {
                e: "gen-start",
                traceId: entry.traceId,
                id: genId,
                llmCall: entry.llmCallCount,
                model: turnModel,
                ts: startTime.toISOString(),
              },
              logger,
            )
          ) {
            entry.observationLedgerIncomplete = true;
            continue;
          }
          if (
            !prepareDiagnosticSdkEnqueue(
              entry,
              onBeforeSdkEnqueue,
              genId,
              "generation-create",
              "diagnostic turn generation",
            )
          ) {
            continue;
          }
          const gen = entry.trace.generation({
            id: genId,
            name: `llm-call-${entry.llmCallCount}`,
            model: turnModel,
            input: boundedGenInput,
            metadata: {
              provider: String(diagEvt.provider ?? ""),
              ...diagnosticRuntimeMetadata(diagEvt),
              ...(llmTurn.toolCalls.length > 0
                ? {
                    toolCalls: llmTurn.toolCalls.map((t) => t.name),
                  }
                : {}),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
          });

          // Aggregate usage is attributable only when the transcript contains one call.
          if (isLast) {
            if (
              !writeObservationEvent(
                stateDir,
                agentId,
                sessionId,
                {
                  e: "gen-end",
                  traceId: entry.traceId,
                  id: genId,
                  ts: endTime.toISOString(),
                },
                logger,
              )
            ) {
              entry.observationLedgerIncomplete = true;
              continue;
            }
            if (
              !prepareDiagnosticSdkEnqueue(
                entry,
                onBeforeSdkEnqueue,
                genId,
                "generation-update",
                "diagnostic turn generation update",
              )
            ) {
              continue;
            }
            gen.update({
              endTime,
              output: genOutput,
              ...(aggregateDescribesSingleCall && aggregateUsageDetails
                ? { usageDetails: aggregateUsageDetails }
                : {}),
              metadata: aggregateDescribesSingleCall ? { durationMs } : {},
            });
          } else {
            const intermediateEndTime = new Date();
            if (
              !writeObservationEvent(
                stateDir,
                agentId,
                sessionId,
                {
                  e: "gen-end",
                  traceId: entry.traceId,
                  id: genId,
                  ts: intermediateEndTime.toISOString(),
                },
                logger,
              )
            ) {
              entry.observationLedgerIncomplete = true;
              continue;
            }
            if (
              !prepareDiagnosticSdkEnqueue(
                entry,
                onBeforeSdkEnqueue,
                genId,
                "generation-update",
                "diagnostic turn generation end",
              )
            ) {
              continue;
            }
            gen.end({ output: genOutput });
          }
        }
      }

      // Update trace metadata only if agentEnd hasn't finalized it
      // (Langfuse update is full-replace, not merge)
      if (!entry.finalized) {
        if (
          !prepareDiagnosticSdkEnqueue(
            entry,
            onBeforeSdkEnqueue,
            entry.traceId,
            "trace-create",
            "diagnostic aggregate trace update",
          )
        ) {
          return;
        }
        const aggregateTraceMetadata = {
          ...objectRecord(entry.traceMetadata),
          sessionKey,
          agentId,
          channelId: diagEvt.channel,
          trigger: "diagnostic",
          timestamp: entry.timestamp,
          aggregateUsage: usage,
          stats: {
            durationMs,
            messageCount: messages.length,
            llmCallCount: entry.llmCallCount,
            toolCallCount: entry.toolCallCount,
          },
          ...(entry.lastModel
            ? { lastModel: { provider: entry.lastProvider, model: entry.lastModel } }
            : {}),
          ...entry.modelContextMetadata,
          ...runtimeMetadata(entry),
          ...(entry.promptMatch && "name" in entry.promptMatch
            ? { prompt: entry.promptMatch }
            : {}),
        };
        entry.traceMetadata = aggregateTraceMetadata;
        entry.trace.update({
          output: turn.output ? truncatePayload(redactText(turn.output, redactEnabled)) : undefined,
          metadata: aggregateTraceMetadata,
        });
      }
      await finalizeDiagnosticTraceEntry(
        entry,
        onTraceFinalized,
        agentId,
        String(diagEvt.sessionId ?? ""),
      );

      logger?.info?.(
        `Langfuse: generation created (agent=${agentId}, model=${diagEvt.model}, tokens=${usage?.total})`,
      );
    } catch (err) {
      logger?.error?.(
        `Langfuse: diagnostic event handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    } finally {
      if (diagnosticRootEntry) {
        const depth = nativeChildDiagnosticDepth.get(diagnosticRootEntry) ?? 1;
        if (depth <= 1) {
          nativeChildDiagnosticDepth.delete(diagnosticRootEntry);
          onNativeChildDiagnosticBatchComplete?.(diagnosticRootEntry);
        } else {
          nativeChildDiagnosticDepth.set(diagnosticRootEntry, depth - 1);
        }
      }
    }
  };
  const unsubscribe = internalDiagnostics.onEvent((evt, metadata, privateData) => {
    const task = diagnosticListener(evt, metadata, privateData);
    opts.onDiagnosticTask?.(task, evt);
    void task;
  });

  return () => {
    pendingTraceIdentities.clear();
    unsubscribe();
  };
}
