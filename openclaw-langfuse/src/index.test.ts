import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK so importing the plugin doesn't require real creds
// ---------------------------------------------------------------------------

const langfuseMock = vi.hoisted(() => ({
  instances: [] as Array<{
    trace: ReturnType<typeof vi.fn>;
    flushAsync: ReturnType<typeof vi.fn>;
    shutdownAsync: ReturnType<typeof vi.fn>;
    getPrompt: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>,
  nextGetPrompt: undefined as ReturnType<typeof vi.fn> | undefined,
}));

const recoveryMock = vi.hoisted(() => ({
  scanIncompleteTraces: vi.fn(() => []),
  recoverTrace: vi.fn(),
}));

const diagnosticRuntimeMock = vi.hoisted(() => ({
  waitForDiagnosticEventsDrained: vi.fn().mockResolvedValue(undefined),
}));

const transcriptRuntimeMock = vi.hoisted(() => ({
  readVisibleSessionTranscriptMessageEntries: vi.fn().mockResolvedValue([]),
}));

vi.mock("langfuse", () => ({
  default: vi.fn().mockImplementation(function () {
    const instance = {
      trace: vi.fn().mockReturnValue({
        generation: vi.fn().mockReturnValue({ update: vi.fn(), end: vi.fn() }),
        span: vi.fn().mockReturnValue({ update: vi.fn(), end: vi.fn() }),
        update: vi.fn(),
      }),
      flushAsync: vi.fn().mockResolvedValue(undefined),
      shutdownAsync: vi.fn().mockResolvedValue(undefined),
      getPrompt:
        langfuseMock.nextGetPrompt ?? vi.fn().mockResolvedValue({ prompt: "Hello from Langfuse" }),
      on: vi.fn(() => vi.fn()),
    };
    langfuseMock.instances.push(instance);
    return instance;
  }),
}));

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  emitTrustedDiagnosticEvent: vi.fn(),
  emitTrustedDiagnosticEventWithPrivateData: vi.fn(),
  resetDiagnosticEventsForTest: vi.fn(),
  waitForDiagnosticEventsDrained: diagnosticRuntimeMock.waitForDiagnosticEventsDrained,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => transcriptRuntimeMock);

vi.mock("./recovery.js", () => recoveryMock);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const ORIGINAL_ENV = {
  LANGFUSE_PUBLIC_KEY: process.env["LANGFUSE_PUBLIC_KEY"],
  LANGFUSE_SECRET_KEY: process.env["LANGFUSE_SECRET_KEY"],
};

function makeApi(config: LangfusePluginConfig) {
  return {
    pluginConfig: config,
    logger: mockLogger,
    registerService: vi.fn(),
    on: vi.fn(),
    runtime: {},
  };
}

