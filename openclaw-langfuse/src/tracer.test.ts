import type { PluginLogger, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { createLangfuseService, generateTraceId } from "./service.js";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK — use vi.hoisted so refs are available inside factory
// ---------------------------------------------------------------------------

const { mockGeneration, mockSpan, mockTrace, mockLangfuseInstance } = vi.hoisted(() => {
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

  it("creates generation on llm_input", async () => {
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

    expect(mockTrace.generation).toHaveBeenCalledOnce();
    const genArgs = mockTrace.generation.mock.calls[0][0];
    expect(genArgs.name).toBe("llm-call-1");
    expect(genArgs.model).toBe("claude-3-5-sonnet");
    expect(genArgs.input.systemPrompt).toBe("You are helpful");
    expect(genArgs.input.prompt).toBe("What is 2+2?");
  });

  it("updates generation on llm_output", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    llmInput(
      {
        runId: "run-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
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

    expect(mockGeneration.end).toHaveBeenCalledOnce();
    const endArgs = mockGeneration.end.mock.calls[0][0];
    expect(endArgs.output).toBe("The answer is 4.");
    expect(endArgs.usage.input).toBe(10);
    expect(endArgs.usage.output).toBe(8);
    expect(endArgs.usage.total).toBe(18);
  });

  it("creates span on before_tool_call", async () => {
    const service = await startService();
    const { beforeAgentStart, beforeToolCall } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    beforeToolCall(
      {
        toolName: "readFile",
        params: { path: "/tmp/test.txt" },
        runId: "run-1",
        toolCallId: "tool-call-1",
      },
      toolCtx,
    );

    expect(mockTrace.span).toHaveBeenCalledOnce();
    const spanArgs = mockTrace.span.mock.calls[0][0];
    expect(spanArgs.name).toBe("tool:readFile");
    expect(spanArgs.input).toMatchObject({ path: "/tmp/test.txt" });
    expect(spanArgs.metadata.toolCallId).toBe("tool-call-1");
  });

  it("updates span on after_tool_call", async () => {
    const service = await startService();
    const { beforeAgentStart, beforeToolCall, afterToolCall } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    beforeToolCall(
      {
        toolName: "readFile",
        params: { path: "/tmp/test.txt" },
        toolCallId: "tool-call-1",
      },
      toolCtx,
    );
    afterToolCall(
      {
        toolName: "readFile",
        params: { path: "/tmp/test.txt" },
        toolCallId: "tool-call-1",
        result: "file contents here",
        durationMs: 42,
      },
      toolCtx,
    );

    expect(mockSpan.end).toHaveBeenCalledOnce();
    const endArgs = mockSpan.end.mock.calls[0][0];
    expect(endArgs.metadata.durationMs).toBe(42);
    // No error → level DEFAULT
    expect(endArgs.level).toBe("DEFAULT");
  });

  it("finalizes trace on agent_end", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);
    agentEnd(
      {
        messages: [
          { role: "user", content: "What is 2+2?" },
          { role: "assistant", content: "The answer is 4." },
        ],
        success: true,
        durationMs: 1234,
      },
      agentCtx,
    );

    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("The answer is 4.");
    expect(updateArgs.metadata.success).toBe(true);
    expect(updateArgs.metadata.llmCallCount).toBe(0);
    expect(updateArgs.metadata.toolCallCount).toBe(0);
  });

  it("full multi-tool-call sequence", async () => {
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

    // Tool call 1: read
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
        assistantTexts: ["ok2"],
      },
      agentCtx,
    );

    // Tool call 2: openai_internal_api_call
    beforeToolCall(
      { toolName: "openai_internal_api_call", params: {}, toolCallId: "tc-2" },
      { ...toolCtx, toolName: "openai_internal_api_call", toolCallId: "tc-2" },
    );
    afterToolCall(
      { toolName: "openai_internal_api_call", params: {}, toolCallId: "tc-2", result: "result2" },
      { ...toolCtx, toolName: "openai_internal_api_call", toolCallId: "tc-2" },
    );

    // LLM call 3 (final)
    llmInput(
      {
        runId: "run-3",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "p3",
        historyMessages: [],
        imagesCount: 0,
      },
      agentCtx,
    );
    llmOutput(
      {
        runId: "run-3",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["final answer"],
      },
      agentCtx,
    );

    agentEnd(
      {
        messages: [{ role: "assistant", content: "final answer" }],
        success: true,
        durationMs: 5000,
      },
      agentCtx,
    );

    // 3 generations created
    expect(mockTrace.generation).toHaveBeenCalledTimes(3);
    expect(mockTrace.generation.mock.calls[0][0].name).toBe("llm-call-1");
    expect(mockTrace.generation.mock.calls[1][0].name).toBe("llm-call-2");
    expect(mockTrace.generation.mock.calls[2][0].name).toBe("llm-call-3");

    // 2 spans created
    expect(mockTrace.span).toHaveBeenCalledTimes(2);
    expect(mockTrace.span.mock.calls[0][0].name).toBe("tool:read");
    expect(mockTrace.span.mock.calls[1][0].name).toBe("tool:openai_internal_api_call");

    // All generations ended
    expect(mockGeneration.end).toHaveBeenCalledTimes(3);

    // All spans ended
    expect(mockSpan.end).toHaveBeenCalledTimes(2);

    // Trace finalized with correct counts
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.metadata.llmCallCount).toBe(3);
    expect(updateArgs.metadata.toolCallCount).toBe(2);
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

  it("truncatePayload truncates large objects", async () => {
    const service = await startService();
    const { beforeAgentStart, beforeToolCall } = service.getHookHandlers();

    beforeAgentStart({ prompt: "hello" }, agentCtx);

    // Build a params object that exceeds 100KB when serialized
    const largeValue = "x".repeat(101 * 1024);
    beforeToolCall(
      {
        toolName: "bigTool",
        params: { data: largeValue },
        toolCallId: "tc-large",
      },
      { ...toolCtx, toolName: "bigTool", toolCallId: "tc-large" },
    );

    expect(mockTrace.span).toHaveBeenCalledOnce();
    const spanArgs = mockTrace.span.mock.calls[0][0];
    // input should be a truncated string, not the original object
    expect(typeof spanArgs.input).toBe("string");
    expect(String(spanArgs.input)).toContain("[truncated:");
  });
});
