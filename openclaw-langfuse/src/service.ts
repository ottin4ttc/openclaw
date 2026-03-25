/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Langfuse from "langfuse";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk";
import { resolveCredentials } from "./config.js";
import type { LangfusePluginConfig } from "./config.js";
import { findMatchingRule } from "./matcher.js";
import { PromptManager } from "./prompt-manager.js";
import { redactText, redactObject } from "./redact.js";
import { TraceContextMap } from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";

const MAX_PAYLOAD_BYTES = 100 * 1024; // 100KB

// ---------------------------------------------------------------------------
// Local hook event/context type definitions (subset of what we use).
// These mirror the canonical types in src/plugins/types.ts but are defined
// locally because they are not re-exported from openclaw/plugin-sdk.
// ---------------------------------------------------------------------------

type AgentCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  channelId?: string;
  trigger?: string;
};

type ToolCtx = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  toolCallId?: string;
};

type SessionCtx = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};

type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type BeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

type BeforeAgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

type BeforeAgentStartResult = BeforePromptBuildResult & {
  modelOverride?: string;
  providerOverride?: string;
};

type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};

// ---------------------------------------------------------------------------

/**
 * Generate a deterministic trace ID from session key and timestamp.
 * Exported so external callers can compute the same ID.
 */
export function generateTraceId(sessionKey: string, timestamp: number): string {
  return createHash("sha256").update(`${sessionKey}:${timestamp}`).digest("hex").slice(0, 32);
}

/**
 * Truncate a payload to MAX_PAYLOAD_BYTES. Returns original object if small
 * enough, otherwise a truncated string with a size notice.
 */
function truncatePayload(obj: unknown): unknown {
  if (obj === undefined || obj === null) {
    return obj;
  }
  const serialized = JSON.stringify(obj);
  if (!serialized || serialized.length <= MAX_PAYLOAD_BYTES) {
    return obj;
  }
  const originalKb = Math.round(serialized.length / 1024);
  return serialized.slice(0, MAX_PAYLOAD_BYTES) + `\n[truncated: original size ${originalKb}kb]`;
}

// ---------------------------------------------------------------------------
// Session JSONL reading helpers (for gateway mode content extraction)
// ---------------------------------------------------------------------------

/**
 * Read messages from a session JSONL file on disk.
 * Returns an array of message objects ({ role, content, ... }).
 */
