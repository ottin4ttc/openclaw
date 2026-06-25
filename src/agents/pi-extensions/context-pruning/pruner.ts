import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { EffectiveContextPruningSettings } from "./settings.js";
import { makeToolPrunablePredicate } from "./tools.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
const IMAGE_CHAR_ESTIMATE = 8_000;
const PRUNED_CONTEXT_IMAGE_MARKER = "[image removed during context pruning]";

function asText(text: string): TextContent {
  return { type: "text", text };
}

function collectTextSegments(content: ReadonlyArray<TextContent | ImageContent>): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts;
}

function collectPrunableToolResultSegments(
  content: ReadonlyArray<TextContent | ImageContent>,
): string[] {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      parts.push(PRUNED_CONTEXT_IMAGE_MARKER);
    }
  }
  return parts;
}

function estimateJoinedTextLength(parts: string[]): number {
  if (parts.length === 0) {
    return 0;
  }
  let len = 0;
  for (const p of parts) {
    len += p.length;
  }
  // Joined with "\n" separators between blocks.
  len += Math.max(0, parts.length - 1);
  return len;
}

function takeHeadFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  let out = "";
  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) {
      out += "\n";
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

function takeTailFromJoinedText(parts: string[], maxChars: number): string {
  if (maxChars <= 0 || parts.length === 0) {
    return "";
  }
  let remaining = maxChars;
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) {
      out.push("\n");
      remaining -= 1;
    }
  }
  out.reverse();
  return out.join("");
}

function hasImageBlocks(content: ReadonlyArray<TextContent | ImageContent>): boolean {
  for (const block of content) {
    if (block.type === "image") {
      return true;
    }
  }
  return false;
}

function estimateTextAndImageChars(content: ReadonlyArray<TextContent | ImageContent>): number {
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") {
      chars += block.text.length;
    }
    if (block.type === "image") {
      chars += IMAGE_CHAR_ESTIMATE;
    }
  }
  return chars;
}

function estimateMessageChars(message: AgentMessage): number {
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      return content.length;
    }
    return estimateTextAndImageChars(content);
  }

  if (message.role === "assistant") {
    let chars = 0;
    for (const b of message.content) {
      if (!b || typeof b !== "object") {
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") {
        chars += b.text.length;
      }
      if (b.type === "thinking" && typeof b.thinking === "string") {
        chars += b.thinking.length;
      }
      if (b.type === "toolCall") {
        try {
          chars += JSON.stringify(b.arguments ?? {}).length;
        } catch {
          chars += 128;
        }
      }
    }
    return chars;
  }

  if (message.role === "toolResult") {
    return estimateTextAndImageChars(message.content);
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}

function findAssistantCutoffIndex(
  messages: AgentMessage[],
  keepLastAssistants: number,
): number | null {
  // keepLastAssistants <= 0 => everything is potentially prunable.
  if (keepLastAssistants <= 0) {
    return messages.length;
  }

  // Find the last real user message (non-toolResult). Everything after it
  // belongs to the current turn and is automatically protected. This ensures
  // keepLastAssistants only counts pre-turn assistants, so the cutoff stays
  // stable as new assistant/tool_result messages accumulate within a turn.
  let searchFrom = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      searchFrom = i;
      break;
    }
  }

  let remaining = keepLastAssistants;
  for (let i = searchFrom; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") {
      continue;
    }
    remaining--;
    if (remaining === 0) {
      return i;
    }
  }

  // Not enough assistant messages to establish a protected tail.
  return null;
}

function findFirstUserIndex(messages: AgentMessage[]): number | null {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }
  return null;
}

