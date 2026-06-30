import type { PluginLogger, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { computeCorrectedStartTimes } from "./finalize.js";
import { createLangfuseService, generateTraceId } from "./service.js";
import type { SessionEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK — use vi.hoisted so refs are available inside factory
// ---------------------------------------------------------------------------

const { mockTrace, mockLangfuseInstance } = vi.hoisted(() => {
  const mockGeneration = { update: vi.fn(), end: vi.fn() };
  const mockSpan = { update: vi.fn(), end: vi.fn() };
  const mockTrace = {
    generation: vi.fn().mockReturnValue(mockGeneration),
    span: vi.fn().mockReturnValue(mockSpan),
    update: vi.fn(),
  };
  const mockLangfuseInstance = {
    trace: vi.fn().mockReturnValue(mockTrace),
    shutdownAsync: vi.fn().mockResolvedValue(undefined),
    flushAsync: vi.fn().mockResolvedValue(undefined),
    getPrompt: vi.fn(),
  };
  return { mockGeneration, mockSpan, mockTrace, mockLangfuseInstance };
});

vi.mock("langfuse", () => ({
  default: vi.fn().mockImplementation(function () {
    return mockLangfuseInstance;
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const config: LangfusePluginConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
  baseUrl: "http://localhost:3000",
  tracing: { enabled: true, tags: ["test"], redact: false },
};

const mockLogger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeServiceCtx(
  overrides?: Partial<OpenClawPluginServiceContext>,
): OpenClawPluginServiceContext {
  return {
    logger: mockLogger,
    ...overrides,
  } as OpenClawPluginServiceContext;
}

const agentCtx = {
  agentId: "agent-1",
  sessionKey: "session-key-1",
  sessionId: "session-id-1",
  channelId: "channel-1",
  trigger: "message",
};

const toolCtx = {
  agentId: "agent-1",
  sessionKey: "session-key-1",
  sessionId: "session-id-1",
  toolName: "readFile",
  toolCallId: "tool-call-1",
};

async function startService(cfg: LangfusePluginConfig = config) {
  const service = createLangfuseService(cfg, mockLogger);
  await service.start(makeServiceCtx());
  return service;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LangfuseService tracer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates trace on before_agent_start", async () => {
    const service = await startService();
    const { beforeAgentStart } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello", messages: [] }, agentCtx);

    expect(mockLangfuseInstance.trace).toHaveBeenCalledOnce();
    const traceArgs = mockLangfuseInstance.trace.mock.calls[0][0];

    // id should be a 32-char hex string (sha256 slice)
    expect(traceArgs.id).toMatch(/^[0-9a-f]{32}$/);
    // sessionId on the trace is the sessionKey (used for Langfuse session grouping)
    expect(traceArgs.sessionId).toBe(agentCtx.sessionKey);
    // tags include the configured tag plus agentId/channelId
    expect(traceArgs.tags).toContain("test");
    expect(traceArgs.tags).toContain("agent-1");
    expect(traceArgs.tags).toContain("channel-1");
    // metadata carries the original sessionId
    expect(traceArgs.metadata.sessionId).toBe(agentCtx.sessionId);
    expect(traceArgs.metadata.agentId).toBe(agentCtx.agentId);
  });

  it("llmInput creates generation incrementally", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    llmInput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        systemPrompt: "You are helpful",
        prompt: "What is 2+2?",
        historyMessages: [],
        imagesCount: 0,
      },
      agentCtx,
    );

    // llmInput now creates generation immediately for real-time Langfuse display
    expect(mockTrace.generation).toHaveBeenCalledOnce();
    const genArgs = mockTrace.generation.mock.calls[0][0];
    expect(genArgs.name).toBe("llm-call-1");
    expect(genArgs.model).toBe("anthropic/claude-3-5-sonnet");
  });

  it("llmInput creates and llmOutput updates generation incrementally", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx2 = { ...agentCtx, sessionKey: "session-key-incr" };

    beforeAgentStart({ prompt: "hello" }, ctx2);
    llmInput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        systemPrompt: "You are helpful",
        prompt: "What is 2+2?",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx2,
    );

    // Generation created in llmInput
    expect(mockTrace.generation).toHaveBeenCalled();
    const lastGenCall =
      mockTrace.generation.mock.calls[mockTrace.generation.mock.calls.length - 1][0];
    expect(lastGenCall.name).toBe("llm-call-1");
    expect(lastGenCall.model).toBe("anthropic/claude-3-5-sonnet");

    llmOutput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["The answer is 4."],
        usage: { input: 10, output: 8, total: 18 },
      },
      ctx2,
    );

    // Generation updated in llmOutput (output deferred to agentEnd/finalize)
    const genClient =
      mockTrace.generation.mock.results[mockTrace.generation.mock.results.length - 1].value;
    expect(genClient.update).toHaveBeenCalledOnce();
    const updateArgs = genClient.update.mock.calls[0][0];
    expect(updateArgs.output).toBeUndefined(); // output set by finalize from JSONL, not llmOutput

    await agentEnd(
      {
        messages: [
          { role: "user", content: "What is 2+2?" },
          {
            role: "assistant",
            content: [{ type: "text", text: "The answer is 4." }],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            usage: { input: 10, output: 8, totalTokens: 18 },
          },
        ],
        success: true,
        durationMs: 1234,
      },
      ctx2,
    );
  });

  it("agentEnd creates tool spans from event.messages", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx3 = { ...agentCtx, sessionKey: "session-key-toolspan" };

    beforeAgentStart({ prompt: "hello" }, ctx3);
    await agentEnd(
      {
        messages: [
          { role: "user", content: "Read the file" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me read it." },
              {
                type: "toolCall",
                id: "tc-1",
                name: "readFile",
                input: { path: "/tmp/test.txt" },
              },
            ],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            timestamp: 1000,
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "readFile",
            content: [{ type: "text", text: "file contents here" }],
            timestamp: 1042,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "The file contains..." }],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            timestamp: 2000,
          },
        ],
        success: true,
        durationMs: 2000,
      },
      ctx3,
    );

    // 2 generations (2 assistant messages) + 1 tool span (via useBatchCreation path)
    const genCalls = mockTrace.generation.mock.calls.filter((c: unknown[]) =>
      (c[0] as Record<string, unknown>).name?.toString().startsWith("llm-call-"),
    );
    expect(genCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockTrace.span).toHaveBeenCalled();
    const spanCalls = mockTrace.span.mock.calls;
    const readSpan = spanCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).name === "tool:readFile",
    );
    expect(readSpan).toBeDefined();
  });

  it("finalizes trace on agent_end with structured metadata", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    await agentEnd(
      {
        messages: [
          { role: "user", content: "What is 2+2?" },
          {
            role: "assistant",
            content: [{ type: "text", text: "The answer is 4." }],
            model: "claude-3-5-sonnet",
          },
        ],
        success: true,
        durationMs: 1234,
      },
      agentCtx,
    );

    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("The answer is 4.");
    expect(updateArgs.metadata.stats.success).toBe(true);
    expect(updateArgs.metadata.stats.llmCallCount).toBe(1);
  });

  it("full multi-turn sequence with tools", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, beforeToolCall, afterToolCall, agentEnd } =
      service.getHookHandlers();

    beforeAgentStart({ prompt: "Do some work" }, agentCtx);

    // LLM call 1
    llmInput(
      {
        runId: "run-1",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "p1",
        historyMessages: [],
        imagesCount: 0,
      },
      agentCtx,
    );
    llmOutput(
      {
        runId: "run-1",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["ok1"],
      },
      agentCtx,
    );

    // Tool calls (beforeToolCall just increments count)
    beforeToolCall(
      { toolName: "read", params: {}, toolCallId: "tc-1" },
      { ...toolCtx, toolName: "read", toolCallId: "tc-1" },
    );
    afterToolCall(
      { toolName: "read", params: {}, toolCallId: "tc-1", result: "data" },
      { ...toolCtx, toolName: "read", toolCallId: "tc-1" },
    );

    // LLM call 2
    llmInput(
      {
        runId: "run-2",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "p2",
        historyMessages: [],
        imagesCount: 0,
      },
      agentCtx,
    );
    llmOutput(
      {
        runId: "run-2",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["final answer"],
      },
      agentCtx,
    );

    // agentEnd with full message history creates all observations
    await agentEnd(
      {
        messages: [
          { role: "user", content: "Do some work" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "ok1" },
              { type: "toolCall", id: "tc-1", name: "read", input: {} },
            ],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            timestamp: 1000,
          },
          {
            role: "toolResult",
            toolCallId: "tc-1",
            toolName: "read",
            content: [{ type: "text", text: "data" }],
            timestamp: 1100,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            timestamp: 2000,
          },
        ],
        success: true,
        durationMs: 5000,
      },
      agentCtx,
    );

    // 2 generations created (2 assistant messages)
    expect(mockTrace.generation).toHaveBeenCalledTimes(2);
    expect(mockTrace.generation.mock.calls[0][0].name).toBe("llm-call-1");
    expect(mockTrace.generation.mock.calls[1][0].name).toBe("llm-call-2");

    // 1 tool span created from toolCall+toolResult in messages
    expect(mockTrace.span).toHaveBeenCalledOnce();
    expect(mockTrace.span.mock.calls[0][0].name).toBe("tool:read");

    // Trace finalized
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.metadata.stats.llmCallCount).toBe(2);
  });

  it("disabled service skips all hooks", async () => {
    const disabledConfig: LangfusePluginConfig = {
      tracing: { enabled: true },
      // No keys → disabled
    };
    const service = await startService(disabledConfig);
    const { beforeAgentStart, llmInput, llmOutput, beforeToolCall, afterToolCall, agentEnd } =
      service.getHookHandlers();

    // None of these should throw, and none should call langfuse
    beforeAgentStart({ prompt: "hello" }, agentCtx);
    llmInput(
      {
        runId: "r1",
        sessionId: "s1",
        provider: "x",
        model: "m",
        prompt: "p",
        historyMessages: [],
        imagesCount: 0,
      },
      agentCtx,
    );
    llmOutput(
      { runId: "r1", sessionId: "s1", provider: "x", model: "m", assistantTexts: [] },
      agentCtx,
    );
    beforeToolCall({ toolName: "t", params: {}, toolCallId: "tc-1" }, toolCtx);
    afterToolCall({ toolName: "t", params: {}, toolCallId: "tc-1" }, toolCtx);
    await agentEnd({ messages: [], success: true }, agentCtx);

    expect(mockLangfuseInstance.trace).not.toHaveBeenCalled();
    expect(mockTrace.generation).not.toHaveBeenCalled();
    expect(mockTrace.span).not.toHaveBeenCalled();
    expect(mockTrace.update).not.toHaveBeenCalled();
  });

  it("generateTraceId produces deterministic output", () => {
    const id1 = generateTraceId("my-session", 1700000000000);
    const id2 = generateTraceId("my-session", 1700000000000);
    const id3 = generateTraceId("other-session", 1700000000000);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^[0-9a-f]{32}$/);
  });

  // --- Restart resilience: the key bug fix ---

  it("agentEnd creates trace and observations even without prior beforeAgentStart (restart resilience)", async () => {
    const service = await startService();
    const { agentEnd } = service.getHookHandlers();

    // Use a fresh agentCtx key to avoid stale entries from previous tests
    const restartCtx = {
      agentId: "agent-restart",
      sessionKey: "session-key-restart",
      sessionId: "session-id-restart",
      channelId: "webchat",
      trigger: "user",
    };

    // Simulate: gateway restarted, so no beforeAgentStart/llmInput/llmOutput was called.
    // agentEnd fires with event.messages containing the full conversation.
    await agentEnd(
      {
        messages: [
          { role: "user", content: "我换了一个模型，你在试试吧" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "好，马上试！" },
              {
                type: "toolCall",
                id: "toolu_1",
                name: "openmai_internal_api_call",
                input: { method: "GET", path: "/api/user_service/v1/me" },
              },
            ],
            model: "anthropic/claude-sonnet-4.6",
            provider: "zenmux-anthropic",
            usage: { input: 3, output: 93, cacheRead: 0, cacheWrite: 45065, totalTokens: 45161 },
            stopReason: "toolUse",
            timestamp: 1774599687682,
          },
          {
            role: "toolResult",
            toolCallId: "toolu_1",
            toolName: "openmai_internal_api_call",
            content: [{ type: "text", text: '{"error":"api_call_failed"}' }],
            isError: false,
            timestamp: 1774599698463,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "GET 接口还是同样的错。再试 POST：" },
              {
                type: "toolCall",
                id: "toolu_2",
                name: "openmai_internal_api_call",
                input: { method: "POST", path: "/api/private-talent/v1/talents/search-for-skill" },
              },
            ],
            model: "anthropic/claude-sonnet-4.6",
            provider: "zenmux-anthropic",
            usage: { input: 1, output: 155, cacheRead: 45065, cacheWrite: 148, totalTokens: 45369 },
            stopReason: "toolUse",
            timestamp: 1774599698483,
          },
          {
            role: "toolResult",
            toolCallId: "toolu_2",
            toolName: "openmai_internal_api_call",
            content: [{ type: "text", text: '{"code":0,"message":"success","data":{}}' }],
            isError: false,
            timestamp: 1774599710522,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "搜索成功！找到了3位候选人。" }],
            model: "anthropic/claude-sonnet-4.6",
            provider: "zenmux-anthropic",
            usage: { input: 5, output: 200, totalTokens: 205 },
            timestamp: 1774599720000,
          },
        ],
        success: true,
        durationMs: 32000,
      },
      restartCtx,
    );

    // Should create a new trace on the fly
    expect(mockLangfuseInstance.trace).toHaveBeenCalledOnce();

    // Should create 3 generations (3 assistant messages)
    expect(mockTrace.generation).toHaveBeenCalledTimes(3);
    expect(mockTrace.generation.mock.calls[0][0].name).toBe("llm-call-1");
    expect(mockTrace.generation.mock.calls[1][0].name).toBe("llm-call-2");
    expect(mockTrace.generation.mock.calls[2][0].name).toBe("llm-call-3");

    // Should create 2 tool spans
    expect(mockTrace.span).toHaveBeenCalledTimes(2);

    // Trace should be finalized
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("搜索成功！找到了3位候选人。");
    expect(updateArgs.metadata.stats.llmCallCount).toBe(3);
    expect(updateArgs.metadata.stats.success).toBe(true);
  });

  it("finalize rebuilds tool_use output from JSONL (not null)", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-tooluse-output" };

    beforeAgentStart({ prompt: "search" }, ctx);
    llmInput(
      {
        runId: "run-tu",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        prompt: "search",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    // llmOutput with no lastAssistant (simulates tool_use where assistantTexts is empty)
    llmOutput(
      {
        runId: "run-tu",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        assistantTexts: [],
        usage: { input: 3, output: 114, total: 96563 },
      },
      ctx,
    );

    await agentEnd(
      {
        messages: [
          { role: "user", content: "search something" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tc-ws",
                name: "omb_web_search",
                arguments: { query: "test query", max_results: 5 },
              },
            ],
            model: "claude-sonnet-4.6",
            provider: "anthropic",
            usage: { input: 3, output: 114, totalTokens: 96563 },
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
          {
            role: "toolResult",
            toolCallId: "tc-ws",
            toolName: "omb_web_search",
            content: [{ type: "text", text: "search results" }],
            timestamp: Date.now() + 5000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Here are the results." }],
            model: "claude-sonnet-4.6",
            provider: "anthropic",
            usage: { input: 1, output: 50, totalTokens: 51 },
            timestamp: Date.now() + 10000,
          },
        ],
        success: true,
        durationMs: 15000,
      },
      ctx,
    );

    // The first generation (tool_use) should have its output rebuilt from JSONL
    const genClient = mockTrace.generation.mock.results[0].value;
    const updateCalls = genClient.update.mock.calls;
    // Find the finalize update that sets output with tool_calls (not the llmOutput string update)
    const outputUpdate = updateCalls.find((c: unknown[]) => {
      const out = (c[0] as Record<string, unknown>).output;
      return out && typeof out === "object" && (out as Record<string, unknown>).tool_calls;
    });
    expect(outputUpdate).toBeDefined();
    const output = (outputUpdate![0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(output.tool_calls).toBeDefined();
    expect((output.tool_calls as unknown[]).length).toBe(1);
  });

  it("finalize does not send zero costDetails", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-zero-cost" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    llmInput(
      {
        runId: "run-zc",
        sessionId: "s1",
        provider: "zenmux",
        model: "claude-sonnet-4.6",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    llmOutput(
      {
        runId: "run-zc",
        sessionId: "s1",
        provider: "zenmux",
        model: "claude-sonnet-4.6",
        assistantTexts: ["Hi there"],
        usage: { input: 10, output: 5, total: 15 },
      },
      ctx,
    );

    await agentEnd(
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hi there" }],
            model: "claude-sonnet-4.6",
            provider: "zenmux",
            usage: {
              input: 10,
              output: 5,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        ],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );

    // The generation update from finalize should NOT include costDetails
    const genClient = mockTrace.generation.mock.results[0].value;
    const updateCalls = genClient.update.mock.calls;
    for (const call of updateCalls) {
      const args = call[0] as Record<string, unknown>;
      if (args.costDetails) {
        // If costDetails is present, it must have non-zero values
        const cd = args.costDetails as Record<string, number>;
        expect(cd.input > 0 || cd.output > 0 || cd.total > 0).toBe(true);
      }
    }
  });

  it("computeCorrectedStartTimes places gen-2 after tool results", () => {
    const entryTimestamp = 1000;
    const turnEntries = [
      { timestamp: 1000, message: { role: "user", content: "hello" } },
      {
        timestamp: 1100,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "toolUse",
        },
      },
      {
        timestamp: 1200,
        message: { role: "toolResult", toolCallId: "tc-1", content: "result1", timestamp: 1200 },
      },
      {
        timestamp: 1500,
        message: { role: "toolResult", toolCallId: "tc-2", content: "result2", timestamp: 1500 },
      },
      {
        timestamp: 2000,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
    ] as unknown as SessionEntry[];
    const assistantMsgs = turnEntries.filter((e: SessionEntry) => e.message.role === "assistant");

    const startTimes = computeCorrectedStartTimes(assistantMsgs, turnEntries, entryTimestamp);

    // gen-1 starts at entry timestamp
    expect(startTimes[0]).toBe(entryTimestamp);
    // gen-2 starts after the last toolResult (1500), not before it
    expect(startTimes[1]).toBe(1500);
    expect(startTimes[1]!).toBeGreaterThan(1200);
  });

  it("beforeToolCall sets parentObservationId from currentGenerationId", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, beforeToolCall } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-parent-obs" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    llmInput(
      {
        runId: "run-po",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );

    // Get the generation ID that was created
    const genArgs = mockTrace.generation.mock.calls[0][0] as Record<string, unknown>;
    const genId = genArgs.id;

    beforeToolCall(
      { toolName: "web_search", params: { query: "test" }, toolCallId: "tc-parent" },
      { ...toolCtx, agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolCallId: "tc-parent" },
    );

    // The span should have parentObservationId matching the generation
    const spanArgs = mockTrace.span.mock.calls[0][0] as Record<string, unknown>;
    expect(spanArgs.parentObservationId).toBe(genId);
  });
});
