/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import path from "node:path";
import Langfuse from "langfuse";
import type { LangfuseGenerationClient } from "langfuse";
import { waitForDiagnosticEventsDrained } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveCredentials } from "./config.js";
import type { LangfusePluginConfig } from "./config.js";
import { retryPendingProviderRequestTerminals, subscribeDiagnosticEvents } from "./diagnostics.js";
import { finalizeIncrementalObservations } from "./finalize.js";
import { findMatchingRule } from "./matcher.js";
import { buildObservationsFromEntries } from "./observations.js";
import { PromptManager } from "./prompt-manager.js";
import type { PromptResolveResult } from "./prompt-manager.js";
import { recoverTrace, scanIncompleteTraces, TRACE_RECOVERY_MAX_ATTEMPTS } from "./recovery.js";
import { redactObject, redactText } from "./redact.js";
import {
  bindSdkDeliveryTracker,
  flushSdkDeliveryForBackpressure,
  flushSdkDeliveryThroughWatermark,
  SDK_DELIVERY_TIMEOUT_MS,
  SdkDeliveryTracker,
} from "./sdk-delivery.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import {
  readOpenTraceMarkerByCorrelation,
  readSessionMessagesFromFile,
  readSessionMessagesByIdentity,
  writeObservationEvent,
  writeTraceMarker,
  writeTraceRecoveryMarker,
} from "./session.js";
import {
  completeProviderRequestUsageTotals,
  resolveCurrentGeneration,
  TraceContextMap,
} from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";
import type {
  AgentCtx,
  ToolCtx,
  SessionCtx,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  BeforeAgentRunEvent,
  BeforeAgentRunResult,
  LlmInputEvent,
  LlmOutputEvent,
  AgentEndEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  SessionEndEvent,
  SessionEntry,
  MaybePromise,
} from "./types.js";
import {
  generateTraceId,
  generateObservationId,
  qualifiedModel,
  extractTextContent,
  filterCurrentTurnEntries,
  truncatePayload,
  buildApiMessage,
  buildGenerationOutput,
  usageDetailsFromUsage,
  isTraceableAssistantEntry,
  isTranscriptOnlyAssistantMessage,
  isToolCallBlock,
  normalizeBeforeAgentRunTraceContext,
  normalizeModelCallInput,
} from "./utils.js";

// Re-export for external consumers (e.g. tracer.test.ts)
export { generateTraceId, generateObservationId } from "./utils.js";

export type BeforeMessageWriteEvent = {
  message: unknown;
  sessionKey?: string;
  agentId?: string;
};

// Result type deliberately uses `any` for message to match the upstream
// AgentMessage union without importing it (not exported from plugin SDK).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BeforeMessageWriteResult = {
  block?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message?: any;
};

export type SessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

type TranscriptUpdate = {
  target?: TranscriptUpdateTarget;
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type TranscriptUpdateTarget = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
};

type NormalizedTranscriptUpdate = TranscriptUpdate & {
  target: TranscriptUpdateTarget;
  agentId: string;
  sessionId: string;
  sessionKey: string;
};

type TranscriptTiming = {
  assistantCallIndex?: number;
  startTime?: Date;
  endTime?: Date;
};

export type LangfuseServiceHookHandlers = {
  beforePromptBuild: (
    event: BeforePromptBuildEvent,
    ctx: AgentCtx,
  ) => MaybePromise<BeforePromptBuildResult | void>;
  beforeAgentRun: (event: BeforeAgentRunEvent, ctx: AgentCtx) => BeforeAgentRunResult;
  llmInput: (event: LlmInputEvent, ctx: AgentCtx) => MaybePromise<void>;
  llmOutput: (event: LlmOutputEvent, ctx: AgentCtx) => void;
  beforeToolCall: (event: BeforeToolCallEvent, ctx: ToolCtx) => void;
  afterToolCall: (event: AfterToolCallEvent, ctx: ToolCtx) => void;
  agentEnd: (event: AgentEndEvent, ctx: AgentCtx) => void | Promise<void>;
  sessionEnd: (event: SessionEndEvent, ctx: SessionCtx) => void;
  sessionStart: (event: SessionStartEvent, ctx: SessionCtx) => void;
  beforeMessageWrite: (
    event: BeforeMessageWriteEvent,
    ctx: { agentId?: string; sessionKey?: string },
  ) => BeforeMessageWriteResult | void;
};

export type LangfuseService = OpenClawPluginService & {
  getHookHandlers(): LangfuseServiceHookHandlers;
};

type InternalDiagnosticDeliveryCursor = Readonly<{
  traceId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  sequence: number;
}>;

type InternalDiagnosticDelivery = {
  captureDeliveryCursor: (identity?: {
    traceId?: string;
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
  }) => InternalDiagnosticDeliveryCursor;
  waitForDeliveryCursor: (
    cursor: InternalDiagnosticDeliveryCursor,
    options?: { timeoutMs?: number },
  ) => Promise<
    | { ok: true; deliveredEvents: number }
    | {
        ok: false;
        reason: "cap_exhausted" | "listener_failure" | "producer_incomplete" | "timeout";
        deliveredEvents: number;
      }
  >;
};

function internalDiagnosticDeliveryFromContext(
  ctx: OpenClawPluginServiceContext,
): InternalDiagnosticDelivery | null {
  const diagnostics = ctx.internalDiagnostics as
    | (NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]> &
        Partial<InternalDiagnosticDelivery>)
    | undefined;
  return diagnostics?.captureDeliveryCursor && diagnostics.waitForDeliveryCursor
    ? (diagnostics as NonNullable<typeof diagnostics> & InternalDiagnosticDelivery)
    : null;
}

// ---------------------------------------------------------------------------
// Module-level shared state.
// The gateway may create the plugin registry multiple times (CLI snapshot +
// gateway activation). Hook handlers registered in the first pass must still
// work when start() is called in the second pass, so langfuse/contextMap are
// stored at module scope rather than inside the createLangfuseService closure.
// ---------------------------------------------------------------------------
let langfuse: Langfuse | null = null;
let contextMap: TraceContextMap | null = null;
let disabled = false;
let serviceLogger: PluginLogger | null = null;
let serviceStateDir: string | null = null;
let unsubscribeDiagnostics: (() => void) | null = null;
let unsubscribeTranscript: (() => void) | null = null;
let sdkEventCleanups: Array<() => void> = [];
let promptManager: PromptManager | null = null;
let activeRuntimeEvents: OpenClawPluginApi["runtime"]["events"] | null = null;
let activeServiceOwner: symbol | null = null;
let internalDiagnosticDelivery: InternalDiagnosticDelivery | null = null;
const inFlightRuntimeTasks = new Set<Promise<unknown>>();
const transcriptTaskTails = new Map<string, Promise<void>>();
const transcriptTaskPendingCounts = new Map<string, number>();
const transcriptTaskPendingBytes = new Map<string, number>();
const transcriptQueueLimitWarnedSessions = new Set<string>();
const runtimeTaskDrainWaiters = new Set<() => void>();
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS = 30_000;
const TRANSCRIPT_TASK_MAX_PENDING_PER_SESSION = 128;
const TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION = 8 * 1024 * 1024;

const sdkDeliveryTracker = new SdkDeliveryTracker();

type PendingPromptState = {
  matchInfo?: PromptResolveResult["matchInfo"];
  promptClient?: unknown;
  promptInjection?: { prepend?: string; append?: string };
  createdAt: number;
};

const PENDING_PROMPT_STATE_TTL_MS = 5 * 60 * 1000;
const PENDING_PROMPT_STATE_MAX_ENTRIES = 256;
const pendingPromptStates = new Map<string, PendingPromptState>();

type PendingRootTraceIdentity = {
  key: string;
  traceId: string;
  timestamp: number;
  tags: string[];
  traceMetadata: Record<string, unknown>;
  createdAt: number;
};

const PENDING_ROOT_TRACE_IDENTITY_TTL_MS = 5 * 60 * 1000;
const PENDING_ROOT_TRACE_IDENTITY_MAX_ENTRIES = 256;
const pendingRootTraceIdentities = new Map<string, PendingRootTraceIdentity>();

function trackRuntimeTask<T>(task: Promise<T>): Promise<T> {
  inFlightRuntimeTasks.add(task);
  const remove = () => {
    inFlightRuntimeTasks.delete(task);
    if (inFlightRuntimeTasks.size === 0) {
      for (const resolve of runtimeTaskDrainWaiters) {
        resolve();
      }
      runtimeTaskDrainWaiters.clear();
    }
  };
  void task.then(remove, remove);
  return task;
}

async function waitForRuntimeTasksWithTimeout(): Promise<boolean> {
  if (inFlightRuntimeTasks.size === 0) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      runtimeTaskDrainWaiters.delete(onDrained);
      resolve(drained);
    };
    const onDrained = () => finish(true);
    const timeout = setTimeout(() => finish(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
    runtimeTaskDrainWaiters.add(onDrained);
    if (inFlightRuntimeTasks.size === 0) {
      onDrained();
    }
  });
}

async function waitForDiagnosticDrainWithTimeout(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, SHUTDOWN_DRAIN_TIMEOUT_MS);
    void waitForDiagnosticEventsDrained().then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(false);
        }
      },
    );
  });
}

async function waitForPromiseWithTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    void promise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(false);
        }
      },
    );
  });
}

async function waitForTranscriptTasksWithTimeout(
  sessionKey: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const tail = transcriptTaskTails.get(sessionKey);
    if (!tail) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || !(await waitForPromiseWithTimeout(tail, remainingMs))) {
      return false;
    }
    const nextTail = transcriptTaskTails.get(sessionKey);
    if (!nextTail || nextTail === tail) {
      return true;
    }
  }
}

async function closeTranscriptAdmissionAndDrain(
  entry: TraceContextEntry,
  sessionKey: string | undefined,
  source: string,
): Promise<boolean> {
  // Transcript delivery is synchronous up to this listener. Closing admission
  // before reading the queue tail makes the final drain a stable turn boundary.
  entry.transcriptAdmissionClosed = true;
  if (!sessionKey) {
    return true;
  }
  const drained = await waitForTranscriptTasksWithTimeout(sessionKey, SHUTDOWN_DRAIN_TIMEOUT_MS);
  if (!drained) {
    markObservationBarrierFailed(entry, "transcript_drain_timeout", source, 1);
    serviceLogger?.warn?.(
      `Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for transcript updates in ${source} (traceId=${entry.traceId})`,
    );
  }
  return drained;
}

function estimateTranscriptUpdateBytes(update: NormalizedTranscriptUpdate): number {
  try {
    return Buffer.byteLength(JSON.stringify(update), "utf8");
  } catch {
    return TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION + 1;
  }
}

