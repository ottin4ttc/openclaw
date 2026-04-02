/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import { createHash } from "node:crypto";
import { redactText } from "./redact.js";
import type { SessionEntry } from "./types.js";

export const MAX_PAYLOAD_BYTES = 100 * 1024; // 100KB

/** Build qualified model name: provider/model (e.g. zenmux-anthropic/anthropic/claude-opus-4.6) */
export function qualifiedModel(provider: string | undefined, model: string | undefined): string {
  const m = String(model ?? "unknown");
  if (provider && !m.startsWith(provider + "/")) {
    return `${provider}/${m}`;
  }
  return m;
}

/**
 * Generate a deterministic trace ID from session key and timestamp.
 * Exported so external callers can compute the same ID.
 */
export function generateTraceId(sessionKey: string, timestamp: number): string {
  return createHash("sha256").update(`${sessionKey}:${timestamp}`).digest("hex").slice(0, 32);
}

/**
 * Generate a deterministic observation ID for a generation or span.
 * - Generations: `${traceId}-gen-${N}` where N is 1-based call index
 * - Spans: `${traceId}-span-${toolCallId}`
 */
export function generateObservationId(traceId: string, type: "gen", index: number): string;
export function generateObservationId(traceId: string, type: "span", toolCallId: string): string;
export function generateObservationId(
  traceId: string,
  type: "gen" | "span",
  indexOrToolCallId: number | string,
): string {
  if (type === "gen") {
    return `${traceId}-gen-${indexOrToolCallId}`;
  }
  return `${traceId}-span-${indexOrToolCallId}`;
}

/**
 * Truncate a payload to MAX_PAYLOAD_BYTES. Returns original object if small
 * enough, otherwise a truncated string with a size notice.
 */
export function truncatePayload(obj: unknown): unknown {
  if (obj === undefined || obj === null) {
    return obj;
  }
  const serialized = JSON.stringify(obj);
  if (!serialized) {
    return obj;
  }
  const byteLength = Buffer.byteLength(serialized, "utf-8");
  if (byteLength <= MAX_PAYLOAD_BYTES) {
    return obj;
  }
  // Truncate by characters but respect the byte budget.
  // Binary-search for the character count that fits within MAX_PAYLOAD_BYTES.
  let lo = 0;
  let hi = serialized.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(serialized.slice(0, mid), "utf-8") <= MAX_PAYLOAD_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const originalKb = Math.round(byteLength / 1024);
  return serialized.slice(0, lo) + `\n[truncated: original size ${originalKb}kb]`;
}

/**
 * Check if a content block is a tool call (OpenClaw `toolCall` or Anthropic API `tool_use`).
 */
export function isToolCallBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== "object") {
    return false;
  }
  const b = block as Record<string, unknown>;
  return b.type === "toolCall" || b.type === "tool_use";
}

/**
 * Extract text content from a message content field.
 * Handles both plain string content and content-block arrays.
 */
export function extractTextContent(content: unknown): string {
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
export function extractConversation(messages: unknown[]): {
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
        .filter((b) => isToolCallBlock(b))
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
export function buildApiMessage(msg: SessionEntry["message"]): unknown {
  const role = msg.role;

  if (role === "assistant") {
    const textContent = extractTextContent(msg.content);
    if (Array.isArray(msg.content)) {
      const toolCalls = (msg.content as Record<string, unknown>[])
        .filter((b) => isToolCallBlock(b))
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
export function extractLLMTurns(messages: unknown[]): Array<{
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
          if (isToolCallBlock(block)) {
            toolCalls.push({
              name: String(block.name ?? "unknown"),
              id: String(block.id ?? ""),
              input: block.input ?? block.args ?? block.arguments,
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
export function filterCurrentTurnEntries(entries: SessionEntry[]): SessionEntry[] {
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
export function filterCurrentTurnMessages(messages: unknown[]): unknown[] {
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
export function buildGenerationOutput(content: unknown, redactEnabled: boolean): unknown {
  const text = extractTextContent(content);
  const toolCalls: Array<{
    id: unknown;
    type: string;
    function: { name: string; arguments: string };
  }> = [];

  if (Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      if (isToolCallBlock(block)) {
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
export function extractUserMessageText(content: unknown): string {
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
export function hasNonZeroUsage(usage: Record<string, number> | undefined): boolean {
  if (!usage) {
    return false;
  }
  return Object.values(usage).some((v) => typeof v === "number" && v > 0);
}
