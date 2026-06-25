import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  computeEffectiveSettings,
  default as contextPruningExtension,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  pruneContextMessages,
} from "./context-pruning.js";
import { setContextPruningRuntime } from "./context-pruning/runtime.js";

function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return msg.role === "toolResult";
}

function toolText(msg: ToolResultMessage): string {
  const first = msg.content.find((b) => b.type === "text");
  if (!first || first.type !== "text") {
    return "";
  }
  return first.text;
}

function findToolResult(messages: AgentMessage[], toolCallId: string): ToolResultMessage {
  const msg = messages.find((m): m is ToolResultMessage => {
    return isToolResultMessage(m) && m.toolCallId === toolCallId;
  });
  if (!msg) {
    throw new Error(`missing toolResult: ${toolCallId}`);
  }
  return msg;
}

function makeToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.text }],
    isError: false,
    timestamp: Date.now(),
  };
}

function makeImageToolResult(params: {
  toolCallId: string;
  toolName: string;
  text: string;
}): ToolResultMessage {
  const base = makeToolResult(params);
  return {
    ...base,
    content: [{ type: "image", data: "AA==", mimeType: "image/png" }, ...base.content],
  };
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** Create a mock sessionManager whose getEntries() returns a single cache-ttl custom entry. */
function makeMockSessionManager(cacheTtlTimestamp: number | null) {
  const entries =
    cacheTtlTimestamp != null
      ? [
          {
            type: "custom",
            customType: "openclaw.cache-ttl",
            data: { timestamp: cacheTtlTimestamp },
          },
        ]
      : [];
  return { getEntries: () => entries };
}

type ContextPruningSettings = NonNullable<ReturnType<typeof computeEffectiveSettings>>;
type PruneArgs = Parameters<typeof pruneContextMessages>[0];
type PruneOverrides = Partial<Omit<PruneArgs, "messages" | "settings" | "ctx">>;

/**
 * A `referenceTime` far in the future so tool results created via `Date.now()`
 * in the test helpers appear older than the default 5-minute TTL. Tests that
 * want to verify age-based filtering pass a custom `referenceTime`.
 */
const FUTURE_REFERENCE_TIME = Date.now() + 10 * 60 * 1000;

const CONTEXT_WINDOW_1000 = {
  model: { contextWindow: 1000 },
} as unknown as ExtensionContext;

function makeAggressiveSettings(
  overrides: Partial<ContextPruningSettings> = {},
): ContextPruningSettings {
  return {
    ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
    keepLastAssistants: 0,
    softTrimRatio: 0,
    hardClearRatio: 0,
    minPrunableToolChars: 0,
    hardClear: { enabled: true, placeholder: "[cleared]" },
    softTrim: { maxChars: 10, headChars: 3, tailChars: 3 },
    ...overrides,
  };
}

function pruneWithAggressiveDefaults(
  messages: AgentMessage[],
  settingsOverrides: Partial<ContextPruningSettings> = {},
  extra: PruneOverrides = {},
): AgentMessage[] {
  return pruneContextMessages({
    messages,
    settings: makeAggressiveSettings(settingsOverrides),
    ctx: CONTEXT_WINDOW_1000,
    referenceTime: FUTURE_REFERENCE_TIME,
    ...extra,
  });
}

function makeLargeExecToolResult(toolCallId: string, textChar: string): AgentMessage {
  return makeToolResult({
    toolCallId,
    toolName: "exec",
    text: textChar.repeat(20_000),
  });
}

function makeSimpleToolPruningMessages(includeTrailingAssistant = false): AgentMessage[] {
  return [
    makeUser("u1"),
    makeAssistant("a1"),
    makeLargeExecToolResult("t1", "x"),
    ...(includeTrailingAssistant ? [makeAssistant("a2")] : []),
  ];
}

type ContextHandler = (
  event: { messages: AgentMessage[] },
  ctx: ExtensionContext,
) => { messages: AgentMessage[] } | undefined;

function createContextHandler(): ContextHandler {
  let handler: ContextHandler | undefined;
  const api = {
    on: (name: string, fn: unknown) => {
      if (name === "context") {
        handler = fn as ContextHandler;
      }
    },
    appendEntry: (_type: string, _data?: unknown) => {},
  } as unknown as ExtensionAPI;

  contextPruningExtension(api);
  if (!handler) {
    throw new Error("missing context handler");
  }
  return handler;
}

function runContextHandler(
  handler: ContextHandler,
  messages: AgentMessage[],
  sessionManager: unknown,
) {
  return handler({ messages }, {
    model: undefined,
    sessionManager,
  } as unknown as ExtensionContext);
}

describe("context-pruning", () => {
  it("mode off disables pruning", () => {
    expect(computeEffectiveSettings({ mode: "off" })).toBeNull();
    expect(computeEffectiveSettings({})).toBeNull();
  });

  it("does not touch tool results after the last N assistants", () => {
    // keepLastAssistants counts from the last real user message, not from array end.
    // Current-turn assistants (after u4) are auto-protected.
    // keepLastAssistants=2 protects a3, a2 (pre-turn), leaving a1 + t1 prunable.
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "x".repeat(20_000),
      }),
      makeUser("u2"),
      makeAssistant("a2"),
      makeToolResult({
        toolCallId: "t2",
        toolName: "exec",
        text: "y".repeat(20_000),
      }),
      makeUser("u3"),
      makeAssistant("a3"),
      makeToolResult({
        toolCallId: "t3",
        toolName: "exec",
        text: "z".repeat(20_000),
      }),
      makeUser("u4"),
      makeAssistant("a4"),
      makeToolResult({
        toolCallId: "t4",
        toolName: "exec",
        text: "w".repeat(20_000),
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, { keepLastAssistants: 2 });

    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
    expect(toolText(findToolResult(next, "t4"))).toContain("w".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("never prunes tool results before the first user message", () => {
    const messages: AgentMessage[] = [
      makeAssistant("bootstrap tool calls"),
      makeToolResult({
        toolCallId: "t0",
        toolName: "read",
        text: "x".repeat(20_000),
      }),
      makeAssistant("greeting"),
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "y".repeat(20_000),
      }),
    ];

    const next = pruneWithAggressiveDefaults(
      messages,
      {},
      {
        isToolPrunable: () => true,
        contextWindowTokensOverride: 1000,
      },
    );

    expect(toolText(findToolResult(next, "t0"))).toBe("x".repeat(20_000));
    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
  });

  it("hard-clear removes eligible tool results before cutoff", () => {
    // keepLastAssistants=1 counts from the last real user message (u2).
    // a1 is the 1 protected pre-turn assistant. a0 + t1 + t2 are before cutoff.
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a0"),
      makeLargeExecToolResult("t1", "x"),
      makeLargeExecToolResult("t2", "y"),
      makeAssistant("a1"),
      makeUser("u2"),
      makeAssistant("a2"),
      makeLargeExecToolResult("t3", "z"),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      keepLastAssistants: 1,
      softTrimRatio: 10.0,
      softTrim: DEFAULT_CONTEXT_PRUNING_SETTINGS.softTrim,
    });

    expect(toolText(findToolResult(next, "t1"))).toBe("[cleared]");
    expect(toolText(findToolResult(next, "t2"))).toBe("[cleared]");
    // Tool results after the last assistant are protected.
    expect(toolText(findToolResult(next, "t3"))).toContain("z".repeat(20_000));
  });

  it("uses contextWindow override when ctx.model is missing", () => {
    const messages = makeSimpleToolPruningMessages(true);

    const result = pruneContextMessages({
      messages,
      settings: makeAggressiveSettings(),
      ctx: { model: undefined } as unknown as ExtensionContext,
      contextWindowTokensOverride: 1000,
      referenceTime: FUTURE_REFERENCE_TIME,
    });

    expect(toolText(findToolResult(result, "t1"))).toBe("[cleared]");
  });

  it("reads per-session settings from registry", async () => {
    const expiredTimestamp = Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000;
    const sessionManager = makeMockSessionManager(expiredTimestamp);

    setContextPruningRuntime(sessionManager, {
      settings: makeAggressiveSettings(),
      contextWindowTokens: 1000,
      isToolPrunable: () => true,
    });

    // Tool result created in the past so its age exceeds TTL.
    const oldToolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "exec",
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: false,
      timestamp: Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 60_000,
    };
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeAssistant("a1"),
      oldToolResult,
      makeAssistant("a2"),
    ];

    const handler = createContextHandler();
    const result = runContextHandler(handler, messages, sessionManager);

    if (!result) {
      throw new Error("expected handler to return messages");
    }
    expect(toolText(findToolResult(result.messages, "t1"))).toBe("[cleared]");
  });

  it("cache-ttl: all LLM calls within a turn prune consistently", () => {
    const expiredTimestamp = Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 1000;
    const sessionManager = makeMockSessionManager(expiredTimestamp);

    setContextPruningRuntime(sessionManager, {
      settings: makeAggressiveSettings(),
      contextWindowTokens: 1000,
      isToolPrunable: () => true,
    });

    const oldToolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "exec",
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: false,
      timestamp: Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 60_000,
    };
    const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), oldToolResult];

    const handler = createContextHandler();
    const first = runContextHandler(handler, messages, sessionManager);
    if (!first) {
      throw new Error("expected first prune");
    }
    expect(toolText(findToolResult(first.messages, "t1"))).toBe("[cleared]");

    // Second call within the same turn should produce identical output: same
    // turnKey (cache-ttl timestamp unchanged) → same turnStartTime anchor →
    // same per-tool-result age → same pruning decision.
    const second = runContextHandler(handler, messages, sessionManager);
    expect(second).toBeDefined();
    expect(toolText(findToolResult(second!.messages, "t1"))).toBe("[cleared]");
  });

  it("respects tools allow/deny (deny wins; wildcards supported)", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "Exec",
        text: "x".repeat(20_000),
      }),
      makeToolResult({
        toolCallId: "t2",
        toolName: "Browser",
        text: "y".repeat(20_000),
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      tools: { allow: ["ex*"], deny: ["exec"] },
    });

    // Deny wins => exec is not pruned, even though allow matches.
    expect(toolText(findToolResult(next, "t1"))).toContain("x".repeat(20_000));
    // allow is non-empty and browser is not allowed => never pruned.
    expect(toolText(findToolResult(next, "t2"))).toContain("y".repeat(20_000));
  });

  it("replaces image blocks in tool results during soft trim", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeImageToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "visible tool text",
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClearRatio: 10.0,
      hardClear: { enabled: false, placeholder: "[cleared]" },
      softTrim: { maxChars: 200, headChars: 100, tailChars: 100 },
    });

    const tool = findToolResult(next, "t1");
    expect(tool.content.some((b) => b.type === "image")).toBe(false);
    expect(toolText(tool)).toContain("[image removed during context pruning]");
    expect(toolText(tool)).toContain("visible tool text");
  });

  it("soft-trims across block boundaries", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [
          { type: "text", text: "AAAAA" },
          { type: "text", text: "BBBBB" },
        ],
        isError: false,
        timestamp: Date.now(),
      } as ToolResultMessage,
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClearRatio: 10.0,
      softTrim: { maxChars: 5, headChars: 7, tailChars: 3 },
    });

    const text = toolText(findToolResult(next, "t1"));
    expect(text).toContain("AAAAA\nB");
    expect(text).toContain("BBB");
    expect(text).toContain("[Tool result trimmed:");
  });

  it("soft-trims oversized tool results and preserves head/tail with a note", () => {
    const messages: AgentMessage[] = [
      makeUser("u1"),
      makeToolResult({
        toolCallId: "t1",
        toolName: "exec",
        text: "abcdefghij".repeat(1000),
      }),
    ];

    const next = pruneWithAggressiveDefaults(messages, {
      hardClearRatio: 10.0,
      softTrim: { maxChars: 10, headChars: 6, tailChars: 6 },
    });

    const tool = findToolResult(next, "t1");
    const text = toolText(tool);
    expect(text).toContain("abcdef");
    expect(text).toContain("efghij");
    expect(text).toContain("[Tool result trimmed:");
  });

  describe("time-anchored pruning", () => {
    /**
     * Make a tool result whose timestamp is `ageMs` milliseconds before T.
     * Used to set up known-age messages for age-gate tests.
     */
    function makeDatedToolResult(params: {
      toolCallId: string;
      text: string;
      timestamp: number;
    }): ToolResultMessage {
      return {
        role: "toolResult",
        toolCallId: params.toolCallId,
        toolName: "exec",
        content: [{ type: "text", text: params.text }],
        isError: false,
        timestamp: params.timestamp,
      };
    }

    const TTL = DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs;

    it("fresh tool result is not pruned even when old ones are", () => {
      const T = 10_000_000;
      const oldMsg = makeDatedToolResult({
        toolCallId: "t-old",
        text: "x".repeat(20_000),
        timestamp: T - TTL - 1_000,
      });
      const freshMsg = makeDatedToolResult({
        toolCallId: "t-fresh",
        text: "y".repeat(20_000),
        timestamp: T - 1_000,
      });
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), oldMsg, freshMsg];

      const next = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });

      expect(toolText(findToolResult(next, "t-old"))).toBe("[cleared]");
      expect(toolText(findToolResult(next, "t-fresh"))).toContain("y".repeat(20_000));
    });

    it("tool result without timestamp is not pruned", () => {
      const noTimestamp: AgentMessage = {
        role: "toolResult",
        toolCallId: "t-no-ts",
        toolName: "exec",
        content: [{ type: "text", text: "z".repeat(20_000) }],
        isError: false,
      } as unknown as AgentMessage;
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), noTimestamp];

      const next = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: FUTURE_REFERENCE_TIME,
      });

      const tool = next.find((m) => m.role === "toolResult") as ToolResultMessage;
      expect(toolText(tool)).toContain("z".repeat(20_000));
    });

    it("same referenceTime across calls produces identical output (within-turn stability)", () => {
      const T = 10_000_000;
      const msg = makeDatedToolResult({
        toolCallId: "t1",
        text: "x".repeat(20_000),
        timestamp: T - TTL - 1_000,
      });
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), msg];

      const a = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });
      const b = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });

      expect(toolText(findToolResult(a, "t1"))).toBe(toolText(findToolResult(b, "t1")));
      expect(toolText(findToolResult(a, "t1"))).toBe("[cleared]");
    });

    it("cross-turn monotonicity: short gap does not un-prune", () => {
      // Turn N starts at T0; tool result is old enough to be pruned.
      // Turn N+1 starts at T1 (only 2 minutes later, well within TTL).
      // The tool result must still be pruned in Turn N+1.
      const T0 = 10_000_000;
      const T1 = T0 + 2 * 60 * 1000; // 2 minutes later
      const oldMsg = makeDatedToolResult({
        toolCallId: "t-old",
        text: "x".repeat(20_000),
        timestamp: T0 - TTL - 1_000,
      });
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), oldMsg];

      const turnN = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T0,
      });
      const turnNPlus1 = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T1,
      });

      expect(toolText(findToolResult(turnN, "t-old"))).toBe("[cleared]");
      expect(toolText(findToolResult(turnNPlus1, "t-old"))).toBe("[cleared]");
    });

    it("long turn: multiple LLM calls spread across time use same anchor", () => {
      // Simulate a long turn: turnStartTime is fixed at T, even though LLM calls
      // happen at T+90s and T+240s. The pruning decision must be identical across
      // all three simulated calls.
      const T = 10_000_000;
      const msg = makeDatedToolResult({
        toolCallId: "t1",
        text: "x".repeat(20_000),
        timestamp: T - 4 * 60 * 1000, // 4 minutes before turn start, < 5min TTL
      });
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), msg];

      // All three calls anchored to T (not Date.now() + 90s / 240s).
      const call1 = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });
      const call2 = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });
      const call3 = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings(),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });

      // All three see age = 4min < 5min TTL → not pruned.
      const expected = "x".repeat(20_000);
      expect(toolText(findToolResult(call1, "t1"))).toContain(expected);
      expect(toolText(findToolResult(call2, "t1"))).toContain(expected);
      expect(toolText(findToolResult(call3, "t1"))).toContain(expected);
    });

    it("ratio-based hard-clear only affects age-eligible tool results", () => {
      // Two tool results, one old (eligible), one fresh (not eligible).
      // Even if ratio is over threshold, the fresh one must NOT be hard-cleared.
      const T = 10_000_000;
      const oldMsg = makeDatedToolResult({
        toolCallId: "t-old",
        text: "x".repeat(20_000),
        timestamp: T - TTL - 1_000,
      });
      const freshMsg = makeDatedToolResult({
        toolCallId: "t-fresh",
        text: "y".repeat(20_000),
        timestamp: T - 1_000,
      });
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), oldMsg, freshMsg];

      const next = pruneContextMessages({
        messages,
        settings: makeAggressiveSettings({
          // Force hard-clear regardless of context size by setting ratio to 0.
          hardClearRatio: 0,
          minPrunableToolChars: 0,
        }),
        ctx: CONTEXT_WINDOW_1000,
        referenceTime: T,
      });

      expect(toolText(findToolResult(next, "t-old"))).toBe("[cleared]");
      // Fresh tool result must not be touched by hard-clear.
      expect(toolText(findToolResult(next, "t-fresh"))).toContain("y".repeat(20_000));
    });

    it("extension: short inter-turn gap still runs the pruner (no global skip gate)", () => {
      // Previous turn end timestamp is only 30s ago (well within TTL).
      // Old-style logic would skip pruning entirely. New logic must still invoke
      // the pruner and let per-tool-result age checks decide.
      const recentTimestamp = Date.now() - 30 * 1000;
      const sessionManager = makeMockSessionManager(recentTimestamp);

      setContextPruningRuntime(sessionManager, {
        settings: makeAggressiveSettings(),
        contextWindowTokens: 1000,
        isToolPrunable: () => true,
      });

      // Tool result is old enough to be prunable regardless.
      const oldMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "x".repeat(20_000) }],
        isError: false,
        timestamp: Date.now() - DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs - 60_000,
      };
      const messages: AgentMessage[] = [makeUser("u1"), makeAssistant("a1"), oldMsg];

      const handler = createContextHandler();
      const result = runContextHandler(handler, messages, sessionManager);

      expect(result).toBeDefined();
      expect(toolText(findToolResult(result!.messages, "t1"))).toBe("[cleared]");
    });
  });
});
