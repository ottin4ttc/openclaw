import type Langfuse from "langfuse";
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { LangfusePluginConfig } from "./config.js";
import { createToolSpansFromMessages } from "./observations.js";
import type { PromptManager } from "./prompt-manager.js";
import { redactObject, redactText } from "./redact.js";
import { readSessionMessages } from "./session.js";
import { TraceContextMap } from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";
import {
  generateTraceId,
  qualifiedModel,
  extractTextContent,
  extractConversation,
  extractLLMTurns,
  filterCurrentTurnMessages,
} from "./utils.js";

export interface DiagnosticsOptions {
  langfuse: Langfuse;
  contextMap: TraceContextMap;
  logger: PluginLogger | null;
  stateDir: string | null;
  redactEnabled: boolean;
  config: LangfusePluginConfig;
  promptManager: PromptManager | null;
}

/**
 * Subscribe to diagnostic events for gateway mode tracing.
 * Gateway auto-reply does not fire llm_input/llm_output/agent_end hooks,
 * but it does emit model.usage diagnostic events after each LLM call.
 * Returns an unsubscribe function, or null if diagnostics-otel is unavailable.
 */
export async function subscribeDiagnosticEvents(
  opts: DiagnosticsOptions,
): Promise<(() => void) | null> {
  const { langfuse, contextMap, logger, stateDir, redactEnabled, config, promptManager } = opts;

  // Dynamically import onDiagnosticEvent — this module is only available
  // at runtime inside the openclaw process (not during npm install).
  let onDiagnosticEvent: ((listener: (evt: Record<string, unknown>) => void) => () => void) | null =
    null;
  try {
    const mod = await import("openclaw/plugin-sdk/diagnostics-otel");
    onDiagnosticEvent = mod.onDiagnosticEvent;
  } catch {
    logger?.warn?.(
      "Langfuse: could not import diagnostics-otel — diagnostic event tracing disabled",
    );
    return null;
  }

  const unsubscribe = onDiagnosticEvent((evt: Record<string, unknown>) => {
    try {
      if (!langfuse || !contextMap) {
        return;
      }
      if (evt.type !== "model.usage") {
        return;
      }

      const diagEvt = evt;
      const sessionKey = String(diagEvt.sessionKey ?? "unknown");
      const agentId = sessionKey.split(":")[1] ?? "unknown";
      const key = TraceContextMap.key(agentId, sessionKey);

      let entry: TraceContextEntry | undefined = contextMap.get(key);
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
          pendingGenIds: new Map(),
          completedGenerations: new Map(),
          pendingSpans: new Map(),
          completedSpanToolCallIds: new Set(),
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
        logger?.info?.(
          `Langfuse: skipping diagnostic handler — agent_end already finalized (agent=${agentId})`,
        );
        return;
      }

      // Read session JSONL and filter to current turn only.
      // The JSONL contains the full session history across turns;
      // we only want messages from the latest user message onward.
      const sessionId = String(diagEvt.sessionId ?? "");
      const allEntries = sessionId ? readSessionMessages(stateDir, agentId, sessionId, logger) : [];
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
        const llmTurns = extractLLMTurns(messages);

        if (llmTurns.length === 0) {
          // Fallback: no parseable turns, create single generation as before
          entry.llmCallCount += 1;
          const genInput = redactEnabled ? redactObject(turn.input, redactEnabled) : turn.input;
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
            ...(typeof diagEvt.costUsd === "number" && diagEvt.costUsd > 0
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

            const genInput = redactEnabled ? redactObject(turnInput, redactEnabled) : turnInput;
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

      logger?.info?.(
        `Langfuse: generation created (agent=${agentId}, model=${diagEvt.model}, tokens=${usage?.total})`,
      );
    } catch (err) {
      logger?.error?.(
        `Langfuse: diagnostic event handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  });

  return unsubscribe;
}
