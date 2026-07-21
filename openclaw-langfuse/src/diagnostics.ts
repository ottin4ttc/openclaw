import type Langfuse from "langfuse";
import type { LangfuseGenerationClient } from "langfuse";
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type { OpenClawPluginServiceContext, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { LangfusePluginConfig } from "./config.js";
import { countToolCallsFromMessages } from "./observations.js";
import type { PromptManager } from "./prompt-manager.js";
import { redactObject, redactText } from "./redact.js";
import { readSessionMessagesByIdentity } from "./session.js";
import {
  completeProviderRequestUsageTotals,
  resolveCurrentGeneration,
  TraceContextMap,
} from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";
import {
  generateObservationId,
  generateTraceId,
  qualifiedModel,
  extractTextContent,
  extractConversation,
  extractLLMTurns,
  filterCurrentTurnMessages,
  usageDetailsFromUsage,
  isTranscriptOnlyAssistantMessage,
  truncatePayload,
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
}

type DiagnosticRecord = Record<string, unknown>;
type DiagnosticPrivateData = {
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
};

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

function getOrCreateDiagnosticTraceEntry(args: DiagnosticTraceEntryArgs): TraceContextEntry {
  const { langfuse, contextMap, config, promptManager, diagEvt, sessionKey, agentId, key } = args;
  const existing = contextMap.get(key);
  if (existing && !existing.finalized) {
    return existing;
  }

  // No trace from before_agent_start — create one now (gateway mode).
  const timestamp = Date.now();
  const traceId = generateTraceId(sessionKey, timestamp);
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
  const trace = langfuse.trace({
    id: traceId,
    name: agentId,
    sessionId: sessionKey,
    tags,
    metadata: traceMetadata,
  });
  const runId = diagnosticString(diagEvt.runId);
  const entry: TraceContextEntry = {
    trace,
    traceId,
    traceMetadata,
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
    createdAt: timestamp,
    timestamp,
  };
  contextMap.create(key, entry);

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

function isProviderRequestModelCall(evt: DiagnosticRecord): boolean {
  return (
    (evt.type === "model.call.started" ||
      evt.type === "model.call.completed" ||
      evt.type === "model.call.error") &&
    evt.scope === "provider-request"
  );
}

function diagnosticUsage(evt: DiagnosticRecord): Record<string, number> | undefined {
  const usage = evt.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  return usage as Record<string, number>;
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
  };
}

function updateAuthoritativeProviderUsage(entry: TraceContextEntry): void {
  const usage = completeProviderRequestUsageTotals(entry);
  entry.authoritativeProviderUsage = usage;
  if (!usage) {
    return;
  }
  if (!entry.finalized) {
    return;
  }

  const nextMetadata = {
    ...objectRecord(entry.traceMetadata),
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead || undefined,
      cacheWriteInputTokens: usage.cacheWrite || undefined,
      totalTokens: usage.total,
    },
  };
  entry.traceMetadata = nextMetadata;
  entry.trace.update({ metadata: nextMetadata });
}

function diagnosticModelContent(privateData: DiagnosticPrivateData | undefined) {
  return privateData?.modelContent;
}

function isPrivateToolExecution(
  evt: DiagnosticRecord,
  privateData: DiagnosticPrivateData | undefined,
): boolean {
  return (
    evt.toolOwner === "codex-rollout-trace" &&
    (evt.type === "tool.execution.completed" || evt.type === "tool.execution.error") &&
    privateData?.toolContent !== undefined
  );
}

