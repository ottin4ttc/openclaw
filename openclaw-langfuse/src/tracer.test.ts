import type { PluginLogger, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { createLangfuseService, generateTraceId } from "./service.js";

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

  it("llmInput stores data without creating generation", async () => {
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

    // llmInput no longer creates generations directly — they are created in agentEnd
    expect(mockTrace.generation).not.toHaveBeenCalled();
  });

  it("agentEnd creates generation from event.messages", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();

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
    llmOutput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["The answer is 4."],
        usage: { input: 10, output: 8, total: 18 },
      },
      agentCtx,
    );
    agentEnd(
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
      agentCtx,
    );

    // Generation created from event.messages in agentEnd
    expect(mockTrace.generation).toHaveBeenCalledOnce();
    const genArgs = mockTrace.generation.mock.calls[0][0];
    expect(genArgs.name).toBe("llm-call-1");
    expect(genArgs.model).toBe("anthropic/claude-3-5-sonnet");
  });

  it("agentEnd creates tool spans from event.messages", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    agentEnd(
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
      agentCtx,
    );

    // 2 generations (2 assistant messages) + 1 tool span
    expect(mockTrace.generation).toHaveBeenCalledTimes(2);
    expect(mockTrace.span).toHaveBeenCalledOnce();
    const spanArgs = mockTrace.span.mock.calls[0][0];
    expect(spanArgs.name).toBe("tool:readFile");
  });

  it("finalizes trace on agent_end with structured metadata", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    agentEnd(
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
    agentEnd(
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
    agentEnd({ messages: [], success: true }, agentCtx);

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
    agentEnd(
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
});
