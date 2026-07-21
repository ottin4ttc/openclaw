/** Process-local prompt projection state owned by an embedded session lifecycle. */
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentMessage } from "../runtime/index.js";

export type ToolResultPromptProjectionState = {
  replacements: Map<string, AgentMessage>;
  frozen: Set<string>;
  ambiguousBaseKeys: Set<string>;
  sourceTextByKey: Map<string, string[]>;
};

export type EmbeddedSessionPromptState = {
  toolResults: ToolResultPromptProjectionState;
  sentUserTurnIds: Set<string>;
};

type StoredSessionPromptState = {
  state: EmbeddedSessionPromptState;
  lastAccessedAt: number;
};

// Provider prompt caches do not outlive this idle window. Expiring only inactive
// state avoids rewriting a live cache prefix while bounding retained tool output.
const SESSION_PROMPT_STATE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_PROMPT_STATES_KEY = Symbol.for("openclaw.embeddedSessionPromptStates");
const sessionPromptStates = resolveGlobalSingleton(
  SESSION_PROMPT_STATES_KEY,
  () => new Map<string, StoredSessionPromptState>(),
);

function createSessionPromptState(): EmbeddedSessionPromptState {
  return {
    toolResults: {
      replacements: new Map<string, AgentMessage>(),
      frozen: new Set<string>(),
      ambiguousBaseKeys: new Set<string>(),
      sourceTextByKey: new Map<string, string[]>(),
    },
    sentUserTurnIds: new Set<string>(),
  };
}

export function cloneToolResultPromptProjectionState(
  state: ToolResultPromptProjectionState,
): ToolResultPromptProjectionState {
  return {
    replacements: new Map(state.replacements),
    frozen: new Set(state.frozen),
    ambiguousBaseKeys: new Set(state.ambiguousBaseKeys),
    sourceTextByKey: new Map(state.sourceTextByKey),
  };
}

export function getEmbeddedSessionPromptState(sessionId: string): EmbeddedSessionPromptState {
  const now = Date.now();
  for (const [storedSessionId, stored] of sessionPromptStates) {
    if (now - stored.lastAccessedAt >= SESSION_PROMPT_STATE_IDLE_TTL_MS) {
      sessionPromptStates.delete(storedSessionId);
    }
  }
  const existing = sessionPromptStates.get(sessionId);
  if (existing) {
    existing.lastAccessedAt = now;
    return existing.state;
  }
  const created = createSessionPromptState();
  sessionPromptStates.set(sessionId, { state: created, lastAccessedAt: now });
  return created;
}

export function clearEmbeddedSessionPromptStates(sessionIds: Iterable<string | undefined>): void {
  for (const sessionId of sessionIds) {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionPromptStates.delete(normalized);
    }
  }
}

export function markSessionUserTurnsSent(
  state: EmbeddedSessionPromptState,
  messages: AgentMessage[],
): void {
  state.sentUserTurnIds.clear();
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      state.sentUserTurnIds.add(idempotencyKey);
    }
  }
}

export function hasSessionUserTurnBeenSent(
  state: EmbeddedSessionPromptState,
  message: AgentMessage | undefined,
): boolean | undefined {
  if (!message || message.role !== "user") {
    return undefined;
  }
  const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.length > 0
    ? state.sentUserTurnIds.has(idempotencyKey)
    : undefined;
}

export const testing = {
  idleTtlMs: SESSION_PROMPT_STATE_IDLE_TTL_MS,
  reset() {
    sessionPromptStates.clear();
  },
};
