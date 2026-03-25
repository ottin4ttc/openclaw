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
import { checkModelCostConfig, formatCostWarning } from "./diagnose.js";
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

type SessionEntry = { timestamp: number; message: Record<string, unknown> };

/**
 * Read messages from a session JSONL file on disk.
 * Returns entries with timestamps so callers can derive accurate startTime/endTime.
 */
function readSessionMessages(agentId: string, sessionId: string): SessionEntry[] {
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
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        const msg = parsed.message as Record<string, unknown>;
        // Derive timestamp: prefer message.timestamp, then outer timestamp field
        let ts: number;
        if (typeof msg.timestamp === "number") {
          ts = msg.timestamp;
        } else if (typeof parsed.timestamp === "string") {
          ts = Date.parse(parsed.timestamp);
        } else if (typeof parsed.timestamp === "number") {
          ts = parsed.timestamp;
        } else {
          ts = Date.now();
        }
        entries.push({ timestamp: ts, message: msg });
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return entries;
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
 * Build an API-shaped message object from a session entry message.
 * Preserves structure: assistant with tool calls, toolResult -> tool role, etc.
 * Matches the actual LLM API request format (see langfuse_api_reference.md).
 */
function buildApiMessage(msg: SessionEntry["message"]): unknown {
  const role = msg.role;

  if (role === "assistant") {
    const textContent = extractTextContent(msg.content);
    if (Array.isArray(msg.content)) {
      const toolCalls = (msg.content as Record<string, unknown>[])
        .filter((b) => b?.type === "toolCall")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input ?? b.args ?? b.arguments ?? {}),
          },
        }));
      if (toolCalls.length > 0) {
        return { role: "assistant", content: textContent || null, tool_calls: toolCalls };
      }
    }
    return { role: "assistant", content: textContent };
  }

  if (role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: msg.toolCallId ?? msg.toolName ?? "unknown",
      content: extractTextContent(msg.content),
    };
  }

  // user, system, etc.
  return { role, content: extractTextContent(msg.content) };
}

/**
 * Extract individual LLM turns from session messages.
 * Each assistant message = one LLM call. Input is the preceding user/toolResult messages.
 */
function extractLLMTurns(messages: unknown[]): Array<{
  inputMessages: unknown[];
  assistantMessage: Record<string, unknown>;
  assistantText: string;
  toolCalls: Array<{ name: string; id: string; input: unknown }>;
}> {
  const turns: Array<{
    inputMessages: unknown[];
    assistantMessage: Record<string, unknown>;
    assistantText: string;
    toolCalls: Array<{ name: string; id: string; input: unknown }>;
  }> = [];
  let currentInput: unknown[] = [];

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "assistant") {
      const toolCalls: Array<{ name: string; id: string; input: unknown }> = [];
      if (Array.isArray(m.content)) {
        for (const block of m.content as Record<string, unknown>[]) {
          if (block?.type === "toolCall") {
            toolCalls.push({
              name: String(block.name ?? "unknown"),
              id: String(block.id ?? ""),
              input: block.input ?? block.args,
            });
          }
        }
      }
      turns.push({
        inputMessages: [...currentInput],
        assistantMessage: m,
        assistantText: extractTextContent(m.content),
        toolCalls,
      });
      currentInput = [];
    } else {
      currentInput.push(msg);
    }
  }

  return turns;
}

/**
 * Filter session entries to only the current agent turn.
 * A turn starts at the last user message; everything after it
 * (assistant responses, toolResults) belongs to that turn.
 */
function filterCurrentTurnEntries(entries: SessionEntry[]): SessionEntry[] {
  let lastUserIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].message.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return entries.slice(lastUserIdx);
}

/**
 * Legacy wrapper: filter plain message arrays (used by diagnostic handler).
 */
function filterCurrentTurnMessages(messages: unknown[]): unknown[] {
  let lastUserIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return messages.slice(lastUserIdx);
}

/**
 * Build structured generation output from assistant message content (D3 format).
 * - Has tool calls + text: {text, toolCalls}
 * - Pure text: direct string
 * - Only tool calls: {toolCalls}
 */
function buildGenerationOutput(content: unknown, redactEnabled: boolean): unknown {
  const text = extractTextContent(content);
  const toolCalls: Array<{
    id: unknown;
    type: string;
    function: { name: string; arguments: string };
  }> = [];

  if (Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === "toolCall") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: String(block.name ?? "unknown"),
            arguments: JSON.stringify(block.input ?? block.args ?? block.arguments ?? {}),
          },
        });
      }
    }
  }

  const redactedText = text ? redactText(text, redactEnabled) : "";

  if (toolCalls.length > 0) {
    return {
      content: redactedText || null,
      tool_calls: toolCalls,
    };
  }
  return redactedText || undefined;
}