const baseConfig: LangfusePluginConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
  baseUrl: "http://localhost:3000",
  tracing: { enabled: true, tags: ["test"], redact: false },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Langfuse plugin registration (index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    langfuseMock.instances.length = 0;
    langfuseMock.nextGetPrompt = undefined;
    recoveryMock.scanIncompleteTraces.mockClear();
    recoveryMock.recoverTrace.mockClear();
    diagnosticRuntimeMock.waitForDiagnosticEventsDrained.mockReset();
    diagnosticRuntimeMock.waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
    transcriptRuntimeMock.readVisibleSessionTranscriptMessageEntries.mockReset();
    transcriptRuntimeMock.readVisibleSessionTranscriptMessageEntries.mockResolvedValue([]);
    if (ORIGINAL_ENV.LANGFUSE_PUBLIC_KEY === undefined) {
      delete process.env["LANGFUSE_PUBLIC_KEY"];
    } else {
      process.env["LANGFUSE_PUBLIC_KEY"] = ORIGINAL_ENV.LANGFUSE_PUBLIC_KEY;
    }
    if (ORIGINAL_ENV.LANGFUSE_SECRET_KEY === undefined) {
      delete process.env["LANGFUSE_SECRET_KEY"];
    } else {
      process.env["LANGFUSE_SECRET_KEY"] = ORIGINAL_ENV.LANGFUSE_SECRET_KEY;
    }
  });

  it("exports plugin with correct id and name", async () => {
    const { default: plugin } = await import("../index.js");
    expect(plugin.id).toBe("openclaw-langfuse");
    expect(plugin.name).toBe("Langfuse");
    expect(typeof plugin.description).toBe("string");
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  it("register calls api.registerService", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi(baseConfig);
    await plugin.register(api as never);
    expect(api.registerService).toHaveBeenCalledOnce();
  });

  it("registers when credentials are supplied only via env", async () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-env";
    process.env["LANGFUSE_SECRET_KEY"] = "sk-env";
    const { default: plugin } = await import("../index.js");
    const api = makeApi({});
    await plugin.register(api as never);
    expect(api.registerService).toHaveBeenCalledOnce();
    expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
  });

  it("registers tracing hooks when tracing enabled", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi(baseConfig);
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("llm_input");
    expect(registeredEvents).toContain("llm_output");
    expect(registeredEvents).toContain("before_tool_call");
    expect(registeredEvents).toContain("after_tool_call");
    expect(registeredEvents).toContain("agent_end");
    expect(registeredEvents).toContain("session_end");
  });

  it("registers tracing hooks when tracing.enabled is false", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({ ...baseConfig, tracing: { enabled: false } });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("llm_input");
    expect(registeredEvents).toContain("llm_output");
    expect(registeredEvents).toContain("before_tool_call");
    expect(registeredEvents).toContain("after_tool_call");
    expect(registeredEvents).toContain("agent_end");
    expect(registeredEvents).toContain("session_end");
  });

  it("registers prompt hook when prompts configured", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({
      ...baseConfig,
      prompts: [{ match: "agent-1", langfusePrompt: "my-prompt" }],
    });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_prompt_build");
  });

  it("registers prompt hook when no prompts configured", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({ ...baseConfig, prompts: [] });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_prompt_build");
  });

  it("injects a Langfuse prompt on the first prompt hook cache miss", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({
      ...baseConfig,
      prompts: [{ match: "agent-1", langfusePrompt: "my-prompt", inject: "prepend" }],
    });
    await plugin.register(api as never);
    const service = api.registerService.mock.calls[0][0];
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent: vi.fn(() => vi.fn()) },
    };
    const firstFetchNeverResolves = new Promise<{ prompt: string }>(() => {});
    langfuseMock.nextGetPrompt = vi
      .fn()
      .mockReturnValueOnce(firstFetchNeverResolves)
      .mockResolvedValueOnce({ prompt: "First turn {{agent_name}}" });

    await service.start(ctx);
    const beforePromptBuild = api.on.mock.calls.find(
      (call: unknown[]) => call[0] === "before_prompt_build",
    )?.[1] as (...args: unknown[]) => Promise<unknown>;

    await expect(
      beforePromptBuild(
        { prompt: "hello", messages: [] },
        { agentId: "agent-1", sessionKey: "session-1" },
      ),
    ).resolves.toEqual({ prependSystemContext: "First turn agent-1" });
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Langfuse: prompt injection name=my-prompt mode=prepend length=18",
    );
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain("First turn agent-1");

    await service.stop(ctx);
  });

  it("cleans old subscriptions and the old Langfuse client before a restarted service registers again", async () => {
    const { createLangfuseService } = await import("./service.js");
    const firstDiagnosticUnsubscribe = vi.fn();
    const secondDiagnosticUnsubscribe = vi.fn();
    const firstTranscriptUnsubscribe = vi.fn();
    const secondTranscriptUnsubscribe = vi.fn();
    const onEvent = vi
      .fn()
      .mockReturnValueOnce(firstDiagnosticUnsubscribe)
      .mockReturnValueOnce(secondDiagnosticUnsubscribe);
    const onSessionTranscriptUpdate = vi
      .fn()
      .mockReturnValueOnce(firstTranscriptUnsubscribe)
      .mockReturnValueOnce(secondTranscriptUnsubscribe);
    const runtime = { events: { onSessionTranscriptUpdate } };
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent },
    };
    const firstService = createLangfuseService(baseConfig, mockLogger, runtime as never);
    await firstService.start(ctx as never);
    const firstClient = langfuseMock.instances[0];
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onSessionTranscriptUpdate).toHaveBeenCalledTimes(1);

    const secondService = createLangfuseService(baseConfig, mockLogger, runtime as never);
    await secondService.start(ctx as never);

    expect(firstDiagnosticUnsubscribe).toHaveBeenCalledOnce();
    expect(firstTranscriptUnsubscribe).toHaveBeenCalledOnce();
    expect(firstClient.shutdownAsync).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onSessionTranscriptUpdate).toHaveBeenCalledTimes(2);

    const secondClient = langfuseMock.instances[1];
    secondService
      .getHookHandlers()
      .beforeAgentStart({}, { agentId: "agent-1", sessionKey: "session-1" });
    expect(secondClient.trace).toHaveBeenCalledOnce();

    await secondService.stop(ctx as never);
    expect(secondDiagnosticUnsubscribe).toHaveBeenCalledOnce();
    expect(secondTranscriptUnsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the existing runtime while a duplicate service starts during an active trace", async () => {
    const { createLangfuseService } = await import("./service.js");
    const diagnosticUnsubscribe = vi.fn();
    const transcriptUnsubscribe = vi.fn();
    const onEvent = vi.fn(() => diagnosticUnsubscribe);
    const onSessionTranscriptUpdate = vi.fn(() => transcriptUnsubscribe);
    const runtime = { events: { onSessionTranscriptUpdate } };
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent },
    };
    const firstService = createLangfuseService(baseConfig, mockLogger, runtime as never);
    await firstService.start(ctx as never);
    const firstClient = langfuseMock.instances[0];
    firstService
      .getHookHandlers()
      .beforeAgentStart({}, { agentId: "agent-1", sessionKey: "session-1" });

    const secondService = createLangfuseService(baseConfig, mockLogger, runtime as never);
    await secondService.start(ctx as never);

    expect(langfuseMock.instances).toHaveLength(1);
    expect(firstClient.trace).toHaveBeenCalledOnce();
    expect(firstClient.shutdownAsync).not.toHaveBeenCalled();
    expect(diagnosticUnsubscribe).not.toHaveBeenCalled();
    expect(transcriptUnsubscribe).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onSessionTranscriptUpdate).toHaveBeenCalledOnce();

    await secondService.stop(ctx as never);
    expect(firstClient.shutdownAsync).not.toHaveBeenCalled();
    expect(diagnosticUnsubscribe).not.toHaveBeenCalled();
    expect(transcriptUnsubscribe).not.toHaveBeenCalled();

    firstService
      .getHookHandlers()
      .beforeAgentStart({}, { agentId: "agent-2", sessionKey: "session-2" });
    expect(firstClient.trace).toHaveBeenCalledTimes(2);

    await firstService.stop(ctx as never);
    expect(firstClient.shutdownAsync).toHaveBeenCalledOnce();
    expect(diagnosticUnsubscribe).toHaveBeenCalledOnce();
    expect(transcriptUnsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps the existing runtime without a transcript event source during an active trace", async () => {
    const { createLangfuseService } = await import("./service.js");
    const diagnosticUnsubscribe = vi.fn();
    const onEvent = vi.fn(() => diagnosticUnsubscribe);
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent },
    };
    const firstService = createLangfuseService(baseConfig, mockLogger);
    await firstService.start(ctx as never);
    const firstClient = langfuseMock.instances[0];
    firstService
      .getHookHandlers()
      .beforeAgentStart({}, { agentId: "agent-1", sessionKey: "session-1" });

    const secondService = createLangfuseService(baseConfig, mockLogger);
    await secondService.start(ctx as never);

    expect(langfuseMock.instances).toHaveLength(1);
    expect(firstClient.trace).toHaveBeenCalledOnce();
    expect(firstClient.shutdownAsync).not.toHaveBeenCalled();
    expect(diagnosticUnsubscribe).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledOnce();

    await secondService.stop(ctx as never);
    expect(firstClient.shutdownAsync).not.toHaveBeenCalled();
    expect(diagnosticUnsubscribe).not.toHaveBeenCalled();

    firstService
      .getHookHandlers()
      .beforeAgentStart({}, { agentId: "agent-2", sessionKey: "session-2" });
    expect(firstClient.trace).toHaveBeenCalledTimes(2);

    await firstService.stop(ctx as never);
    expect(firstClient.shutdownAsync).toHaveBeenCalledOnce();
    expect(diagnosticUnsubscribe).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight transcript update before shutting down the Langfuse client", async () => {
    const { createLangfuseService } = await import("./service.js");
    let resolveTranscript!: (entries: unknown[]) => void;
    transcriptRuntimeMock.readVisibleSessionTranscriptMessageEntries.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const onSessionTranscriptUpdate = vi.fn(() => vi.fn());
    const runtime = { events: { onSessionTranscriptUpdate } };
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent: vi.fn(() => vi.fn()) },
    };
    const service = createLangfuseService(baseConfig, mockLogger, runtime as never);
    await service.start(ctx as never);
    service.getHookHandlers().beforeAgentStart({}, { agentId: "agent-1", sessionKey: "session-1" });
    const listener = onSessionTranscriptUpdate.mock.calls[0]?.[0] as (update: unknown) => void;
    listener({
      target: { agentId: "agent-1", sessionId: "session-id-1", sessionKey: "session-1" },
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 1, output: 1, total: 2 },
      },
    });
    await vi.waitFor(() => {
      expect(
        transcriptRuntimeMock.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalledOnce();
    });

    const client = langfuseMock.instances[0];
    const stopPromise = service.stop(ctx as never);
    await Promise.resolve();
    expect(client.shutdownAsync).not.toHaveBeenCalled();

    resolveTranscript([]);
    await stopPromise;
    expect(client.shutdownAsync).toHaveBeenCalledOnce();
  });

  it("waits for queued diagnostic handlers before shutting down the Langfuse client", async () => {
    const { createLangfuseService } = await import("./service.js");
    const service = createLangfuseService(baseConfig, mockLogger);
    const ctx = {
      logger: mockLogger,
      internalDiagnostics: { onEvent: vi.fn(() => vi.fn()) },
    };
    await service.start(ctx as never);
    let releaseDiagnostics!: () => void;
    diagnosticRuntimeMock.waitForDiagnosticEventsDrained.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDiagnostics = resolve;
        }),
    );

    const client = langfuseMock.instances[0];
    const stopPromise = service.stop(ctx as never);
    await Promise.resolve();
    expect(client.shutdownAsync).not.toHaveBeenCalled();

    releaseDiagnostics();
    await stopPromise;
    expect(client.shutdownAsync).toHaveBeenCalledOnce();
  });

  it("does not recover or upload incomplete traces when tracing is disabled", async () => {
    const { createLangfuseService } = await import("./service.js");
    const service = createLangfuseService(
      { ...baseConfig, tracing: { enabled: false } },
      mockLogger,
    );
    const ctx = { logger: mockLogger, stateDir: "/tmp/openclaw-langfuse-disabled" };

    await service.start(ctx as never);
    await Promise.resolve();

    expect(recoveryMock.scanIncompleteTraces).not.toHaveBeenCalled();
    expect(recoveryMock.recoverTrace).not.toHaveBeenCalled();

    await service.stop(ctx as never);
  });
});
