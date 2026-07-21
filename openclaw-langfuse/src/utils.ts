/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import { createHash } from "node:crypto";
import { redactObject, redactText } from "./redact.js";
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
 * Return the timestamp embedded in the persisted message when available.
 * For user/toolResult rows this is the event time. For assistant rows this is
 * the model-call start time in current OpenClaw session JSONL.
 */
export function messageTimestamp(entry: SessionEntry): number {
  const raw = entry.message.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return entry.timestamp;
}

/**
 * Assistant rows carry two useful times:
 * - message.timestamp: model call start
 * - outer row timestamp: assistant response persisted/completed
 */
export function assistantStartTimestamp(entry: SessionEntry): number {
  return messageTimestamp(entry);
}

export function assistantEndTimestamp(entry: SessionEntry): number {
  return entry.timestamp;
}

/**
 * Truncate a payload to MAX_PAYLOAD_BYTES. Returns original object if small
 * enough, otherwise a truncated string with a size notice.
 */
export function truncatePayload(obj: unknown): unknown {
  if (obj === undefined || obj === null) {
    return obj;
  }
  let serialized = safeJsonStringify(obj);
  let payload = obj;
  if (serialized === undefined) {
    try {
      payload = normalizeJsonPayload(obj, new WeakSet<object>());
      serialized = JSON.stringify(payload);
    } catch {
      payload = "[unserializable: payload]";
      serialized = JSON.stringify(payload);
    }
  }
  if (!serialized) {
    return payload;
  }
  const byteLength = Buffer.byteLength(serialized, "utf-8");
  if (byteLength <= MAX_PAYLOAD_BYTES) {
    return payload;
  }
  const originalKb = Math.round(byteLength / 1024);
  const notice = `\n[truncated: original size ${originalKb}kb]`;
  let lo = 0;
  let hi = serialized.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const candidate = serialized.slice(0, mid) + notice;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf-8") <= MAX_PAYLOAD_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Never split a UTF-16 surrogate pair at the truncation boundary.
  if (lo > 0 && lo < serialized.length) {
    const previous = serialized.charCodeAt(lo - 1);
    const next = serialized.charCodeAt(lo);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      lo -= 1;
    }
  }
  return serialized.slice(0, lo) + notice;
}

function safeJsonStringify(obj: unknown): string | undefined {
  try {
    return JSON.stringify(obj);
  } catch {
    return undefined;
  }
}

function normalizeJsonPayload(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") {
    return "[unserializable: bigint]";
  }
  if (typeof value === "function") {
    return "[unserializable: function]";
  }
  if (typeof value === "symbol") {
    return "[unserializable: symbol]";
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[unserializable: circular]";
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeJsonPayload(item, seen));
    seen.delete(value);
    return normalized;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    try {
      normalized[key] = normalizeJsonPayload((value as Record<string, unknown>)[key], seen);
    } catch {
      normalized[key] = "[unserializable: property]";
    }
  }
  seen.delete(value);
  return normalized;
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
 * Codex app-server mirrors reasoning items as assistant transcript rows with
 * a stable `${turnId}:reasoning` identity. User-visible assistant text can
 * legitimately start with "Codex reasoning:", so text alone is not a marker.
 */
export function isReasoningOnlyAssistantMessage(msg: SessionEntry["message"]): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  const openclaw = (msg as Record<string, unknown>).__openclaw as
    | Record<string, unknown>
    | undefined;
  const mirrorIdentity = openclaw?.mirrorIdentity;
  if (typeof mirrorIdentity === "string" && mirrorIdentity.endsWith(":reasoning")) {
    return true;
  }
  return false;
}

/**
 * Codex app-server mirrors native tool calls as assistant transcript rows so
 * OpenClaw history can show tool progress. They are not separate model calls;
 * the turn-level token usage is attached to the final `${turnId}:assistant`.
 */
export function isCodexToolCallMirrorMessage(msg: SessionEntry["message"]): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  const openclaw = (msg as Record<string, unknown>).__openclaw as
    | Record<string, unknown>
    | undefined;
  const mirrorIdentity = openclaw?.mirrorIdentity;
  if (
    typeof mirrorIdentity !== "string" ||
    !mirrorIdentity.includes(":tool:") ||
    !mirrorIdentity.endsWith(":call")
  ) {
    return false;
  }
  if (!Array.isArray(msg.content) || !msg.content.some((block) => isToolCallBlock(block))) {
    return false;
  }
  return !hasNonZeroUsage(msg.usage as Record<string, number> | undefined);
}

