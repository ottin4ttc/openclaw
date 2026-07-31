import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
  markSessionUserTurnsSent,
  testing,
} from "./session-prompt-state.js";

describe("embedded session prompt state", () => {
  beforeEach(() => testing.reset());
  afterEach(() => vi.useRealTimers());

  it("keeps prompt projections until the owning session is explicitly cleared", () => {
    const original = getEmbeddedSessionPromptState("active-session");
    original.toolResults.frozen.add("tool-result");
    markSessionUserTurnsSent(original, [
      {
        role: "user",
        content: "first turn",
        timestamp: 1,
        idempotencyKey: "turn-1",
      } as AgentMessage,
    ]);

    for (let index = 0; index < 128; index += 1) {
      getEmbeddedSessionPromptState(`other-session-${index}`);
    }

    const restored = getEmbeddedSessionPromptState("active-session");
    expect(restored).toBe(original);
    expect(restored.toolResults.frozen).toContain("tool-result");
    expect(restored.sentUserTurnIds).toContain("turn-1");
  });

  it("expires only prompt projections that stayed idle beyond provider cache lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const expired = getEmbeddedSessionPromptState("expired-session");
    expired.toolResults.frozen.add("old-result");

    vi.advanceTimersByTime(testing.idleTtlMs - 1);
    const active = getEmbeddedSessionPromptState("active-session");
    active.toolResults.frozen.add("current-result");

    vi.advanceTimersByTime(1);
    expect(getEmbeddedSessionPromptState("expired-session")).not.toBe(expired);
    expect(getEmbeddedSessionPromptState("active-session")).toBe(active);
  });

  it("drops sent user turns that are no longer in the provider transcript", () => {
    const state = getEmbeddedSessionPromptState("active-session");
    markSessionUserTurnsSent(state, [
      {
        role: "user",
        content: "first turn",
        timestamp: 1,
        idempotencyKey: "turn-1",
      } as AgentMessage,
    ]);
    markSessionUserTurnsSent(state, [
      {
        role: "user",
        content: "second turn",
        timestamp: 2,
        idempotencyKey: "turn-2",
      } as AgentMessage,
    ]);

    expect(state.sentUserTurnIds).toEqual(new Set(["turn-2"]));
    clearEmbeddedSessionPromptStates(["active-session"]);
  });
});
