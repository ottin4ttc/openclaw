/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import Langfuse from "langfuse";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveCredentials } from "./config.js";
import type { LangfusePluginConfig } from "./config.js";
import { checkModelCostConfig, formatCostWarning } from "./diagnose.js";
import { subscribeDiagnosticEvents } from "./diagnostics.js";
import { finalizeIncrementalObservations } from "./finalize.js";
import { findMatchingRule } from "./matcher.js";
import { buildObservationsFromEntries } from "./observations.js";
import { PromptManager } from "./prompt-manager.js";
import { scanIncompleteTraces, recoverTrace } from "./recovery.js";
import { redactObject, redactText } from "./redact.js";
import { readSessionMessages, writeTraceMarker, writeObservationEvent } from "./session.js";
import { TraceContextMap } from "./trace-context.js";
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

export type LangfuseServiceHookHandlers = {
  beforePromptBuild: (
    event: BeforePromptBuildEvent,
    ctx: AgentCtx,
  ) => BeforePromptBuildResult | void;
  beforeAgentStart: (event: BeforeAgentStartEvent, ctx: AgentCtx) => BeforeAgentStartResult | void;
  llmInput: (event: LlmInputEvent, ctx: AgentCtx) => void;
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

/**
 * Creates the Langfuse plugin service with full tracing and prompt management.
 */
export function createLangfuseService(
  config: LangfusePluginConfig,
  logger?: PluginLogger,
  pluginRuntime?: {
    events?: {
      onSessionTranscriptUpdate?: (
        listener: (update: {
          sessionFile: string;
          sessionKey?: string;
          message?: unknown;
          messageId?: string;
        }) => void,
      ) => () => void;
    };
  },
): LangfuseService {
  serviceLogger = logger ?? null;

  const redactEnabled = config.tracing?.redact !== false;

  function getEntry(agentId?: string, sessionKey?: string): TraceContextEntry | undefined {
    return contextMap?.get(TraceContextMap.key(agentId, sessionKey));
  }

  const handlers: LangfuseServiceHookHandlers = {
    // before_prompt_build: capture system prompt and record prompt match info
    beforePromptBuild(
      event: BeforePromptBuildEvent,
      ctx: AgentCtx,
    ): BeforePromptBuildResult | void {
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
            `Langfuse: prompt injection → ${JSON.stringify(syncResult.injection).slice(0, 100)}`,
          );
          if (entry) {
            entry.promptMatch = syncResult.matchInfo;
            entry.promptClient = syncResult.promptClient;
            // Store injection text for merging into systemPrompt in generation input
            const injection = syncResult.injection as Record<string, unknown> | undefined;
            if (injection) {
              entry.promptInjection = {
                prepend:
                  typeof injection.prependSystemContext === "string"
                    ? injection.prependSystemContext
                    : undefined,
                append:
                  typeof injection.appendSystemContext === "string"
                    ? injection.appendSystemContext
                    : undefined,
              };
            }
          }
          return syncResult.injection;
        }
        // Cache miss — fire async resolve to populate cache for next time
        promptManager
          .resolve(agentId, {
            agentId: ctx.agentId,
            channelId: ctx.channelId,
            sessionKey: ctx.sessionKey,
            trigger: ctx.trigger,
          })
          .then((result) => {
            if (result && entry) {
              entry.promptMatch = result.matchInfo;
              entry.promptClient = result.promptClient;
            }
          })
          .catch(() => {});
      } else if (entry && config.prompts?.length) {
        // Fallback: record match info without prompt client
        const agentId = ctx.agentId ?? "unknown";
        const rule = findMatchingRule(agentId, config.prompts);
        if (rule) {
          entry.promptMatch = {
            name: rule.langfusePrompt,
            version: rule.version,
            label: rule.label,
            inject: rule.inject,
            matchRule: rule.match,
          };
        }
      }

      return undefined;
    },

    // before_agent_start: create a new Langfuse trace for this agent turn
    beforeAgentStart(_event: BeforeAgentStartEvent, ctx: AgentCtx): BeforeAgentStartResult | void {
      if (disabled || !langfuse || !contextMap) {
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

      const trace = langfuse.trace({
        id: traceId,
        name: ctx.agentId ?? "agent",
        sessionId: ctx.sessionKey,
        tags,
        metadata: {
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          trigger: ctx.trigger,
          timestamp,
        },
      });

      const entry: TraceContextEntry = {
        trace,
        traceId,
        llmCallCount: 0,
        toolCallCount: 0,
        pendingGenerations: new Map(),
        pendingGenIds: new Map(),
        completedGenerations: new Map(),
        pendingSpans: new Map(),
        completedSpanToolCallIds: new Set(),
        createdAt: Date.now(),
        timestamp,
        sessionId: ctx.sessionId,
      };

      contextMap.create(TraceContextMap.key(ctx.agentId, ctx.sessionKey), entry);
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
      if (disabled || !langfuse || !contextMap) {
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
        const trace = langfuse.trace({
          id: traceId,
          name: ctx.agentId ?? "agent",
          sessionId: ctx.sessionKey,
          tags,
          metadata: {
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            channelId: ctx.channelId,
            trigger: ctx.trigger,
            timestamp,
            source: "llm_input-fallback",
          },
        });
        entry = {
          trace,
          traceId,
          llmCallCount: 0,
          toolCallCount: 0,
          pendingGenerations: new Map(),
          pendingGenIds: new Map(),
          completedGenerations: new Map(),
          pendingSpans: new Map(),
          completedSpanToolCallIds: new Set(),
          createdAt: timestamp,
          timestamp,
        };
        contextMap.create(key, entry);
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

      // --- Incremental generation creation ---
      entry.llmCallCount += 1;
      const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
      const model = qualifiedModel(event.provider, event.model);
      const startTime = new Date();

      // Build generation input from historyMessages (excluding system messages) + current prompt
      const historyMsgs = Array.isArray(event.historyMessages) ? event.historyMessages : [];
      const nonSystemMessages = historyMsgs
        .map((m) => buildApiMessage(m as Record<string, unknown>))
        .filter((m) => (m as Record<string, unknown>).role !== "system");
      // Append current user prompt so the generation input includes the triggering message
      if (event.prompt) {
        nonSystemMessages.push({ role: "user", content: event.prompt });
      }
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
      // Flush so generation appears in Langfuse UI in real-time
      langfuse?.flushAsync().catch((e: unknown) => {
        serviceLogger?.debug?.(`Langfuse: flushAsync failed: ${String(e)}`);
      });
    },

    // llm_output: update pending generation with endTime, usage, output
    llmOutput(event: LlmOutputEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse) {
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

    // before_tool_call: create span immediately for accurate startTime
    beforeToolCall(event: BeforeToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !langfuse) {
        return;
      }
      let entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry && contextMap) {
        entry = contextMap.findActive();
      }
      if (!entry) {
        return;
      }
      entry.toolCallCount += 1;

      const toolCallId = ctx.toolCallId ?? event.toolCallId;
      if (!toolCallId) {
        // No toolCallId — can't create a trackable span; defer to agentEnd JSONL fallback
        return;
      }

      const spanId = generateObservationId(entry.traceId, "span", toolCallId);
      const startTime = new Date();
      const span = entry.trace.span({
        id: spanId,
        name: `tool:${event.toolName ?? "unknown"}`,
        startTime,
        input: event.params
          ? redactObject(truncatePayload(event.params), redactEnabled)
          : undefined,
        ...(entry.currentGenerationId ? { parentObservationId: entry.currentGenerationId } : {}),
      });
      entry.pendingSpans.set(toolCallId, span);

      writeObservationEvent(
        serviceStateDir,
        ctx.agentId ?? "unknown",
        ctx.sessionId ?? "",
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
      serviceLogger?.debug?.(
        `Langfuse: created tool span ${spanId} (${event.toolName}) at beforeToolCall`,
      );
      langfuse?.flushAsync().catch((e: unknown) => {
        serviceLogger?.debug?.(`Langfuse: flushAsync failed: ${String(e)}`);
      });
    },

    // after_tool_call: complete pending span via findByPendingSpan (bypasses ctx.agentId=undefined)
    afterToolCall(event: AfterToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !langfuse || !contextMap) {
        return;
      }
      const toolCallId = ctx.toolCallId ?? event.toolCallId;
      if (!toolCallId) {
        return;
      }

      // Use findByPendingSpan to locate entry — ctx.agentId may be undefined
      const entry = contextMap.findByPendingSpan(toolCallId);
      if (!entry) {
        serviceLogger?.debug?.(
          `Langfuse: afterToolCall — no pending span for toolCallId=${toolCallId}`,
        );
        return;
      }

      const span = entry.pendingSpans.get(toolCallId);
      if (!span) {
        return;
      }

      const endTime = new Date();
      span.update({
        endTime,
        output: event.error
          ? { error: event.error }
          : event.result
            ? redactObject(truncatePayload(event.result), redactEnabled)
            : undefined,
        statusMessage: event.error,
        level: event.error ? "ERROR" : "DEFAULT",
        metadata: event.durationMs != null ? { durationMs: event.durationMs } : {},
      });
      entry.pendingSpans.delete(toolCallId);
      entry.completedSpanToolCallIds.add(toolCallId);

      const spanId = generateObservationId(entry.traceId, "span", toolCallId);
      writeObservationEvent(
        serviceStateDir,
        ctx.agentId ?? "unknown",
        ctx.sessionId ?? "",
        { e: "span-end", traceId: entry.traceId, id: spanId, ts: endTime.toISOString() },
        serviceLogger,
      );
      serviceLogger?.debug?.(
        `Langfuse: completed tool span ${spanId} (${event.toolName}) at afterToolCall`,
      );
      // No flush here — agentEnd handles final flush to avoid race conditions.
    },

    // agent_end: create per-LLM-call generations from JSONL and finalize the trace
    async agentEnd(event: AgentEndEvent, ctx: AgentCtx): Promise<void> {
      if (disabled || !langfuse || !contextMap) {
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
        const trace = langfuse.trace({
          id: traceId,
          name: ctx.agentId ?? "agent",
          sessionId: ctx.sessionKey,
          tags,
          metadata: {
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            channelId: ctx.channelId,
            trigger: ctx.trigger,
            timestamp,
            source: "agent_end-recovery",
          },
        });
        entry = {
          trace,
          traceId,
          llmCallCount: 0,
          toolCallCount: 0,
          pendingGenerations: new Map(),
          pendingGenIds: new Map(),
          completedGenerations: new Map(),
          pendingSpans: new Map(),
          completedSpanToolCallIds: new Set(),
          createdAt: timestamp,
          timestamp,
          sessionId: ctx.sessionId,
        };
        contextMap.create(key, entry);
        serviceLogger?.info?.(
          `Langfuse: trace created from agentEnd recovery (agent=${ctx.agentId}, traceId=${traceId})`,
        );
      }

      const agentId = ctx.agentId ?? "unknown";
      const sessionId = entry.sessionId ?? ctx.sessionId ?? "";
      // Read JSONL and filter to current turn
      let allEntries: SessionEntry[] = [];
      let turnEntries: SessionEntry[] = [];
      if (sessionId) {
        allEntries = readSessionMessages(serviceStateDir, agentId, sessionId, serviceLogger);
        turnEntries = filterCurrentTurnEntries(allEntries);
      }

      // Fallback: if JSONL unavailable, build entries from event.messages
      if (turnEntries.length === 0 && Array.isArray(event.messages)) {
        serviceLogger?.warn?.(
          `Langfuse: JSONL unavailable for agent=${agentId} session=${sessionId}, using event.messages fallback`,
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
            pendingSpans: entry.pendingSpans,
            lastModel: entry.lastModel,
            lastProvider: entry.lastProvider,
            redactEnabled,
            langfuseClient: langfuse ?? undefined,
          },
          serviceLogger,
        );
        entry.llmCallCount = obsResult.llmCallCount;
        entry.toolCallCount += obsResult.toolCallCount;
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
      }

      // 4. Extract trace-level data
      const userEntry = turnEntries.find((e) => e.message.role === "user");
      const userInputText = userEntry
        ? extractUserMessageText(userEntry.message.content)
        : undefined;

      // Find last assistant text for trace output (if not set by recovery path)
      if (!lastAssistantText) {
        for (let i = turnEntries.length - 1; i >= 0; i--) {
          if (turnEntries[i].message.role === "assistant") {
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
          if (msg.role !== "assistant") {
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
      const usageSrc =
        aggregatedUsage ??
        (batchTotalUsage &&
        (batchTotalUsage.input > 0 || batchTotalUsage.output > 0 || batchTotalUsage.total > 0)
          ? batchTotalUsage
          : entry.storedUsage);
      const finalUsage = usageSrc
        ? {
            inputTokens: usageSrc.input,
            outputTokens: usageSrc.output,
            cacheReadInputTokens: usageSrc.cacheRead || undefined,
            cacheWriteInputTokens: usageSrc.cacheWrite || undefined,
            totalTokens: usageSrc.total,
          }
        : undefined;

      // Update trace with structured metadata
      entry.trace.update({
        input: userInputText ? redactText(userInputText, redactEnabled) : undefined,
        output: lastAssistantText ? redactText(lastAssistantText, redactEnabled) : undefined,
        metadata: {
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
          prompt: entry.promptMatch,
          system_prompt: entry.systemPrompt
            ? redactText(entry.systemPrompt, redactEnabled)
            : undefined,
        },
        ...(event.error
          ? {
              statusMessage: event.error,
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
        writeTraceMarker(serviceStateDir, agentId, sessionId, "end", entry.traceId, serviceLogger);
      } catch (flushErr: unknown) {
        serviceLogger?.warn?.(
          `Langfuse: flushAsync failed in agentEnd (traceId=${entry.traceId}), skipping end marker — ${String(flushErr)}`,
        );
      }
    },

    // session_end: log session metadata
    sessionEnd(event: SessionEndEvent, ctx: SessionCtx): void {
      if (disabled) {
        return;
      }
      serviceLogger?.debug?.(
        `Langfuse session end: agentId=${ctx.agentId ?? "unknown"} sessionKey=${ctx.sessionKey ?? "unknown"} messageCount=${event.messageCount} durationMs=${event.durationMs ?? "unknown"}`,
      );
    },

    // session_start: initialize trace context early
    sessionStart(event: SessionStartEvent, ctx: SessionCtx): void {
      if (disabled || !langfuse || !contextMap) {
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
      if (disabled || !contextMap) {
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
        metadata._langfuse = {
          traceId: entry.traceId,
          genId: entry.currentGenerationId,
        };
        return { message: { ...msg, metadata } };
      }

      if (role === "toolResult" || role === "tool") {
        const toolCallId = (msg.toolCallId as string) ?? (msg.tool_call_id as string) ?? undefined;
        if (toolCallId) {
          const pendingSpan = entry.pendingSpans.get(toolCallId);
          const spanId = pendingSpan
            ? generateObservationId(entry.traceId, "span", toolCallId)
            : undefined;
          metadata._langfuse = {
            traceId: entry.traceId,
            spanId,
            toolCallId,
          };
          return { message: { ...msg, metadata } };
        }
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Real-time transcript update handler
  // Processes every message written to the session JSONL via onSessionTranscriptUpdate.
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

  function handleTranscriptUpdate(
    update: { sessionFile: string; sessionKey?: string; message?: unknown; messageId?: string },
    _redactEnabled: boolean,
  ): void {
    if (disabled || !langfuse || !contextMap) {
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

    // Find active trace entry — we don't have agentId in the update,
    // so use the most recent non-finalized entry as a best-effort match.
    const entry = contextMap.findActive();
    if (!entry || entry.finalized) {
      return;
    }

    if (role === "assistant") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      const model = msg.model as string | undefined;
      const provider = msg.provider as string | undefined;
      const stopReason = msg.stopReason as string | undefined;

      // Check if this assistant message was already captured by llm_output
      // (to avoid double-counting). If completedGenerations has entries for this
      // llmCallCount, skip.
      if (entry.completedGenerations.size >= entry.llmCallCount && entry.llmCallCount > 0) {
        serviceLogger?.debug?.(
          `Langfuse: transcript assistant msg — already captured by llm_output (completedGens=${entry.completedGenerations.size})`,
        );
        // Still update usage/output if the completed generation is missing them
        return;
      }

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

      // If there's a pending generation (created by llm_input but not completed by llm_output),
      // complete it with data from the transcript message
      const pendingEntries = [...entry.pendingGenerations.entries()];
      if (pendingEntries.length > 0) {
        const [runId, pendingGen] = pendingEntries[0];
        const eu = usage;
        pendingGen.update({
          endTime: new Date(),
          ...(msg.content
            ? { output: redactObject(truncatePayload(msg.content), _redactEnabled) }
            : {}),
          ...(stopReason ? { metadata: { provider, model, stopReason } } : {}),
          ...(eu
            ? {
                usageDetails: {
                  input: (eu.input as number) ?? 0,
                  output: (eu.output as number) ?? 0,
                  total: (eu.totalTokens as number) ?? (eu.total as number) ?? 0,
                  ...(eu.cacheRead ? { cache_read_input_tokens: eu.cacheRead as number } : {}),
                  ...(eu.cacheWrite
                    ? { cache_creation_input_tokens: eu.cacheWrite as number }
                    : {}),
                },
              }
            : {}),
        });
        entry.pendingGenerations.delete(runId);
        entry.completedGenerations.set(entry.llmCallCount, pendingGen);
        serviceLogger?.debug?.(
          `Langfuse: transcript completed pending generation (llmCall=${entry.llmCallCount})`,
        );
      } else {
        // No pending generation — this is an intermediate LLM call during a tool-use loop
        // that llm_input/llm_output hooks cannot see. Create a new generation from scratch.
        entry.llmCallCount += 1;
        const genId = generateObservationId(entry.traceId, "gen", entry.llmCallCount);
        const qualModel = model
          ? qualifiedModel(provider ?? "", model)
          : (entry.lastModel ?? "unknown");
        const endTime = new Date();

        const eu = usage;
        const generation = entry.trace.generation({
          id: genId,
          name: `llm-call-${entry.llmCallCount}`,
          model: qualModel,
          startTime: endTime, // best-effort: we don't have the actual start time
          endTime,
          ...(msg.content
            ? { output: redactObject(truncatePayload(msg.content), _redactEnabled) }
            : {}),
          ...(entry.currentGenerationId ? { parentObservationId: entry.currentGenerationId } : {}),
          metadata: { provider, model, stopReason, source: "transcript-realtime" },
          ...(eu
            ? {
                usageDetails: {
                  input: (eu.input as number) ?? 0,
                  output: (eu.output as number) ?? 0,
                  total: (eu.totalTokens as number) ?? (eu.total as number) ?? 0,
                  ...(eu.cacheRead ? { cache_read_input_tokens: eu.cacheRead as number } : {}),
                  ...(eu.cacheWrite
                    ? { cache_creation_input_tokens: eu.cacheWrite as number }
                    : {}),
                },
              }
            : {}),
        });
        entry.completedGenerations.set(entry.llmCallCount, generation);
        entry.currentGenerationId = genId;
        serviceLogger?.info?.(
          `Langfuse: transcript created intermediate generation ${genId} (llmCall=${entry.llmCallCount})`,
        );
      }

      scheduleFlush();
    }

    if (role === "toolResult" || role === "tool") {
      const toolCallId = (msg.toolCallId as string) ?? (msg.tool_call_id as string) ?? undefined;
      if (!toolCallId) {
        return;
      }

      // Complete pending span if one exists (created by before_tool_call hook)
      const pendingSpan = entry.pendingSpans.get(toolCallId);
      if (pendingSpan) {
        const error = msg.error as string | undefined;
        const result = msg.content ?? msg.result;
        pendingSpan.update({
          endTime: new Date(),
          ...(result ? { output: redactObject(truncatePayload(result), _redactEnabled) } : {}),
          ...(error ? { statusMessage: error, level: "ERROR" as const } : {}),
        });
        entry.pendingSpans.delete(toolCallId);
        entry.completedSpanToolCallIds.add(toolCallId);
        serviceLogger?.debug?.(
          `Langfuse: transcript completed tool span (toolCallId=${toolCallId})`,
        );
        scheduleFlush();
      }
    }
  }

  return {
    id: "openclaw-langfuse",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      serviceLogger = ctx.logger;
      serviceStateDir = ctx.stateDir ?? null;
      const { publicKey, secretKey, baseUrl } = resolveCredentials(config);

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "Langfuse plugin: missing publicKey or secretKey — tracing disabled. " +
            "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars or configure them in pluginConfig.",
        );
        disabled = true;
        return;
      }

      // Check for missing model cost config that causes zero usage data
      try {
        const costIssues = checkModelCostConfig(serviceStateDir ?? undefined);
        if (costIssues.length > 0) {
          ctx.logger.warn(formatCostWarning(costIssues));
        }
      } catch {
        // Non-critical check — don't block startup
      }

      langfuse = new Langfuse({
        publicKey,
        secretKey,
        baseUrl,
        requestTimeout: 30000,
        fetchRetryCount: 2,
        fetchRetryDelay: 2000,
      });
      // Diagnostic: log generation events to trace output issues.
      // Track unsubscribe functions to avoid listener accumulation on re-init.
      for (const unsub of sdkEventCleanups) {
        unsub();
      }
      sdkEventCleanups = [];
      if (typeof langfuse.on === "function") {
        sdkEventCleanups.push(
          langfuse.on("generation-create", (evt: Record<string, unknown>) => {
            const id = String(evt.id ?? "").slice(-10);
            const hasOutput = evt.output !== undefined && evt.output !== null;
            ctx.logger.info(`Langfuse: [evt] gen-create id=${id} hasOutput=${hasOutput}`);
          }),
          langfuse.on("generation-update", (evt: Record<string, unknown>) => {
            const id = String(evt.id ?? "").slice(-10);
            const o = evt.output;
            const outputType =
              o === undefined
                ? "undefined"
                : o === null
                  ? "null"
                  : typeof o === "string"
                    ? `str(${o.length})`
                    : `obj(${JSON.stringify(o).slice(0, 80)})`;
            ctx.logger.info(`Langfuse: [evt] gen-update id=${id} output=${outputType}`);
          }),
          langfuse.on("warning", (msg: string) => {
            ctx.logger.warn(`Langfuse: [SDK-warn] ${msg}`);
          }),
          langfuse.on("error", (msg: unknown) => {
            ctx.logger.error(`Langfuse: [SDK-error] ${String(msg)}`);
          }),
        );
      }
      // Preserve existing contextMap if it has active (non-finalized) entries.
      // The plugin may be re-registered mid-run (e.g., openmai reloads config);
      // recreating contextMap would lose the in-flight trace entry.
      if (!contextMap || contextMap.size === 0) {
        contextMap = new TraceContextMap();
        contextMap.startSweep();
      }
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
      void (async () => {
        try {
          if (!serviceStateDir) {
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
      })();

      // Subscribe to diagnostic events for gateway mode tracing.
      // Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
      // but it does emit model.usage diagnostic events after each LLM call.
      if (langfuse && contextMap) {
        unsubscribeDiagnostics = await subscribeDiagnosticEvents({
          langfuse,
          contextMap,
          logger: serviceLogger,
          stateDir: serviceStateDir,
          redactEnabled,
          config,
          promptManager,
        });
      }

      // Subscribe to real-time transcript updates for per-message observation creation.
      // This captures every message written by pi-agent-core (including intermediate
      // tool-use loop messages that llm_input/llm_output hooks cannot see).
      if (langfuse && contextMap && pluginRuntime?.events?.onSessionTranscriptUpdate) {
        unsubscribeTranscript = pluginRuntime.events.onSessionTranscriptUpdate((update) => {
          handleTranscriptUpdate(update, redactEnabled);
        });
        ctx.logger.info("Langfuse: subscribed to onSessionTranscriptUpdate");
      }

      ctx.logger.info(`Langfuse plugin initialized (${baseUrl})`);
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      for (const unsub of sdkEventCleanups) {
        unsub();
      }
      sdkEventCleanups = [];
      if (unsubscribeTranscript) {
        unsubscribeTranscript();
        unsubscribeTranscript = null;
      }
      if (unsubscribeDiagnostics) {
        unsubscribeDiagnostics();
        unsubscribeDiagnostics = null;
      }
      if (langfuse) {
        await langfuse.shutdownAsync();
        langfuse = null;
      }
      if (contextMap) {
        contextMap.stopSweep();
        contextMap.clear();
        contextMap = null;
      }
    },

    getHookHandlers(): LangfuseServiceHookHandlers {
      return handlers;
    },
  };
}