export function isTranscriptOnlyAssistantMessage(msg: SessionEntry["message"]): boolean {
  return isReasoningOnlyAssistantMessage(msg) || isCodexToolCallMirrorMessage(msg);
}

export function isTraceableAssistantEntry(entry: SessionEntry): boolean {
  return entry.message.role === "assistant" && !isTranscriptOnlyAssistantMessage(entry.message);
}

export function isTraceContextInputEntry(entry: SessionEntry): boolean {
  return !isTranscriptOnlyAssistantMessage(entry.message);
}

const MAX_TEXT_CONTENT_DEPTH = 32;

/**
 * Extract text content from a message content field.
 * Handles both plain string content and content-block arrays.
 */
export function extractTextContent(content: unknown): string {
  return extractTextContentInner(content, 0, new WeakSet<object>());
}

function extractTextContentInner(content: unknown, depth: number, seen: WeakSet<object>): string {
  if (depth > MAX_TEXT_CONTENT_DEPTH) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    if (seen.has(content)) {
      return "";
    }
    seen.add(content);
    const extracted = content
      .map((block) => extractTextContentInner(block, depth + 1, seen))
      .filter(Boolean)
      .join("\n");
    seen.delete(content);
    return extracted;
  }
  if (content && typeof content === "object") {
    if (seen.has(content)) {
      return "";
    }
    seen.add(content);
    const block = content as Record<string, unknown>;
    if (typeof block.text === "string") {
      seen.delete(content);
      return block.text;
    }
    if ("content" in block) {
      const extracted = extractTextContentInner(block.content, depth + 1, seen);
      seen.delete(content);
      return extracted;
    }
    seen.delete(content);
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
            arguments: JSON.stringify(
              redactObject(block.input ?? block.args ?? block.arguments ?? {}, redactEnabled),
            ),
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

  const senderSentinel = "Sender (untrusted metadata):";
  const senderStart = text.indexOf(senderSentinel);
  if (senderStart !== -1) {
    const fenceStart = text.indexOf("```json", senderStart + senderSentinel.length);
    const fenceEnd = fenceStart === -1 ? -1 : text.indexOf("```", fenceStart + 7);
    if (fenceEnd === -1) {
      return text;
    }
    const afterBlock = text.slice(fenceEnd + 3).trim();
    // Find text after the timestamp line like "[Wed 2026-03-25 17:00 GMT+8]"
    const tsMatch = afterBlock.match(/^\[[^\]]+\]\s*([\s\S]+)/);
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

export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export function usageDetailsFromUsage(
  usage: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!hasNonZeroUsage(usage)) {
    return undefined;
  }

  const total = usageTotalFromUsage(usage);
  return {
    ...(typeof usage.input === "number" ? { input: usage.input } : {}),
    ...(typeof usage.output === "number" ? { output: usage.output } : {}),
    ...(typeof total === "number" ? { total } : {}),
    ...(typeof usage.cacheRead === "number" ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(typeof usage.cacheWrite === "number"
      ? { cache_creation_input_tokens: usage.cacheWrite }
      : {}),
    ...(typeof usage.reasoningTokens === "number"
      ? { reasoning_tokens: usage.reasoningTokens }
      : {}),
  };
}

export function addUsageToTotals(
  totals: UsageTotals,
  usage: Record<string, number> | undefined,
): void {
  if (!usage) {
    return;
  }

  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.total += usageTotalFromUsage(usage) ?? 0;
}

function usageTotalFromUsage(usage: Record<string, number>): number | undefined {
  const explicitTotal = usage.totalTokens ?? usage.total;
  if (typeof explicitTotal === "number") {
    return explicitTotal;
  }
  if (typeof usage.input === "number" || typeof usage.output === "number") {
    return (usage.input ?? 0) + (usage.output ?? 0);
  }
  return undefined;
}

export function findAggregateOnlyUsageEntry(
  assistantEntries: SessionEntry[],
  turnEntries: SessionEntry[],
): SessionEntry | undefined {
  if (assistantEntries.length <= 1) {
    return undefined;
  }

  const usageEntries = assistantEntries.filter((entry) =>
    hasNonZeroUsage(entry.message.usage as Record<string, number> | undefined),
  );
  if (usageEntries.length !== 1 || usageEntries[0] !== assistantEntries.at(-1)) {
    return undefined;
  }

  const aggregateIndex = turnEntries.indexOf(usageEntries[0]);
  const hasPriorToolResult = turnEntries
    .slice(0, aggregateIndex)
    .some((entry) => entry.message.role === "toolResult");
  return hasPriorToolResult ? usageEntries[0] : undefined;
}