function enqueueTranscriptTask(
  sessionKey: string,
  retainedBytes: number,
  task: () => Promise<void>,
): boolean {
  const pendingCount = transcriptTaskPendingCounts.get(sessionKey) ?? 0;
  const pendingBytes = transcriptTaskPendingBytes.get(sessionKey) ?? 0;
  if (
    pendingCount >= TRANSCRIPT_TASK_MAX_PENDING_PER_SESSION ||
    retainedBytes > TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION - pendingBytes
  ) {
    if (!transcriptQueueLimitWarnedSessions.has(sessionKey)) {
      transcriptQueueLimitWarnedSessions.add(sessionKey);
      serviceLogger?.warn?.(
        `Langfuse: transcript queue limit reached for session ${sessionKey}; dropping updates until queued work drains`,
      );
    }
    return false;
  }

  transcriptTaskPendingCounts.set(sessionKey, pendingCount + 1);
  transcriptTaskPendingBytes.set(sessionKey, pendingBytes + retainedBytes);
  const previous = transcriptTaskTails.get(sessionKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  transcriptTaskTails.set(sessionKey, current);
  const remove = () => {
    const nextCount = Math.max(0, (transcriptTaskPendingCounts.get(sessionKey) ?? 1) - 1);
    const nextBytes = Math.max(
      0,
      (transcriptTaskPendingBytes.get(sessionKey) ?? retainedBytes) - retainedBytes,
    );
    if (nextCount === 0) {
      transcriptTaskPendingCounts.delete(sessionKey);
      transcriptTaskPendingBytes.delete(sessionKey);
      transcriptQueueLimitWarnedSessions.delete(sessionKey);
    } else {
      transcriptTaskPendingCounts.set(sessionKey, nextCount);
      transcriptTaskPendingBytes.set(sessionKey, nextBytes);
    }
    if (transcriptTaskTails.get(sessionKey) === current) {
      transcriptTaskTails.delete(sessionKey);
    }
  };
  void current.then(remove, remove);
  void trackRuntimeTask(current);
  return true;
}

async function cleanupRuntimeState(): Promise<void> {
  if (unsubscribeTranscript) {
    unsubscribeTranscript();
    unsubscribeTranscript = null;
  }
  const stopDiagnosticSubscription = unsubscribeDiagnostics;
  if (stopDiagnosticSubscription) {
    // Keep the listener installed while the process queue drains. The dispatcher
    // resolves listeners at delivery time, so early unsubscription loses accepted events.
    const drained = await waitForDiagnosticDrainWithTimeout();
    if (!drained) {
      serviceLogger?.warn?.(
        `Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for diagnostic events to drain during shutdown`,
      );
    }
    if (unsubscribeDiagnostics === stopDiagnosticSubscription) {
      stopDiagnosticSubscription();
      unsubscribeDiagnostics = null;
    }
  }
  const runtimeTasksDrained = await waitForRuntimeTasksWithTimeout();
  if (!runtimeTasksDrained) {
    serviceLogger?.warn?.(
      `Langfuse: timed out waiting ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for runtime tasks to drain during shutdown`,
    );
    inFlightRuntimeTasks.clear();
    runtimeTaskDrainWaiters.clear();
  }
  transcriptTaskTails.clear();
  transcriptTaskPendingCounts.clear();
  transcriptTaskPendingBytes.clear();
  transcriptQueueLimitWarnedSessions.clear();
  promptManager = null;
  const previousLangfuse = langfuse;
  langfuse = null;
  if (previousLangfuse) {
    await previousLangfuse.shutdownAsync();
  }
  for (const unsub of sdkEventCleanups) {
    unsub();
  }
  sdkEventCleanups = [];
  sdkDeliveryTracker.clear();
  pendingRootTraceIdentities.clear();
  if (contextMap) {
    contextMap.stopSweep();
    contextMap.clear();
    contextMap = null;
  }
  activeRuntimeEvents = null;
  internalDiagnosticDelivery = null;
}

function extractPromptInjectionState(
  injection: PromptResolveResult["injection"] | undefined,
): { prepend?: string; append?: string } | undefined {
  if (!injection) {
    return undefined;
  }
  const promptInjection = {
    prepend:
      typeof injection.prependSystemContext === "string"
        ? injection.prependSystemContext
        : undefined,
    append:
      typeof injection.appendSystemContext === "string" ? injection.appendSystemContext : undefined,
  };
  return promptInjection.prepend || promptInjection.append ? promptInjection : undefined;
}

function promptStateFromResolveResult(result: PromptResolveResult): PendingPromptState {
  return {
    matchInfo: result.matchInfo,
    promptClient: result.promptClient,
    promptInjection: extractPromptInjectionState(result.injection),
    createdAt: Date.now(),
  };
}

function promptInjectionLogSummary(result: PromptResolveResult): string {
  const injection = result.injection;
  const content =
    injection.systemPrompt ?? injection.prependSystemContext ?? injection.appendSystemContext ?? "";
  const mode =
    result.matchInfo.inject ??
    (injection.systemPrompt
      ? "replace"
      : injection.prependSystemContext
        ? "prepend"
        : injection.appendSystemContext
          ? "append"
          : "unknown");
  return `name=${result.matchInfo.name} mode=${mode} length=${content.length}`;
}

function applyPromptState(entry: TraceContextEntry, state: PendingPromptState): void {
  if (state.matchInfo) {
    entry.promptMatch = state.matchInfo;
  }
  if (state.promptClient !== undefined) {
    entry.promptClient = state.promptClient;
  }
  if (state.promptInjection) {
    entry.promptInjection = state.promptInjection;
  }
}

function prunePendingPromptStates(now = Date.now()): void {
  for (const [key, state] of pendingPromptStates) {
    if (now - state.createdAt > PENDING_PROMPT_STATE_TTL_MS) {
      pendingPromptStates.delete(key);
    }
  }
  while (pendingPromptStates.size > PENDING_PROMPT_STATE_MAX_ENTRIES) {
    const oldestKey = pendingPromptStates.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    pendingPromptStates.delete(oldestKey);
  }
}

function prunePendingRootTraceIdentities(now = Date.now()): void {
  for (const [key, identity] of pendingRootTraceIdentities) {
    if (now - identity.createdAt > PENDING_ROOT_TRACE_IDENTITY_TTL_MS) {
      pendingRootTraceIdentities.delete(key);
    }
  }
  while (pendingRootTraceIdentities.size >= PENDING_ROOT_TRACE_IDENTITY_MAX_ENTRIES) {
    const oldestKey = pendingRootTraceIdentities.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    pendingRootTraceIdentities.delete(oldestKey);
  }
}

function isUserPromptMessage(message: unknown, prompt: string): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  return record.role === "user" && extractTextContent(record.content) === prompt;
}

function buildLlmInputMessages(historyMessages: unknown[], prompt: string): unknown[] {
  if (!prompt) {
    return [...historyMessages];
  }
  const lastHistoryMessage = historyMessages.at(-1);
  if (isUserPromptMessage(lastHistoryMessage, prompt)) {
    return [...historyMessages];
  }
  return [...historyMessages, { role: "user", content: prompt }];
}

function replaceTraceMetadata(
  entry: TraceContextEntry,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  entry.traceMetadata = metadata;
  return metadata;
}

function mergeTraceMetadata(
  entry: TraceContextEntry,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = { ...entry.traceMetadata, ...patch };
  entry.traceMetadata = metadata;
  return metadata;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type TraceUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  reasoningTokens?: number;
};

function finiteUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFieldPresence(usage: TraceUsage | undefined): {
  input: boolean;
  output: boolean;
  cacheRead: boolean;
  cacheWrite: boolean;
  total: boolean;
} {
  return {
    input: finiteUsageNumber(usage?.input) !== undefined,
    output: finiteUsageNumber(usage?.output) !== undefined,
    cacheRead: finiteUsageNumber(usage?.cacheRead) !== undefined,
    cacheWrite: finiteUsageNumber(usage?.cacheWrite) !== undefined,
    total: finiteUsageNumber(usage?.total) !== undefined,
  };
}

function mergeTraceStats(
  entry: TraceContextEntry,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadataRecord(entry.traceMetadata?.stats), ...patch };
}

function safeToolErrorStatusMessage(error: unknown, redactEnabled: boolean): string {
  if (redactEnabled) {
    return "tool returned an error result";
  }
  return typeof error === "string" && error.trim() ? error : "tool returned an error result";
}

function safeAgentErrorStatusMessage(error: unknown, redactEnabled: boolean): string {
  if (redactEnabled) {
    return "agent run failed";
  }
  return typeof error === "string" && error.trim() ? error : "agent run failed";
}

function canonicalAgentEndAssistantText(messages: unknown[]): string | undefined {
  let currentTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).role === "user"
    ) {
      currentTurnStart = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > currentTurnStart; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const assistant = message as Record<string, unknown>;
    if (
      assistant.role !== "assistant" ||
      isTranscriptOnlyAssistantMessage(assistant) ||
      (Array.isArray(assistant.content) &&
        assistant.content.some((block) => isToolCallBlock(block)))
    ) {
      continue;
    }
    const text = extractTextContent(assistant.content);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function llmInputRunIds(entry: TraceContextEntry): Set<string> {
  const extended = entry as TraceContextEntry & { llmInputRunIds?: Set<string> };
  if (!extended.llmInputRunIds) {
    extended.llmInputRunIds = new Set();
  }
  return extended.llmInputRunIds;
}

const MAX_OBSERVATION_RECONCILIATION_REASONS = 8;

function markObservationBarrierFailed(
  entry: TraceContextEntry,
  reason: string,
  source: string,
  count = 1,
): void {
  entry.observationLedgerIncomplete = true;
  const reconciliation = (entry.observationReconciliation ??= { required: true, reasons: [] });
  reconciliation.required = true;
  const existing = reconciliation.reasons.find(
    (candidate) => candidate.reason === reason && candidate.source === source,
  );
  if (existing) {
    existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + count);
    return;
  }
  if (reconciliation.reasons.length < MAX_OBSERVATION_RECONCILIATION_REASONS) {
    reconciliation.reasons.push({ reason, source, count });
  }
}

function sdkDeliveryFailureKey(observationId: string, source: string): string {
  return `sdk:${source}:${observationId}`;
}

function markSdkDeliveryPending(
  entry: TraceContextEntry,
  observationId: string,
  source: string,
): void {
  (entry.pendingObservationDeliveryFailures ??= new Set()).add(
    sdkDeliveryFailureKey(observationId, source),
  );
}

function clearSdkDeliveryPending(
  entry: TraceContextEntry,
  observationId: string,
  source: string,
): void {
  entry.pendingObservationDeliveryFailures?.delete(sdkDeliveryFailureKey(observationId, source));
}

function clearSupersededSdkDeliveryFailures(entry: TraceContextEntry, observationId: string): void {
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

function beginSdkEnqueue(
  entry: TraceContextEntry,
  observationId: string,
  eventType: SdkDeliveryEventType,
  source: string,
): boolean {
  if (entry.deliveryFinalized) {
    serviceLogger?.warn?.(
      `Langfuse: rejected ${source} enqueue after trace delivery finalized (traceId=${entry.traceId}, observationId=${observationId})`,
    );
    return false;
  }
  if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
    clearSdkDeliveryPending(entry, observationId, source);
    return true;
  }
  markSdkDeliveryPending(entry, observationId, source);
  serviceLogger?.warn?.(
    `Langfuse: SDK delivery ticket cap reached before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`,
  );
  return false;
}

function beginRootTraceSdkEnqueue(traceId: string, source: string): boolean {
  if (sdkDeliveryTracker.begin(traceId, traceId, "trace-create")) {
    return true;
  }
  serviceLogger?.warn?.(
    `Langfuse: SDK delivery trace cap reached before ${source} enqueue (traceId=${traceId})`,
  );
  return false;
}

function beginSdkReconstructionEnqueue(
  entry: TraceContextEntry,
  observationId: string,
  eventType: SdkDeliveryEventType,
  source: string,
): boolean {
  if (!beginSdkEnqueue(entry, observationId, eventType, source)) {
    return false;
  }
  // A fallback recreates the complete observation with the same stable ID, so
  // earlier rejected SDK operations for that observation are no longer pending.
  clearSupersededSdkDeliveryFailures(entry, observationId);
  return true;
}

async function beginSdkEnqueueWithBackpressure(
  entry: TraceContextEntry,
  observationId: string,
  eventType: SdkDeliveryEventType,
  source: string,
): Promise<boolean> {
  if (entry.deliveryFinalized) {
    serviceLogger?.warn?.(
      `Langfuse: rejected ${source} enqueue after trace delivery finalized (traceId=${entry.traceId}, observationId=${observationId})`,
    );
    return false;
  }
  if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
    clearSdkDeliveryPending(entry, observationId, source);
    return true;
  }
  markSdkDeliveryPending(entry, observationId, source);
  const client = langfuse;
  if (!client) {
    markObservationBarrierFailed(entry, "delivery_ticket_cap", "langfuse-sdk-ticket");
    return false;
  }

  const watermark = sdkDeliveryTracker.watermark(entry.traceId);
  try {
    const delivery =
      watermark > 0
        ? await flushSdkDeliveryThroughWatermark(
            client,
            sdkDeliveryTracker,
            entry.traceId,
            watermark,
          )
        : await flushSdkDeliveryForBackpressure(client, sdkDeliveryTracker);
    if (!delivery.ok) {
      markObservationBarrierFailed(entry, "delivery_drain_failed", "langfuse-sdk-ticket");
      serviceLogger?.warn?.(
        `Langfuse: ${delivery.reason} while draining SDK delivery tickets before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`,
      );
      return false;
    }
  } catch (err) {
    markObservationBarrierFailed(entry, "delivery_drain_failed", "langfuse-sdk-ticket");
    serviceLogger?.warn?.(
      `Langfuse: failed to drain SDK delivery tickets before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId}): ${String(err)}`,
    );
    return false;
  }

  if (sdkDeliveryTracker.begin(entry.traceId, observationId, eventType)) {
    clearSdkDeliveryPending(entry, observationId, source);
    return true;
  }
  markObservationBarrierFailed(entry, "delivery_ticket_cap", "langfuse-sdk-ticket");
  serviceLogger?.warn?.(
    `Langfuse: SDK delivery ticket cap remained exhausted before ${source} enqueue (traceId=${entry.traceId}, observationId=${observationId})`,
  );
  return false;
}

async function finalizeTraceDelivery(
  entry: TraceContextEntry,
  agentId: string,
  sessionId: string,
  source: string,
  deliveryTimeoutMs = SDK_DELIVERY_TIMEOUT_MS,
): Promise<boolean> {
  const client = langfuse;
  if (!client) {
    return false;
  }
  // A pending terminal may exist because its trace ticket was the first enqueue
  // rejected at capacity. Drain the owning watermark before retrying that ticket.
  if ((entry.providerRequestPendingTerminalCommits?.size ?? 0) > 0) {
    const capacityWatermark = sdkDeliveryTracker.watermark(entry.traceId);
    try {
      const capacityDelivery =
        capacityWatermark > 0
          ? await flushSdkDeliveryThroughWatermark(
              client,
              sdkDeliveryTracker,
              entry.traceId,
              capacityWatermark,
              deliveryTimeoutMs,
            )
          : await flushSdkDeliveryForBackpressure(client, sdkDeliveryTracker, deliveryTimeoutMs);
      if (!capacityDelivery.ok) {
        serviceLogger?.warn?.(
          `Langfuse: ${capacityDelivery.reason} while draining SDK capacity before pending provider usage retry in ${source} (traceId=${entry.traceId}), skipping end marker`,
        );
        return false;
      }
    } catch (err) {
      serviceLogger?.warn?.(
        `Langfuse: failed to drain SDK capacity before pending provider usage retry in ${source} (traceId=${entry.traceId}): ${String(err)}`,
      );
      return false;
    }
  }
  if (
    !retryPendingProviderRequestTerminals(
      entry,
      (_traceId, observationId, eventType, enqueueSource) =>
        beginSdkEnqueue(entry, observationId, eventType, enqueueSource),
    )
  ) {
    serviceLogger?.warn?.(
      `Langfuse: pending provider usage could not be enqueued in ${source} (traceId=${entry.traceId}), skipping end marker`,
    );
    return false;
  }
  const deliveryWatermark = sdkDeliveryTracker.watermark(entry.traceId);
  try {
    const delivery = await flushSdkDeliveryThroughWatermark(
      client,
      sdkDeliveryTracker,
      entry.traceId,
      deliveryWatermark,
      deliveryTimeoutMs,
    );
    if (!delivery.ok) {
      serviceLogger?.warn?.(
        `Langfuse: ${delivery.reason} in ${source} (traceId=${entry.traceId}), skipping end marker`,
      );
      return false;
    }
    if (
      entry.observationLedgerIncomplete ||
      (entry.pendingObservationDeliveryFailures?.size ?? 0) > 0
    ) {
      serviceLogger?.warn?.(
        `Langfuse: observation ledger/reconciliation incomplete in ${source} (traceId=${entry.traceId}), skipping end marker`,
      );
      return false;
    }
    if (
      !writeTraceMarker(serviceStateDir, agentId, sessionId, "end", entry.traceId, serviceLogger)
    ) {
      markObservationBarrierFailed(entry, "trace_end_marker_failed", source);
      return false;
    }
    entry.deliveryFinalized = true;
    return true;
  } catch (flushErr: unknown) {
    serviceLogger?.warn?.(
      `Langfuse: flushAsync failed in ${source} (traceId=${entry.traceId}), skipping end marker — ${String(flushErr)}`,
    );
    return false;
  }
}