function recordPrivateToolExecution(params: {
  entry: TraceContextEntry;
  diagEvt: DiagnosticRecord;
  privateData: DiagnosticPrivateData;
  redactEnabled: boolean;
}): void {
  const { entry, diagEvt, privateData, redactEnabled } = params;
  const toolCallId = String(diagEvt.toolCallId ?? "");
  const toolName = String(diagEvt.toolName ?? "");
  if (!toolCallId || !toolName || entry.diagnosticCorrectedSpanToolCallIds?.has(toolCallId)) {
    return;
  }
  const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
  const endTime = eventDate(diagEvt, "endTimeMs");
  const startTime =
    typeof diagEvt.startTimeMs === "number"
      ? eventDate(diagEvt, "startTimeMs")
      : new Date(Math.max(0, endTime.getTime() - durationMs));
  const existingSpan = entry.pendingSpans.get(toolCallId) ?? entry.completedSpans?.get(toolCallId);
  const input = truncatePayload(redactObject(privateData.toolContent?.toolInput, redactEnabled));
  const output = truncatePayload(redactObject(privateData.toolContent?.toolOutput, redactEnabled));
  const spanArgs = {
    id: generateObservationId(entry.traceId, "span", toolCallId),
    name: `tool:${toolName}`,
    startTime,
    input,
    metadata: {
      toolName,
      toolCallId,
      source: "diagnostic-tool-content",
    },
  };
  const currentGeneration = resolveCurrentGeneration(entry);
  const span =
    existingSpan ??
    (currentGeneration ? currentGeneration.span(spanArgs) : entry.trace.span(spanArgs));
  entry.pendingSpans.set(toolCallId, span);
  if (!existingSpan) {
    entry.toolCallCount += 1;
  }
  const isError = diagEvt.type === "tool.execution.error";
  span.update({
    startTime,
    endTime,
    input,
    output,
    metadata: {
      toolName,
      toolCallId,
      durationMs,
      source: "diagnostic-tool-content",
      ...(isError ? { isError: true } : {}),
    },
    ...(isError
      ? {
          level: "ERROR" as const,
          statusMessage: String(diagEvt.errorCategory ?? "tool_execution_error"),
        }
      : {}),
  });
  entry.pendingSpans.delete(toolCallId);
  (entry.completedSpans ??= new Map()).set(toolCallId, span);
  entry.completedSpanToolCallIds.add(toolCallId);
  (entry.diagnosticCorrectedSpanToolCallIds ??= new Set()).add(toolCallId);
}

function generationInputFromModelContent(
  modelContent: DiagnosticPrivateData["modelContent"] | undefined,
  redactEnabled: boolean,
): unknown | undefined {
  if (!modelContent) {
    return undefined;
  }
  const input = {
    ...(modelContent.systemPrompt ? { systemPrompt: modelContent.systemPrompt } : {}),
    ...(modelContent.inputMessages !== undefined ? { messages: modelContent.inputMessages } : {}),
    ...(modelContent.toolDefinitions !== undefined ? { tools: modelContent.toolDefinitions } : {}),
  };
  return Object.keys(input).length > 0
    ? truncatePayload(redactObject(input, redactEnabled))
    : undefined;
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
  return typeof evt.ts === "number" ? new Date(evt.ts) : new Date();
}

function claimProviderRequestIndex(entry: TraceContextEntry, callId: string): number {
  if (!entry.providerRequestCallIndexes) {
    entry.providerRequestCallIndexes = new Map();
  }
  const existingIndex = entry.providerRequestCallIndexes.get(callId);
  if (existingIndex) {
    return existingIndex;
  }
  const nextIndex = (entry.providerRequestCallCount ?? 0) + 1;
  entry.providerRequestCallCount = nextIndex;
  entry.providerRequestCallIndexes.set(callId, nextIndex);
  entry.authoritativeProviderUsage = undefined;
  return nextIndex;
}

function generationIndexFromId(
  entry: TraceContextEntry,
  generationId: string | undefined,
): number | undefined {
  const prefix = `${entry.traceId}-gen-`;
  if (!generationId?.startsWith(prefix)) {
    return undefined;
  }
  const generationIndex = Number(generationId.slice(prefix.length));
  return Number.isInteger(generationIndex) && generationIndex > 0 ? generationIndex : undefined;
}

