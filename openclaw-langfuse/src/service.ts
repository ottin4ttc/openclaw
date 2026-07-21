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
import { subscribeDiagnosticEvents } from "./diagnostics.js";
import { finalizeIncrementalObservations } from "./finalize.js";
import { findMatchingRule } from "./matcher.js";
import { buildObservationsFromEntries } from "./observations.js";
import { PromptManager } from "./prompt-manager.js";
import type { PromptResolveResult } from "./prompt-manager.js";
import { scanIncompleteTraces, recoverTrace } from "./recovery.js";
import { redactObject, redactText } from "./redact.js";
import {
  readSessionMessagesFromFile,
  readSessionMessagesByIdentity,
  writeTraceMarker,
  writeObservationEvent,
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
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
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
  extractUserMessageText,
  filterCurrentTurnEntries,
  truncatePayload,
  buildApiMessage,
  buildGenerationOutput,
  usageDetailsFromUsage,
  isTraceableAssistantEntry,
  isTranscriptOnlyAssistantMessage,
  isToolCallBlock,
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
  beforeAgentStart: (event: BeforeAgentStartEvent, ctx: AgentCtx) => BeforeAgentStartResult | void;
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
const inFlightRuntimeTasks = new Set<Promise<unknown>>();
const transcriptTaskTails = new Map<string, Promise<void>>();
const transcriptTaskPendingCounts = new Map<string, number>();
const transcriptTaskPendingBytes = new Map<string, number>();
const transcriptQueueLimitWarnedSessions = new Set<string>();
const runtimeTaskDrainWaiters = new Set<() => void>();
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const TRANSCRIPT_TASK_MAX_PENDING_PER_SESSION = 128;
const TRANSCRIPT_TASK_MAX_PENDING_BYTES_PER_SESSION = 8 * 1024 * 1024;

type PendingPromptState = {
  matchInfo?: PromptResolveResult["matchInfo"];
  promptClient?: unknown;
  promptInjection?: { prepend?: string; append?: string };
  createdAt: number;
};

const PENDING_PROMPT_STATE_TTL_MS = 5 * 60 * 1000;
const PENDING_PROMPT_STATE_MAX_ENTRIES = 256;
const pendingPromptStates = new Map<string, PendingPromptState>();

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
  for (const unsub of sdkEventCleanups) {
    unsub();
  }
  sdkEventCleanups = [];
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
  if (contextMap) {
    contextMap.stopSweep();
    contextMap.clear();
    contextMap = null;
  }
  activeRuntimeEvents = null;
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
  const metadata = { ...(entry.traceMetadata ?? {}), ...patch };
  entry.traceMetadata = metadata;
  return metadata;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function llmInputRunIds(entry: TraceContextEntry): Set<string> {
  const extended = entry as TraceContextEntry & { llmInputRunIds?: Set<string> };
  if (!extended.llmInputRunIds) {
    extended.llmInputRunIds = new Set();
  }
  return extended.llmInputRunIds;
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

      // Prompt injection MUST work even before entry exists (beforePromptBuild fires before beforeAgentStart).
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

    // before_agent_start: create a new Langfuse trace for this agent turn
    beforeAgentStart(_event: BeforeAgentStartEvent, ctx: AgentCtx): BeforeAgentStartResult | void {
      if (disabled || !tracingEnabled || !langfuse || !contextMap) {
        return;
      }

      // Skip if a trace already exists for this agent turn (multiple registry passes
      // can cause register() to be called multiple times, each registering hooks)
      const existingKey = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      const existing = contextMap.get(existingKey);
      if (existing && !existing.finalized) {
        return;
      }
      if (existing) {
        contextMap.delete(existingKey);
      }

      const timestamp = Date.now();
      const sessionKey = ctx.sessionKey ?? "unknown";
      const traceId = generateTraceId(sessionKey, timestamp);

      const tags = [ctx.agentId, ctx.channelId, ...(config.tracing?.tags ?? [])].filter(
        (t): t is string => Boolean(t),
      );

      const traceMetadata: Record<string, unknown> = {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        channelId: ctx.channelId,
        trigger: ctx.trigger,
        timestamp,
      };
      const trace = langfuse.trace({
        id: traceId,
        name: ctx.agentId ?? "agent",
        sessionId: ctx.sessionKey,
        tags,
        metadata: traceMetadata,
      });

      const entry: TraceContextEntry = {
        trace,
        traceId,
        traceMetadata,
        llmCallCount: 0,
        toolCallCount: 0,
        pendingGenerations: new Map(),
        pendingGenIds: new Map(),
        completedGenerations: new Map(),
        ...(ctx.runId ? { runIds: new Set([ctx.runId]) } : {}),
        pendingSpans: new Map(),
        completedSpanToolCallIds: new Set(),
        createdAt: Date.now(),
        timestamp,
        sessionId: ctx.sessionId,
      };

      contextMap.create(TraceContextMap.key(ctx.agentId, ctx.sessionKey), entry);
      hydratePendingPromptState(ctx, entry);
      serviceLogger?.info?.(`Langfuse: trace created (agent=${ctx.agentId}, traceId=${traceId})`);
      writeTraceMarker(
        serviceStateDir,
        ctx.agentId ?? "unknown",
        ctx.sessionId ?? "",
        "start",
        traceId,
        serviceLogger,
      );
    },

    // llm_input: store model/provider/systemPrompt on entry (generation created in agent_end)
    llmInput(event: LlmInputEvent, ctx: AgentCtx): void {
      if (disabled || !tracingEnabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      let entry = contextMap.get(key);

      // If previous turn's entry is finalized, discard and create fresh
      if (entry?.finalized) {
        contextMap.delete(key);
        entry = undefined;
      }

      // Create trace entry on-demand if before_agent_start didn't create one
      if (!entry) {
        const timestamp = Date.now();
        const sessionKey = ctx.sessionKey ?? "unknown";
        const traceId = generateTraceId(sessionKey, timestamp);
        const tags = [ctx.agentId, ctx.channelId, ...(config.tracing?.tags ?? [])].filter(
          (t): t is string => Boolean(t),
        );
        const traceMetadata: Record<string, unknown> = {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
          timestamp,
          source: "llm_input-fallback",
        };
        const trace = langfuse.trace({
          id: traceId,
          name: ctx.agentId ?? "agent",
          sessionId: ctx.sessionKey,
          tags,
          metadata: traceMetadata,
        });
        entry = {
          trace,
          traceId,
          traceMetadata,
          llmCallCount: 0,
          toolCallCount: 0,
          pendingGenerations: new Map(),
          pendingGenIds: new Map(),
          completedGenerations: new Map(),
          runIds: new Set([event.runId]),
          pendingSpans: new Map(),
          completedSpanToolCallIds: new Set(),
          createdAt: timestamp,
          timestamp,
        };
        contextMap.create(key, entry);
        hydratePendingPromptState(ctx, entry);
        serviceLogger?.info?.(
          `Langfuse: trace created from llm_input fallback (agent=${ctx.agentId}, traceId=${traceId})`,
        );
        writeTraceMarker(
          serviceStateDir,
          ctx.agentId ?? "unknown",
          ctx.sessionId ?? "",
          "start",
          traceId,
          serviceLogger,
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

      // Build generation input as a delta. Earlier session history belongs in trace
      // metadata, not repeated inside every generation input.
      const historyMsgs = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      const allMessages = buildLlmInputMessages(historyMsgs, event.prompt);

      let deltaMessages: unknown[];
      if (entry.llmCallCount === 1) {
        const userPromptIdx = allMessages.findLastIndex(
          (m) => (m as Record<string, unknown>).role === "user",
        );
        const preTurnMessages = userPromptIdx > 0 ? allMessages.slice(0, userPromptIdx) : [];
        deltaMessages = userPromptIdx >= 0 ? allMessages.slice(userPromptIdx) : allMessages;

        if (preTurnMessages.length > 0) {
          const preTurnApiMessages = preTurnMessages
            .map((m) => buildApiMessage(m as Record<string, unknown>))
            .filter((m) => (m as Record<string, unknown>).role !== "system");
          if (preTurnApiMessages.length > 0) {
            const priorConversation = redactObject(
              truncatePayload(preTurnApiMessages),
              redactEnabled,
            );
            entry.priorConversation = priorConversation;
            const metadata = mergeTraceMetadata(entry, {
              prior_conversation: priorConversation,
            });
            entry.trace.update({ metadata });
          }
        }
      } else {
        const lastLen = entry.lastHistoryLength ?? 0;
        deltaMessages = lastLen <= allMessages.length ? allMessages.slice(lastLen) : allMessages;
      }
      entry.lastHistoryLength = allMessages.length;

      const nonSystemMessages = deltaMessages
        .map((m) => buildApiMessage(m as Record<string, unknown>))
        .filter((m) => (m as Record<string, unknown>).role !== "system");
      const genInput = redactObject(
        truncatePayload({ model: event.model, messages: nonSystemMessages }),
        redactEnabled,
      );

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

      writeObservationEvent(
        serviceStateDir,
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
        serviceLogger,
      );
      serviceLogger?.debug?.(
        `Langfuse: created generation ${genId} (llm-call-${entry.llmCallCount}) at llmInput`,
      );
      scheduleFlush();
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
        entry.lastGenerationEndTime = endTime;
        pendingGen.update({
          endTime,
          ...(truncatedOutput !== undefined ? { output: truncatedOutput } : {}),
          // Set usageDetails here (single update) so cache tokens are included.
          // Splitting into two update() calls risks the second being dropped by the SDK.
          ...(eu
            ? {
                usageDetails: {
                  input: eu.input ?? 0,
                  output: eu.output ?? 0,
                  total: eu.total ?? 0,
                  ...(eu.cacheRead ? { cache_read_input_tokens: eu.cacheRead } : {}),
                  ...(eu.cacheWrite ? { cache_creation_input_tokens: eu.cacheWrite } : {}),
                },
              }
            : {}),
          metadata: {
            provider: event.provider,
            model: event.model,
          },
        });
        entry.pendingGenerations.delete(event.runId);
        // Store completed generation client for agentEnd metadata/costDetails correction
        entry.completedGenerations.set(entry.llmCallCount, pendingGen);
        applyDeferredProviderRequestCompletion(entry, entry.llmCallCount, pendingGen);

        const genId = entry.pendingGenIds.get(event.runId);
        entry.pendingGenIds.delete(event.runId);
        if (genId) {
          writeObservationEvent(
            serviceStateDir,
            ctx.agentId ?? "unknown",
            ctx.sessionId ?? "",
            { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
            serviceLogger,
          );
        }
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
      writeObservationEvent(
        serviceStateDir,
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
        serviceLogger,
      );
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
        writeObservationEvent(
          serviceStateDir,
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
          serviceLogger,
        );
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
      writeObservationEvent(
        serviceStateDir,
        ctx.agentId ?? "unknown",
        entry.sessionId ?? ctx.sessionId ?? "",
        {
          e: "span-end",
          traceId: entry.traceId,
          id: spanId,
          ts: endTime.toISOString(),
        },
        serviceLogger,
      );
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
        const timestamp = Date.now();
        const sessionKey = ctx.sessionKey ?? "unknown";
        const traceId = generateTraceId(sessionKey, timestamp);
        const tags = [ctx.agentId, ctx.channelId, ...(config.tracing?.tags ?? [])].filter(
          (t): t is string => Boolean(t),
        );
        const traceMetadata: Record<string, unknown> = {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
          timestamp,
          source: "agent_end-recovery",
        };
        const trace = langfuse.trace({
          id: traceId,
          name: ctx.agentId ?? "agent",
          sessionId: ctx.sessionKey,
          tags,
          metadata: traceMetadata,
        });
        entry = {
          trace,
          traceId,
          traceMetadata,
          llmCallCount: 0,
          toolCallCount: 0,
          pendingGenerations: new Map(),
          pendingGenIds: new Map(),
          completedGenerations: new Map(),
          ...(ctx.runId ? { runIds: new Set([ctx.runId]) } : {}),
          pendingSpans: new Map(),
          completedSpanToolCallIds: new Set(),
          createdAt: timestamp,
          timestamp,
          sessionId: ctx.sessionId,
        };
        contextMap.create(key, entry);
        hydratePendingPromptState(ctx, entry);
        serviceLogger?.info?.(
          `Langfuse: trace created from agentEnd recovery (agent=${ctx.agentId}, traceId=${traceId})`,
        );
        writeTraceMarker(
          serviceStateDir,
          ctx.agentId ?? "unknown",
          ctx.sessionId ?? "",
          "start",
          traceId,
          serviceLogger,
        );
      }

      if (entry.finalized || entry.finalizationInProgress) {
        serviceLogger?.debug?.(
          `Langfuse: duplicate agentEnd ignored (traceId=${entry.traceId}, finalized=${entry.finalized === true})`,
        );
        return;
      }
      entry.finalizationInProgress = true;

      try {
        const agentId = ctx.agentId ?? "unknown";
        const sessionId = entry.sessionId ?? ctx.sessionId ?? "";
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
        if (useBatchCreation) {
          const obsResult = buildObservationsFromEntries(
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
            },
            serviceLogger,
          );
          entry.llmCallCount = obsResult.llmCallCount;
          entry.completedGenerations = obsResult.completedGenerations;
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
        } else {
          finalizeIncrementalObservations(
            entry,
            turnEntries,
            allEntries,
            agentId,
            sessionId,
            redactEnabled,
            { logger: serviceLogger, stateDir: serviceStateDir, langfuseClient: langfuse },
          );
          applyDeferredProviderRequestCompletions(entry);
        }

        // 4. Extract trace-level data
        const userEntry = turnEntries.find((e) => e.message.role === "user");
        const userInputText = userEntry
          ? extractUserMessageText(userEntry.message.content)
          : undefined;

        // Find last assistant text for trace output (if not set by recovery path)
        if (!lastAssistantText) {
          for (let i = turnEntries.length - 1; i >= 0; i--) {
            if (isTraceableAssistantEntry(turnEntries[i])) {
              const text = extractTextContent(turnEntries[i].message.content);
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
        if (turnEntries.length > 0) {
          const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
          for (const te of turnEntries) {
            const msg = te.message;
            if (!isTraceableAssistantEntry(te)) {
              continue;
            }
            const u = msg.usage as Record<string, unknown> | undefined;
            if (!u) {
              continue;
            }
            acc.input += (u.input as number) || 0;
            acc.output += (u.output as number) || 0;
            acc.cacheRead += (u.cacheRead as number) || 0;
            acc.cacheWrite += (u.cacheWrite as number) || 0;
            acc.total +=
              (u.totalTokens as number) ||
              (u.total as number) ||
              ((u.input as number) || 0) + ((u.output as number) || 0);
          }
          if (acc.input > 0 || acc.output > 0 || acc.total > 0) {
            aggregatedUsage = acc;
          }
          serviceLogger?.info?.(
            `Langfuse: usage from turnEntries — input=${acc.input} output=${acc.output} total=${acc.total}`,
          );
        }
        const providerUsage = completeProviderRequestUsageTotals(entry);
        if (providerUsage) {
          entry.authoritativeProviderUsage = providerUsage;
        }
        const usageSrc =
          providerUsage ??
          aggregatedUsage ??
          (batchTotalUsage &&
          (batchTotalUsage.input > 0 || batchTotalUsage.output > 0 || batchTotalUsage.total > 0)
            ? batchTotalUsage
            : entry.storedUsage);
        entry.finalizedUsage = usageSrc ? { ...usageSrc } : undefined;
        const finalUsage = usageSrc
          ? {
              inputTokens: usageSrc.input,
              outputTokens: usageSrc.output,
              cacheReadInputTokens: usageSrc.cacheRead || undefined,
              cacheWriteInputTokens: usageSrc.cacheWrite || undefined,
              totalTokens: usageSrc.total,
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
          ...(entry.priorConversation !== undefined
            ? { prior_conversation: entry.priorConversation }
            : {}),
          prompt: truncatePayload(entry.promptMatch),
          system_prompt: entry.systemPrompt
            ? truncatePayload(redactText(entry.systemPrompt, redactEnabled))
            : undefined,
        });

        // Update trace with structured metadata
        entry.trace.update({
          input: userInputText
            ? truncatePayload(redactText(userInputText, redactEnabled))
            : undefined,
          output: lastAssistantText
            ? truncatePayload(redactText(lastAssistantText, redactEnabled))
            : undefined,
          metadata: finalTraceMetadata,
          ...(event.error
            ? {
                statusMessage: safeAgentErrorStatusMessage(event.error, redactEnabled),
                level: "ERROR" as const,
              }
            : {}),
        });

        // Mark as finalized instead of deleting — diagnostic events may still arrive
        // but should not overwrite our clean metadata structure.
        entry.finalized = true;

        // Flush observations to Langfuse before writing end marker.
        // End marker means "data confirmed delivered" — if flush fails,
        // skip the marker so startup recovery can rebuild the trace.
        try {
          await langfuse.flushAsync();
          writeTraceMarker(
            serviceStateDir,
            agentId,
            sessionId,
            "end",
            entry.traceId,
            serviceLogger,
          );
        } catch (flushErr: unknown) {
          serviceLogger?.warn?.(
            `Langfuse: flushAsync failed in agentEnd (traceId=${entry.traceId}), skipping end marker — ${String(flushErr)}`,
          );
        }
      } finally {
        entry.finalizationInProgress = false;
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

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const FLUSH_DEBOUNCE_MS = 2000; // buffer flushes to avoid per-message API calls

  function scheduleFlush(): void {
    if (flushTimer) {
      return; // already scheduled
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      langfuse?.flushAsync().catch((e: unknown) => {
        serviceLogger?.debug?.(`Langfuse: transcript flush failed: ${String(e)}`);
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  function cancelScheduledFlush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

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
    const total = usage.total ?? (usage.input ?? 0) + (usage.output ?? 0);
    if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite && !total) {
      return undefined;
    }
    return {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead || undefined,
      cacheWriteInputTokens: usage.cacheWrite || undefined,
      totalTokens: total || undefined,
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
    writeObservationEvent(
      serviceStateDir,
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
      serviceLogger,
    );
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
      writeObservationEvent(
        serviceStateDir,
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
        serviceLogger,
      );
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
    writeObservationEvent(
      serviceStateDir,
      agentId,
      sessionId,
      { e: "span-end", traceId: entry.traceId, id: spanId, ts: endTime.toISOString() },
      serviceLogger,
    );
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
    scheduleFlush();
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
    generation.update({
      ...(deferred.startTime ? { startTime: deferred.startTime } : {}),
      endTime: deferred.endTime,
      ...(deferred.input !== undefined ? { input: deferred.input } : {}),
      ...(deferred.output !== undefined ? { output: deferred.output } : {}),
      ...(deferred.usageDetails ? { usageDetails: deferred.usageDetails } : {}),
      ...(deferred.costDetails ? { costDetails: deferred.costDetails } : {}),
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
    if (!entry || (entry.finalized && !isInitiallyLateFinalizedTranscript)) {
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
        scheduleFlush();
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
        scheduleFlush();
        return;
      }

      if (completedGen && completedGenIndex > 0) {
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
        scheduleFlush();
        return;
      }

      // If there's a pending generation (created by llm_input but not completed by llm_output),
      // complete it with data from the transcript message.
      const pendingEntries = [...entry.pendingGenerations.entries()];
      if (pendingEntries.length > 0) {
        const [runId, pendingGen] = pendingEntries[0];
        const endTime = transcriptTiming.endTime ?? new Date();
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
        const pendingGenId = entry.pendingGenIds.get(runId);
        entry.pendingGenIds.delete(runId);
        const resolvedGenIndex = completedGenIndex > 0 ? completedGenIndex : entry.llmCallCount;
        entry.completedGenerations.set(resolvedGenIndex, pendingGen);
        applyDeferredProviderRequestCompletion(entry, resolvedGenIndex, pendingGen);
        entry.llmCallCount = Math.max(entry.llmCallCount, resolvedGenIndex);
        entry.lastGenerationEndTime = endTime;
        if (pendingGenId) {
          writeObservationEvent(
            serviceStateDir,
            transcriptAgentId,
            transcriptSessionId,
            { e: "gen-end", traceId: entry.traceId, id: pendingGenId, ts: endTime.toISOString() },
            serviceLogger,
          );
        }
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        serviceLogger?.debug?.(
          `Langfuse: transcript completed pending generation (llmCall=${resolvedGenIndex})`,
        );
      } else {
        if (isLateFinalizedAssistant && !transcriptTiming.assistantCallIndex) {
          patchFinalizedTraceFromTranscript(entry, _redactEnabled);
          scheduleFlush();
          return;
        }
        if (entry.hasProviderRequestGenerations) {
          patchFinalizedTraceFromTranscript(entry, _redactEnabled);
          scheduleFlush();
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
          scheduleFlush();
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
        applyDeferredProviderRequestCompletion(entry, nextLlmCall, generation);
        entry.currentGenerationId = genId;
        entry.lastGenerationEndTime = endTime;
        writeObservationEvent(
          serviceStateDir,
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
          serviceLogger,
        );
        writeObservationEvent(
          serviceStateDir,
          transcriptAgentId,
          transcriptSessionId,
          { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
          serviceLogger,
        );
        patchFinalizedTraceFromTranscript(entry, _redactEnabled);
        serviceLogger?.info?.(
          `Langfuse: transcript created intermediate generation ${genId} (llmCall=${nextLlmCall})`,
        );
      }

      scheduleFlush();
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
      if (typeof langfuse.on === "function") {
        sdkEventCleanups.push(
          langfuse.on("warning", (msg: string) => {
            ctx.logger.warn(`Langfuse: [SDK-warn] ${msg}`);
          }),
          langfuse.on("error", (msg: unknown) => {
            ctx.logger.error(`Langfuse: [SDK-error] ${String(msg)}`);
          }),
        );
      }
      sdkEventCleanups.push(cancelScheduledFlush);
      contextMap = new TraceContextMap();
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
            const incompleteTraces = scanIncompleteTraces(serviceStateDir);
            if (incompleteTraces.length === 0) {
              return;
            }
            serviceLogger?.info?.(
              `Langfuse: recovering ${incompleteTraces.length} incomplete trace(s)`,
            );
            for (const traceInfo of incompleteTraces) {
              try {
                const count = await recoverTrace(
                  langfuse,
                  traceInfo,
                  {
                    redactEnabled,
                  },
                  serviceStateDir,
                  serviceLogger,
                );
                serviceLogger?.info?.(
                  `Langfuse: recovered trace ${traceInfo.traceId} (${count} observations)`,
                );
              } catch (err) {
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
          enqueueTranscriptTask(
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