function completeTraceFinalization(entry: TraceContextEntry): void {
  sdkDeliveryTracker.completeTrace(entry.traceId, {
    preservePending: !entry.deliveryFinalized,
  });
  entry.finalizationInProgress = false;
  entry.finalizationDiagnosticSequence = undefined;
}

async function finalizeTraceDeliveryWithinReplyBudget(
  entry: TraceContextEntry,
  agentId: string,
  sessionId: string,
  source: string,
): Promise<boolean> {
  const deliveryTask = (async () => {
    if (
      await finalizeTraceDelivery(
        entry,
        agentId,
        sessionId,
        source,
        BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS,
      )
    ) {
      return true;
    }
    serviceLogger?.warn?.(
      `Langfuse: retrying final delivery once in ${source} (traceId=${entry.traceId})`,
    );
    return await finalizeTraceDelivery(
      entry,
      agentId,
      sessionId,
      `${source}-retry`,
      BACKGROUND_TRACE_DELIVERY_TIMEOUT_MS,
    );
  })();
  if (await waitForPromiseWithTimeout(deliveryTask, SHUTDOWN_DRAIN_TIMEOUT_MS)) {
    return false;
  }
  serviceLogger?.warn?.(
    `Langfuse: delivery exceeded ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms in ${source}; continuing in background (traceId=${entry.traceId})`,
  );
  void trackRuntimeTask(
    deliveryTask
      .catch((error) => {
        serviceLogger?.warn?.(
          `Langfuse: background delivery failed in ${source} (traceId=${entry.traceId}) — ${String(error)}`,
        );
        return false;
      })
      .finally(() => completeTraceFinalization(entry)),
  );
  return true;
}

function appendObservationEventOrMark(
  entry: TraceContextEntry,
  agentId: string,
  sessionId: string,
  event: Parameters<typeof writeObservationEvent>[3],
  source: string,
): boolean {
  const written = writeObservationEvent(serviceStateDir, agentId, sessionId, event, serviceLogger);
  if (!written) {
    markObservationBarrierFailed(entry, "identity_ledger_append_failed", source);
    serviceLogger?.warn?.(
      `Langfuse: buffered observation because identity ledger append failed (traceId=${entry.traceId}, observationId=${event.id})`,
    );
  }
  return written;
}

/**
 * Creates the Langfuse plugin service with full tracing and prompt management.
 */