function readSessionMessages(agentId: string, sessionId: string): unknown[] {
  const homeDir = os.homedir();
  const sessionFile = path.join(
    homeDir,
    ".openclaw",
    "agents",
    agentId,
    "sessions",
    `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(sessionFile)) {
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  const messages: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        messages.push(parsed.message);
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return messages;
}

/**
 * Extract text content from a message content field.
 * Handles both plain string content and content-block arrays.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is Record<string, unknown> =>
          b !== null && typeof b === "object" && (b as Record<string, unknown>).type === "text",
      )
      .map((b) => String(b.text ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * Extract the full conversation as structured input and the last assistant response as output.
 * Input includes all messages as a structured array for full context visibility.
 * Output is the last assistant text response.
 */
function extractConversation(messages: unknown[]): {
  input: unknown[];
  output: string;
  lastUserText: string;
} {
  let lastAssistantText = "";
  let lastUserText = "";

  // Find last assistant output and last user input
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === "assistant" && !lastAssistantText) {
      lastAssistantText = extractTextContent(msg.content);
    }
    if (msg.role === "user" && !lastUserText) {
      lastUserText = extractTextContent(msg.content);
      break;
    }
  }

  // Build structured input: summarize each message with role + content preview
  const input = messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const text = extractTextContent(m.content);
    // For toolResult, include toolName
    if (role === "toolResult") {
      return {
        role,
        toolName: m.toolName ?? m.toolCallId,
        content: text.length > 2000 ? text.slice(0, 2000) + "...[truncated]" : text,
      };
    }
    // For assistant with toolCall, show tool calls
    if (role === "assistant" && Array.isArray(m.content)) {
      const toolCalls = (m.content as Record<string, unknown>[])
        .filter((b) => b?.type === "toolCall")
        .map((b) => ({ name: b.name, id: b.id }));
      if (toolCalls.length > 0) {
        return { role, toolCalls, text: text.length > 500 ? text.slice(0, 500) + "..." : text };
      }
    }
    return {
      role,
      content: text.length > 2000 ? text.slice(0, 2000) + "...[truncated]" : text,
    };
  });

  return { input, output: lastAssistantText, lastUserText };
}

/**
 * Create Langfuse spans for tool calls found in session messages.
 */
function createToolSpansFromMessages(
  messages: unknown[],
  entry: TraceContextEntry,
  redactEnabled: boolean,
): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown> | null;
        if (!b || b.type !== "toolCall") {
          continue;
        }

        entry.toolCallCount += 1;

        // Find matching toolResult
        const toolResultMsg = messages.find((r) => {
          const rm = r as Record<string, unknown>;
          return rm.role === "toolResult" && rm.toolCallId === b.id;
        }) as Record<string, unknown> | undefined;

        const toolInput = truncatePayload(b.input ?? b.args);
        const toolOutput = toolResultMsg ? extractTextContent(toolResultMsg.content) : undefined;

        entry.trace.span({
          name: `tool:${String(b.name ?? "unknown")}`,
          input: redactObject(toolInput, redactEnabled),
          output: toolOutput
            ? redactText(String(truncatePayload(toolOutput)), redactEnabled)
            : undefined,
          metadata: { toolCallId: b.id },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------

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
  agentEnd: (event: AgentEndEvent, ctx: AgentCtx) => void;
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
      if (entry) {
        // Capture the user prompt as system prompt context (event.prompt contains the user input,
        // but more importantly event.messages may have system-level context)
        // The actual system prompt is built by OpenClaw internally and not directly exposed,
        // but we can capture what's available
        if (event.prompt) {
          entry.systemPrompt = event.prompt;
        }

        // Record prompt match info and fetch prompt client for generation linking
        if (promptManager) {
          const agentId = ctx.agentId ?? "unknown";
          const capturedEntry = entry;
          promptManager
            .resolve(agentId, {
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              sessionKey: ctx.sessionKey,
              trigger: ctx.trigger,
            })
            .then((result) => {
              if (result) {
                capturedEntry.promptMatch = result.matchInfo;
                capturedEntry.promptClient = result.promptClient;
                serviceLogger?.debug?.(
                  `Langfuse: prompt client fetched for "${result.matchInfo.name}" (agent=${agentId})`,
                );
              }
            })
            .catch((err: unknown) => {
              serviceLogger?.warn?.(
                `Langfuse: failed to resolve prompt (agent=${agentId}): ${err}`,
              );
            });
        } else if (config.prompts?.length) {
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
      if (contextMap.get(existingKey)) {
        return;
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
        llmCallCount: 0,
        toolCallCount: 0,
        pendingGenerations: new Map(),
        pendingSpans: new Map(),
        createdAt: Date.now(),
        timestamp,
      };

      contextMap.create(TraceContextMap.key(ctx.agentId, ctx.sessionKey), entry);
      serviceLogger?.info?.(`Langfuse: trace created (agent=${ctx.agentId}, traceId=${traceId})`);
    },

    // llm_input: start a generation span for this LLM call (CLI mode only)
    llmInput(event: LlmInputEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      let entry = contextMap.get(key);

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
      }

      // Capture system prompt for trace metadata and diagnostic event fallback
      if (event.systemPrompt) {
        entry.systemPrompt = event.systemPrompt;
      }

      entry.llmCallCount += 1;

      const startTime = new Date();
      const generation = entry.trace.generation({
        name: `llm-call-${entry.llmCallCount}`,
        model: event.model,
        startTime,
        input: redactObject(
          {
            systemPrompt: event.systemPrompt,
            prompt: event.prompt,
            historyMessages: event.historyMessages,
          },
          redactEnabled,
        ),
        metadata: {
          provider: event.provider,
          runId: event.runId,
          imagesCount: event.imagesCount,
        },
        // Link generation to Langfuse prompt (makes Observations count > 0)
        ...(entry.promptClient ? { prompt: entry.promptClient } : {}),
      });

      entry.pendingGenerations.set(event.runId, generation);
    },

    // llm_output: end the generation span (CLI mode only)
    llmOutput(event: LlmOutputEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      const generation = entry.pendingGenerations.get(event.runId);
      if (!generation) {
        return;
      }

      // Extract thinking content if present in lastAssistant block
      let thinkingText: string | undefined;
      if (
        event.lastAssistant &&
        typeof event.lastAssistant === "object" &&
        (event.lastAssistant as Record<string, unknown>)["type"] === "thinking"
      ) {
        const thinking = event.lastAssistant as Record<string, unknown>;
        thinkingText = typeof thinking["thinking"] === "string" ? thinking["thinking"] : undefined;
      }

      generation.end({
        output: redactText(event.assistantTexts.join("\n"), redactEnabled),
        usage: {
          input: event.usage?.input,
          output: event.usage?.output,
          total: event.usage?.total,
        },
        metadata: {
          cacheRead: event.usage?.cacheRead,
          cacheWrite: event.usage?.cacheWrite,
          thinkingContent: thinkingText,
          provider: event.provider,
          model: event.model,
        },
      });

      entry.pendingGenerations.delete(event.runId);
    },

    // before_tool_call: start a span for the tool call (CLI mode only)
    beforeToolCall(event: BeforeToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      entry.toolCallCount += 1;

      const truncatedParams = truncatePayload(event.params);

      const span = entry.trace.span({
        name: `tool:${event.toolName}`,
        input: redactObject(truncatedParams, redactEnabled),
        metadata: {
          runId: event.runId,
          toolCallId: event.toolCallId,
        },
      });

      if (event.toolCallId) {
        entry.pendingSpans.set(event.toolCallId, span);
      }
    },

    // after_tool_call: end the tool span (CLI mode only)
    afterToolCall(event: AfterToolCallEvent, ctx: ToolCtx): void {
      if (disabled || !langfuse) {
        return;
      }

      const entry = getEntry(ctx.agentId, ctx.sessionKey);
      if (!entry) {
        return;
      }

      if (!event.toolCallId) {
        return;
      }
      const span = entry.pendingSpans.get(event.toolCallId);
      if (!span) {
        return;
      }

      const truncatedResult = truncatePayload(event.result);

      span.end({
        output: event.error ? { error: event.error } : redactObject(truncatedResult, redactEnabled),
        statusMessage: event.error,
        level: event.error ? "ERROR" : "DEFAULT",
        metadata: {
          durationMs: event.durationMs,
        },
      });

      entry.pendingSpans.delete(event.toolCallId);
    },

    // agent_end: finalize the trace (CLI mode only)
    agentEnd(event: AgentEndEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      const entry = contextMap.get(key);
      if (!entry) {
        return;
      }

      // Extract last assistant text from messages
      let lastAssistantText: string | undefined;
      if (Array.isArray(event.messages)) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          if (
            msg &&
            typeof msg === "object" &&
            (msg as Record<string, unknown>)["role"] === "assistant"
          ) {
            const content = (msg as Record<string, unknown>)["content"];
            if (typeof content === "string") {
              lastAssistantText = content;
            } else if (Array.isArray(content)) {
              const texts = content
                .filter(
                  (block): block is Record<string, unknown> =>
                    block !== null &&
                    typeof block === "object" &&
                    (block as Record<string, unknown>)["type"] === "text",
                )
                .map((block) => String(block["text"] ?? ""));
              if (texts.length > 0) {
                lastAssistantText = texts.join("\n");
              }
            }
            break;
          }
        }
      }

      entry.trace.update({
        output: lastAssistantText ? redactText(lastAssistantText, redactEnabled) : undefined,
        metadata: {
          success: event.success,
          durationMs: event.durationMs,
          messageCount: event.messages?.length,
          llmCallCount: entry.llmCallCount,
          toolCallCount: entry.toolCallCount,
          prompt: entry.promptMatch,
        },
        ...(event.error
          ? {
              statusMessage: event.error,
              level: "ERROR" as const,
            }
          : {}),
      });

      contextMap.delete(key);
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
      const { publicKey, secretKey, baseUrl } = resolveCredentials(config);

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "Langfuse plugin: missing publicKey or secretKey — tracing disabled. " +
            "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars or configure them in pluginConfig.",
        );
        disabled = true;
        return;
      }

      langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
      contextMap = new TraceContextMap();
      contextMap.startSweep();
      disabled = false;
      promptManager = config.prompts?.length ? new PromptManager(langfuse, config) : null;

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

            // Read session JSONL to get full input/output content
            const sessionId = String(diagEvt.sessionId ?? "");
            const messages = sessionId ? readSessionMessages(agentId, sessionId) : [];
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
                  usage: {
                    input: usage?.input,
                    output: usage?.output,
                    total: usage?.total,
                  },
                  metadata: {
                    costUsd: diagEvt.costUsd,
                    durationMs,
                    cacheRead: usage?.cacheRead,
                    cacheWrite: usage?.cacheWrite,
                  },
                });
                entry.pendingGenerations.delete(runId);
              }
            } else {
              // llm_input didn't fire — create generation from diagnostic event + JSONL
              entry.llmCallCount += 1;
              const genInput = redactEnabled ? redactObject(turn.input, redactEnabled) : turn.input;
              const genOutput = turn.output ? redactText(turn.output, redactEnabled) : undefined;

              const gen = entry.trace.generation({
                name: `llm-call-${entry.llmCallCount}`,
                model: String(diagEvt.model ?? "unknown"),
                startTime,
                input: {
                  systemPrompt: entry.systemPrompt
                    ? redactText(entry.systemPrompt, redactEnabled)
                    : undefined,
                  messages: genInput,
                },
                metadata: {
                  provider: String(diagEvt.provider ?? ""),
                  costUsd: diagEvt.costUsd,
                  durationMs,
                  cacheRead: usage?.cacheRead,
                  cacheWrite: usage?.cacheWrite,
                  lastUserInput: turn.lastUserText,
                },
                // Link generation to Langfuse prompt (makes Observations count > 0)
                ...(entry.promptClient ? { prompt: entry.promptClient } : {}),
              });
              gen.update({
                endTime,
                output: genOutput,
                usage: {
                  input: usage?.input,
                  output: usage?.output,
                  total: usage?.total,
                },
              });
            }

            // Update trace with output and full metadata
            entry.trace.update({
              output: turn.output ? redactText(turn.output, redactEnabled) : undefined,
              metadata: {
                durationMs,
                llmCallCount: entry.llmCallCount,
                costUsd: diagEvt.costUsd,
                provider: diagEvt.provider,
                model: diagEvt.model,
                messageCount: messages.length,
              },
            });

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
