/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import Langfuse from "langfuse";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { resolveCredentials } from "./config.js";
import type { LangfusePluginConfig } from "./config.js";
import { checkModelCostConfig, formatCostWarning } from "./diagnose.js";
import { findMatchingRule } from "./matcher.js";
import { buildObservationsFromEntries, createToolSpansFromMessages } from "./observations.js";
import { PromptManager } from "./prompt-manager.js";
import { scanIncompleteTraces, recoverTrace } from "./recovery.js";
import { redactObject, redactText } from "./redact.js";
import { readSessionMessages, writeTraceMarker } from "./session.js";
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
  extractConversation,
  extractLLMTurns,
  extractUserMessageText,
  filterCurrentTurnEntries,
  filterCurrentTurnMessages,
} from "./utils.js";

// Re-export for external consumers (e.g. tracer.test.ts)
export { generateTraceId, generateObservationId } from "./utils.js";

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
let promptManager: PromptManager | null = null;

/**
 * Creates the Langfuse plugin service with full tracing and prompt management.
 */
export function createLangfuseService(
  config: LangfusePluginConfig,
  logger?: PluginLogger,
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
        pendingSpans: new Map(),
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
          pendingSpans: new Map(),
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

      // Store data for agent_end to use when creating generations
      // Set systemPrompt from the first llm_input call only; subsequent calls in the same
      // turn reuse the same system prompt so we avoid overwriting with a post-injection version.
      if (event.systemPrompt && !entry.systemPrompt) {
        entry.systemPrompt = event.systemPrompt;
      }
      serviceLogger?.debug?.(
        `Langfuse: llmInput — systemPrompt=${entry.systemPrompt ? `${entry.systemPrompt.length}chars` : "not set"}`,
      );
      // Store historyMessages from first llm_input call for generation input
      if (!entry.initialMessages && event.historyMessages) {
        entry.initialMessages = event.historyMessages;
      }
      entry.lastModel = event.model;
      entry.lastProvider = event.provider;
      entry.sessionId = ctx.sessionId;
    },

    // llm_output: store usage/output on entry (generation created in agent_end)
    llmOutput(event: LlmOutputEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      // Store data for agent_end to use when creating generations
      entry.storedUsage = event.usage;
      entry.storedOutput = event.assistantTexts.join("\n");
      entry.lastModel = event.model;
      entry.lastProvider = event.provider;
    },

    // before_tool_call: track tool call count only.
    // Tool spans are created from JSONL in agent_end for reliable timing and output.
    beforeToolCall(_event: BeforeToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !langfuse) {
        return;
      }
      let entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry && contextMap) {
        entry = contextMap.findActive();
      }
      if (entry) {
        entry.toolCallCount += 1;
      }
    },

    // after_tool_call: no-op — tool spans are completed from JSONL in agent_end.
    afterToolCall(): void {},

    // agent_end: create per-LLM-call generations from JSONL and finalize the trace
    async agentEnd(event: AgentEndEvent, ctx: AgentCtx): Promise<void> {
      if (disabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      let entry = contextMap.get(key);
      if (!entry) {
        // Restart resilience: if no entry exists (e.g., gateway restarted mid-conversation),
        // create a new trace on the fly so observations are still recorded.
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
          pendingSpans: new Map(),
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

      // Build generations and tool spans from JSONL entries
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

      // Update entry counts
      entry.llmCallCount = obsResult.llmCallCount;
      entry.toolCallCount += obsResult.toolCallCount;

      // Extract user message for trace input
      const userEntry = turnEntries.find((e) => e.message.role === "user");
      const userInputText = userEntry
        ? extractUserMessageText(userEntry.message.content)
        : undefined;

      // Use aggregated usage if we have per-call data, otherwise use stored usage
      const hasPerCallUsage =
        obsResult.totalUsage.input > 0 ||
        obsResult.totalUsage.output > 0 ||
        obsResult.totalUsage.total > 0;
      const finalUsage = hasPerCallUsage
        ? {
            inputTokens: obsResult.totalUsage.input,
            outputTokens: obsResult.totalUsage.output,
            cacheReadInputTokens: obsResult.totalUsage.cacheRead || undefined,
            cacheWriteInputTokens: obsResult.totalUsage.cacheWrite || undefined,
            totalTokens: obsResult.totalUsage.total,
          }
        : entry.storedUsage
          ? {
              inputTokens: entry.storedUsage.input,
              outputTokens: entry.storedUsage.output,
              cacheReadInputTokens: entry.storedUsage.cacheRead || undefined,
              cacheWriteInputTokens: entry.storedUsage.cacheWrite || undefined,
              totalTokens: entry.storedUsage.total,
            }
          : undefined;

      // Update trace with structured metadata matching yesterday's working format
      entry.trace.update({
        input: userInputText ? redactText(userInputText, redactEnabled) : undefined,
        output: obsResult.lastAssistantText
          ? redactText(obsResult.lastAssistantText, redactEnabled)
          : undefined,
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
            llmCallCount: obsResult.llmCallCount,
            toolCallCount: entry.toolCallCount,
          },
          usage: finalUsage,
          lastModel:
            obsResult.lastModel || obsResult.lastProvider
              ? { provider: obsResult.lastProvider, model: obsResult.lastModel }
              : undefined,
          prompt: entry.promptMatch,
          // Store system prompt once at trace level (not in each generation)
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
  };

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

      // Dynamically import onDiagnosticEvent — this module is only available
      // at runtime inside the openclaw process (not during npm install).
      let onDiagnosticEvent:
        | ((listener: (evt: Record<string, unknown>) => void) => () => void)
        | null = null;
      try {
        const mod = await import("openclaw/plugin-sdk/diagnostics-otel");
        onDiagnosticEvent = mod.onDiagnosticEvent;
      } catch {
        ctx.logger.warn(
          "Langfuse: could not import diagnostics-otel — diagnostic event tracing disabled",
        );
      }

      // Subscribe to diagnostic events for gateway mode tracing.
      // Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
      // but it does emit model.usage diagnostic events after each LLM call.
      if (onDiagnosticEvent) {
        unsubscribeDiagnostics = onDiagnosticEvent((evt: Record<string, unknown>) => {
          try {
            if (disabled || !langfuse || !contextMap) {
              return;
            }
            if (evt.type !== "model.usage") {
              return;
            }

            const diagEvt = evt;
            const sessionKey = String(diagEvt.sessionKey ?? "unknown");
            const agentId = sessionKey.split(":")[1] ?? "unknown";
            const key = TraceContextMap.key(agentId, sessionKey);

            let entry = contextMap.get(key);
            if (!entry) {
              // No trace from before_agent_start — create one now (gateway mode)
              const timestamp = Date.now();
              const traceId = generateTraceId(sessionKey, timestamp);
              const tags = [
                agentId,
                String(diagEvt.channel ?? ""),
                ...(config.tracing?.tags ?? []),
              ].filter(Boolean);
              const trace = langfuse.trace({
                id: traceId,
                name: agentId,
                sessionId: sessionKey,
                tags,
                metadata: {
                  sessionId: diagEvt.sessionId,
                  sessionKey,
                  agentId,
                  channel: diagEvt.channel,
                  timestamp,
                  source: "diagnostic-event",
                },
              });
              entry = {
                trace,
                traceId,
                llmCallCount: 0,
                toolCallCount: 0,
                pendingGenerations: new Map(),
                pendingSpans: new Map(),
                createdAt: timestamp,
                timestamp,
              };
              contextMap.create(key, entry);

              // Fetch prompt client for gateway mode (best-effort, async)
              if (promptManager) {
                const gatewayEntry = entry;
                promptManager
                  .resolve(agentId, {
                    agentId,
                    channelId: String(diagEvt.channel ?? ""),
                    sessionKey,
                  })
                  .then((result) => {
                    if (result) {
                      gatewayEntry.promptClient = result.promptClient;
                    }
                  })
                  .catch(() => {});
              }
            }

            // If agent_end already finalized this entry (created generations from JSONL),
            // skip entirely to avoid duplicate spans/generations.
            if (entry.finalized) {
              serviceLogger?.info?.(
                `Langfuse: skipping diagnostic handler — agent_end already finalized (agent=${agentId})`,
              );
              return;
            }

            // Read session JSONL and filter to current turn only.
            // The JSONL contains the full session history across turns;
            // we only want messages from the latest user message onward.
            const sessionId = String(diagEvt.sessionId ?? "");
            const allEntries = sessionId
              ? readSessionMessages(serviceStateDir, agentId, sessionId, serviceLogger)
              : [];
            const messages = filterCurrentTurnMessages(allEntries.map((e) => e.message));
            const turn = extractConversation(messages);

            // Create tool call spans from session messages (only if llm hooks didn't already)
            if (messages.length > 0 && entry.toolCallCount === 0) {
              createToolSpansFromMessages(messages, entry, redactEnabled);
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
                  output: turn.output ? redactText(turn.output, redactEnabled) : undefined,
                  usageDetails: {
                    input: usage?.input ?? 0,
                    output: usage?.output ?? 0,
                    total: usage?.total ?? 0,
                    ...(usage?.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
                    ...(usage?.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
                  },
                  ...(typeof diagEvt.costUsd === "number"
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
              const llmTurns = extractLLMTurns(messages);

              if (llmTurns.length === 0) {
                // Fallback: no parseable turns, create single generation as before
                entry.llmCallCount += 1;
                const genInput = redactEnabled
                  ? redactObject(turn.input, redactEnabled)
                  : turn.input;
                const genOutput = turn.output ? redactText(turn.output, redactEnabled) : undefined;
                const gen = entry.trace.generation({
                  name: `llm-call-${entry.llmCallCount}`,
                  model: qualifiedModel(
                    String(diagEvt.provider ?? ""),
                    String(diagEvt.model ?? "unknown"),
                  ),
                  startTime,
                  input: {
                    systemPrompt: entry.systemPrompt
                      ? redactText(entry.systemPrompt, redactEnabled)
                      : undefined,
                    messages: genInput,
                  },
                  ...(typeof diagEvt.costUsd === "number"
                    ? { costDetails: { total: diagEvt.costUsd } }
                    : {}),
                  metadata: {
                    provider: String(diagEvt.provider ?? ""),
                    durationMs,
                    cacheRead: usage?.cacheRead,
                    cacheWrite: usage?.cacheWrite,
                    lastUserInput: turn.lastUserText,
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

                  const genInput = redactEnabled
                    ? redactObject(turnInput, redactEnabled)
                    : turnInput;
                  const genOutput = llmTurn.assistantText
                    ? redactText(llmTurn.assistantText, redactEnabled)
                    : undefined;

                  const gen = entry.trace.generation({
                    name: `llm-call-${entry.llmCallCount}`,
                    model: qualifiedModel(
                      String(diagEvt.provider ?? ""),
                      String(diagEvt.model ?? "unknown"),
                    ),
                    input: {
                      // Include system prompt only on the first generation
                      ...(i === 0 && entry.systemPrompt
                        ? {
                            systemPrompt: redactText(entry.systemPrompt, redactEnabled),
                          }
                        : {}),
                      messages: genInput,
                    },
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
                        ...(usage?.cacheWrite
                          ? { cache_creation_input_tokens: usage.cacheWrite }
                          : {}),
                      },
                      ...(typeof diagEvt.costUsd === "number"
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
                output: turn.output ? redactText(turn.output, redactEnabled) : undefined,
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
                  ...(entry.promptMatch && "name" in entry.promptMatch
                    ? { prompt: entry.promptMatch }
                    : {}),
                },
              });
            }

            serviceLogger?.info?.(
              `Langfuse: generation created (agent=${agentId}, model=${diagEvt.model}, tokens=${usage?.total})`,
            );
          } catch (err) {
            serviceLogger?.error?.(
              `Langfuse: diagnostic event handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
            );
          }
        });
      }

      ctx.logger.info(`Langfuse plugin initialized (${baseUrl})`);
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
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