/**
 * Extract the plain user message text from a user message content field.
 * Strips the "Sender (untrusted metadata):" wrapper to get the actual user input.
 */
function extractUserMessageText(content: unknown): string {
  const text = extractTextContent(content);
  if (!text) {
    return "";
  }

  // Look for the last line after the metadata JSON block wrapper
  // Pattern: everything after the last "]" followed by newlines + actual text
  const lastClosingBracket = text.lastIndexOf("```");
  if (lastClosingBracket !== -1) {
    const afterBlock = text.slice(lastClosingBracket + 3).trim();
    // Find text after the timestamp line like "[Wed 2026-03-25 17:00 GMT+8]"
    const tsMatch = afterBlock.match(/\[.+?\]\s*([\s\S]+)/);
    if (tsMatch?.[1]?.trim()) {
      return tsMatch[1].trim();
    }
    if (afterBlock) {
      return afterBlock;
    }
  }
  return text;
}

/**
 * Check if a usage object has any non-zero values.
 */
function hasNonZeroUsage(usage: Record<string, number> | undefined): boolean {
  if (!usage) {
    return false;
  }
  return Object.values(usage).some((v) => typeof v === "number" && v > 0);
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
      if (entry && event.prompt) {
        entry.systemPrompt = event.prompt;
      }

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

      // Store data for agent_end to use when creating generations
      if (event.systemPrompt) {
        entry.systemPrompt = event.systemPrompt;
      }
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

    // agent_end: create per-LLM-call generations from JSONL and finalize the trace
    agentEnd(event: AgentEndEvent, ctx: AgentCtx): void {
      if (disabled || !langfuse || !contextMap) {
        return;
      }

      const key = TraceContextMap.key(ctx.agentId, ctx.sessionKey);
      const entry = contextMap.get(key);
      if (!entry) {
        return;
      }

      const agentId = ctx.agentId ?? "unknown";
      const sessionId = entry.sessionId ?? ctx.sessionId ?? "";

      // Read JSONL and filter to current turn
      let allEntries: SessionEntry[] = [];
      let turnEntries: SessionEntry[] = [];
      if (sessionId) {
        allEntries = readSessionMessages(agentId, sessionId);
        turnEntries = filterCurrentTurnEntries(allEntries);
      }

      // Fallback: if JSONL unavailable, build entries from event.messages
      if (turnEntries.length === 0 && Array.isArray(event.messages)) {
        const now = Date.now();
        turnEntries = (event.messages as Record<string, unknown>[]).map((msg, i) => ({
          timestamp: now - (event.messages.length - i) * 1000,
          message: msg,
        }));
      }

      // Create a generation for each assistant message in the turn
      let llmCallCount = 0;
      let lastAssistantText: string | undefined;
      let lastProvider: string | undefined;
      let lastModel: string | undefined;
      let prevTimestamp: number | undefined;

      // Aggregate usage across all assistant messages
      let totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      let hasPerCallUsage = false;

      // Count total assistant messages to know which is last
      const assistantCount = turnEntries.filter((e) => e.message.role === "assistant").length;

      for (const te of turnEntries) {
        const msg = te.message;

        if (msg.role === "assistant") {
          llmCallCount += 1;
          const isLast = llmCallCount === assistantCount;

          const assistantTs = te.timestamp;
          const startTime = prevTimestamp ? new Date(prevTimestamp) : new Date(entry.timestamp);
          const endTime = new Date(assistantTs);

          // Build output (D3 format)
          const output = buildGenerationOutput(msg.content, redactEnabled);

          // Build generation input matching LLM API structure: {model, messages}
          // Use ALL session entries up to this assistant message as input
          // (includes full history + current user message + any prior tool results)
          const systemMessage = entry.systemPrompt
            ? [{ role: "system", content: entry.systemPrompt }]
            : [];
          const allPriorEntries = allEntries.slice(0, allEntries.indexOf(te));
          const accumulatedMessages = allPriorEntries.map((e) => buildApiMessage(e.message));
          const genInput = redactObject(
            {
              model: String(msg.model ?? entry.lastModel ?? "unknown"),
              messages: [...systemMessage, ...accumulatedMessages],
            },
            redactEnabled,
          );

          // Extract per-call usage from JSONL assistant message
          const msgUsage = msg.usage as Record<string, number> | undefined;
          let genUsage: { input?: number; output?: number; total?: number } | undefined;

          if (hasNonZeroUsage(msgUsage)) {
            hasPerCallUsage = true;
            genUsage = {
              input: msgUsage?.input ?? 0,
              output: msgUsage?.output ?? 0,
              total: msgUsage?.totalTokens ?? msgUsage?.total ?? 0,
              ...(msgUsage?.cacheRead ? { cache_read_input_tokens: msgUsage.cacheRead } : {}),
              ...(msgUsage?.cacheWrite ? { cache_creation_input_tokens: msgUsage.cacheWrite } : {}),
            };
            // Aggregate
            totalUsage.input += msgUsage?.input ?? 0;
            totalUsage.output += msgUsage?.output ?? 0;
            totalUsage.cacheRead += msgUsage?.cacheRead ?? 0;
            totalUsage.cacheWrite += msgUsage?.cacheWrite ?? 0;
            totalUsage.total += msgUsage?.totalTokens ?? msgUsage?.total ?? 0;
          } else if (isLast && entry.storedUsage) {
            // Fall back to stored usage from llm_output for last generation
            genUsage = {
              input: entry.storedUsage.input,
              output: entry.storedUsage.output,
              total: entry.storedUsage.total,
            };
            totalUsage.input += entry.storedUsage.input ?? 0;
            totalUsage.output += entry.storedUsage.output ?? 0;
            totalUsage.cacheRead += entry.storedUsage.cacheRead ?? 0;
            totalUsage.cacheWrite += entry.storedUsage.cacheWrite ?? 0;
            totalUsage.total += entry.storedUsage.total ?? 0;
          }

          const model = String(msg.model ?? entry.lastModel ?? "unknown");
          const provider = String(msg.provider ?? entry.lastProvider ?? "");

          entry.trace.generation({
            name: `llm-call-${llmCallCount}`,
            model,
            startTime,
            endTime,
            input: truncatePayload(genInput),
            output: truncatePayload(output),
            usageDetails: genUsage as Record<string, number> | undefined,
            metadata: {
              provider,
              model: msg.model,
              stopReason: msg.stopReason,
              ...(msgUsage?.cost ? { cost: msgUsage.cost } : {}),
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
          });

          // Track last assistant text for trace output
          const text = extractTextContent(msg.content);
          if (text) {
            lastAssistantText = text;
          }
          lastProvider = provider;
          lastModel = model;
        } else {
          // non-assistant entries (user, toolResult) are captured via allEntries
        }

        prevTimestamp = te.timestamp;
      }

      // Update entry counts
      entry.llmCallCount = llmCallCount;

      // Extract user message for trace input
      const userEntry = turnEntries.find((e) => e.message.role === "user");
      const userInputText = userEntry
        ? extractUserMessageText(userEntry.message.content)
        : undefined;

      // Use aggregated usage if we have per-call data, otherwise use stored usage
      const finalUsage = hasPerCallUsage
        ? {
            inputTokens: totalUsage.input,
            outputTokens: totalUsage.output,
            cacheReadInputTokens: totalUsage.cacheRead || undefined,
            cacheWriteInputTokens: totalUsage.cacheWrite || undefined,
            totalTokens: totalUsage.total,
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
            llmCallCount,
            toolCallCount: entry.toolCallCount,
          },
          usage: finalUsage,
          lastModel:
            lastModel || lastProvider ? { provider: lastProvider, model: lastModel } : undefined,
          prompt: entry.promptMatch,
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

      // Check for missing model cost config that causes zero usage data
      try {
        const costIssues = checkModelCostConfig();
        if (costIssues.length > 0) {
          ctx.logger.warn(formatCostWarning(costIssues));
        }
      } catch {
        // Non-critical check — don't block startup
      }

      langfuse = new Langfuse({ publicKey, secretKey, baseUrl });
      contextMap = new TraceContextMap();
      contextMap.startSweep();
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

            // Read session JSONL and filter to current turn only.
            // The JSONL contains the full session history across turns;
            // we only want messages from the latest user message onward.
            const sessionId = String(diagEvt.sessionId ?? "");
            const allEntries = sessionId ? readSessionMessages(agentId, sessionId) : [];
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
                  metadata: {
                    costUsd: diagEvt.costUsd,
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
                    model: String(diagEvt.model ?? "unknown"),
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
                      metadata: {
                        costUsd: diagEvt.costUsd,
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