function softTrimToolResultMessage(params: {
  msg: ToolResultMessage;
  settings: EffectiveContextPruningSettings;
}): ToolResultMessage | null {
  const { msg, settings } = params;
  const hasImages = hasImageBlocks(msg.content);
  const parts = hasImages
    ? collectPrunableToolResultSegments(msg.content)
    : collectTextSegments(msg.content);
  const rawLen = estimateJoinedTextLength(parts);
  if (rawLen <= settings.softTrim.maxChars) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const headChars = Math.max(0, settings.softTrim.headChars);
  const tailChars = Math.max(0, settings.softTrim.tailChars);
  if (headChars + tailChars >= rawLen) {
    if (!hasImages) {
      return null;
    }
    return { ...msg, content: [asText(parts.join("\n"))] };
  }

  const head = takeHeadFromJoinedText(parts, headChars);
  const tail = takeTailFromJoinedText(parts, tailChars);
  const trimmed = `${head}
...
${tail}`;

  const note = `

[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return { ...msg, content: [asText(trimmed + note)] };
}

function getMessageTimestamp(msg: AgentMessage): number | null {
  const ts = (msg as unknown as { timestamp?: unknown }).timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

function isAgeEligible(msg: AgentMessage, referenceTime: number, ttlMs: number): boolean {
  if (ttlMs <= 0) {
    return false;
  }
  const ts = getMessageTimestamp(msg);
  if (ts === null) {
    return false;
  }
  return referenceTime - ts >= ttlMs;
}

export function pruneContextMessages(params: {
  messages: AgentMessage[];
  settings: EffectiveContextPruningSettings;
  ctx: Pick<ExtensionContext, "model">;
  isToolPrunable?: (toolName: string) => boolean;
  contextWindowTokensOverride?: number;
  /**
   * Reference time used to compute each tool result's age. Should be the current
   * turn's start time so decisions remain stable across all LLM calls in that turn
   * and monotonic across turns.
   */
  referenceTime: number;
}): AgentMessage[] {
  const { messages, settings, ctx, referenceTime } = params;

  const contextWindowTokens =
    typeof params.contextWindowTokensOverride === "number" &&
    Number.isFinite(params.contextWindowTokensOverride) &&
    params.contextWindowTokensOverride > 0
      ? params.contextWindowTokensOverride
      : ctx.model?.contextWindow;
  if (!contextWindowTokens || contextWindowTokens <= 0) {
    return messages;
  }

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (charWindow <= 0) {
    return messages;
  }

  const cutoffIndex = findAssistantCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoffIndex === null) {
    return messages;
  }

  // Bootstrap safety: never prune anything before the first user message. This protects initial
  // "identity" reads (SOUL.md, USER.md, etc.) which typically happen before the first inbound user
  // message exists in the session transcript.
  const firstUserIndex = findFirstUserIndex(messages);
  const pruneStartIndex = firstUserIndex === null ? messages.length : firstUserIndex;

  const isToolPrunable = params.isToolPrunable ?? makeToolPrunablePredicate(settings.tools);
  const ttlMs = settings.ttlMs;

  // First pass: collect age-eligible prunable tool results and apply soft-trim.
  const ageEligibleIndexes: number[] = [];
  let totalChars = estimateContextChars(messages);
  let next: AgentMessage[] | null = null;

  for (let i = pruneStartIndex; i < cutoffIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    if (!isToolPrunable(msg.toolName)) {
      continue;
    }
    // Keep fork's age-based eligibility (only prune tool results past the TTL).
    // Image handling is intentionally NOT skipped here: v2026.3.11 changed
    // softTrimToolResultMessage to replace image blocks with a text marker and
    // still trim them, so excluding image results would bypass that behavior.
    if (!isAgeEligible(msg, referenceTime, ttlMs)) {
      continue;
    }
    ageEligibleIndexes.push(i);

    const updated = softTrimToolResultMessage({
      msg: msg as unknown as ToolResultMessage,
      settings,
    });
    if (!updated) {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const afterChars = estimateMessageChars(updated as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    if (!next) {
      next = messages.slice();
    }
    next[i] = updated as unknown as AgentMessage;
  }

  const outputAfterSoftTrim = next ?? messages;

  // Second pass: ratio-based hard-clear as an overflow safety net. Only operates
  // on the age-eligible subset — fresh tool results are never hard-cleared.
  let ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio) {
    return outputAfterSoftTrim;
  }
  if (!settings.hardClear.enabled) {
    return outputAfterSoftTrim;
  }

  let prunableToolChars = 0;
  for (const i of ageEligibleIndexes) {
    const msg = outputAfterSoftTrim[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }
    prunableToolChars += estimateMessageChars(msg);
  }
  if (prunableToolChars < settings.minPrunableToolChars) {
    return outputAfterSoftTrim;
  }

  for (const i of ageEligibleIndexes) {
    if (ratio < settings.hardClearRatio) {
      break;
    }
    const msg = (next ?? messages)[i];
    if (!msg || msg.role !== "toolResult") {
      continue;
    }

    const beforeChars = estimateMessageChars(msg);
    const clearedContent: TextContent[] = [asText(settings.hardClear.placeholder)];
    const cleared: ToolResultMessage = {
      ...msg,
      content: clearedContent,
    };
    if (!next) {
      next = messages.slice();
    }
    next[i] = cleared as unknown as AgentMessage;
    const afterChars = estimateMessageChars(cleared as unknown as AgentMessage);
    totalChars += afterChars - beforeChars;
    ratio = totalChars / charWindow;
  }

  return next ?? messages;
}