function claimExistingHookGenerationForProviderRequest(
  entry: TraceContextEntry,
  callId: string,
  providerRequestIndex: number,
): LangfuseGenerationClient | null {
  if (entry.hasProviderRequestGenerations || entry.llmCallCount < providerRequestIndex) {
    return null;
  }
  const genId = generateObservationId(entry.traceId, "gen", providerRequestIndex);
  const existingGen =
    entry.completedGenerations.get(providerRequestIndex) ??
    [...entry.pendingGenerations.entries()].find(
      ([runId]) => entry.pendingGenIds.get(runId) === genId,
    )?.[1];
  if (!existingGen) {
    return null;
  }
  entry.providerRequestAugmentedHookGenerations = true;
  entry.pendingGenerations.set(callId, existingGen);
  entry.pendingGenIds.set(callId, genId);
  entry.currentGenerationId = genId;
  return existingGen;
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

function nextProviderRequestGenerationIndex(
  entry: TraceContextEntry,
  providerRequestIndex: number,
): number {
  entry.llmCallCount = Math.max(entry.llmCallCount, providerRequestIndex);
  entry.hasProviderRequestGenerations = true;
  return providerRequestIndex;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactAndTruncateObject(value: unknown, redactEnabled: boolean): unknown {
  return truncatePayload(redactObject(value, redactEnabled));
}

function redactAndTruncateText(text: string, redactEnabled: boolean): unknown {
  return truncatePayload(redactText(text, redactEnabled));
}

function generationInputPayload(
  systemPrompt: string | undefined,
  messages: unknown,
  redactEnabled: boolean,
): unknown {
  return truncatePayload(
    redactObject(
      {
        ...(systemPrompt ? { systemPrompt } : {}),
        messages,
      },
      redactEnabled,
    ),
  );
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
    entry.authoritativeProviderUsage,
    ...(entry.providerRequestUsages?.values() ?? []),
  ]
    .filter((usage): usage is NonNullable<typeof usage> => usage !== undefined)
    .map((usage) => objectRecord(usage));
}

function entryHasRecordedUsageMatch(entry: TraceContextEntry, diagEvt: DiagnosticRecord): boolean {
  const eventUsage = objectRecord(diagEvt.usage);
  return recordedUsagesForEntry(entry).some((usage) => usageMatches(eventUsage, usage));
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
  return (
    (!provider || !entry.lastProvider || provider === entry.lastProvider) &&
    (!model || !entry.lastModel || model === entry.lastModel)
  );
}

function updateProviderRequestTraceStats(
  entry: TraceContextEntry,
  diagEvt: DiagnosticRecord,
  sessionKey: string,
  agentId: string,
): void {
  const existingMetadata = objectRecord(entry.traceMetadata);
  const existingStats = objectRecord(existingMetadata.stats);
  const nextMetadata = {
    ...existingMetadata,
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
  entry.trace.update({ metadata: nextMetadata });
}

function finalizeDiagnosticTraceEntry(entry: TraceContextEntry): void {
  entry.finalized = true;
}

function deferProviderRequestCompletion(
  entry: TraceContextEntry,
  providerRequestIndex: number,
  diagEvt: DiagnosticRecord,
  modelContent: DiagnosticPrivateData["modelContent"] | undefined,
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
  const input = generationInputFromModelContent(modelContent, redactEnabled);
  const output = generationOutputFromModelContent(modelContent, redactEnabled);
  const baseMetadata = {
    durationMs,
    scope: diagEvt.scope,
    usageSource: diagEvt.usageSource,
    requestPayloadBytes: diagEvt.requestPayloadBytes,
    responseStreamBytes: diagEvt.responseStreamBytes,
    timeToFirstByteMs: diagEvt.timeToFirstByteMs,
  };
  entry.deferredProviderRequestCompletions.set(providerRequestIndex, {
    endTime,
    startTime:
      explicitStartTime ?? (durationMs > 0 ? new Date(endTime.getTime() - durationMs) : undefined),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(usageDetails ? { usageDetails } : {}),
    ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
      ? { costDetails: { total: diagEvt.costUsd } }
      : {}),
    ...(diagEvt.type === "model.call.error"
      ? {
          level: "ERROR",
          statusMessage: String(diagEvt.errorCategory ?? "model_call_error"),
          metadata: {
            ...baseMetadata,
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
    redactEnabled,
    config,
    promptManager,
    internalDiagnostics,
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

  const unsubscribe = internalDiagnostics.onEvent(
    async (evt, _metadata, privateData) => {
      try {
        if (!langfuse || !contextMap) {
          return;
        }
        const privateToolExecution = isPrivateToolExecution(evt, privateData);
        if (
          evt.type !== "model.usage" &&
          !isProviderRequestModelCall(evt) &&
          !privateToolExecution
        ) {
          return;
        }

        const diagEvt = evt;
        const modelContent = diagnosticModelContent(privateData);
        const generationInput = generationInputFromModelContent(modelContent, redactEnabled);
        const generationOutput = generationOutputFromModelContent(modelContent, redactEnabled);
        const sessionKey = diagnosticSessionKey(diagEvt);
        const agentId = diagnosticAgentId(diagEvt, sessionKey);
        const key = TraceContextMap.key(agentId, sessionKey);
        const providerRequestModelCall = isProviderRequestModelCall(diagEvt);
        const providerRequestCallId = providerRequestModelCall
          ? (diagnosticString(diagEvt.callId) ?? diagnosticString(diagEvt.runId))
          : undefined;
        const diagnosticRunId = diagnosticString(diagEvt.runId);

        const existingEntry = contextMap.get(key);
        const matchingRunEntry = diagnosticRunId
          ? (contextMap.findActive(sessionKey, { runId: diagnosticRunId }) ??
            contextMap.findRecent(sessionKey, { runId: diagnosticRunId }))
          : undefined;
        const matchingProviderEntry = providerRequestCallId
          ? (contextMap.findActive(sessionKey, { runId: providerRequestCallId }) ??
            contextMap.findRecent(sessionKey, { runId: providerRequestCallId }))
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
          matchingRunEntry ?? matchingProviderEntry ?? matchingLateAggregateEntry ?? activeEntry;
        const entry =
          reusableEntry ??
          (() => {
            if (existingEntry?.finalized && !providerRequestModelCall) {
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
            });
          })();

        if (privateToolExecution && privateData) {
          recordPrivateToolExecution({ entry, diagEvt, privateData, redactEnabled });
          return;
        }

        if (providerRequestModelCall) {
          const callId = providerRequestCallId ?? "";
          if (!callId) {
            return;
          }
          const providerRequestIndex = claimProviderRequestIndex(entry, callId);

          if (diagEvt.type !== "model.call.started") {
            (entry.providerRequestCompletedCallIds ??= new Set()).add(callId);
            const usage = completeProviderRequestUsage(diagnosticUsage(diagEvt));
            if (usage) {
              (entry.providerRequestUsages ??= new Map()).set(callId, usage);
            }
            updateAuthoritativeProviderUsage(entry);
          }

          if (diagEvt.type === "model.call.started") {
            const claimedGen = claimExistingHookGenerationForProviderRequest(
              entry,
              callId,
              providerRequestIndex,
            );
            if (claimedGen) {
              claimedGen.update({
                model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
                startTime: eventDate(diagEvt, "startTimeMs"),
                ...(generationInput !== undefined ? { input: generationInput } : {}),
                metadata: {
                  provider: String(diagEvt.provider ?? ""),
                  api: diagEvt.api,
                  transport: diagEvt.transport,
                  scope: diagEvt.scope,
                  usageSource: diagEvt.usageSource,
                  promptStats: diagEvt.promptStats,
                  upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
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
              entry.hasProviderRequestGenerations = true;
              entry.pendingGenerations.set(callId, finalizedGen);
              entry.pendingGenIds.set(
                callId,
                generateObservationId(entry.traceId, "gen", finalizedGenIndex),
              );
              return;
            }
            const genIndex = nextProviderRequestGenerationIndex(entry, providerRequestIndex);
            updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId);
            const genId = generateObservationId(entry.traceId, "gen", genIndex);
            const gen = entry.trace.generation({
              id: genId,
              name: `llm-call-${genIndex}`,
              model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
              startTime: eventDate(diagEvt, "startTimeMs"),
              ...(generationInput !== undefined ? { input: generationInput } : {}),
              metadata: {
                provider: String(diagEvt.provider ?? ""),
                api: diagEvt.api,
                transport: diagEvt.transport,
                scope: diagEvt.scope,
                usageSource: diagEvt.usageSource,
                promptStats: diagEvt.promptStats,
                upstreamRequestIdHash: diagEvt.upstreamRequestIdHash,
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
            });
            entry.pendingGenerations.set(callId, gen);
            entry.pendingGenIds.set(callId, genId);
            entry.currentGenerationId = genId;
            return;
          }

          let gen = entry.pendingGenerations.get(callId);
          if (!gen) {
            const claimedGen = claimExistingHookGenerationForProviderRequest(
              entry,
              callId,
              providerRequestIndex,
            );
            if (claimedGen) {
              gen = claimedGen;
            }
          }
          if (!gen) {
            const finalizedGenIndex = entry.finalized ? providerRequestIndex : undefined;
            const finalizedGen = finalizedGenIndex
              ? entry.completedGenerations.get(finalizedGenIndex)
              : undefined;
            const completedProviderGen = entry.completedGenerations.get(providerRequestIndex);
            if (completedProviderGen) {
              gen = completedProviderGen;
              entry.pendingGenIds.set(
                callId,
                generateObservationId(entry.traceId, "gen", providerRequestIndex),
              );
            } else if (finalizedGen && finalizedGenIndex) {
              gen = finalizedGen;
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
                modelContent,
                redactEnabled,
              );
              logger?.debug?.(
                `Langfuse: deferred provider-request completion without matching hook generation (agent=${agentId}, callId=${callId}, index=${providerRequestIndex})`,
              );
              return;
            } else {
              nextProviderRequestGenerationIndex(entry, providerRequestIndex);
              updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId);
            }
            const genId =
              finalizedGenIndex && finalizedGen
                ? generateObservationId(entry.traceId, "gen", finalizedGenIndex)
                : generateObservationId(entry.traceId, "gen", providerRequestIndex);
            const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
            const endTime = eventDate(diagEvt, "endTimeMs");
            if (!gen) {
              gen = entry.trace.generation({
                id: genId,
                name: `llm-call-${providerRequestIndex}`,
                model: qualifiedModel(String(diagEvt.provider ?? ""), String(diagEvt.model ?? "")),
                startTime: new Date(endTime.getTime() - durationMs),
                ...(generationInput !== undefined ? { input: generationInput } : {}),
                metadata: {
                  provider: String(diagEvt.provider ?? ""),
                  api: diagEvt.api,
                  transport: diagEvt.transport,
                  scope: diagEvt.scope,
                  orphanedStart: true,
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
              });
            }
            entry.pendingGenIds.set(callId, genId);
            entry.currentGenerationId = genId;
          }

          const usage = diagnosticUsage(diagEvt);
          const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
          const endTime = eventDate(diagEvt, "endTimeMs");
          const startTime =
            typeof diagEvt.startTimeMs === "number"
              ? eventDate(diagEvt, "startTimeMs")
              : new Date(Math.max(0, endTime.getTime() - durationMs));
          const usageDetails = usageDetailsFromUsage(usage);
          if (diagEvt.type === "model.call.error") {
            gen.update({
              startTime,
              endTime,
              ...(generationInput !== undefined ? { input: generationInput } : {}),
              ...(generationOutput !== undefined ? { output: generationOutput } : {}),
              ...(usageDetails ? { usageDetails } : {}),
              level: "ERROR",
              statusMessage: String(diagEvt.errorCategory ?? "model_call_error"),
              metadata: {
                durationMs,
                scope: diagEvt.scope,
                usageSource: diagEvt.usageSource,
                failureKind: diagEvt.failureKind,
                requestPayloadBytes: diagEvt.requestPayloadBytes,
                responseStreamBytes: diagEvt.responseStreamBytes,
                timeToFirstByteMs: diagEvt.timeToFirstByteMs,
              },
            });
          } else {
            gen.update({
              startTime,
              endTime,
              ...(generationInput !== undefined ? { input: generationInput } : {}),
              ...(generationOutput !== undefined ? { output: generationOutput } : {}),
              ...(usageDetails ? { usageDetails } : {}),
              ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
                ? { costDetails: { total: diagEvt.costUsd } }
                : {}),
              metadata: {
                durationMs,
                scope: diagEvt.scope,
                usageSource: diagEvt.usageSource,
                requestPayloadBytes: diagEvt.requestPayloadBytes,
                responseStreamBytes: diagEvt.responseStreamBytes,
                timeToFirstByteMs: diagEvt.timeToFirstByteMs,
              },
            });
          }
          const genId = entry.pendingGenIds.get(callId);
          const genIndex = generationIndexFromId(entry, genId) ?? entry.llmCallCount;
          entry.completedGenerations.set(genIndex, gen);
          removePendingGenerationAliases(entry, gen, genId);
          updateProviderRequestTraceStats(entry, diagEvt, sessionKey, agentId);
          return;
        }

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
            entry.trace.update({
              output: turn.output
                ? truncatePayload(redactText(turn.output, redactEnabled))
                : undefined,
              metadata: nextMetadata,
            });
          }
          finalizeDiagnosticTraceEntry(entry);
          logger?.info?.(
            `Langfuse: skipped aggregate diagnostic generation because provider-request generations exist (agent=${agentId}, model=${diagEvt.model})`,
          );
          return;
        }

        const usage = diagEvt.usage as Record<string, number> | undefined;
        const durationMs = typeof diagEvt.durationMs === "number" ? diagEvt.durationMs : 0;
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - durationMs);

        // If llm_input hook already created a generation, just update it with usage/output
        // Otherwise create a new generation from diagnostic event data
        if (entry.llmCallCount > 0 && entry.pendingGenerations.size > 0) {
          // llm_input already fired — update the pending generation with usage
          for (const [runId, gen] of entry.pendingGenerations) {
            gen.update({
              endTime,
              output: turn.output ? redactAndTruncateText(turn.output, redactEnabled) : undefined,
              usageDetails: {
                input: usage?.input ?? 0,
                output: usage?.output ?? 0,
                total: usage?.total ?? 0,
                ...(usage?.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
                ...(usage?.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
              },
              ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
                ? { costDetails: { total: diagEvt.costUsd } }
                : {}),
              metadata: {
                durationMs,
              },
            });
            entry.pendingGenerations.delete(runId);
          }
        } else {
          // llm_input didn't fire — create generations from diagnostic event + JSONL.
          // Each assistant message in the session = one LLM call.
          const llmTurns = extractLLMTurns(messagesForLlm);

          if (llmTurns.length === 0) {
            // Fallback: no parseable turns, create single generation as before
            entry.llmCallCount += 1;
            const genInput = generationInputPayload(entry.systemPrompt, turn.input, redactEnabled);
            const genOutput = turn.output
              ? redactAndTruncateText(turn.output, redactEnabled)
              : undefined;
            const gen = entry.trace.generation({
              name: `llm-call-${entry.llmCallCount}`,
              model: qualifiedModel(
                String(diagEvt.provider ?? ""),
                String(diagEvt.model ?? "unknown"),
              ),
              startTime,
              input: genInput,
              ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
                ? { costDetails: { total: diagEvt.costUsd } }
                : {}),
              metadata: {
                provider: String(diagEvt.provider ?? ""),
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
            gen.update({
              endTime,
              output: genOutput,
              usageDetails: {
                input: usage?.input ?? 0,
                output: usage?.output ?? 0,
                total: usage?.total ?? 0,
                ...(usage?.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
                ...(usage?.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
              },
            });
          } else {
            // Create a generation for each LLM turn
            for (let i = 0; i < llmTurns.length; i++) {
              const llmTurn = llmTurns[i];
              entry.llmCallCount += 1;
              const isLast = i === llmTurns.length - 1;

              // Build per-turn input: summarize preceding messages
              const turnInput = llmTurn.inputMessages.map((msg) => {
                const m = msg as Record<string, unknown>;
                const role = String(m.role ?? "unknown");
                const text = extractTextContent(m.content);
                if (role === "toolResult") {
                  return {
                    role,
                    toolName: m.toolName ?? m.toolCallId,
                    content: text.length > 2000 ? text.slice(0, 2000) + "...[truncated]" : text,
                  };
                }
                return {
                  role,
                  content: text.length > 2000 ? text.slice(0, 2000) + "...[truncated]" : text,
                };
              });

              const boundedGenInput = generationInputPayload(
                i === 0 ? entry.systemPrompt : undefined,
                turnInput,
                redactEnabled,
              );
              const genOutput = llmTurn.assistantText
                ? redactAndTruncateText(llmTurn.assistantText, redactEnabled)
                : undefined;

              const gen = entry.trace.generation({
                name: `llm-call-${entry.llmCallCount}`,
                model: qualifiedModel(
                  String(diagEvt.provider ?? ""),
                  String(diagEvt.model ?? "unknown"),
                ),
                input: boundedGenInput,
                metadata: {
                  provider: String(diagEvt.provider ?? ""),
                  ...(llmTurn.toolCalls.length > 0
                    ? {
                        toolCalls: llmTurn.toolCalls.map((t) => t.name),
                      }
                    : {}),
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
              });

              // Only the last generation gets usage/timing (we only have aggregate data)
              if (isLast) {
                gen.update({
                  endTime,
                  output: genOutput,
                  usageDetails: {
                    input: usage?.input ?? 0,
                    output: usage?.output ?? 0,
                    total: usage?.total ?? 0,
                    ...(usage?.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
                    ...(usage?.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
                  },
                  ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
                    ? { costDetails: { total: diagEvt.costUsd } }
                    : {}),
                  metadata: {
                    durationMs,
                  },
                });
              } else {
                gen.end({ output: genOutput });
              }
            }
          }
        }

        // Update trace metadata only if agentEnd hasn't finalized it
        // (Langfuse update is full-replace, not merge)
        if (!entry.finalized) {
          entry.trace.update({
            output: turn.output
              ? truncatePayload(redactText(turn.output, redactEnabled))
              : undefined,
            metadata: {
              sessionKey,
              agentId,
              channelId: diagEvt.channel,
              trigger: "diagnostic",
              timestamp: entry.timestamp,
              stats: {
                durationMs,
                messageCount: messages.length,
                llmCallCount: entry.llmCallCount,
                toolCallCount: entry.toolCallCount,
              },
              ...(entry.lastModel
                ? { lastModel: { provider: entry.lastProvider, model: entry.lastModel } }
                : {}),
              ...(entry.priorConversation !== undefined
                ? { prior_conversation: entry.priorConversation }
                : {}),
              ...(entry.promptMatch && "name" in entry.promptMatch
                ? { prompt: entry.promptMatch }
                : {}),
            },
          });
        }
        finalizeDiagnosticTraceEntry(entry);

        logger?.info?.(
          `Langfuse: generation created (agent=${agentId}, model=${diagEvt.model}, tokens=${usage?.total})`,
        );
      } catch (err) {
        logger?.error?.(
          `Langfuse: diagnostic event handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    },
    {
      captureModelContent: {
        inputMessages: true,
        outputMessages: true,
        toolInputs: true,
        toolOutputs: true,
        systemPrompt: true,
        toolDefinitions: true,
      },
    },
  );

  return unsubscribe;
}