export function createLangfuseService(
  config: LangfusePluginConfig,
  logger?: PluginLogger,
  pluginRuntime?: Pick<OpenClawPluginApi["runtime"], "events">,
): LangfuseService {
  serviceLogger = logger ?? null;
  const serviceOwner = Symbol("openclaw-langfuse-service");
  let ownsActiveRuntime = false;

  const redactEnabled = config.tracing?.redact !== false;
  const tracingEnabled = config.tracing?.enabled !== false;

  function getEntry(agentId?: string, sessionKey?: string): TraceContextEntry | undefined {
    return contextMap?.get(TraceContextMap.key(agentId, sessionKey));
  }

  function reserveRootTraceIdentity(
    ctx: AgentCtx,
    metadataSource?: string,
  ): PendingRootTraceIdentity | undefined {
    const primaryKey = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
    const runKey = `${primaryKey}\u0000${ctx.runId ?? "unknown"}`;
    const existing =
      pendingRootTraceIdentities.get(runKey) ??
      (ctx.runId ? pendingRootTraceIdentities.get(`${primaryKey}\u0000unknown`) : undefined);
    if (existing) {
      return existing;
    }
    prunePendingRootTraceIdentities();

    const persistedMarker = readOpenTraceMarkerByCorrelation(
      serviceStateDir,
      ctx.agentId ?? "unknown",
      ctx.sessionId ?? "",
      runKey,
    );
    const timestamp = persistedMarker?.timestamp ?? Date.now();
    const traceId =
      persistedMarker?.traceId ?? generateTraceId(ctx.sessionKey ?? "unknown", timestamp);
    const tags = [ctx.agentId, ctx.channelId, ...(config.tracing?.tags ?? [])].filter(
      (tag): tag is string => Boolean(tag),
    );
    const traceMetadata: Record<string, unknown> = {
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      channelId: ctx.channelId,
      trigger: ctx.trigger,
      timestamp,
      ...(metadataSource ? { source: metadataSource } : {}),
    };
    if (
      !persistedMarker &&
      !writeTraceMarker(
        serviceStateDir,
        ctx.agentId ?? "unknown",
        ctx.sessionId ?? "",
        "start",
        traceId,
        serviceLogger,
        { correlationKey: runKey },
      )
    ) {
      return undefined;
    }
    const identity = {
      key: runKey,
      traceId,
      timestamp,
      tags,
      traceMetadata,
      createdAt: Date.now(),
    };
    pendingRootTraceIdentities.set(runKey, identity);
    return identity;
  }

  function materializeRootTrace(
    ctx: AgentCtx,
    identity: PendingRootTraceIdentity,
    enqueueSource: string,
    runId?: string,
  ): TraceContextEntry | undefined {
    if (!langfuse || !contextMap || !beginRootTraceSdkEnqueue(identity.traceId, enqueueSource)) {
      return undefined;
    }
    const trace = langfuse.trace({
      id: identity.traceId,
      name: ctx.agentId ?? "agent",
      sessionId: ctx.sessionKey,
      tags: identity.tags,
      metadata: identity.traceMetadata,
    });
    const entry: TraceContextEntry = {
      trace,
      traceId: identity.traceId,
      traceMetadata: identity.traceMetadata,
      llmCallCount: 0,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      ...(runId ? { runIds: new Set([runId]) } : {}),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: identity.timestamp,
      timestamp: identity.timestamp,
      sessionId: ctx.sessionId,
    };
    contextMap.create(TraceContextMap.key(ctx.agentId, ctx.sessionKey), entry);
    pendingRootTraceIdentities.delete(identity.key);
    hydratePendingPromptState(ctx, entry);
    return entry;
  }

  function codexRolloutOwnsToolSpans(entry: TraceContextEntry): boolean {
    return (
      entry.lastProvider?.trim().toLowerCase() === "codex" &&
      (entry.hasProviderRequestGenerations === true ||
        entry.providerRequestAugmentedHookGenerations === true)
    );
  }

  function codexRolloutMayOwnToolSpans(entry: TraceContextEntry): boolean {
    return (
      codexRolloutOwnsToolSpans(entry) ||
      (unsubscribeDiagnostics !== null && entry.lastProvider?.trim().toLowerCase() === "codex")
    );
  }

  function shouldDeferCodexTranscriptToolSpans(entry: TraceContextEntry): boolean {
    return (
      codexRolloutOwnsToolSpans(entry) || (!entry.finalized && codexRolloutMayOwnToolSpans(entry))
    );
  }

  function rememberPromptState(ctx: AgentCtx, state: PendingPromptState): void {
    prunePendingPromptStates();
    const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
    const entry = getEntry(ctx.agentId, ctx.sessionKey);
    if (entry && !entry.finalized) {
      applyPromptState(entry, state);
      pendingPromptStates.delete(key);
      return;
    }
    pendingPromptStates.delete(key);
    pendingPromptStates.set(key, state);
    prunePendingPromptStates();
  }

  function hydratePendingPromptState(ctx: AgentCtx, entry: TraceContextEntry): void {
    prunePendingPromptStates();
    const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
    const state = pendingPromptStates.get(key);
    if (!state) {
      return;
    }
    applyPromptState(entry, state);
    pendingPromptStates.delete(key);
  }

  const handlers: LangfuseServiceHookHandlers = {
    // before_prompt_build: capture system prompt and record prompt match info
    async beforePromptBuild(
      event: BeforePromptBuildEvent,
      ctx: AgentCtx,
    ): Promise<BeforePromptBuildResult | void> {
      if (disabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      // Note: event.prompt here is the user's message, NOT the system prompt.
      // The actual system prompt is captured later in llmInput via event.systemPrompt.
      serviceLogger?.debug?.(
        `Langfuse: beforePromptBuild — entry=${entry ? "found" : "null"} prompt=${event.prompt ? `${event.prompt.length}chars` : "empty"}`,
      );

      // Prompt injection MUST work even before entry exists because beforePromptBuild fires first.
      // Use resolveSync for synchronous injection, fall back to async resolve for cache population.
      if (promptManager) {
        const agentId = ctx.agentId ?? "unknown";
        const syncResult = promptManager.resolveSync(agentId, {
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          sessionKey: ctx.sessionKey,
          trigger: ctx.trigger,
        });
        serviceLogger?.debug?.(
          `Langfuse: resolveSync(${agentId}) → ${syncResult ? `hit: ${syncResult.matchInfo.name}` : "miss"}`,
        );
        if (syncResult) {
          serviceLogger?.info?.(
            `Langfuse: prompt injection ${promptInjectionLogSummary(syncResult)}`,
          );
          rememberPromptState(ctx, promptStateFromResolveResult(syncResult));
          return syncResult.injection;
        }
        try {
          const result = await promptManager.resolve(agentId, {
            agentId: ctx.agentId,
            channelId: ctx.channelId,
            sessionKey: ctx.sessionKey,
            trigger: ctx.trigger,
          });
          if (result) {
            serviceLogger?.info?.(
              `Langfuse: prompt injection ${promptInjectionLogSummary(result)}`,
            );
            rememberPromptState(ctx, promptStateFromResolveResult(result));
            return result.injection;
          }
        } catch {
          // PromptManager degrades to undefined, but keep the hook non-fatal if that changes.
        }
      } else if (config.prompts?.length) {
        // Fallback: record match info without prompt client
        const agentId = ctx.agentId ?? "unknown";
        const rule = findMatchingRule(agentId, config.prompts);
        if (rule) {
          rememberPromptState(ctx, {
            matchInfo: {
              name: rule.langfusePrompt,
              version: rule.version,
              label: rule.label,
              inject: rule.inject,
              matchRule: rule.match,
            },
            createdAt: Date.now(),
          });
        }
      }

      return undefined;
    },

    // before_agent_run: establish the canonical root input/context before inference.
    beforeAgentRun(event: BeforeAgentRunEvent, ctx: AgentCtx): BeforeAgentRunResult {
      try {
        if (disabled || !tracingEnabled || !langfuse || !contextMap) {
          return { outcome: "pass" };
        }

        const existingKey = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
        let entry = contextMap.get(existingKey);
        if (entry?.finalized) {
          entry = undefined;
        }
        if (!entry) {
          const identity = reserveRootTraceIdentity(ctx);
          if (!identity) {
            return { outcome: "pass" };
          }
          entry = materializeRootTrace(ctx, identity, "before_agent_run trace", ctx.runId);
          if (!entry) {
            return { outcome: "pass" };
          }
          serviceLogger?.info?.(
            `Langfuse: trace created (agent=${ctx.agentId}, traceId=${entry.traceId})`,
          );
        }

        const projection = normalizeBeforeAgentRunTraceContext({
          prompt: event.prompt,
          systemPrompt: event.systemPrompt,
          ...(event.priorMessages !== undefined ? { priorMessages: event.priorMessages } : {}),
          redactEnabled,
        });
        entry.rootInput = projection.rootInput;
        entry.systemPrompt = event.systemPrompt;
        entry.priorConversation = projection.priorConversation;
        entry.modelContextMetadata = projection.metadata;
        const metadata = mergeTraceMetadata(entry, projection.metadata);
        if (
          beginSdkEnqueue(entry, entry.traceId, "trace-create", "before_agent_run trace update")
        ) {
          entry.trace.update({
            input: projection.rootInput,
            metadata,
          });
        }
      } catch (error) {
        serviceLogger?.warn?.(`Langfuse: before_agent_run tracing failed open — ${String(error)}`);
      }
      return { outcome: "pass" };
    },

    // llm_input: store model/provider/systemPrompt on entry (generation created in agent_end)
    llmInput(event: LlmInputEvent, ctx: AgentCtx): void {
      if (disabled || !tracingEnabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      let entry = contextMap.get(key);

      // Finalized entries stay addressable by traceId for late transcript repair.
      // The composite context map can add the new turn without deleting them.
      if (entry?.finalized) {
        entry = undefined;
      }

      // Create the trace on demand when the lifecycle hook did not materialize one.
      if (!entry) {
        const identity = reserveRootTraceIdentity(ctx, "llm_input-fallback");
        if (!identity) {
          return;
        }
        entry = materializeRootTrace(ctx, identity, "llm_input fallback trace", event.runId);
        if (!entry) {
          return;
        }
        serviceLogger?.info?.(
          `Langfuse: trace created from llm_input fallback (agent=${ctx.agentId}, traceId=${entry.traceId})`,
        );
      }

      // Store systemPrompt from the first llm_input call only; subsequent calls in the same
      // turn reuse the same system prompt so we avoid overwriting with a post-injection version.
      if (event.systemPrompt && !entry.systemPrompt) {
        entry.systemPrompt = event.systemPrompt;
      }
      entry.lastModel = event.model;
      entry.lastProvider = event.provider;
      entry.sessionId = ctx.sessionId;
      (entry.runIds ??= new Set()).add(event.runId);

      const seenLlmInputRunIds = llmInputRunIds(entry);
      if (seenLlmInputRunIds.has(event.runId)) {
        serviceLogger?.debug?.(`Langfuse: skipped duplicate llmInput for runId=${event.runId}`);
        return;
      }

      if (entry.hasProviderRequestGenerations) {
        serviceLogger?.debug?.(
          `Langfuse: skipped llmInput generation because provider-request diagnostics own this trace (runId=${event.runId})`,
        );
        return;
      }
      seenLlmInputRunIds.add(event.runId);

      // --- Incremental generation creation ---
      entry.llmCallCount += 1;
      const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
      const model = qualifiedModel(event.provider, event.model);
      const startTime = new Date();

      // Normalize the provider input into stable trace context plus this call's
      // delta. The same contract is used by Codex diagnostics and recovery.
      const historyMsgs = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      const allMessages = buildLlmInputMessages(historyMsgs, event.prompt);
      const canonicalMessages = allMessages
        .map((message) => buildApiMessage(message as Record<string, unknown>))
        .filter((message) => (message as Record<string, unknown>).role !== "system");
      const normalizedInput = normalizeModelCallInput({
        model: event.model,
        systemPrompt: entry.systemPrompt,
        messages: canonicalMessages,
        previousMessages: entry.previousModelInputMessages,
        ...(entry.previousModelInputMessages === undefined && typeof entry.rootInput === "string"
          ? { firstGenerationInput: entry.rootInput }
          : {}),
        redactEnabled,
      });
      entry.previousModelInputMessages = normalizedInput.nextMessages;
      entry.lastHistoryLength = allMessages.length;
      if (Object.keys(normalizedInput.traceMetadata).length > 0) {
        entry.modelContextMetadata = {
          ...normalizedInput.traceMetadata,
          ...entry.modelContextMetadata,
        };
        if (
          entry.priorConversation === undefined &&
          normalizedInput.priorConversation !== undefined
        ) {
          entry.priorConversation = normalizedInput.priorConversation;
        }
        const metadata = mergeTraceMetadata(entry, entry.modelContextMetadata);
        if (
          !beginSdkEnqueue(
            entry,
            entry.traceId,
            "trace-create",
            "llm_input model context trace update",
          )
        ) {
          return;
        }
        entry.modelContextMetadataPublished = true;
        entry.trace.update({ metadata });
      }
      const genInput = normalizedInput.generationInput;

      if (
        !appendObservationEventOrMark(
          entry,
          ctx.agentId ?? "unknown",
          ctx.sessionId ?? "",
          {
            e: "gen-start",
            traceId: entry.traceId,
            id: genId,
            llmCall: entry.llmCallCount,
            model,
            ts: startTime.toISOString(),
          },
          "llm_input",
        )
      ) {
        return;
      }
      if (!beginSdkEnqueue(entry, genId, "generation-create", "llm_input generation")) {
        return;
      }
      const generation = entry.trace.generation({
        id: genId,
        name: `llm-call-${entry.llmCallCount}`,
        model,
        startTime,
        input: genInput,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
        metadata: { provider: event.provider, model: event.model },
      });
      entry.pendingGenerations.set(event.runId, generation);
      entry.pendingGenIds.set(event.runId, genId);
      entry.currentGenerationId = genId;
      serviceLogger?.debug?.(
        `Langfuse: created generation ${genId} (llm-call-${entry.llmCallCount}) at llmInput`,
      );
    },

    // llm_output: update pending generation with endTime, usage, output
    llmOutput(event: LlmOutputEvent, ctx: AgentCtx): void {
      if (disabled || !tracingEnabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      // Always store for agentEnd fallback
      entry.storedUsage = event.usage;
      entry.storedOutput = event.assistantTexts.join("\n");
      entry.lastModel = event.model;
      entry.lastProvider = event.provider;
      (entry.runIds ??= new Set()).add(event.runId);

      if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
        serviceLogger?.debug?.(
          `Langfuse: skipped aggregate llmOutput because provider-request diagnostics own this trace (runId=${event.runId})`,
        );
        return;
      }

      // --- Incremental generation update ---
      // Two-phase usage strategy: set usageDetails here for real-time Langfuse display,
      // then agentEnd corrects with authoritative JSONL data (adds costDetails, stopReason,
      // errorMessage that are only available from JSONL).
      const pendingGen = entry.pendingGenerations.get(event.runId);
      if (pendingGen) {
        const endTime = new Date();
        // Best-effort output for real-time display. buildGenerationOutput handles both
        // Anthropic tool_use and OpenClaw toolCall formats. For tool_use responses,
        // event.lastAssistant is typically undefined so output stays unset here;
        // finalize section 1 (orphan handler) sets it from JSONL ground truth.
        const lastAssistantContent = event.lastAssistant
          ? ((event.lastAssistant as Record<string, unknown>).content ?? event.lastAssistant)
          : undefined;
        const output = lastAssistantContent
          ? buildGenerationOutput(lastAssistantContent, redactEnabled)
          : undefined;
        // Only include output if meaningful — empty string gets converted to null by Langfuse
        const truncatedOutput =
          output !== undefined && output !== null && output !== ""
            ? truncatePayload(output)
            : undefined;
        const eu = event.usage;
        const usageDetails = usageDetailsFromUsage(eu as Record<string, number> | undefined);
        entry.lastGenerationEndTime = endTime;
        const genId = entry.pendingGenIds.get(event.runId);
        if (
          genId &&
          !appendObservationEventOrMark(
            entry,
            ctx.agentId ?? "unknown",
            ctx.sessionId ?? "",
            { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
            "llm_output",
          )
        ) {
          return;
        }
        if (
          !beginSdkEnqueue(
            entry,
            genId ?? entry.traceId,
            "generation-update",
            "llm_output generation update",
          )
        ) {
          return;
        }
        pendingGen.update({
          endTime,
          ...(truncatedOutput !== undefined ? { output: truncatedOutput } : {}),
          // Set usageDetails here (single update) so cache tokens are included.
          // Splitting into two update() calls risks the second being dropped by the SDK.
          ...(usageDetails ? { usageDetails } : {}),
          metadata: {
            provider: event.provider,
            model: event.model,
          },
        });
        entry.pendingGenerations.delete(event.runId);
        // Store completed generation client for agentEnd metadata/costDetails correction
        entry.completedGenerations.set(entry.llmCallCount, pendingGen);
        if (genId) {
          (entry.completedGenerationIds ??= new Map()).set(entry.llmCallCount, genId);
        }
        applyDeferredProviderRequestCompletion(entry, entry.llmCallCount, pendingGen);

        entry.pendingGenIds.delete(event.runId);
        serviceLogger?.debug?.(`Langfuse: updated generation at llmOutput (runId=${event.runId})`);
        // No flush here — agentEnd handles the final flush after metadata correction (step 1b).
      } else {
        serviceLogger?.debug?.(
          `Langfuse: llmOutput — no pending generation for runId=${event.runId}, stored for agentEnd fallback`,
        );
      }
    },

    // before_tool_call: create a Langfuse span for the actual OpenClaw tool call.
    // Codex transcript mirror rows stay excluded from LLM generations, but tools
    // still need first-class spans so Langfuse shows the real agent activity.
    beforeToolCall(event: BeforeToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !tracingEnabled || !langfuse) {
        return;
      }
      let entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry && contextMap) {
        entry = contextMap.findActive(ctx.sessionKey);
      }
      if (!entry) {
        return;
      }

      // Codex rollout replay is the only source that knows the provider request
      // which produced this tool call. Creating a live span here fixes a parent
      // that Langfuse cannot change when ordered rollout diagnostics arrive.
      if (codexRolloutMayOwnToolSpans(entry)) {
        return;
      }

      const toolCallId =
        event.toolCallId ?? ctx.toolCallId ?? `${event.toolName}-${entry.toolCallCount + 1}`;
      if (entry.pendingSpans.has(toolCallId) || entry.completedSpanToolCallIds.has(toolCallId)) {
        return;
      }

      const startTime = new Date();
      const spanId = generateObservationId(entry.traceId, "span", toolCallId);
      if (
        !appendObservationEventOrMark(
          entry,
          ctx.agentId ?? "unknown",
          entry.sessionId ?? ctx.sessionId ?? "",
          {
            e: "span-start",
            traceId: entry.traceId,
            id: spanId,
            tool: event.toolName,
            toolCallId,
            ts: startTime.toISOString(),
          },
          "before_tool_call",
        )
      ) {
        return;
      }
      if (!beginSdkEnqueue(entry, spanId, "span-create", "before_tool_call span")) {
        return;
      }
      const spanOwner = resolveCurrentGeneration(entry) ?? entry.trace;
      const span = spanOwner.span({
        id: spanId,
        name: `tool:${event.toolName}`,
        startTime,
        input: redactObject(truncatePayload(event.params), redactEnabled),
        metadata: {
          toolName: event.toolName,
          toolCallId,
        },
      });

      entry.pendingSpans.set(toolCallId, span);
      entry.toolCallCount += 1;
      serviceLogger?.debug?.(`Langfuse: created tool span ${spanId}`);
    },

    // after_tool_call: complete the tool span created by before_tool_call.
    afterToolCall(event: AfterToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !tracingEnabled || !langfuse) {
        return;
      }
      const toolCallId = event.toolCallId ?? ctx.toolCallId;
      let entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry && toolCallId && contextMap) {
        entry = contextMap.findByPendingSpan(toolCallId);
      }
      if (!entry && contextMap) {
        entry = contextMap.findActive(ctx.sessionKey);
      }
      if (!entry) {
        return;
      }

      if (codexRolloutMayOwnToolSpans(entry)) {
        return;
      }

      const resolvedToolCallId =
        toolCallId ?? `${event.toolName}-${Math.max(entry.toolCallCount, 1)}`;
      let span = entry.pendingSpans.get(resolvedToolCallId);
      let spanId = generateObservationId(entry.traceId, "span", resolvedToolCallId);
      if (!span && !entry.completedSpanToolCallIds.has(resolvedToolCallId)) {
        const endMs = Date.now();
        const startTime =
          typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
            ? new Date(Math.max(0, endMs - event.durationMs))
            : new Date(endMs);
        const spanOwner = resolveCurrentGeneration(entry) ?? entry.trace;
        if (
          !appendObservationEventOrMark(
            entry,
            ctx.agentId ?? "unknown",
            entry.sessionId ?? ctx.sessionId ?? "",
            {
              e: "span-start",
              traceId: entry.traceId,
              id: spanId,
              tool: event.toolName,
              toolCallId: resolvedToolCallId,
              ts: startTime.toISOString(),
            },
            "after_tool_call_fallback",
          )
        ) {
          return;
        }
        if (
          !beginSdkReconstructionEnqueue(
            entry,
            spanId,
            "span-create",
            "after_tool_call fallback span",
          )
        ) {
          return;
        }
        span = spanOwner.span({
          id: spanId,
          name: `tool:${event.toolName}`,
          startTime,
          input: redactObject(truncatePayload(event.params), redactEnabled),
          metadata: {
            toolName: event.toolName,
            toolCallId: resolvedToolCallId,
            source: "afterToolCall-fallback",
          },
        });
        entry.pendingSpans.set(resolvedToolCallId, span);
        entry.toolCallCount += 1;
      }
      if (!span) {
        return;
      }

      const endTime = new Date();
      const isError = event.isError === true || Boolean(event.error);
      const outputPayload =
        event.result !== undefined
          ? event.result
          : event.error
            ? { error: event.error }
            : undefined;
      const statusMessage = isError
        ? safeToolErrorStatusMessage(event.error, redactEnabled)
        : undefined;
      if (
        !appendObservationEventOrMark(
          entry,
          ctx.agentId ?? "unknown",
          entry.sessionId ?? ctx.sessionId ?? "",
          {
            e: "span-end",
            traceId: entry.traceId,
            id: spanId,
            ts: endTime.toISOString(),
          },
          "after_tool_call",
        )
      ) {
        return;
      }
      if (!beginSdkEnqueue(entry, spanId, "span-update", "after_tool_call span update")) {
        return;
      }
      span.update({
        endTime,
        output: redactObject(truncatePayload(outputPayload), redactEnabled),
        metadata: {
          toolName: event.toolName,
          toolCallId: resolvedToolCallId,
          ...(isError ? { isError: true } : {}),
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        },
        ...(isError ? { level: "ERROR" as const, statusMessage } : {}),
      });
      entry.pendingSpans.delete(resolvedToolCallId);
      (entry.completedSpans ??= new Map()).set(resolvedToolCallId, span);
      entry.completedSpanToolCallIds.add(resolvedToolCallId);
      serviceLogger?.debug?.(`Langfuse: completed tool span ${spanId}`);
    },

    // agent_end: create per-LLM-call generations from JSONL and finalize the trace
    async agentEnd(event: AgentEndEvent, ctx: AgentCtx): Promise<void> {
      if (disabled || !tracingEnabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      let entry = contextMap.get(key);
      let isRecoveryEntry = false;
      if (!entry) {
        // Restart resilience: if no entry exists (e.g., gateway restarted mid-conversation),
        // create a new trace on the fly so observations are still recorded.
        isRecoveryEntry = true;
        const identity = reserveRootTraceIdentity(ctx, "agent_end-recovery");
        if (!identity) {
          return;
        }
        entry = materializeRootTrace(ctx, identity, "agent_end recovery trace", ctx.runId);
        if (!entry) {
          return;
        }
        serviceLogger?.info?.(
          `Langfuse: trace created from agentEnd recovery (agent=${ctx.agentId}, traceId=${entry.traceId})`,
        );
      }

      const diagnosticCursorIdentity =
        ctx.runId || ctx.sessionKey || ctx.sessionId
          ? {
              ...(ctx.runId ? { runId: ctx.runId } : {}),
              ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
              ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            }
          : undefined;
      const diagnosticCursor = diagnosticCursorIdentity
        ? internalDiagnosticDelivery?.captureDeliveryCursor(diagnosticCursorIdentity)
        : undefined;
      if (entry.deliveryFinalized || entry.finalizationInProgress) {
        serviceLogger?.debug?.(
          `Langfuse: duplicate agentEnd ignored (traceId=${entry.traceId}, deliveryFinalized=${entry.deliveryFinalized === true})`,
        );
        return;
      }
      entry.finalizationDiagnosticSequence = diagnosticCursor?.sequence;
      entry.diagnosticAdmissionClosed = true;
      entry.transcriptAdmissionClosed = true;
      entry.finalizationInProgress = true;
      let finalizationDeferred = false;
      const canonicalRootOutput = canonicalAgentEndAssistantText(
        Array.isArray(event.messages) ? event.messages : [],
      );

      try {
        const agentId = ctx.agentId ?? "unknown";
        const sessionId = entry.sessionId ?? ctx.sessionId ?? "";
        const diagnosticDrain =
          diagnosticCursor && internalDiagnosticDelivery
            ? await internalDiagnosticDelivery.waitForDeliveryCursor(diagnosticCursor, {
                timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
              })
            : { ok: true as const };
        if (!diagnosticDrain.ok) {
          markObservationBarrierFailed(
            entry,
            `diagnostic_drain_${diagnosticDrain.reason}`,
            "agent_end",
            1,
          );
          serviceLogger?.warn?.(
            `Langfuse: diagnostic cursor drain failed before agentEnd reconciliation (reason=${diagnosticDrain.reason}, traceId=${entry.traceId})`,
          );
        }
        // Diagnostics can complete concurrently with transcript persistence. Close
        // this turn's admission before capturing the final queue tail so no callback
        // can race past reconciliation and the delivery watermark.
        await closeTranscriptAdmissionAndDrain(entry, ctx.sessionKey, "agent_end");
        // Read the canonical SQLite transcript and filter to the current turn.
        let allEntries: SessionEntry[] = [];
        let turnEntries: SessionEntry[] = [];
        if (sessionId && ctx.sessionKey) {
          allEntries = await readSessionMessagesByIdentity(
            { agentId, sessionId, sessionKey: ctx.sessionKey },
            serviceLogger,
          );
          turnEntries = filterCurrentTurnEntries(allEntries);
        }

        // Fallback: if the canonical transcript is unavailable, build entries from event.messages.
        if (turnEntries.length === 0 && Array.isArray(event.messages)) {
          serviceLogger?.warn?.(
            `Langfuse: transcript unavailable for agent=${agentId} session=${sessionId}, using event.messages fallback`,
          );
          const now = Date.now();
          const fallbackEntries = (event.messages as Record<string, unknown>[]).map((msg, i) => ({
            timestamp:
              typeof msg.timestamp === "number"
                ? msg.timestamp
                : now - (event.messages.length - i) * 1000,
            message: msg,
          }));
          // Apply turn filtering to fallback entries too — event.messages may contain
          // messages from previous turns in the same session.
          turnEntries = filterCurrentTurnEntries(fallbackEntries);
          if (turnEntries.length === 0) {
            turnEntries = fallbackEntries;
          }
          // Also set allEntries for generation input building
          allEntries = turnEntries;
        }

        // --- Recovery vs Incremental finalizer ---
        // When entry was created on-the-fly in agentEnd (restart resilience),
        // no incremental observations exist — use buildObservationsFromEntries to create all.
        // Otherwise, just complete orphans from the incremental path.

        let lastAssistantText: string | undefined;

        // Use batch creation when no incremental observations were created
        // (recovery entry, or llmInput hooks never fired e.g. event.messages-only path)
        const useBatchCreation = isRecoveryEntry || entry.llmCallCount === 0;
        serviceLogger?.info?.(
          `Langfuse: agentEnd path — useBatchCreation=${useBatchCreation} isRecovery=${isRecoveryEntry} llmCallCount=${entry.llmCallCount} completedGens=${entry.completedGenerations.size} turnEntries=${turnEntries.length}`,
        );

        let batchTotalUsage:
          | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
          | undefined;
        let batchReportedUsageFields:
          | {
              input: boolean;
              output: boolean;
              cacheRead: boolean;
              cacheWrite: boolean;
              total: boolean;
            }
          | undefined;
        let batchHasReportedUsage = false;
        if (useBatchCreation) {
          const obsResult = await buildObservationsFromEntries(
            entry.trace,
            entry.traceId,
            turnEntries,
            allEntries,
            {
              entryTimestamp: entry.timestamp,
              systemPrompt: entry.systemPrompt,
              storedUsage: entry.storedUsage,
              promptClient: entry.promptClient,
              lastModel: entry.lastModel,
              lastProvider: entry.lastProvider,
              redactEnabled,
              langfuseClient: langfuse ?? undefined,
              existingToolCallIds: new Set([
                ...entry.pendingSpans.keys(),
                ...entry.completedSpanToolCallIds,
              ]),
              recordObservationEvent: (observationEvent, source) =>
                appendObservationEventOrMark(entry, agentId, sessionId, observationEvent, source),
              onBeforeSdkEnqueue: async (observationId, eventType, source) => {
                const accepted = await beginSdkEnqueueWithBackpressure(
                  entry,
                  observationId,
                  eventType,
                  source,
                );
                if (accepted) {
                  clearSupersededSdkDeliveryFailures(entry, observationId);
                }
                return accepted;
              },
            },
            serviceLogger,
          );
          entry.llmCallCount = obsResult.llmCallCount;
          entry.completedGenerations = obsResult.completedGenerations;
          entry.completedGenerationIds = obsResult.completedGenerationIds;
          if (Object.keys(obsResult.modelContextMetadata).length > 0) {
            entry.modelContextMetadata = obsResult.modelContextMetadata;
            entry.priorConversation = obsResult.priorConversation;
          }
          if (obsResult.observationBarrierIncomplete) {
            markObservationBarrierFailed(entry, "batch_reconciliation_incomplete", "agent_end");
          }
          applyDeferredProviderRequestCompletions(entry);
          entry.toolCallCount = Math.max(entry.toolCallCount, obsResult.toolCallCount);
          lastAssistantText = obsResult.lastAssistantText;
          if (obsResult.lastModel) {
            entry.lastModel = obsResult.lastModel;
          }
          if (obsResult.lastProvider) {
            entry.lastProvider = obsResult.lastProvider;
          }
          batchTotalUsage = obsResult.totalUsage;
          batchReportedUsageFields = obsResult.reportedUsageFields;
          batchHasReportedUsage = obsResult.hasReportedUsage;
        } else {
          finalizeIncrementalObservations(
            entry,
            turnEntries,
            allEntries,
            agentId,
            sessionId,
            redactEnabled,
            {
              logger: serviceLogger,
              stateDir: serviceStateDir,
              langfuseClient: langfuse,
              onBeforeSdkEnqueue: beginSdkReconstructionEnqueue,
            },
          );
          applyDeferredProviderRequestCompletions(entry);
        }

        // Find last assistant text for trace output (if not set by recovery path)
        if (!lastAssistantText) {
          for (let i = turnEntries.length - 1; i >= 0; i--) {
            const candidate = turnEntries[i];
            if (candidate && isTraceableAssistantEntry(candidate)) {
              const text = extractTextContent(candidate.message.content);
              if (text) {
                lastAssistantText = text;
                break;
              }
            }
          }
        }

        // Aggregate usage across all completed generations (real-time path) or fall back to
        // batch/stored usage for backward compatibility.
        // Aggregate usage from all assistant messages in turnEntries (works for both
        // new real-time path and old JSONL-only path — JSONL always has usage data).
        let aggregatedUsage:
          | { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
          | undefined;
        let aggregatedUsageFields:
          | {
              input: boolean;
              output: boolean;
              cacheRead: boolean;
              cacheWrite: boolean;
              total: boolean;
            }
          | undefined;
        if (turnEntries.length > 0) {
          const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          const fields = {
            input: false,
            output: false,
            cacheRead: false,
            cacheWrite: false,
            total: false,
          };
          for (const te of turnEntries) {
            const msg = te.message;
            if (!isTraceableAssistantEntry(te)) {
              continue;
            }
            const u = msg.usage as Record<string, unknown> | undefined;
            if (!u) {
              continue;
            }
            const input = finiteUsageNumber(u.input);
            const output = finiteUsageNumber(u.output);
            const cacheRead = finiteUsageNumber(u.cacheRead);
            const cacheWrite = finiteUsageNumber(u.cacheWrite);
            const explicitTotal = finiteUsageNumber(u.totalTokens) ?? finiteUsageNumber(u.total);
            if (input !== undefined) {
              acc.input += input;
              fields.input = true;
            }
            if (output !== undefined) {
              acc.output += output;
              fields.output = true;
            }
            if (cacheRead !== undefined) {
              acc.cacheRead += cacheRead;
              fields.cacheRead = true;
            }
            if (cacheWrite !== undefined) {
              acc.cacheWrite += cacheWrite;
              fields.cacheWrite = true;
            }
            if (explicitTotal !== undefined) {
              acc.total += explicitTotal;
              fields.total = true;
            } else if (input !== undefined || output !== undefined) {
              acc.total += (input ?? 0) + (output ?? 0);
              fields.total = true;
            }
          }
          if (Object.values(fields).some(Boolean)) {
            aggregatedUsage = acc;
            aggregatedUsageFields = fields;
          }
          serviceLogger?.info?.(
            `Langfuse: usage from turnEntries — input=${acc.input} output=${acc.output} total=${acc.total}`,
          );
        }
        const providerUsage = completeProviderRequestUsageTotals(entry);
        if (providerUsage) {
          entry.authoritativeProviderUsage = providerUsage;
        }
        const storedUsageFields = usageFieldPresence(entry.storedUsage);
        const usageSrc = providerUsage
          ? providerUsage
          : aggregatedUsage
            ? aggregatedUsage
            : batchTotalUsage && batchHasReportedUsage
              ? batchTotalUsage
              : Object.values(storedUsageFields).some(Boolean)
                ? entry.storedUsage
                : undefined;
        const usageFields = providerUsage
          ? usageFieldPresence(providerUsage)
          : aggregatedUsage
            ? (aggregatedUsageFields ?? usageFieldPresence(aggregatedUsage))
            : batchTotalUsage && batchHasReportedUsage
              ? (batchReportedUsageFields ?? usageFieldPresence(batchTotalUsage))
              : storedUsageFields;
        entry.finalizedUsage = usageSrc ? { ...usageSrc } : undefined;
        const traceUsage = usageSrc as TraceUsage | undefined;
        const finalUsage = usageSrc
          ? {
              ...(usageFields.input ? { inputTokens: traceUsage?.input } : {}),
              ...(usageFields.output ? { outputTokens: traceUsage?.output } : {}),
              ...(usageFields.cacheRead ? { cacheReadInputTokens: traceUsage?.cacheRead } : {}),
              ...(usageFields.cacheWrite ? { cacheWriteInputTokens: traceUsage?.cacheWrite } : {}),
              ...(usageFields.total ? { totalTokens: traceUsage?.total } : {}),
              ...(typeof traceUsage?.reasoningTokens === "number"
                ? { reasoningTokens: traceUsage.reasoningTokens }
                : {}),
            }
          : undefined;

        const finalTraceMetadata = replaceTraceMetadata(entry, {
          sessionId,
          sessionKey: ctx.sessionKey,
          agentId,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
          timestamp: entry.timestamp,
          stats: {
            success: event.success,
            durationMs: event.durationMs,
            messageCount: event.messages?.length ?? turnEntries.length,
            llmCallCount: entry.llmCallCount,
            toolCallCount: entry.toolCallCount,
          },
          usage: finalUsage,
          lastModel:
            entry.lastModel || entry.lastProvider
              ? { provider: entry.lastProvider, model: entry.lastModel }
              : undefined,
          ...entry.modelContextMetadata,
          prompt: truncatePayload(entry.promptMatch),
          ...(entry.observationReconciliation
            ? { observationReconciliation: entry.observationReconciliation }
            : {}),
        });

        // Update trace with structured metadata. The root update is a separate SDK
        // enqueue from observation create/update calls, so it gets its own ticket.
        if (
          beginSdkReconstructionEnqueue(
            entry,
            entry.traceId,
            "trace-create",
            "agent_end trace update",
          )
        ) {
          entry.trace.update({
            input: entry.rootInput,
            ...(canonicalRootOutput
              ? {
                  output: truncatePayload(redactText(canonicalRootOutput, redactEnabled)),
                }
              : {}),
            metadata: finalTraceMetadata,
            ...(event.error
              ? {
                  statusMessage: safeAgentErrorStatusMessage(event.error, redactEnabled),
                  level: "ERROR" as const,
                }
              : {}),
          });
        }

        // Mark as finalized instead of deleting — diagnostic events may still arrive
        // but should not overwrite our clean metadata structure.
        entry.finalized = true;
        finalizationDeferred = await finalizeTraceDeliveryWithinReplyBudget(
          entry,
          agentId,
          sessionId,
          "agentEnd",
        );
      } finally {
        if (!finalizationDeferred) {
          completeTraceFinalization(entry);
        }
      }
    },

    // session_end: log session metadata
    sessionEnd(event: SessionEndEvent, ctx: SessionCtx): void {
      if (disabled || !tracingEnabled) {
        return;
      }
      serviceLogger?.debug?.(
        `Langfuse session end: agentId=${ctx.agentId ?? "unknown"} sessionKey=${ctx.sessionKey ?? "unknown"} messageCount=${event.messageCount} durationMs=${event.durationMs ?? "unknown"}`,
      );
    },

    // session_start: initialize trace context early
    sessionStart(event: SessionStartEvent, ctx: SessionCtx): void {
      if (disabled || !tracingEnabled || !langfuse || !contextMap) {
        return;
      }
      serviceLogger?.debug?.(
        `Langfuse session start: sessionId=${event.sessionId} sessionKey=${ctx.sessionKey ?? "unknown"} resumedFrom=${event.resumedFrom ?? "none"}`,
      );
    },

    // before_message_write: inject langfuse identifiers into JSONL messages
    beforeMessageWrite(
      event: BeforeMessageWriteEvent,
      ctx: { agentId?: string; sessionKey?: string },
    ): BeforeMessageWriteResult | void {
      if (disabled || !tracingEnabled || !contextMap) {
        return;
      }
      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      const msg = event.message as Record<string, unknown> | undefined;
      if (!msg || typeof msg !== "object") {
        return;
      }
      const role = msg.role as string | undefined;
      if (!role) {
        return;
      }

      const metadata = (msg.metadata ?? {}) as Record<string, unknown>;

      if (role === "assistant") {
        if (isTranscriptOnlyAssistantMessage(msg as SessionEntry["message"])) {
          serviceLogger?.debug?.("Langfuse: skipped transcript-only assistant message");
          return;
        }
        metadata._langfuse = {
          traceId: entry.traceId,
          genId: entry.currentGenerationId,
        };
        return { message: { ...msg, metadata } };
      }

      if (role === "toolResult" || role === "tool") {
        const toolCallId = (msg.toolCallId as string) ?? (msg.tool_call_id as string) ?? undefined;
        if (toolCallId) {
          metadata._langfuse = {
            traceId: entry.traceId,
            toolCallId,
          };
          return { message: { ...msg, metadata } };
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Real-time transcript update handler
  // Processes every message published through the canonical transcript event stream.
  // Creates/updates Langfuse observations in real-time, including intermediate
  // LLM calls during tool-use loops that llm_input/llm_output hooks cannot see.
  // ---------------------------------------------------------------------------

  function normalizeTranscriptUpdate(update: TranscriptUpdate): NormalizedTranscriptUpdate | null {
    const sessionKey = update.sessionKey ?? update.target?.sessionKey;
    const sessionFile = update.sessionFile?.trim() || undefined;
    const agentId =
      update.agentId ??
      update.target?.agentId ??
      (sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined);
    const sessionId =
      update.sessionId ?? update.target?.sessionId ?? sessionIdFromTranscriptFile(sessionFile);
    if (!agentId || !sessionId || !sessionKey) {
      return null;
    }
    return {
      ...update,
      agentId,
      sessionId,
      sessionKey,
      ...(sessionFile ? { sessionFile } : {}),
      target: {
        agentId,
        sessionId,
        sessionKey,
      },
    };
  }

  function sessionIdFromTranscriptFile(sessionFile: string | undefined): string | undefined {
    if (!sessionFile) {
      return undefined;
    }
    const basename = path.basename(sessionFile);
    return basename.endsWith(".jsonl") && basename.length > ".jsonl".length
      ? basename.slice(0, -".jsonl".length)
      : undefined;
  }

  function normalizeTranscriptUsage(
    usage: Record<string, unknown> | undefined,
  ): Record<string, number> | undefined {
    if (!usage) {
      return undefined;
    }
    const normalized: Record<string, number> = {};
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
      "totalTokens",
    ] as const) {
      const value = usage[key];
      if (typeof value === "number") {
        normalized[key] = value;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  function persistedLangfuseTraceId(msg: Record<string, unknown>): string | undefined {
    const metadata = metadataRecord(msg.metadata);
    const langfuseMetadata = metadataRecord(metadata._langfuse);
    const traceId = langfuseMetadata.traceId;
    return typeof traceId === "string" && traceId ? traceId : undefined;
  }

  function transcriptAdmissionEntry(
    update: NormalizedTranscriptUpdate,
  ): TraceContextEntry | undefined {
    const message = metadataRecord(update.message);
    const persistedTraceId = persistedLangfuseTraceId(message);
    if (persistedTraceId) {
      return contextMap?.findRecent(update.sessionKey, { traceId: persistedTraceId });
    }
    return contextMap?.findActive(update.sessionKey) ?? contextMap?.findRecent(update.sessionKey);
  }

  function isWithinFinalizedTraceTimeBoundary(
    messageTime: Date | undefined,
    entry: TraceContextEntry,
  ): boolean {
    const messageTimeMs = messageTime?.getTime();
    if (messageTimeMs === undefined) {
      return false;
    }
    const stats = metadataRecord(entry.traceMetadata?.stats);
    const durationMs = typeof stats.durationMs === "number" ? stats.durationMs : undefined;
    const endCandidates = [
      typeof durationMs === "number" ? entry.timestamp + durationMs : undefined,
      entry.lastGenerationEndTime?.getTime(),
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (endCandidates.length === 0) {
      return false;
    }
    const boundaryGraceMs = 1_000;
    return (
      messageTimeMs >= entry.timestamp - boundaryGraceMs &&
      messageTimeMs <= Math.max(...endCandidates) + boundaryGraceMs
    );
  }

  function traceUsageFromEntry(entry: TraceContextEntry):
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
        totalTokens?: number;
      }
    | undefined {
    const usage = entry.authoritativeProviderUsage ?? entry.finalizedUsage ?? entry.storedUsage;
    if (!usage) {
      return undefined;
    }
    const input = finiteUsageNumber(usage.input);
    const output = finiteUsageNumber(usage.output);
    const cacheRead = finiteUsageNumber(usage.cacheRead);
    const cacheWrite = finiteUsageNumber(usage.cacheWrite);
    const explicitTotal = finiteUsageNumber(usage.total);
    const total =
      explicitTotal ??
      (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
    if (
      input === undefined &&
      output === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined &&
      total === undefined
    ) {
      return undefined;
    }
    return {
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
      ...(total !== undefined ? { totalTokens: total } : {}),
    };
  }

  function timestampToDate(value: unknown): Date | undefined {
    let ms: number | undefined;
    if (typeof value === "number" && Number.isFinite(value)) {
      ms = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    } else if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        ms = parsed;
      }
    }
    if (ms === undefined) {
      return undefined;
    }
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  function persistedEntryTimestampToDate(value: unknown): Date | undefined {
    let ms: number | undefined;
    if (typeof value === "number" && Number.isFinite(value)) {
      ms = value;
    } else if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        ms = parsed;
      }
    }
    if (ms === undefined) {
      return undefined;
    }
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }

  function startTimeBeforeEnd(
    startTime: Date | undefined,
    endTime: Date | undefined,
  ): Date | undefined {
    if (!startTime) {
      return undefined;
    }
    if (endTime && startTime.getTime() > endTime.getTime()) {
      return undefined;
    }
    return startTime;
  }

  async function readTranscriptEntriesForUpdate(
    update: NormalizedTranscriptUpdate,
  ): Promise<SessionEntry[]> {
    return update.sessionFile
      ? readSessionMessagesFromFile(update.sessionFile, serviceLogger)
      : await readSessionMessagesByIdentity(update.target, serviceLogger);
  }

  function findPersistedTranscriptEntry(
    update: NormalizedTranscriptUpdate,
    transcriptEntries: SessionEntry[],
  ): SessionEntry | undefined {
    let messageSeq = 0;
    for (const transcriptEntry of transcriptEntries) {
      messageSeq += 1;
      const persistedEntryId =
        transcriptEntry.id ?? (transcriptEntry as SessionEntry & { entryId?: string }).entryId;
      const idMatches = !!update.messageId && persistedEntryId === update.messageId;
      const seqMatches = update.messageSeq !== undefined && messageSeq === update.messageSeq;
      if (idMatches || seqMatches) {
        return transcriptEntry;
      }
    }
    return undefined;
  }

  async function resolveTranscriptTiming(
    update: NormalizedTranscriptUpdate,
    entry: TraceContextEntry,
    msg: Record<string, unknown>,
    preloadedTranscriptEntries?: SessionEntry[],
  ): Promise<TranscriptTiming> {
    const fallbackStartTime = timestampToDate(msg.timestamp);
    if (!update.messageId && update.messageSeq === undefined) {
      return fallbackStartTime ? { startTime: fallbackStartTime } : {};
    }

    const transcriptEntries =
      preloadedTranscriptEntries ?? (await readTranscriptEntriesForUpdate(update));
    if (transcriptEntries.length === 0) {
      return fallbackStartTime ? { startTime: fallbackStartTime } : {};
    }

    let messageSeq = 0;
    let assistantCallIndex = 0;
    for (const transcriptEntry of transcriptEntries) {
      messageSeq += 1;
      const inTraceWindow = transcriptEntry.timestamp >= entry.timestamp - 1000;
      const isAssistant = isTraceableAssistantEntry(transcriptEntry);
      if (inTraceWindow && isAssistant) {
        assistantCallIndex += 1;
      }

      const persistedEntryId =
        transcriptEntry.id ?? (transcriptEntry as SessionEntry & { entryId?: string }).entryId;
      const idMatches = !!update.messageId && persistedEntryId === update.messageId;
      const seqMatches = update.messageSeq !== undefined && messageSeq === update.messageSeq;
      if (!idMatches && !seqMatches) {
        continue;
      }

      const endTime = persistedEntryTimestampToDate(transcriptEntry.timestamp);
      const startTime = startTimeBeforeEnd(
        timestampToDate(transcriptEntry.message.timestamp) ?? fallbackStartTime,
        endTime,
      );
      return {
        ...(inTraceWindow && isAssistant && assistantCallIndex > 0 ? { assistantCallIndex } : {}),
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
      };
    }

    return fallbackStartTime ? { startTime: fallbackStartTime } : {};
  }

  function patchFinalizedTraceFromTranscript(
    entry: TraceContextEntry,
    redactEnabledForUpdate: boolean,
  ): void {
    if (!entry.finalized) {
      return;
    }

    const metadataPatch: Record<string, unknown> = {
      source: "late-transcript-repair",
      stats: mergeTraceStats(entry, {
        llmCallCount: entry.llmCallCount,
        toolCallCount: entry.toolCallCount,
      }),
    };
    const usage = traceUsageFromEntry(entry);
    if (usage) {
      metadataPatch.usage = usage;
    }
    if (entry.lastModel || entry.lastProvider) {
      metadataPatch.lastModel = { provider: entry.lastProvider, model: entry.lastModel };
    }
    if (entry.promptMatch !== undefined) {
      metadataPatch.prompt = entry.promptMatch;
    }

    const traceUpdate: { output?: string; metadata: Record<string, unknown> } = {
      metadata: mergeTraceMetadata(entry, metadataPatch),
    };
    if (entry.storedOutput) {
      traceUpdate.output = String(
        truncatePayload(redactText(entry.storedOutput, redactEnabledForUpdate)),
      );
    }
    if (!beginSdkEnqueue(entry, entry.traceId, "trace-create", "late transcript trace update")) {
      return;
    }
    entry.trace.update(traceUpdate);
  }

  function transcriptToolResultId(msg: Record<string, unknown>): string | undefined {
    return typeof msg.toolCallId === "string"
      ? msg.toolCallId
      : typeof msg.tool_call_id === "string"
        ? msg.tool_call_id
        : undefined;
  }

  function transcriptToolResultOutput(msg: Record<string, unknown>): unknown {
    const content = msg.content;
    if (Array.isArray(content) && content.length === 1) {
      const first = content[0] as Record<string, unknown>;
      if (first && typeof first === "object" && "content" in first) {
        return first.content;
      }
    }
    if ("content" in msg) {
      return msg.content;
    }
    if ("result" in msg) {
      return msg.result;
    }
    return undefined;
  }

  function createTranscriptToolSpan(params: {
    entry: TraceContextEntry;
    agentId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
    startTime: Date;
    redactEnabled: boolean;
    source: string;
  }): void {
    const {
      entry,
      agentId,
      sessionId,
      toolCallId,
      toolName,
      input,
      startTime,
      redactEnabled,
      source,
    } = params;
    if (entry.pendingSpans.has(toolCallId) || entry.completedSpanToolCallIds.has(toolCallId)) {
      return;
    }

    const spanId = generateObservationId(entry.traceId, "span", toolCallId);
    if (
      !appendObservationEventOrMark(
        entry,
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
        source,
      )
    ) {
      return;
    }
    if (!beginSdkEnqueue(entry, spanId, "span-create", `${source} span`)) {
      return;
    }
    const spanOwner = resolveCurrentGeneration(entry) ?? entry.trace;
    const span = spanOwner.span({
      id: spanId,
      name: `tool:${toolName}`,
      startTime,
      input: redactObject(truncatePayload(input), redactEnabled),
      metadata: {
        toolName,
        toolCallId,
        source,
      },
    });
    entry.pendingSpans.set(toolCallId, span);
    entry.toolCallCount += 1;
  }

  function completeTranscriptToolSpan(params: {
    entry: TraceContextEntry;
    agentId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    output: unknown;
    endTime: Date;
    redactEnabled: boolean;
    source: string;
    isError?: boolean;
  }): void {
    const {
      entry,
      agentId,
      sessionId,
      toolCallId,
      toolName,
      output,
      endTime,
      redactEnabled,
      source,
      isError = false,
    } = params;
    if (entry.completedSpanToolCallIds.has(toolCallId)) {
      return;
    }

    let span = entry.pendingSpans.get(toolCallId);
    const spanId = generateObservationId(entry.traceId, "span", toolCallId);
    if (!span) {
      if (
        !appendObservationEventOrMark(
          entry,
          agentId,
          sessionId,
          {
            e: "span-start",
            traceId: entry.traceId,
            id: spanId,
            tool: toolName,
            toolCallId,
            ts: endTime.toISOString(),
          },
          `${source}-fallback-start`,
        )
      ) {
        return;
      }
      if (!beginSdkReconstructionEnqueue(entry, spanId, "span-create", `${source} fallback span`)) {
        return;
      }
      const spanOwner = resolveCurrentGeneration(entry) ?? entry.trace;
      span = spanOwner.span({
        id: spanId,
        name: `tool:${toolName}`,
        startTime: endTime,
        metadata: {
          toolName,
          toolCallId,
          source: `${source}-fallback-start`,
        },
      });
      entry.pendingSpans.set(toolCallId, span);
      entry.toolCallCount += 1;
    }

    if (
      !appendObservationEventOrMark(
        entry,
        agentId,
        sessionId,
        { e: "span-end", traceId: entry.traceId, id: spanId, ts: endTime.toISOString() },
        source,
      )
    ) {
      return;
    }
    if (!beginSdkEnqueue(entry, spanId, "span-update", `${source} span update`)) {
      return;
    }
    span.update({
      endTime,
      output: redactObject(truncatePayload(output), redactEnabled),
      metadata: {
        toolName,
        toolCallId,
        source,
        ...(isError ? { isError: true } : {}),
      },
      ...(isError
        ? { level: "ERROR" as const, statusMessage: "tool returned an error result" }
        : {}),
    });
    entry.pendingSpans.delete(toolCallId);
    (entry.completedSpans ??= new Map()).set(toolCallId, span);
    entry.completedSpanToolCallIds.add(toolCallId);
  }

  function recordTranscriptToolCalls(
    entry: TraceContextEntry,
    update: NormalizedTranscriptUpdate,
    msg: Record<string, unknown>,
    redactEnabledForUpdate: boolean,
    persistedAssistantCompletionTime?: Date,
  ): void {
    if (shouldDeferCodexTranscriptToolSpans(entry)) {
      return;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      return;
    }
    const startTime =
      persistedAssistantCompletionTime ?? timestampToDate(msg.timestamp) ?? new Date();
    for (const block of content as Record<string, unknown>[]) {
      if (!isToolCallBlock(block) || typeof block.id !== "string") {
        continue;
      }
      const toolName = String(block.name ?? "unknown");
      createTranscriptToolSpan({
        entry,
        agentId: update.agentId,
        sessionId: update.sessionId,
        toolCallId: block.id,
        toolName,
        input: block.input ?? block.args ?? block.arguments ?? {},
        startTime,
        redactEnabled: redactEnabledForUpdate,
        source: "transcript-tool-call",
      });
    }
  }

  function recordTranscriptToolResult(
    entry: TraceContextEntry,
    update: NormalizedTranscriptUpdate,
    msg: Record<string, unknown>,
    redactEnabledForUpdate: boolean,
    persistedCompletionTime?: Date,
  ): void {
    if (shouldDeferCodexTranscriptToolSpans(entry)) {
      return;
    }
    const toolCallId = transcriptToolResultId(msg);
    if (!toolCallId) {
      return;
    }
    completeTranscriptToolSpan({
      entry,
      agentId: update.agentId,
      sessionId: update.sessionId,
      toolCallId,
      toolName: typeof msg.toolName === "string" ? msg.toolName : "unknown",
      output: transcriptToolResultOutput(msg),
      endTime: persistedCompletionTime ?? timestampToDate(msg.timestamp) ?? new Date(),
      redactEnabled: redactEnabledForUpdate,
      source: "transcript-tool-result",
      isError: msg.isError === true,
    });
    patchFinalizedTraceFromTranscript(entry, redactEnabledForUpdate);
  }

  function applyDeferredProviderRequestCompletion(
    entry: TraceContextEntry,
    generationIndex: number,
    generation: LangfuseGenerationClient,
  ): void {
    const deferred = entry.deferredProviderRequestCompletions?.get(generationIndex);
    if (!deferred) {
      return;
    }
    const generationId =
      entry.completedGenerationIds?.get(generationIndex) ??
      generateObservationId(entry.traceId, "gen", generationIndex);
    if (
      !beginSdkEnqueue(
        entry,
        generationId,
        "generation-update",
        "provider-request deferred generation update",
      )
    ) {
      return;
    }
    generation.update({
      ...(deferred.startTime ? { startTime: deferred.startTime } : {}),
      endTime: deferred.endTime,
      ...(deferred.input !== undefined ? { input: deferred.input } : {}),
      ...(deferred.output !== undefined ? { output: deferred.output } : {}),
      ...(deferred.usageDetails ? { usageDetails: deferred.usageDetails } : {}),
      ...(deferred.level ? { level: deferred.level } : {}),
      ...(deferred.statusMessage ? { statusMessage: deferred.statusMessage } : {}),
      metadata: {
        ...deferred.metadata,
        source: "provider-request-deferred",
      },
    });
    entry.deferredProviderRequestCompletions?.delete(generationIndex);
  }

  function applyDeferredProviderRequestCompletions(entry: TraceContextEntry): void {
    for (const [generationIndex, generation] of entry.completedGenerations) {
      applyDeferredProviderRequestCompletion(entry, generationIndex, generation);
    }
  }

  function isCurrentTranscriptEntry(
    sessionKey: string,
    entry: TraceContextEntry,
    ownership: "persisted" | "active" | "finalized",
  ): boolean {
    const currentContextMap = contextMap;
    if (disabled || !tracingEnabled || langfuse === null || !currentContextMap) {
      return false;
    }
    if (ownership === "persisted") {
      return currentContextMap.findRecent(sessionKey, { traceId: entry.traceId }) === entry;
    }
    if (ownership === "active") {
      return currentContextMap.findActive(sessionKey) === entry;
    }
    return (
      currentContextMap.findActive(sessionKey) === undefined &&
      currentContextMap.findRecent(sessionKey, { traceId: entry.traceId }) === entry
    );
  }

  async function handleTranscriptUpdate(
    update: NormalizedTranscriptUpdate,
    _redactEnabled: boolean,
  ): Promise<void> {
    if (disabled || !tracingEnabled || !langfuse || !contextMap) {
      return;
    }
    const msg = update.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") {
      return;
    }
    const role = msg.role as string | undefined;
    if (!role) {
      return;
    }
    const transcriptAgentId = update.agentId;
    const transcriptSessionId = update.sessionId;

    // Prefer persisted ownership. Late transcript events can arrive after agentEnd,
    // but finalized repairs must not drift into a newer/older turn sharing sessionKey.
    const sessionKey = update.sessionKey;
    const canRepairLateTranscript =
      role === "assistant" || role === "toolResult" || role === "tool";
    const persistedTraceId = persistedLangfuseTraceId(msg);
    const initialOwnedEntry = persistedTraceId
      ? contextMap.findRecent(sessionKey, { traceId: persistedTraceId })
      : undefined;
    if (persistedTraceId && !initialOwnedEntry) {
      return;
    }
    const initialActiveEntry = persistedTraceId
      ? initialOwnedEntry && !initialOwnedEntry.finalized
        ? initialOwnedEntry
        : undefined
      : contextMap.findActive(sessionKey);
    let preloadedTranscriptEntries: SessionEntry[] | undefined;
    let transcriptBoundaryTime = timestampToDate(msg.timestamp);
    const hasPersistedIdentity = Boolean(update.messageId || update.messageSeq !== undefined);
    const needsLateRepairBoundary =
      !persistedTraceId && !initialActiveEntry && canRepairLateTranscript;
    const needsActiveToolBoundary =
      (role === "toolResult" || role === "tool") && Boolean(initialActiveEntry);
    if (
      !transcriptBoundaryTime &&
      hasPersistedIdentity &&
      (needsLateRepairBoundary || needsActiveToolBoundary)
    ) {
      preloadedTranscriptEntries = await readTranscriptEntriesForUpdate(update);
      const persistedEntry = findPersistedTranscriptEntry(update, preloadedTranscriptEntries);
      transcriptBoundaryTime = persistedEntryTimestampToDate(persistedEntry?.timestamp);
    }
    if (disabled || !tracingEnabled || !langfuse || !contextMap) {
      return;
    }
    const ownedEntry = persistedTraceId
      ? contextMap.findRecent(sessionKey, { traceId: persistedTraceId })
      : undefined;
    if (persistedTraceId && !ownedEntry) {
      return;
    }
    const activeEntry = persistedTraceId
      ? ownedEntry && !ownedEntry.finalized
        ? ownedEntry
        : undefined
      : initialActiveEntry;
    const recentFinalizedEntry =
      !persistedTraceId && !initialActiveEntry && canRepairLateTranscript && transcriptBoundaryTime
        ? contextMap.findRecentFinalized(sessionKey, (candidate) =>
            isWithinFinalizedTraceTimeBoundary(transcriptBoundaryTime, candidate),
          )
        : undefined;
    const entry = ownedEntry ?? activeEntry ?? recentFinalizedEntry;
    const entryOwnership = persistedTraceId
      ? "persisted"
      : entry === activeEntry
        ? "active"
        : "finalized";
    const isInitiallyLateFinalizedTranscript = !!entry?.finalized && canRepairLateTranscript;
    if (
      !entry ||
      entry.deliveryFinalized ||
      (entry.finalized && !isInitiallyLateFinalizedTranscript)
    ) {
      return;
    }

    if (role === "assistant") {
      if (isTranscriptOnlyAssistantMessage(msg as SessionEntry["message"])) {
        if (typeof msg.provider === "string") {
          entry.lastProvider = msg.provider;
        }
        const transcriptTiming = await resolveTranscriptTiming(
          update,
          entry,
          msg,
          preloadedTranscriptEntries,
        );
        if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) {
          return;
        }
        recordTranscriptToolCalls(entry, update, msg, _redactEnabled, transcriptTiming.endTime);
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        serviceLogger?.debug?.("Langfuse: skipping transcript-only assistant row");
        return;
      }

      const transcriptTiming = await resolveTranscriptTiming(
        update,
        entry,
        msg,
        preloadedTranscriptEntries,
      );
      if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) {
        serviceLogger?.debug?.(
          `Langfuse: skipping transcript update after trace replacement (traceId=${entry.traceId})`,
        );
        return;
      }
      const isLateFinalizedAssistant = entry.finalized;
      recordTranscriptToolCalls(entry, update, msg, _redactEnabled, transcriptTiming.endTime);
      const usage = msg.usage as Record<string, unknown> | undefined;
      const model = msg.model as string | undefined;
      const provider = msg.provider as string | undefined;
      const stopReason = msg.stopReason as string | undefined;

      serviceLogger?.info?.(
        `Langfuse: transcript assistant msg — model=${model ?? "?"} stopReason=${stopReason ?? "?"} hasUsage=${!!usage}`,
      );

      // Store usage/output on entry for agent_end trace metadata (mirrors llm_output behavior)
      if (usage) {
        entry.storedUsage = {
          input: (usage.input as number) ?? undefined,
          output: (usage.output as number) ?? undefined,
          cacheRead: (usage.cacheRead as number) ?? undefined,
          cacheWrite: (usage.cacheWrite as number) ?? undefined,
          total: (usage.totalTokens as number) ?? (usage.total as number) ?? undefined,
        };
      }
      if (msg.content) {
        const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
        const texts = contentArr
          .filter(
            (b: unknown) =>
              !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text",
          )
          .map((b: unknown) => (b as Record<string, unknown>).text as string);
        if (texts.length > 0) {
          entry.storedOutput = texts.join("\n");
        }
      }
      if (model) {
        entry.lastModel = model;
      }
      if (provider) {
        entry.lastProvider = provider;
      }

      const normalizedUsage = normalizeTranscriptUsage(usage);
      const usageDetails = usageDetailsFromUsage(normalizedUsage);
      const generationOutput = msg.content
        ? truncatePayload(buildGenerationOutput(msg.content, _redactEnabled))
        : undefined;
      const completedGenIndex = transcriptTiming.assistantCallIndex ?? entry.llmCallCount;
      const completedGen =
        transcriptTiming.assistantCallIndex !== undefined
          ? entry.completedGenerations.get(transcriptTiming.assistantCallIndex)
          : entry.completedGenerations.size >= entry.llmCallCount && entry.llmCallCount > 0
            ? (entry.completedGenerations.get(entry.llmCallCount) ??
              [...entry.completedGenerations.values()].at(-1))
            : undefined;

      if (entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations) {
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        return;
      }

      if (completedGen && completedGenIndex > 0) {
        const genId =
          entry.completedGenerationIds?.get(completedGenIndex) ??
          generateObservationId(entry.traceId, "gen", completedGenIndex);
        if (
          !beginSdkEnqueue(
            entry,
            genId,
            "generation-update",
            "transcript completed generation update",
          )
        ) {
          return;
        }
        completedGen.update({
          ...(completedGenIndex > 1 && transcriptTiming.startTime
            ? { startTime: transcriptTiming.startTime }
            : {}),
          ...(transcriptTiming.endTime ? { endTime: transcriptTiming.endTime } : {}),
          ...(generationOutput !== undefined ? { output: generationOutput } : {}),
          ...(usageDetails ? { usageDetails } : {}),
          metadata: {
            provider,
            model,
            stopReason,
            source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime",
          },
        });
        entry.llmCallCount = Math.max(entry.llmCallCount, completedGenIndex);
        applyDeferredProviderRequestCompletion(entry, completedGenIndex, completedGen);
        if (transcriptTiming.endTime) {
          entry.lastGenerationEndTime = transcriptTiming.endTime;
        }
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        return;
      }

      // If there's a pending generation (created by llm_input but not completed by llm_output),
      // complete it with data from the transcript message.
      const pendingEntries = [...entry.pendingGenerations.entries()];
      const pendingEntry = pendingEntries[0];
      if (pendingEntry) {
        const [runId, pendingGen] = pendingEntry;
        const endTime = transcriptTiming.endTime ?? new Date();
        const pendingGenId = entry.pendingGenIds.get(runId);
        if (
          pendingGenId &&
          !appendObservationEventOrMark(
            entry,
            transcriptAgentId,
            transcriptSessionId,
            { e: "gen-end", traceId: entry.traceId, id: pendingGenId, ts: endTime.toISOString() },
            "transcript-realtime",
          )
        ) {
          return;
        }
        if (
          !beginSdkEnqueue(
            entry,
            pendingGenId ?? entry.traceId,
            "generation-update",
            "transcript pending generation update",
          )
        ) {
          return;
        }
        pendingGen.update({
          ...(completedGenIndex > 1 && transcriptTiming.startTime
            ? { startTime: transcriptTiming.startTime }
            : {}),
          endTime,
          ...(generationOutput !== undefined ? { output: generationOutput } : {}),
          ...(usageDetails ? { usageDetails } : {}),
          metadata: {
            provider,
            model,
            stopReason,
            source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime",
          },
        });
        entry.pendingGenerations.delete(runId);
        const resolvedGenIndex = completedGenIndex > 0 ? completedGenIndex : entry.llmCallCount;
        entry.completedGenerations.set(resolvedGenIndex, pendingGen);
        if (pendingGenId) {
          (entry.completedGenerationIds ??= new Map()).set(resolvedGenIndex, pendingGenId);
        }
        entry.pendingGenIds.delete(runId);
        applyDeferredProviderRequestCompletion(entry, resolvedGenIndex, pendingGen);
        entry.llmCallCount = Math.max(entry.llmCallCount, resolvedGenIndex);
        entry.lastGenerationEndTime = endTime;
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        serviceLogger?.debug?.(
          `Langfuse: transcript completed pending generation (llmCall=${resolvedGenIndex})`,
        );
      } else {
        if (isLateFinalizedAssistant && !transcriptTiming.assistantCallIndex) {
          patchFinalizedTraceFromTranscript(entry, _redactEnabled);
          return;
        }
        if (entry.hasProviderRequestGenerations) {
          patchFinalizedTraceFromTranscript(entry, _redactEnabled);
          return;
        }

        // No pending generation — this is an intermediate LLM call during a tool-use loop
        // that llm_input/llm_output hooks cannot see. Create a new generation from JSONL timing.
        const nextLlmCall =
          transcriptTiming.assistantCallIndex && transcriptTiming.assistantCallIndex > 0
            ? transcriptTiming.assistantCallIndex
            : entry.llmCallCount + 1;
        if (entry.completedGenerations.has(nextLlmCall)) {
          patchFinalizedTraceFromTranscript(entry, _redactEnabled);
          return;
        }
        entry.llmCallCount = Math.max(entry.llmCallCount, nextLlmCall);
        const genId = generateObservationId(entry.traceId, "gen", nextLlmCall);
        const qualModel = model
          ? qualifiedModel(provider ?? "", model)
          : (entry.lastModel ?? "unknown");
        const endTime = transcriptTiming.endTime ?? new Date();
        const startTime =
          startTimeBeforeEnd(transcriptTiming.startTime, endTime) ??
          (entry.lastGenerationEndTime && entry.lastGenerationEndTime.getTime() <= endTime.getTime()
            ? entry.lastGenerationEndTime
            : endTime);

        if (
          !appendObservationEventOrMark(
            entry,
            transcriptAgentId,
            transcriptSessionId,
            {
              e: "gen-start",
              traceId: entry.traceId,
              id: genId,
              llmCall: nextLlmCall,
              model: qualModel,
              ts: startTime.toISOString(),
            },
            "transcript-realtime",
          )
        ) {
          return;
        }
        if (
          !appendObservationEventOrMark(
            entry,
            transcriptAgentId,
            transcriptSessionId,
            { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
            "transcript-realtime",
          )
        ) {
          return;
        }
        if (
          !beginSdkReconstructionEnqueue(entry, genId, "generation-create", "transcript generation")
        ) {
          return;
        }
        const generation = entry.trace.generation({
          id: genId,
          name: `llm-call-${nextLlmCall}`,
          model: qualModel,
          startTime,
          endTime,
          ...(generationOutput !== undefined ? { output: generationOutput } : {}),
          ...(entry.currentGenerationId ? { parentObservationId: entry.currentGenerationId } : {}),
          metadata: {
            provider,
            model,
            stopReason,
            source: isLateFinalizedAssistant ? "late-transcript-repair" : "transcript-realtime",
          },
          ...(usageDetails ? { usageDetails } : {}),
        });
        entry.completedGenerations.set(nextLlmCall, generation);
        (entry.completedGenerationIds ??= new Map()).set(nextLlmCall, genId);
        applyDeferredProviderRequestCompletion(entry, nextLlmCall, generation);
        entry.currentGenerationId = genId;
        entry.lastGenerationEndTime = endTime;
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        serviceLogger?.info?.(
          `Langfuse: transcript created intermediate generation ${genId} (llmCall=${nextLlmCall})`,
        );
      }
    }

    if (role === "toolResult" || role === "tool") {
      if (!isCurrentTranscriptEntry(sessionKey, entry, entryOwnership)) {
        return;
      }
      recordTranscriptToolResult(entry, update, msg, _redactEnabled, transcriptBoundaryTime);
    }
  }

  return {
    id: "openclaw-langfuse",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      // Plugin discovery can construct the service more than once in one process.
      // Replacing the shared client here would orphan observations for an active turn.
      const runtimeEvents = pluginRuntime?.events ?? null;
      if (langfuse && runtimeEvents === activeRuntimeEvents && contextMap?.hasActiveEntries()) {
        ctx.logger.warn("Langfuse: duplicate service start ignored while traces are active");
        return;
      }
      serviceLogger = ctx.logger;
      serviceStateDir = ctx.stateDir ?? null;
      activeServiceOwner = serviceOwner;
      ownsActiveRuntime = true;
      await cleanupRuntimeState();
      internalDiagnosticDelivery = internalDiagnosticDeliveryFromContext(ctx);
      const { publicKey, secretKey, baseUrl } = resolveCredentials(config);

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "Langfuse plugin: missing publicKey or secretKey — tracing disabled. " +
            "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars or configure them in pluginConfig.",
        );
        disabled = true;
        return;
      }

      langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
        // The self-hosted ingestion proxy accepts 1 MB requests. Send each bounded
        // observation separately so multiple valid events cannot overflow one batch.
        flushAt: 1,
        flushInterval: 1000,
        requestTimeout: 30000,
        fetchRetryCount: 2,
        fetchRetryDelay: 2000,
      });
      sdkEventCleanups.push(...bindSdkDeliveryTracker(langfuse, sdkDeliveryTracker, ctx.logger));
      contextMap = new TraceContextMap((entry) => {
        sdkDeliveryTracker.completeTrace(entry.traceId);
      });
      contextMap.startSweep();
      activeRuntimeEvents = runtimeEvents;
      disabled = false;
      promptManager = config.prompts?.length ? new PromptManager(langfuse, config) : null;
      // Pre-warm prompt cache so resolveSync() works on the first message
      if (promptManager) {
        promptManager
          .warmCache()
          .then(() => {
            ctx.logger.info(`Langfuse: prompt cache warmed (${config.prompts?.length ?? 0} rules)`);
          })
          .catch((err: unknown) => {
            ctx.logger.warn(`Langfuse: warmCache failed: ${err}`);
          });
      }

      // Fire-and-forget: recover incomplete traces from previous runs
      trackRuntimeTask(
        (async () => {
          try {
            if (!tracingEnabled || !serviceStateDir) {
              return;
            }
            const incompleteTraces = scanIncompleteTraces(serviceStateDir, serviceLogger);
            if (incompleteTraces.length === 0) {
              return;
            }
            serviceLogger?.info?.(
              `Langfuse: recovering ${incompleteTraces.length} incomplete trace(s)`,
            );
            for (const traceInfo of incompleteTraces) {
              const recoveryAttempt = (traceInfo.recoveryAttempts ?? 0) + 1;
              if (
                !writeTraceRecoveryMarker(
                  serviceStateDir,
                  traceInfo.agentId,
                  traceInfo.sessionId,
                  traceInfo.traceId,
                  recoveryAttempt,
                  "started",
                  serviceLogger,
                )
              ) {
                serviceLogger?.warn?.(
                  `Langfuse: skipped recovery for trace ${traceInfo.traceId}; recovery attempt could not be persisted`,
                );
                continue;
              }
              try {
                const count = await recoverTrace(
                  langfuse,
                  traceInfo,
                  {
                    redactEnabled,
                  },
                  serviceStateDir,
                  serviceLogger,
                  sdkDeliveryTracker,
                );
                writeTraceRecoveryMarker(
                  serviceStateDir,
                  traceInfo.agentId,
                  traceInfo.sessionId,
                  traceInfo.traceId,
                  recoveryAttempt,
                  "succeeded",
                  serviceLogger,
                );
                serviceLogger?.info?.(
                  `Langfuse: recovered trace ${traceInfo.traceId} (${count} observations)`,
                );
              } catch (err) {
                writeTraceRecoveryMarker(
                  serviceStateDir,
                  traceInfo.agentId,
                  traceInfo.sessionId,
                  traceInfo.traceId,
                  recoveryAttempt,
                  "failed",
                  serviceLogger,
                );
                if (recoveryAttempt >= TRACE_RECOVERY_MAX_ATTEMPTS) {
                  writeTraceRecoveryMarker(
                    serviceStateDir,
                    traceInfo.agentId,
                    traceInfo.sessionId,
                    traceInfo.traceId,
                    recoveryAttempt,
                    "abandoned",
                    serviceLogger,
                    "attempt_limit_reached",
                  );
                }
                serviceLogger?.warn?.(
                  `Langfuse: failed to recover trace ${traceInfo.traceId}: ${err}`,
                );
              }
            }
          } catch (err) {
            serviceLogger?.warn?.(`Langfuse: trace recovery scan failed: ${err}`);
          }
        })(),
      );

      // Subscribe to diagnostic events for gateway mode tracing.
      // Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
      // but it does emit model.usage diagnostic events after each LLM call.
      if (tracingEnabled && langfuse && contextMap) {
        unsubscribeDiagnostics = await subscribeDiagnosticEvents({
          langfuse,
          contextMap,
          logger: serviceLogger,
          stateDir: serviceStateDir,
          redactEnabled,
          config,
          promptManager,
          internalDiagnostics: ctx.internalDiagnostics,
          onBeforeSdkEnqueue: (traceId, observationId, eventType, source) => {
            const entry = contextMap?.findRecent(undefined, { traceId });
            if (!entry) {
              return sdkDeliveryTracker.begin(traceId, observationId, eventType);
            }
            return beginSdkEnqueue(entry, observationId, eventType, source);
          },
          onTraceFinalized: async (entry, agentId, sessionId) => {
            if (entry.deliveryFinalized || entry.finalizationInProgress) {
              return;
            }
            entry.finalizationInProgress = true;
            try {
              const sessionKey =
                typeof entry.traceMetadata?.sessionKey === "string"
                  ? entry.traceMetadata.sessionKey
                  : undefined;
              await closeTranscriptAdmissionAndDrain(entry, sessionKey, "diagnostic finalization");
              await finalizeTraceDelivery(entry, agentId, sessionId, "diagnostic finalization");
            } finally {
              completeTraceFinalization(entry);
            }
          },
        });
      }

      // Subscribe to real-time transcript updates for per-message observation creation.
      // This captures every message written by pi-agent-core (including intermediate
      // tool-use loop messages that llm_input/llm_output hooks cannot see).
      if (
        tracingEnabled &&
        langfuse &&
        contextMap &&
        pluginRuntime?.events?.onSessionTranscriptUpdate
      ) {
        unsubscribeTranscript = pluginRuntime.events.onSessionTranscriptUpdate((update) => {
          const normalizedUpdate = normalizeTranscriptUpdate(update);
          if (!normalizedUpdate) {
            serviceLogger?.debug?.("Langfuse: skipped transcript update without session identity");
            return;
          }
          const currentEntry = transcriptAdmissionEntry(normalizedUpdate);
          // OpenClaw publishes this callback synchronously after the SQLite commit.
          // Finalization closes admission, then drains every callback accepted before
          // that boundary; reopening a delivered trace would attach a later turn to it.
          if (currentEntry?.deliveryFinalized || currentEntry?.transcriptAdmissionClosed) {
            return;
          }
          const enqueued = enqueueTranscriptTask(
            normalizedUpdate.sessionKey,
            estimateTranscriptUpdateBytes(normalizedUpdate),
            async () => {
              try {
                await handleTranscriptUpdate(normalizedUpdate, redactEnabled);
              } catch (error) {
                serviceLogger?.warn?.(`Langfuse: transcript update failed — ${String(error)}`);
              }
            },
          );
          if (!enqueued) {
            if (currentEntry) {
              markObservationBarrierFailed(currentEntry, "transcript_queue_drop", "transcript", 1);
            }
          }
        });
        ctx.logger.info("Langfuse: subscribed to onSessionTranscriptUpdate");
      }

      ctx.logger.info(`Langfuse plugin initialized (${baseUrl})`);
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      if (!ownsActiveRuntime || activeServiceOwner !== serviceOwner) {
        return;
      }
      ownsActiveRuntime = false;
      activeServiceOwner = null;
      pendingPromptStates.clear();
      await cleanupRuntimeState();
    },

    getHookHandlers(): LangfuseServiceHookHandlers {
      return handlers;
    },
  };
}
