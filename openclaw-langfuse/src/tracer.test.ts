import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginLogger, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { computeCorrectedStartTimes, finalizeIncrementalObservations } from "./finalize.js";
import { buildObservationsFromEntries } from "./observations.js";
import { createLangfuseService, generateTraceId } from "./service.js";
import { resolveMarkerFilePath } from "./session.js";
import type { TraceContextEntry } from "./trace-context.js";
import type { SessionEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK — use vi.hoisted so refs are available inside factory
// ---------------------------------------------------------------------------

const {
  mockGeneration,
  mockTrace,
  mockSpan,
  mockLangfuseInstance,
  mockLangfuseConstructor,
  diagnosticRuntime,
  sessionTranscriptRuntime,
} = vi.hoisted(() => {
  const mockSpan = { update: vi.fn(), end: vi.fn() };
  const mockGeneration = {
    update: vi.fn(),
    end: vi.fn(),
    span: vi.fn().mockReturnValue(mockSpan),
  };
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
  const mockLangfuseConstructor = vi.fn(function () {
    return mockLangfuseInstance;
  });
  const diagnosticRuntime: {
    listener?: (event: Record<string, unknown>, privateData?: Record<string, unknown>) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
    waitForDiagnosticEventsDrained: ReturnType<typeof vi.fn>;
  } = {
    unsubscribe: vi.fn(),
    waitForDiagnosticEventsDrained: vi.fn(async () => undefined),
  };
  const sessionTranscriptRuntime = {
    entriesBySessionId: new Map<string, unknown[]>(),
    readVisibleSessionTranscriptMessageEntries: vi.fn(
      async ({ sessionId }: { sessionId: string }) =>
        sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
    ),
  };
  return {
    mockGeneration,
    mockSpan,
    mockTrace,
    mockLangfuseInstance,
    mockLangfuseConstructor,
    diagnosticRuntime,
    sessionTranscriptRuntime,
  };
});

vi.mock("langfuse", () => ({
  default: mockLangfuseConstructor,
}));

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  waitForDiagnosticEventsDrained: diagnosticRuntime.waitForDiagnosticEventsDrained,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries:
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
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
    internalDiagnostics: {
      emit: vi.fn(),
      onEvent: (listener) => {
        diagnosticRuntime.listener = (event, privateData) =>
          listener(event as never, {} as never, privateData as never);
        return diagnosticRuntime.unsubscribe;
      },
    },
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

let startedServices: Array<ReturnType<typeof createLangfuseService>> = [];

async function startService(
  cfg: LangfusePluginConfig = config,
  pluginRuntime?: Parameters<typeof createLangfuseService>[2],
  ctxOverrides?: Partial<OpenClawPluginServiceContext>,
) {
  const service = createLangfuseService(cfg, mockLogger, pluginRuntime);
  startedServices.push(service);
  await service.start(makeServiceCtx(ctxOverrides));
  return service;
}

function makeTraceEntry(overrides?: Partial<TraceContextEntry>): TraceContextEntry {
  return {
    trace: mockTrace as unknown as TraceContextEntry["trace"],
    traceId: "trace-test",
    llmCallCount: 0,
    toolCallCount: 0,
    pendingGenerations: new Map(),
    pendingGenIds: new Map(),
    completedGenerations: new Map(),
    pendingSpans: new Map(),
    completedSpanToolCallIds: new Set(),
    createdAt: 1000,
    timestamp: 1000,
    ...overrides,
  };
}

type TranscriptUpdate = {
  target?: { agentId: string; sessionId: string; sessionKey: string };
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

type TranscriptListener = (update: TranscriptUpdate) => void;

function transcriptTarget(ctx: typeof agentCtx): TranscriptUpdate["target"] {
  return {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
  };
}

function setTranscriptRows(
  sessionId: string,
  rows: Array<{
    id: string;
    parentId?: string;
    type?: string;
    timestamp: string;
    message: Record<string, unknown>;
  }>,
): void {
  sessionTranscriptRuntime.entriesBySessionId.set(
    sessionId,
    rows.map((row) => ({
      entryId: row.id,
      ...(row.parentId ? { parentId: row.parentId } : {}),
      createdAt: row.timestamp,
      message: row.message,
    })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LangfuseService tracer", () => {
  beforeEach(() => {
    startedServices = [];
    vi.clearAllMocks();
    diagnosticRuntime.listener = undefined;
    diagnosticRuntime.waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
    sessionTranscriptRuntime.entriesBySessionId.clear();
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockImplementation(
      async ({ sessionId }: { sessionId: string }) =>
        sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
    );
  });

  afterEach(async () => {
    for (const service of startedServices.reverse()) {
      await service.stop?.(makeServiceCtx());
    }
    vi.useRealTimers();
    diagnosticRuntime.listener = undefined;
  });

  it("warns when gateway diagnostics are unavailable", async () => {
    const service = await startService(config, undefined, { internalDiagnostics: undefined });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("hooks.allowConversationAccess"),
    );
    await service.stop?.(makeServiceCtx({ internalDiagnostics: undefined }));
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

  it("flushes each bounded event separately for the self-hosted proxy", async () => {
    const service = await startService();

    expect(mockLangfuseConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ flushAt: 1, flushInterval: 1000 }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("bounds shutdown when the process diagnostic drain never resolves", async () => {
    vi.useFakeTimers();
    diagnosticRuntime.waitForDiagnosticEventsDrained.mockReturnValue(new Promise<never>(() => {}));
    const service = await startService();

    const stopPromise = service.stop?.(makeServiceCtx());
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out waiting 5000ms for diagnostic events to drain"),
    );
  });

  it("keeps diagnostic events subscribed until the process queue drains", async () => {
    let resolveDrain: (() => void) | undefined;
    diagnosticRuntime.waitForDiagnosticEventsDrained.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDrain = resolve;
      }),
    );
    const service = await startService();

    const stopPromise = service.stop?.(makeServiceCtx());
    await vi.waitFor(() =>
      expect(diagnosticRuntime.waitForDiagnosticEventsDrained).toHaveBeenCalledOnce(),
    );
    expect(diagnosticRuntime.unsubscribe).not.toHaveBeenCalled();

    resolveDrain?.();
    await stopPromise;

    expect(diagnosticRuntime.unsubscribe).toHaveBeenCalledOnce();
  });

  it("bounds shutdown when a transcript runtime task never resolves", async () => {
    vi.useFakeTimers();
    let transcriptListener: TranscriptListener | undefined;
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockReturnValue(
      new Promise<never>(() => {}),
    );
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });

    service.getHookHandlers().beforeAgentStart({ prompt: "hello" }, agentCtx);
    transcriptListener?.({
      target: transcriptTarget(agentCtx),
      messageId: "assistant-stalled-read",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
      },
    });
    await vi.waitFor(() =>
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalledOnce(),
    );

    const stopPromise = service.stop?.(makeServiceCtx());
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("timed out waiting 5000ms for runtime tasks to drain"),
    );
  });

  it("bounds queued transcript updates behind a stalled session read", async () => {
    vi.useFakeTimers();
    let transcriptListener: TranscriptListener | undefined;
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockReturnValue(
      new Promise<never>(() => {}),
    );
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });

    service.getHookHandlers().beforeAgentStart({ prompt: "hello" }, agentCtx);
    transcriptListener?.({
      target: transcriptTarget(agentCtx),
      messageId: "assistant-stalled-read",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
      },
    });
    await vi.waitFor(() =>
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalledOnce(),
    );

    for (let index = 0; index < 130; index += 1) {
      transcriptListener?.({
        target: transcriptTarget(agentCtx),
        message: {
          role: "toolResult",
          toolCallId: `tool-${index}`,
          toolName: "example",
          content: [{ type: "text", text: "result" }],
        },
      });
    }

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("transcript queue limit reached"),
    );
    const stopPromise = service.stop?.(makeServiceCtx());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("bounds a large final trace update below the self-hosted proxy limit", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const largeText = "x".repeat(300 * 1024);
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:large-trace-update",
      sessionId: "session-large-trace-update",
    };
    beforeAgentStart({ prompt: largeText }, ctx);
    await llmInput(
      {
        runId: "large-run",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        systemPrompt: largeText,
        prompt: largeText,
        historyMessages: [
          { role: "user", content: largeText },
          { role: "assistant", content: largeText },
        ],
        imagesCount: 0,
      },
      ctx,
    );
    llmOutput(
      {
        runId: "large-run",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        assistantTexts: [largeText],
        usage: { input: 10, output: 5, total: 15 },
      },
      ctx,
    );
    await agentEnd(
      {
        messages: [
          { role: "user", content: largeText },
          {
            role: "assistant",
            content: [{ type: "text", text: largeText }],
            provider: "codex",
            model: "baidu/deepseek-v4-pro",
            usage: { input: 10, output: 5, totalTokens: 15 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );

    const finalUpdate = mockTrace.update.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((update) => (update.metadata as Record<string, unknown> | undefined)?.stats);
    expect(finalUpdate).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(finalUpdate), "utf8")).toBeLessThan(1024 * 1024);
    expect(JSON.stringify(finalUpdate)).toContain("[truncated:");
    await service.stop?.(makeServiceCtx());
  });

  it("aggregates provider-request usage into trace metadata", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:provider-usage",
      sessionId: "session-provider-usage",
    };
    beforeAgentStart({ prompt: "run tools" }, ctx);

    for (const [index, usage] of [
      { input: 100, output: 10, cacheRead: 20, total: 130 },
      { input: 120, output: 15, cacheRead: 30 },
    ].entries()) {
      const callId = `provider-call-${index + 1}`;
      diagnosticRuntime.listener?.({
        type: "model.call.started",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        startTimeMs: 1000 + index * 100,
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        startTimeMs: 1000 + index * 100,
        endTimeMs: 1050 + index * 100,
        usage,
      });
    }

    await agentEnd(
      {
        messages: [
          { role: "user", content: "run tools" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "codex",
            model: "baidu/deepseek-v4-pro",
            usage: { input: 120, output: 15, cacheRead: 30, totalTokens: 135 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );

    expect(mockTrace.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usage: {
            inputTokens: 220,
            outputTokens: 25,
            cacheReadInputTokens: 50,
            cacheWriteInputTokens: undefined,
            totalTokens: 295,
          },
        }),
      }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("patches finalized trace usage when provider diagnostics complete late", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:late-provider-completion",
      sessionId: "session-late-provider-completion",
    };
    beforeAgentStart({ prompt: "run tools" }, ctx);

    diagnosticRuntime.listener?.({
      type: "model.call.started",
      callId: "provider-call-1",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "baidu/deepseek-v4-pro",
      startTimeMs: 1000,
    });
    diagnosticRuntime.listener?.({
      type: "model.call.completed",
      callId: "provider-call-1",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "baidu/deepseek-v4-pro",
      endTimeMs: 1050,
      usage: { input: 100, output: 10, cacheRead: 20, total: 130 },
    });
    diagnosticRuntime.listener?.({
      type: "model.call.started",
      callId: "provider-call-2",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "baidu/deepseek-v4-pro",
      startTimeMs: 1100,
    });

    await agentEnd(
      {
        messages: [
          { role: "user", content: "run tools" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 120, output: 15, cacheRead: 30, totalTokens: 165 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );

    expect(mockTrace.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usage: {
            inputTokens: 120,
            outputTokens: 15,
            cacheReadInputTokens: 30,
            cacheWriteInputTokens: undefined,
            totalTokens: 165,
          },
        }),
      }),
    );

    diagnosticRuntime.listener?.({
      type: "model.call.completed",
      callId: "provider-call-2",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "baidu/deepseek-v4-pro",
      endTimeMs: 1150,
      usage: { input: 120, output: 15, cacheRead: 30 },
    });

    await vi.waitFor(() => {
      expect(mockTrace.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            usage: {
              inputTokens: 220,
              outputTokens: 25,
              cacheReadInputTokens: 50,
              cacheWriteInputTokens: undefined,
              totalTokens: 295,
            },
          }),
        }),
      );
    });
    await service.stop?.(makeServiceCtx());
  });

  it("falls back to turn usage when provider-request usage coverage is incomplete", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:partial-provider-usage",
      sessionId: "session-partial-provider-usage",
    };
    beforeAgentStart({ prompt: "run tools" }, ctx);

    for (const [index, usage] of [
      { input: 100, output: 10, total: 110 },
      { input: 200 },
    ].entries()) {
      const callId = `provider-call-${index + 1}`;
      diagnosticRuntime.listener?.({
        type: "model.call.started",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        startTimeMs: 1000 + index * 100,
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        startTimeMs: 1000 + index * 100,
        endTimeMs: 1050 + index * 100,
        usage,
      });
    }

    await agentEnd(
      {
        messages: [
          { role: "user", content: "run tools" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "codex",
            model: "baidu/deepseek-v4-pro",
            usage: { input: 500, output: 50, cacheRead: 75, totalTokens: 550 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );

    expect(mockTrace.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usage: {
            inputTokens: 500,
            outputTokens: 50,
            cacheReadInputTokens: 75,
            cacheWriteInputTokens: undefined,
            totalTokens: 550,
          },
        }),
      }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("preserves provider-request aggregate usage during late transcript repair", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:late-provider-usage",
      sessionId: "session-late-provider-usage",
    };
    beforeAgentStart({ prompt: "run tools" }, ctx);

    for (const [index, usage] of [
      { input: 100, output: 10, total: 110 },
      { input: 120, output: 15, total: 135 },
    ].entries()) {
      const callId = `provider-call-${index + 1}`;
      diagnosticRuntime.listener?.({
        type: "model.call.started",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        startTimeMs: 1000 + index * 100,
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        callId,
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        endTimeMs: 1050 + index * 100,
        usage,
      });
    }

    await agentEnd(
      {
        messages: [
          { role: "user", content: "run tools" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 120, output: 15, totalTokens: 135 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        usage: { input: 120, output: 15, totalTokens: 135 },
        stopReason: "stop",
      },
    });

    const finalMetadata = mockTrace.update.mock.calls.at(-1)?.[0].metadata;
    expect(finalMetadata.usage).toEqual({
      inputTokens: 220,
      outputTokens: 25,
      cacheReadInputTokens: undefined,
      cacheWriteInputTokens: undefined,
      totalTokens: 245,
    });
    await service.stop?.(makeServiceCtx());
  });

  it("preserves finalized turn aggregate usage during late transcript repair", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:late-finalized-usage",
      sessionId: "session-late-finalized-usage",
    };
    beforeAgentStart({ prompt: "continue" }, ctx);

    await agentEnd(
      {
        messages: [
          { role: "user", content: "continue" },
          {
            role: "assistant",
            content: [{ type: "text", text: "first" }],
            usage: { input: 100, output: 10, totalTokens: 110 },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input: 120, output: 15, totalTokens: 135 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 120, output: 15, totalTokens: 135 },
        stopReason: "stop",
      },
    });

    const finalMetadata = mockTrace.update.mock.calls.at(-1)?.[0].metadata;
    expect(finalMetadata.usage).toEqual({
      inputTokens: 220,
      outputTokens: 25,
      cacheReadInputTokens: undefined,
      cacheWriteInputTokens: undefined,
      totalTokens: 245,
    });
    await service.stop?.(makeServiceCtx());
  });

  it("handles older transcript updates that omit target identity", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });
    const { beforeAgentStart } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:legacy-transcript-update",
      sessionId: "session-legacy-transcript-update",
    };
    beforeAgentStart({ prompt: "continue" }, ctx);

    expect(transcriptListener).toBeDefined();
    transcriptListener?.({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "legacy host response" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: "stop",
        timestamp: Date.parse("2026-07-01T12:00:00.000Z"),
      },
    });

    await vi.waitFor(() => {
      expect(mockTrace.generation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "llm-call-1",
          metadata: expect.objectContaining({ source: "transcript-realtime" }),
        }),
      );
    });
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("transcript update failed"),
    );
    await service.stop?.(makeServiceCtx());
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

  it("links Langfuse prompt when beforePromptBuild runs before trace creation", async () => {
    const promptClient = { prompt: "Always answer in terse bullet points" };
    mockLangfuseInstance.getPrompt.mockResolvedValue(promptClient);
    const service = await startService({
      ...config,
      prompts: [{ match: "agent-1", langfusePrompt: "agent-guidance" }],
    });
    const { beforePromptBuild, beforeAgentStart, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-prompt-link" };

    beforePromptBuild({ prompt: "hello", messages: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-prompt-link",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        systemPrompt: "Base system prompt",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );

    const genArgs = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(genArgs.prompt).toBe(promptClient);
  });

  it("clears pending prompt state when service stops", async () => {
    const promptClient = { prompt: "Link this prompt" };
    mockLangfuseInstance.getPrompt.mockResolvedValue(promptClient);
    const firstService = await startService({
      ...config,
      prompts: [{ match: "agent-1", langfusePrompt: "agent-guidance" }],
    });
    const ctx = { ...agentCtx, sessionKey: "session-key-prompt-stop" };
    firstService.getHookHandlers().beforePromptBuild({ prompt: "hello", messages: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await firstService.stop?.(makeServiceCtx());

    vi.clearAllMocks();

    const secondService = await startService(config);
    const { beforeAgentStart, llmInput } = secondService.getHookHandlers();
    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-prompt-stop",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        systemPrompt: "Base system prompt",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );

    const genArgs = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(genArgs.prompt).toBeUndefined();
    await secondService.stop?.(makeServiceCtx());
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

  it("does not overwrite provider-request generation content during finalization", () => {
    const generation = { update: vi.fn(), end: vi.fn() };
    const entry = {
      trace: mockTrace,
      traceId: "trace-provider-request",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      providerRequestAugmentedHookGenerations: true,
      createdAt: 1_000,
      timestamp: 1_000,
    } as unknown as TraceContextEntry;
    const turnEntries = [
      { timestamp: 2_000, message: { role: "user", content: "hello" } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final text" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          stopReason: "stop",
          usage: { input: 10, output: 2, totalTokens: 12 },
        },
      },
    ] as SessionEntry[];

    finalizeIncrementalObservations(
      entry,
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    expect(generation.update).not.toHaveBeenCalled();
  });

  it("does not create trace-level tool spans when provider diagnostics own the turn", () => {
    const entry = {
      trace: mockTrace,
      traceId: "trace-provider-tool",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      hasProviderRequestGenerations: true,
      lastProvider: "codex",
      createdAt: 1_000,
      timestamp: 1_000,
    } as unknown as TraceContextEntry;
    const turnEntries = [
      { timestamp: 2_000, message: { role: "user", content: "read a file" } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", input: { path: "a" } }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          stopReason: "toolUse",
        },
      },
      {
        timestamp: 4_000,
        message: { role: "toolResult", toolCallId: "call-1", content: "done" },
      },
    ] as SessionEntry[];

    finalizeIncrementalObservations(
      entry,
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    expect(mockTrace.span).not.toHaveBeenCalled();
    expect(entry.toolCallCount).toBe(1);
  });

  it("does not overwrite the first provider request with a later aggregate llmOutput", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:provider-aggregate-race",
    };

    beforeAgentStart({ prompt: "use tools" }, ctx);
    llmInput(
      {
        runId: "turn-run",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/glm-5.2",
        prompt: "use tools",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    diagnosticRuntime.listener?.(
      {
        type: "model.call.started",
        runId: "turn-run",
        callId: "provider-call-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "Baidu",
        model: "glm-5.2",
        startTimeMs: 1_000,
      },
      { modelContent: { inputMessages: [{ role: "user", content: "use tools" }] } },
    );
    diagnosticRuntime.listener?.(
      {
        type: "model.call.completed",
        runId: "turn-run",
        callId: "provider-call-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "Baidu",
        model: "glm-5.2",
        startTimeMs: 1_000,
        endTimeMs: 2_000,
        durationMs: 1_000,
        usageSource: "provider",
        usage: { input: 100, output: 20, total: 120 },
      },
      {
        modelContent: {
          outputMessages: [{ type: "function_call", name: "skills.list" }],
        },
      },
    );
    await vi.waitFor(() => {
      expect(mockGeneration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: [{ type: "function_call", name: "skills.list" }],
          usageDetails: { input: 100, output: 20, total: 120 },
        }),
      );
    });
    mockGeneration.update.mockClear();

    llmOutput(
      {
        runId: "turn-run",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/glm-5.2",
        assistantTexts: ["final answer"],
        lastAssistant: { content: [{ type: "text", text: "final answer" }] },
        usage: { input: 300, output: 5, total: 305 },
      },
      ctx,
    );

    expect(mockGeneration.update).not.toHaveBeenCalled();
    await service.stop?.(makeServiceCtx());
  });

  it("defers Codex tool spans until rollout diagnostics identify their provider generation", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, beforeToolCall, afterToolCall } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "agent:agent-1:codex-tool-parent" };

    beforeAgentStart({ prompt: "use a tool" }, ctx);
    llmInput(
      {
        runId: "turn-run",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/glm-5.2",
        prompt: "use a tool",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    mockGeneration.span.mockClear();
    mockTrace.span.mockClear();

    beforeToolCall(
      { toolName: "skills.list", params: {}, toolCallId: "tool-1" },
      { ...toolCtx, sessionKey: ctx.sessionKey, toolName: "skills.list", toolCallId: "tool-1" },
    );
    afterToolCall(
      { toolName: "skills.list", params: {}, toolCallId: "tool-1", result: { skills: [] } },
      { ...toolCtx, sessionKey: ctx.sessionKey, toolName: "skills.list", toolCallId: "tool-1" },
    );

    expect(mockGeneration.span).not.toHaveBeenCalled();
    expect(mockTrace.span).not.toHaveBeenCalled();

    diagnosticRuntime.listener?.({
      type: "model.call.started",
      runId: "turn-run",
      callId: "provider-call-1",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "Baidu",
      model: "glm-5.2",
      startTimeMs: 1_000,
    });
    diagnosticRuntime.listener?.({
      type: "model.call.completed",
      runId: "turn-run",
      callId: "provider-call-1",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "Baidu",
      model: "glm-5.2",
      startTimeMs: 1_000,
      endTimeMs: 2_000,
      usage: { input: 100, output: 20, total: 120 },
    });
    diagnosticRuntime.listener?.(
      {
        type: "tool.execution.completed",
        runId: "turn-run",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        toolName: "skills.list",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-1",
        startTimeMs: 2_100,
        endTimeMs: 2_125,
        durationMs: 25,
      },
      { toolContent: { toolInput: {}, toolOutput: { skills: [] } } },
    );

    await vi.waitFor(() => {
      expect(mockGeneration.span).toHaveBeenCalledWith(
        expect.objectContaining({ name: "tool:skills.list" }),
      );
    });
    expect(mockTrace.span).not.toHaveBeenCalled();
    await service.stop?.(makeServiceCtx());
  });

  it("keeps live tool spans for non-Codex provider diagnostics", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, beforeToolCall, afterToolCall } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:anthropic-provider-diagnostics",
      sessionId: "session-anthropic-provider-diagnostics",
    };

    beforeAgentStart({ prompt: "use a tool" }, ctx);
    llmInput(
      {
        runId: "anthropic-run",
        sessionId: ctx.sessionId,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        prompt: "use a tool",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    diagnosticRuntime.listener?.({
      type: "model.call.started",
      runId: "anthropic-run",
      callId: "anthropic-provider-call",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      startTimeMs: 1_000,
    });

    mockGeneration.span.mockClear();
    beforeToolCall(
      { toolName: "read", params: { path: "a.txt" }, toolCallId: "anthropic-tool" },
      { ...toolCtx, sessionKey: ctx.sessionKey, toolName: "read", toolCallId: "anthropic-tool" },
    );
    afterToolCall(
      {
        toolName: "read",
        params: { path: "a.txt" },
        toolCallId: "anthropic-tool",
        result: "done",
      },
      { ...toolCtx, sessionKey: ctx.sessionKey, toolName: "read", toolCallId: "anthropic-tool" },
    );

    expect(mockGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tool:read" }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("does not block llmInput on Langfuse flush", async () => {
    vi.useFakeTimers();
    const service = await startService();
    const { beforeAgentStart, llmInput } = service.getHookHandlers();
    const ctx2 = { ...agentCtx, sessionKey: "session-key-nonblocking-flush" };

    beforeAgentStart({ prompt: "hello" }, ctx2);
    const result = llmInput(
      {
        runId: "run-nonblocking-flush",
        sessionId: "session-id-1",
        provider: "openai",
        model: "gpt-5.5",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx2,
    );

    expect(result).toBeUndefined();
    expect(mockLangfuseInstance.flushAsync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce();
  });

  it("agentEnd keeps tool calls in generation output without creating tool spans", async () => {
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

    // 2 generations (2 assistant messages); tool calls stay in generation output.
    const genCalls = mockTrace.generation.mock.calls.filter((c: unknown[]) =>
      (c[0] as Record<string, unknown>).name?.toString().startsWith("llm-call-"),
    );
    expect(genCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockTrace.span).not.toHaveBeenCalled();
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

    // Tool calls are emitted as standalone spans.
    beforeToolCall(
      { toolName: "read", params: {}, toolCallId: "tc-1" },
      { ...toolCtx, toolName: "read", toolCallId: "tc-1" },
    );
    afterToolCall(
      { toolName: "read", params: {}, toolCallId: "tc-1", result: "data" },
      { ...toolCtx, toolName: "read", toolCallId: "tc-1" },
    );
    expect(mockGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:read",
        input: {},
        metadata: expect.objectContaining({ toolName: "read", toolCallId: "tc-1" }),
      }),
    );
    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "data",
        metadata: expect.objectContaining({ toolName: "read", toolCallId: "tc-1" }),
      }),
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

    // Tool calls are counted in metadata, but not emitted as standalone observations.
    expect(mockGeneration.span).toHaveBeenCalledOnce();

    // Trace finalized
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.metadata.stats.llmCallCount).toBe(2);
    expect(updateArgs.metadata.stats.toolCallCount).toBe(1);
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
                name: "example_api_call",
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
            toolName: "example_api_call",
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
                name: "example_api_call",
                input: { method: "POST", path: "/api/example/search" },
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
            toolName: "example_api_call",
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

    // Tool calls are not emitted as standalone observations.
    expect(mockTrace.span).not.toHaveBeenCalled();

    // Trace should be finalized
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("搜索成功！找到了3位候选人。");
    expect(updateArgs.metadata.stats.llmCallCount).toBe(3);
    expect(updateArgs.metadata.stats.success).toBe(true);
  });

  it("writes a recovery start marker before the agentEnd marker", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-recovery-marker-"));
    const service = await startService(config, undefined, { stateDir });
    const { agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      agentId: "agent-recovery-marker",
      sessionKey: "session-key-recovery-marker",
      sessionId: "session-id-recovery-marker",
    };

    try {
      await agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
          ],
          success: true,
        },
        ctx,
      );

      const markerFile = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      const markerTypes = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { customType?: string })
        .flatMap((event) => (event.customType ? [event.customType] : []));
      expect(markerTypes).toEqual(["langfuse-trace-start", "langfuse-trace-end"]);
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("finalizes a trace once when agentEnd is invoked concurrently", async () => {
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-concurrent-agent-end",
      sessionId: "session-id-concurrent-agent-end",
    };
    const event = {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          usage: { input: 10, output: 2, totalTokens: 12 },
        },
      ],
      success: true,
      durationMs: 100,
    };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await Promise.all([agentEnd(event, ctx), agentEnd(event, ctx)]);

    expect(mockTrace.generation).toHaveBeenCalledOnce();
    expect(mockTrace.update).toHaveBeenCalledOnce();
    await service.stop?.(makeServiceCtx());
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

  it("uses assistant row completion timestamps for finalized observations", () => {
    const pendingGen = { update: vi.fn(), end: vi.fn() };
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "search", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-bash", name: "bash", input: { command: "sed" } }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          stopReason: "toolUse",
          timestamp: 2_000,
        },
      },
      {
        timestamp: 3_050,
        message: {
          role: "toolResult",
          toolCallId: "tc-bash",
          toolName: "bash",
          content: "skill doc",
          timestamp: 3_050,
        },
      },
      {
        timestamp: 9_002,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          timestamp: 4_000,
        },
      },
    ] as unknown as SessionEntry[];

    finalizeIncrementalObservations(
      makeTraceEntry({
        llmCallCount: 1,
        pendingGenerations: new Map([["run-1", pendingGen as never]]),
        pendingGenIds: new Map([["run-1", "trace-test-gen-1"]]),
        timestamp: 1_500,
      }),
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    expect((pendingGen.update.mock.calls[0][0].endTime as Date).getTime()).toBe(3_000);
    expect(mockTrace.span).toHaveBeenCalledWith({
      id: "trace-test-span-tc-bash",
      name: "tool:bash",
      startTime: new Date(2_000),
      input: { command: "sed" },
      metadata: {
        toolName: "bash",
        toolCallId: "tc-bash",
        source: "jsonl-finalize",
      },
    });
    expect(mockSpan.update).toHaveBeenCalledWith({
      endTime: new Date(3_050),
      output: "skill doc",
      metadata: {
        toolName: "bash",
        toolCallId: "tc-bash",
        source: "jsonl-finalize",
      },
    });

    const gapFilledGeneration = mockTrace.generation.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).name === "llm-call-2",
    )?.[0] as Record<string, unknown>;
    expect((gapFilledGeneration.startTime as Date).getTime()).toBe(3_050);
    expect((gapFilledGeneration.endTime as Date).getTime()).toBe(9_002);
  });

  it("preserves failed tool status when finalizing spans from JSONL", () => {
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "search" } },
      {
        timestamp: 2_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-error", name: "search", input: {} }],
        },
      },
      {
        timestamp: 3_000,
        message: {
          role: "toolResult",
          toolCallId: "tc-error",
          content: "blocked",
          isError: true,
        },
      },
    ] as unknown as SessionEntry[];

    finalizeIncrementalObservations(
      makeTraceEntry({ timestamp: 1_000 }),
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "blocked",
        level: "ERROR",
        statusMessage: "tool returned an error result",
        metadata: expect.objectContaining({ isError: true }),
      }),
    );
  });

  it("corrects completed generation endTime from assistant row completion", () => {
    const completedGen = { update: vi.fn(), end: vi.fn() };
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "search", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-bash", name: "bash", input: { command: "sed" } }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          stopReason: "toolUse",
          timestamp: 2_000,
        },
      },
    ] as unknown as SessionEntry[];

    finalizeIncrementalObservations(
      makeTraceEntry({
        llmCallCount: 1,
        completedGenerations: new Map([[1, completedGen as never]]),
        timestamp: 1_500,
      }),
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    const patch = completedGen.update.mock.calls[0][0] as Record<string, unknown>;
    expect((patch.startTime as Date).getTime()).toBe(1_500);
    expect((patch.endTime as Date).getTime()).toBe(3_000);
  });

  it("batch recovery uses assistant row completion timestamps", () => {
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "search", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-bash", name: "bash", input: { command: "sed" } }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          stopReason: "toolUse",
          timestamp: 2_000,
        },
      },
      {
        timestamp: 3_050,
        message: {
          role: "toolResult",
          toolCallId: "tc-bash",
          toolName: "bash",
          content: "skill doc",
          timestamp: 3_050,
        },
      },
      {
        timestamp: 9_002,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          timestamp: 4_000,
        },
      },
    ] as unknown as SessionEntry[];

    buildObservationsFromEntries(
      mockTrace as unknown as Parameters<typeof buildObservationsFromEntries>[0],
      "trace-test",
      turnEntries,
      turnEntries,
      { entryTimestamp: 1_500, redactEnabled: false },
      mockLogger,
    );

    const generations = mockTrace.generation.mock.calls.map((call) => call[0]);
    expect((generations[0].endTime as Date).getTime()).toBe(3_000);
    expect((generations[1].startTime as Date).getTime()).toBe(3_050);
    expect((generations[1].endTime as Date).getTime()).toBe(9_002);

    expect(mockTrace.span).not.toHaveBeenCalled();
  });

  it("batch observation gen-1 input starts at current turn boundary", () => {
    const priorEntries = [
      { timestamp: 100, message: { role: "user", content: "old question" } },
      { timestamp: 200, message: { role: "assistant", content: "old answer" } },
    ] as unknown as SessionEntry[];
    const turnEntries = [
      { timestamp: 300, message: { role: "user", content: "new question" } },
      {
        timestamp: 400,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "new answer" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
        },
      },
    ] as unknown as SessionEntry[];
    const allEntries = [...priorEntries, ...turnEntries];

    buildObservationsFromEntries(
      mockTrace as unknown as Parameters<typeof buildObservationsFromEntries>[0],
      "trace-test",
      turnEntries,
      allEntries,
      { entryTimestamp: 300, redactEnabled: false },
      mockLogger,
    );

    const genInput = mockTrace.generation.mock.calls[0][0].input as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(genInput.messages.map((message) => message.content)).toEqual(["new question"]);
  });

  it("keeps aggregate-only usage at trace level without assigning it to a generation", () => {
    const turnEntries = [
      { timestamp: 300, message: { role: "user", content: "search" } },
      {
        timestamp: 400,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "search",
              input: { query: "candidates" },
            },
          ],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
        },
      },
      {
        timestamp: 500,
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          content: "result",
          timestamp: 500,
        },
      },
      {
        timestamp: 600,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          usage: {
            input: 2964,
            output: 1481,
            cacheRead: 71936,
            totalTokens: 76381,
          },
        },
      },
    ] as unknown as SessionEntry[];

    const result = buildObservationsFromEntries(
      mockTrace as unknown as Parameters<typeof buildObservationsFromEntries>[0],
      "trace-test",
      turnEntries,
      turnEntries,
      { entryTimestamp: 300, redactEnabled: false },
      mockLogger,
    );

    const generations = mockTrace.generation.mock.calls.map((call) => call[0]);
    expect(generations).toHaveLength(2);
    expect(generations[0].usageDetails).toBeUndefined();
    expect(generations[1].usageDetails).toBeUndefined();
    expect(result.totalUsage).toEqual({
      input: 2964,
      output: 1481,
      cacheRead: 71936,
      cacheWrite: 0,
      total: 76381,
    });
  });

  it("does not assign aggregate-only usage to orphan or gap-filled generations", () => {
    const pendingGen = { update: vi.fn(), end: vi.fn() };
    const turnEntries = [
      { timestamp: 300, message: { role: "user", content: "search" } },
      {
        timestamp: 400,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc-1",
              name: "search",
              input: { query: "candidates" },
            },
          ],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
        },
      },
      {
        timestamp: 500,
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          content: "result",
          timestamp: 500,
        },
      },
      {
        timestamp: 600,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
          usage: {
            input: 2964,
            output: 1481,
            cacheRead: 71936,
            totalTokens: 76381,
          },
        },
      },
    ] as unknown as SessionEntry[];

    const entry = makeTraceEntry({
      llmCallCount: 1,
      pendingGenerations: new Map([["run-1", pendingGen as never]]),
      pendingGenIds: new Map([["run-1", "trace-test-gen-1"]]),
      timestamp: 300,
    });

    finalizeIncrementalObservations(
      entry,
      turnEntries,
      turnEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    expect(pendingGen.update).toHaveBeenCalledOnce();
    expect(pendingGen.update.mock.calls[0][0].usageDetails).toBeUndefined();

    const gapFilledGeneration = mockTrace.generation.mock.calls[0][0] as Record<string, unknown>;
    expect(gapFilledGeneration.name).toBe("llm-call-2");
    expect(gapFilledGeneration.usageDetails).toBeUndefined();
    expect(entry.completedGenerations.get(2)).toBe(mockTrace.generation.mock.results[0]?.value);
  });

  it("gap-filled gen-1 input starts at current turn boundary", () => {
    const priorEntries = [
      { timestamp: 100, message: { role: "user", content: "old question" } },
      { timestamp: 200, message: { role: "assistant", content: "old answer" } },
    ] as unknown as SessionEntry[];
    const turnEntries = [
      { timestamp: 300, message: { role: "user", content: "new question" } },
      {
        timestamp: 400,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "new answer" }],
          model: "claude-3-5-sonnet",
          provider: "anthropic",
        },
      },
    ] as unknown as SessionEntry[];
    const allEntries = [...priorEntries, ...turnEntries];

    finalizeIncrementalObservations(
      makeTraceEntry({ llmCallCount: 0, timestamp: 300 }),
      turnEntries,
      allEntries,
      "agent-1",
      "session-1",
      false,
      { logger: mockLogger, stateDir: null, langfuseClient: null },
    );

    const genInput = mockTrace.generation.mock.calls[0][0].input as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(genInput.messages.map((message) => message.content)).toEqual(["new question"]);
  });

  it("beforeToolCall creates a tool span", async () => {
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

    beforeToolCall(
      { toolName: "web_search", params: { query: "test" }, toolCallId: "tc-parent" },
      { ...toolCtx, agentId: ctx.agentId, sessionKey: ctx.sessionKey, toolCallId: "tc-parent" },
    );

    expect(mockGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:web_search",
        input: { query: "test" },
        metadata: expect.objectContaining({
          toolName: "web_search",
          toolCallId: "tc-parent",
        }),
      }),
    );
  });

  it("llmInput gen-1 input contains only the current user prompt", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-1" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-delta-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "What is 2+2?",
        historyMessages: [
          { role: "user", content: "prior question" },
          { role: "assistant", content: "prior answer" },
        ],
        imagesCount: 0,
      },
      ctx,
    );

    const genArgs = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const input = genArgs.input as { messages: Array<{ role: string; content: unknown }> };
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].role).toBe("user");
    expect(input.messages[0].content).toBe("What is 2+2?");
  });

  it("llmInput does not duplicate current prompt already present in history", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-history-current" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-delta-history-current",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "What is 2+2?",
        historyMessages: [
          { role: "user", content: "prior question" },
          { role: "assistant", content: "prior answer" },
          { role: "user", content: "What is 2+2?" },
        ],
        imagesCount: 0,
      },
      ctx,
    );

    const genArgs = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const input = genArgs.input as { messages: Array<{ role: string; content: unknown }> };
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].role).toBe("user");
    expect(input.messages[0].content).toBe("What is 2+2?");

    const priorConversation = mockTrace.update.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as Record<string, Record<string, unknown>>)?.metadata?.prior_conversation,
    )?.[0] as Record<
      string,
      { prior_conversation: Array<{ role: string }>; sessionKey?: string; agentId?: string }
    >;
    expect(priorConversation.metadata.sessionKey).toBe(ctx.sessionKey);
    expect(priorConversation.metadata.agentId).toBe(ctx.agentId);
    expect(priorConversation.metadata.prior_conversation.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("llmInput gen-2 input contains only messages added since gen-1", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-2" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-d2-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "What is 2+2?",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    llmOutput(
      {
        runId: "run-d2-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["4"],
        usage: { input: 10, output: 5, total: 15 },
      },
      ctx,
    );

    await llmInput(
      {
        runId: "run-d2-2",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "",
        historyMessages: [
          { role: "user", content: "What is 2+2?" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tc1", name: "calc", input: {} }],
          },
          { role: "toolResult", toolCallId: "tc1", content: "4" },
        ],
        imagesCount: 0,
      },
      ctx,
    );

    const gen2Args = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const input = gen2Args.input as { messages: Array<{ role: string }> };
    expect(input.messages).toHaveLength(2);
    expect(input.messages[0].role).toBe("assistant");
    expect(input.messages[1].role).toBe("tool");
  });

  it("llmInput stores pre-turn history once as prior_conversation metadata", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-prior-conv" };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-prior-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "New question",
        historyMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
        imagesCount: 0,
      },
      ctx,
    );
    llmOutput(
      {
        runId: "run-prior-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["New answer"],
        usage: { input: 10, output: 5, total: 15 },
      },
      ctx,
    );
    await llmInput(
      {
        runId: "run-prior-2",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "",
        historyMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "New question" },
          { role: "assistant", content: "New answer" },
        ],
        imagesCount: 0,
      },
      ctx,
    );

    const priorConversationUpdates = mockTrace.update.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, Record<string, unknown>>)?.metadata?.prior_conversation,
    );
    expect(priorConversationUpdates).toHaveLength(1);
    const priorConversation = (
      priorConversationUpdates[0][0] as Record<string, Record<string, unknown>>
    ).metadata.prior_conversation as Array<{ role: string }>;
    expect(priorConversation.map((m) => m.role)).toEqual(["user", "assistant"]);

    await agentEnd(
      {
        messages: [
          { role: "user", content: "New question" },
          {
            role: "assistant",
            content: [{ type: "text", text: "New answer" }],
            model: "claude-3-5-sonnet",
            provider: "anthropic",
            usage: { input: 10, output: 5, totalTokens: 15 },
          },
        ],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );

    const finalUpdate = mockTrace.update.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, Record<string, unknown>>)
      .find((update) => update.metadata?.stats);
    expect(finalUpdate?.metadata.prior_conversation).toEqual(priorConversation);
  });

  it("uses canonical transcript row timing for realtime generations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T11:48:43.847Z"));
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-transcript-"));
    const service = await startService(config, runtime);
    try {
      const { beforeAgentStart, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:openresponses:transcript-timing",
        sessionId: "session-id-transcript-timing",
      };

      beforeAgentStart({ prompt: "search candidates" }, ctx);
      vi.setSystemTime(new Date("2026-07-01T11:48:44.572Z"));
      await llmInput(
        {
          runId: "run-transcript-timing",
          sessionId: ctx.sessionId,
          provider: "codex",
          model: "baidu-haiwai/A55",
          prompt: "search candidates",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );

      const firstAssistantMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "example_api_call" }],
        provider: "codex",
        model: "baidu-haiwai/A55",
        usage: { input: 1629, output: 1582, cacheRead: 19072, totalTokens: 22283 },
        stopReason: "toolUse",
        timestamp: Date.parse("2026-07-01T11:48:44.572Z"),
      };
      const secondAssistantMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "example_api_call" }],
        provider: "codex",
        model: "baidu-haiwai/A55",
        usage: { input: 2829, output: 1001, cacheRead: 19072, totalTokens: 22902 },
        stopReason: "toolUse",
        timestamp: Date.parse("2026-07-01T11:49:39.832Z"),
      };
      const rows = [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-07-01T11:48:43.900Z",
          message: {
            role: "user",
            content: "search candidates",
            timestamp: Date.parse("2026-07-01T11:48:43.900Z"),
          },
        },
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          timestamp: "2026-07-01T11:49:39.196Z",
          message: firstAssistantMessage,
        },
        {
          id: "t1",
          parentId: "a1",
          type: "message",
          timestamp: "2026-07-01T11:49:39.817Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            content: "result",
            timestamp: Date.parse("2026-07-01T11:49:39.817Z"),
          },
        },
        {
          id: "a2",
          parentId: "t1",
          type: "message",
          timestamp: "2026-07-01T11:50:24.275Z",
          message: secondAssistantMessage,
        },
      ];
      setTranscriptRows(ctx.sessionId, rows);

      expect(transcriptListener).toBeDefined();
      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a1",
        message: firstAssistantMessage,
      });

      const firstGenClient = mockTrace.generation.mock.results[0]?.value;
      await vi.waitFor(() => expect(firstGenClient.update).toHaveBeenCalled());
      const firstGenPatch = firstGenClient.update.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, unknown>)
        .find((patch: Record<string, unknown>) => patch.endTime instanceof Date);
      expect((firstGenPatch?.endTime as Date).toISOString()).toBe("2026-07-01T11:49:39.196Z");

      diagnosticRuntime.listener?.({
        type: "model.call.started",
        callId: "provider-call-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        ts: Date.parse("2026-07-01T11:48:44.572Z"),
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        callId: "provider-call-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        durationMs: 54624,
        usageSource: "provider",
        usage: { input: 1629, output: 1582, total: 22283 },
        ts: Date.parse("2026-07-01T11:49:39.196Z"),
      });
      diagnosticRuntime.listener?.({
        type: "model.call.started",
        callId: "provider-call-2",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        ts: Date.parse("2026-07-01T11:49:39.832Z"),
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        callId: "provider-call-2",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        durationMs: 44443,
        usageSource: "provider",
        usage: { input: 999, output: 111, total: 1110 },
        ts: Date.parse("2026-07-01T11:50:24.275Z"),
      });

      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a2",
        message: secondAssistantMessage,
      });

      await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledTimes(2));
      const secondGeneration = mockTrace.generation.mock.calls.at(-1)?.[0] as Record<
        string,
        unknown
      >;
      expect(secondGeneration.name).toBe("llm-call-2");
      expect((secondGeneration.startTime as Date).toISOString()).toBe("2026-07-01T11:49:39.832Z");
      expect(secondGeneration.endTime).toBeUndefined();
      expect(secondGeneration.usageDetails).toBeUndefined();
      const secondGenClient = mockTrace.generation.mock.results[1]?.value;
      expect(secondGenClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usageDetails: { input: 999, output: 111, total: 1110 },
          metadata: expect.objectContaining({
            scope: "provider-request",
            usageSource: "provider",
          }),
        }),
      );
      expect(secondGenClient.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          usageDetails: expect.objectContaining({
            input: 2829,
            output: 1001,
          }),
        }),
      );

      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not create transcript duplicate generations for provider-request traces", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T09:00:00.000Z"));
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-provider-transcript-"));
    const service = await startService(config, runtime);
    try {
      const { beforeAgentStart } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:openresponses:provider-transcript",
        sessionId: "session-id-provider-transcript",
      };
      beforeAgentStart({ prompt: "search candidates" }, ctx);
      expect(diagnosticRuntime.listener).toBeDefined();

      diagnosticRuntime.listener?.({
        type: "model.call.started",
        runId: "run-provider-1",
        callId: "call-provider-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        ts: Date.parse("2026-07-02T09:00:01.000Z"),
      });
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        runId: "run-provider-1",
        callId: "call-provider-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        durationMs: 4500,
        usageSource: "provider",
        usage: { input: 3335, output: 240, total: 26871 },
        ts: Date.parse("2026-07-02T09:00:05.500Z"),
      });
      expect(mockTrace.generation).toHaveBeenCalledTimes(1);

      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 3335, output: 240, totalTokens: 26871 },
        timestamp: Date.parse("2026-07-02T09:00:01.000Z"),
      };
      setTranscriptRows(ctx.sessionId, [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-07-02T09:00:00.000Z",
          message: { role: "user", content: "search candidates" },
        },
        {
          id: "a1",
          parentId: "u1",
          type: "message",
          timestamp: "2026-07-02T09:00:05.500Z",
          message: assistantMessage,
        },
      ]);

      expect(transcriptListener).toBeDefined();
      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a1",
        message: assistantMessage,
      });

      expect(mockTrace.generation).toHaveBeenCalledTimes(1);
      const providerGenerationClient = mockTrace.generation.mock.results[0]?.value;
      await vi.waitFor(() => expect(providerGenerationClient.update).toHaveBeenCalled());
      expect(providerGenerationClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usageDetails: expect.objectContaining({ input: 3335, output: 240, total: 26871 }),
        }),
      );
      expect(providerGenerationClient.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ source: "transcript-output-repair" }),
        }),
      );
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("patches batch-finalized generations from late provider-request diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T10:00:00.000Z"));
    const service = await startService();
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-batch-late-provider",
      sessionKey: "agent:agent-1:openresponses:batch-late-provider",
      sessionId: "session-id-batch-late-provider",
    };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await agentEnd(
      {
        messages: [
          { role: "user", content: "hello", timestamp: Date.parse("2026-07-02T10:00:00.000Z") },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "codex",
            model: "aliyun/qwen3.7-plus",
            usage: { input: 100, output: 20, totalTokens: 120 },
            timestamp: Date.parse("2026-07-02T10:00:01.000Z"),
          },
        ],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );
    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    const batchGenerationClient = mockTrace.generation.mock.results[0]?.value;

    diagnosticRuntime.listener?.({
      type: "model.call.started",
      runId: "run-batch-late-provider",
      callId: "call-batch-late-provider",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      ts: Date.parse("2026-07-02T10:00:00.500Z"),
    });
    diagnosticRuntime.listener?.({
      type: "model.call.completed",
      runId: "run-batch-late-provider",
      callId: "call-batch-late-provider",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 900,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
      ts: Date.parse("2026-07-02T10:00:01.400Z"),
    });

    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    expect(batchGenerationClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
        }),
      }),
    );
  });

  it("skips Codex reasoning-only assistant rows in realtime transcript updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T08:38:10.215Z"));
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-reasoning-"));
    const service = await startService(config, runtime);
    try {
      const { beforeAgentStart, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "session-key-reasoning-skip",
        sessionId: "session-id-reasoning-skip",
      };

      beforeAgentStart({ prompt: "只回复一行：qwen codex verify alive" }, ctx);
      await llmInput(
        {
          runId: "run-reasoning-skip",
          sessionId: ctx.sessionId,
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          prompt: "只回复一行：qwen codex verify alive",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );

      const reasoningMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Codex reasoning:\nThe user just wants one line." }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        timestamp: Date.parse("2026-07-02T08:38:14.309Z"),
        __openclaw: { mirrorIdentity: "turn-1:reasoning" },
      };
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "qwen codex verify alive" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 22591, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 22621 },
        timestamp: Date.parse("2026-07-02T08:38:14.309Z"),
      };
      const rows = [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-07-02T08:38:10.561Z",
          message: {
            role: "user",
            content: "只回复一行：qwen codex verify alive",
            timestamp: Date.parse("2026-07-02T08:38:10.495Z"),
          },
        },
        {
          id: "a-reasoning",
          parentId: "u1",
          type: "message",
          timestamp: "2026-07-02T08:38:14.333Z",
          message: reasoningMessage,
        },
        {
          id: "a-final",
          parentId: "a-reasoning",
          type: "message",
          timestamp: "2026-07-02T08:38:14.338Z",
          message: finalMessage,
        },
      ];
      setTranscriptRows(ctx.sessionId, rows);

      expect(transcriptListener).toBeDefined();
      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a-reasoning",
        message: reasoningMessage,
      });

      const firstGenClient = mockTrace.generation.mock.results[0]?.value;
      expect(firstGenClient.update).not.toHaveBeenCalled();

      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a-final",
        message: finalMessage,
      });

      await vi.waitFor(() => expect(firstGenClient.update).toHaveBeenCalled());
      expect(mockTrace.generation).toHaveBeenCalledTimes(1);
      const patch = firstGenClient.update.mock.calls[0][0] as Record<string, unknown>;
      expect((patch.endTime as Date).toISOString()).toBe("2026-07-02T08:38:14.338Z");
      expect(patch.output).toBe("qwen codex verify alive");
      expect(patch.usageDetails).toMatchObject({ input: 22591, output: 30, total: 22621 });
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips Codex reasoning-only assistant rows in batch observations", () => {
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "verify", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Codex reasoning:\nNeed answer one line." }],
          model: "aliyun/qwen3.7-plus",
          provider: "codex",
          usage: { input: 0, output: 0, totalTokens: 0 },
          timestamp: 2_000,
          __openclaw: { mirrorIdentity: "turn-1:reasoning" },
        },
      },
      {
        timestamp: 3_010,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "qwen codex verify alive" }],
          model: "aliyun/qwen3.7-plus",
          provider: "codex",
          usage: { input: 22591, output: 30, totalTokens: 22621 },
          timestamp: 2_000,
        },
      },
    ] as unknown as SessionEntry[];

    const result = buildObservationsFromEntries(
      mockTrace as unknown as Parameters<typeof buildObservationsFromEntries>[0],
      "trace-test",
      turnEntries,
      turnEntries,
      { entryTimestamp: 1_000, redactEnabled: false },
      mockLogger,
    );

    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    const generation = mockTrace.generation.mock.calls[0][0] as Record<string, unknown>;
    expect(generation.name).toBe("llm-call-1");
    expect(generation.output).toBe("qwen codex verify alive");
    expect(result.llmCallCount).toBe(1);
    expect(result.totalUsage).toMatchObject({ input: 22591, output: 30, total: 22621 });
  });

  it("skips Codex transcript-only tool call mirrors in realtime transcript updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T08:59:44.968Z"));
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-tool-mirror-"));
    const service = await startService(config, runtime);
    try {
      const { beforeAgentStart, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "session-key-tool-mirror-skip",
        sessionId: "session-id-tool-mirror-skip",
      };

      beforeAgentStart({ prompt: "find golang candidates" }, ctx);
      await llmInput(
        {
          runId: "run-tool-mirror-skip",
          sessionId: ctx.sessionId,
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          prompt: "find golang candidates",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );

      const toolMirrorMessage = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-bash", name: "bash", input: { command: "cat" } }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: Date.parse("2026-07-02T09:00:17.162Z"),
        __openclaw: { mirrorIdentity: "turn-1:tool:call-bash:call" },
      };
      const finalMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 3335, output: 240, cacheRead: 23296, cacheWrite: 0, totalTokens: 26871 },
        timestamp: Date.parse("2026-07-02T09:01:03.652Z"),
        __openclaw: { mirrorIdentity: "turn-1:assistant" },
      };
      const rows = [
        {
          id: "u1",
          type: "message",
          timestamp: "2026-07-02T08:59:46.620Z",
          message: {
            role: "user",
            content: "find golang candidates",
            timestamp: Date.parse("2026-07-02T08:59:46.620Z"),
          },
        },
        {
          id: "a-tool",
          parentId: "u1",
          type: "message",
          timestamp: "2026-07-02T09:01:03.711Z",
          message: toolMirrorMessage,
        },
        {
          id: "a-final",
          parentId: "a-tool",
          type: "message",
          timestamp: "2026-07-02T09:01:03.714Z",
          message: finalMessage,
        },
      ];
      setTranscriptRows(ctx.sessionId, rows);

      expect(transcriptListener).toBeDefined();
      const firstGenClient = mockTrace.generation.mock.results[0]?.value;
      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a-tool",
        message: toolMirrorMessage,
      });

      expect(mockTrace.generation).toHaveBeenCalledTimes(1);
      expect(firstGenClient.update).not.toHaveBeenCalled();
      expect(mockGeneration.span).not.toHaveBeenCalled();

      transcriptListener?.({
        target: transcriptTarget(ctx),
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        messageId: "a-final",
        message: finalMessage,
      });

      await vi.waitFor(() => expect(firstGenClient.update).toHaveBeenCalled());
      expect(mockTrace.generation).toHaveBeenCalledTimes(1);
      const patch = firstGenClient.update.mock.calls[0][0] as Record<string, unknown>;
      expect((patch.endTime as Date).toISOString()).toBe("2026-07-02T09:01:03.714Z");
      expect(patch.output).toBe("done");
      expect(patch.usageDetails).toMatchObject({
        input: 3335,
        output: 240,
        total: 26871,
        cache_read_input_tokens: 23296,
      });
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips Codex transcript-only tool call mirrors in batch observations", () => {
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "find golang", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-bash", name: "bash", input: { command: "cat" } }],
          model: "aliyun/qwen3.7-plus",
          provider: "codex",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "toolUse",
          timestamp: 2_000,
          __openclaw: { mirrorIdentity: "turn-1:tool:call-bash:call" },
        },
      },
      {
        timestamp: 3_050,
        message: {
          role: "toolResult",
          toolCallId: "call-bash",
          toolName: "bash",
          content: "skill doc",
          timestamp: 3_050,
        },
      },
      {
        timestamp: 9_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "aliyun/qwen3.7-plus",
          provider: "codex",
          usage: { input: 3335, output: 240, cacheRead: 23296, totalTokens: 26871 },
          timestamp: 4_000,
          __openclaw: { mirrorIdentity: "turn-1:assistant" },
        },
      },
    ] as unknown as SessionEntry[];

    const result = buildObservationsFromEntries(
      mockTrace as unknown as Parameters<typeof buildObservationsFromEntries>[0],
      "trace-test",
      turnEntries,
      turnEntries,
      { entryTimestamp: 1_000, redactEnabled: false },
      mockLogger,
    );

    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    const generation = mockTrace.generation.mock.calls[0][0] as Record<string, unknown>;
    expect(generation.name).toBe("llm-call-1");
    expect(generation.output).toBe("done");
    expect(generation.usageDetails).toMatchObject({
      input: 3335,
      output: 240,
      total: 26871,
      cache_read_input_tokens: 23296,
    });
    expect(mockTrace.span).not.toHaveBeenCalled();
    expect(result.llmCallCount).toBe(1);
    expect(result.toolCallCount).toBe(1);
    expect(result.totalUsage).toMatchObject({ input: 3335, output: 240, total: 26871 });
  });

  it("skips Codex transcript-only tool call mirrors in diagnostic fallback", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-diagnostic-mirror-"));
    const sessionKey = "agent:agent-1:diag-session-key";
    const sessionId = "diag-session-id";
    const rows = [
      {
        id: "u1",
        type: "message",
        timestamp: "2026-07-02T13:10:25.943Z",
        message: {
          role: "user",
          content: "find golang candidates",
          timestamp: Date.parse("2026-07-02T13:10:25.943Z"),
        },
      },
      {
        id: "tool-call",
        parentId: "u1",
        type: "message",
        timestamp: "2026-07-02T13:12:47.075Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-bash",
              name: "bash",
              input: { command: "cat skill.md" },
            },
          ],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "toolUse",
          timestamp: Date.parse("2026-07-02T13:10:36.876Z"),
          __openclaw: { mirrorIdentity: "turn-1:tool:call-bash:call" },
        },
      },
      {
        id: "tool-result",
        parentId: "tool-call",
        type: "message",
        timestamp: "2026-07-02T13:12:47.081Z",
        message: {
          role: "toolResult",
          toolCallId: "call-bash",
          toolName: "bash",
          content: "skill doc",
          timestamp: Date.parse("2026-07-02T13:12:47.081Z"),
        },
      },
      {
        id: "assistant-final",
        parentId: "tool-result",
        type: "message",
        timestamp: "2026-07-02T13:12:47.097Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          usage: { input: 3335, output: 240, cacheRead: 23296, totalTokens: 26871 },
          timestamp: Date.parse("2026-07-02T13:12:46.988Z"),
          __openclaw: { mirrorIdentity: "turn-1:assistant" },
        },
      },
    ];
    setTranscriptRows(sessionId, rows);

    const service = await startService(config, undefined, { stateDir });
    try {
      expect(diagnosticRuntime.listener).toBeDefined();
      diagnosticRuntime.listener?.({
        type: "model.usage",
        sessionKey,
        sessionId,
        channel: "test-channel",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 3335, output: 240, cacheRead: 23296, total: 26871 },
        durationMs: 70_000,
      });

      await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledTimes(1));
      expect(mockTrace.generation).toHaveBeenCalledTimes(1);
      expect(mockTrace.generation.mock.calls[0][0].name).toBe("llm-call-1");
      expect(mockTrace.span).not.toHaveBeenCalled();
      const traceUpdate = mockTrace.update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      const metadata = traceUpdate.metadata as Record<string, unknown>;
      expect(metadata.stats).toMatchObject({ llmCallCount: 1, toolCallCount: 1 });
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs a finalized pending generation from a late assistant transcript", async () => {
    vi.useFakeTimers();
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-late-transcript",
      sessionId: "session-id-late-transcript",
    };

    beforeAgentStart({ prompt: "只回复一行：codex path fixed" }, ctx);
    await llmInput(
      {
        runId: "run-late-transcript",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        prompt: "只回复一行：codex path fixed",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    const genClient = mockTrace.generation.mock.results.at(-1)?.value;
    const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;

    await agentEnd(
      {
        messages: [{ role: "user", content: "只回复一行：codex path fixed" }],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );

    expect(transcriptListener).toBeDefined();
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "codex path fixed" }],
        api: "openai-chatgpt-responses",
        provider: "codex",
        model: "baidu-haiwai/A55",
        usage: { input: 23443, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 23451 },
        stopReason: "stop",
        metadata: { _langfuse: { traceId } },
      },
    });

    let usagePatch: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      usagePatch = genClient.update.mock.calls
        .map((call: unknown[]) => call[0] as Record<string, unknown>)
        .find((update: Record<string, unknown>) => {
          const usage = update.usageDetails as Record<string, unknown> | undefined;
          return usage?.input === 23443 && usage.output === 8 && usage.total === 23451;
        });
      expect(usagePatch).toBeDefined();
    });
    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    expect(usagePatch).toBeDefined();
    expect(usagePatch?.output).toBe("codex path fixed");

    const tracePatch = mockTrace.update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const traceMetadata = tracePatch.metadata as Record<string, unknown>;
    const traceStats = traceMetadata.stats as Record<string, unknown>;
    expect(tracePatch.output).toBe("codex path fixed");
    expect(traceMetadata.source).toBe("late-transcript-repair");
    expect(traceMetadata.sessionKey).toBe(ctx.sessionKey);
    expect(traceMetadata.agentId).toBe(ctx.agentId);
    expect(traceMetadata.channelId).toBe(ctx.channelId);
    expect(traceStats.success).toBe(true);
    expect(traceStats.durationMs).toBe(1000);
    expect(traceStats.messageCount).toBe(1);
    expect(traceStats.llmCallCount).toBe(1);
    expect(traceMetadata.usage as Record<string, number>).toMatchObject({
      inputTokens: 23443,
      outputTokens: 8,
      totalTokens: 23451,
    });

    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled();
    await service.stop?.(makeServiceCtx());
  });

  it("uses persisted row timing to repair a finalized transcript without event timing", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-late-row-timing",
      sessionId: "session-id-late-row-timing",
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "late persisted reply" }],
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 20, output: 4, totalTokens: 24 },
      stopReason: "stop",
    };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(
      {
        runId: "run-late-row-timing",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        prompt: "hello",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    const generation = mockTrace.generation.mock.results.at(-1)?.value;
    await agentEnd(
      {
        messages: [{ role: "user", content: "hello" }],
        success: true,
        durationMs: 1_000,
      },
      ctx,
    );
    setTranscriptRows(ctx.sessionId, [
      {
        id: "assistant-late-row-timing",
        timestamp: new Date().toISOString(),
        message: assistantMessage,
      },
    ]);

    transcriptListener?.({
      target: transcriptTarget(ctx),
      messageId: "assistant-late-row-timing",
      message: assistantMessage,
    });

    await vi.waitFor(() =>
      expect(generation.update).toHaveBeenCalledWith(
        expect.objectContaining({ output: "late persisted reply" }),
      ),
    );
    expect(mockTrace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "late persisted reply",
        metadata: expect.objectContaining({ source: "late-transcript-repair" }),
      }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("does not repair a finalized trace from transcript metadata owned by another trace", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-late-transcript-owner-mismatch",
      sessionId: "session-id-late-transcript-owner-mismatch",
    };

    beforeAgentStart({ prompt: "first turn" }, ctx);
    await llmInput(
      {
        runId: "run-owner-mismatch",
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu-haiwai/A55",
        prompt: "first turn",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    const genClient = mockTrace.generation.mock.results.at(-1)?.value;

    await agentEnd(
      {
        messages: [{ role: "user", content: "first turn" }],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );
    const genUpdateCount = genClient.update.mock.calls.length;
    const traceUpdateCount = mockTrace.update.mock.calls.length;

    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "belongs elsewhere" }],
        provider: "codex",
        model: "baidu-haiwai/A55",
        usage: { input: 99, output: 7, totalTokens: 106 },
        metadata: { _langfuse: { traceId: "trace-owned-by-next-turn" } },
      },
    });

    await service.stop?.(makeServiceCtx());
    expect(genClient.update).toHaveBeenCalledTimes(genUpdateCount);
    expect(mockTrace.update).toHaveBeenCalledTimes(traceUpdateCount);
  });

  it("does not create a generation when transcript timing resumes after turn replacement", async () => {
    let transcriptListener: TranscriptListener | undefined;
    let resolveFirstRead!: (entries: unknown[]) => void;
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-finalize-during-transcript",
      sessionId: "session-id-finalize-during-transcript",
    };

    beforeAgentStart({ prompt: "hello" }, ctx);
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        usage: { input: 10, output: 2, totalTokens: 12 },
        stopReason: "stop",
      },
    });
    await vi.waitFor(() =>
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalledOnce(),
    );

    await agentEnd(
      { messages: [{ role: "user", content: "hello" }], success: true, durationMs: 100 },
      ctx,
    );
    beforeAgentStart({ prompt: "replacement turn" }, ctx);
    resolveFirstRead([]);

    await vi.waitFor(() =>
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("skipping transcript update after trace replacement"),
      ),
    );
    expect(mockTrace.generation).not.toHaveBeenCalled();

    await service.stop?.(makeServiceCtx());
  });

  it("processes transcript updates in session order", async () => {
    let transcriptListener: TranscriptListener | undefined;
    let resolveFirstRead!: (entries: unknown[]) => void;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-transcript-order",
      sessionId: "session-id-transcript-order",
    };
    const transcriptStart = Date.now() + 1_000;
    setTranscriptRows(ctx.sessionId, [
      {
        id: "assistant-1",
        timestamp: new Date(transcriptStart).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      },
      {
        id: "assistant-2",
        timestamp: new Date(transcriptStart + 1_000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      },
    ]);
    const transcriptRows = sessionTranscriptRuntime.entriesBySessionId.get(ctx.sessionId) ?? [];
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockResolvedValue(transcriptRows);

    beforeAgentStart({ prompt: "hello" }, ctx);
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
      },
    });
    await vi.waitFor(() =>
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalledOnce(),
    );
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      messageId: "assistant-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
      },
    });

    resolveFirstRead(transcriptRows);
    await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledTimes(2));
    expect(mockTrace.generation.mock.calls.map((call) => call[0].name)).toEqual([
      "llm-call-1",
      "llm-call-2",
    ]);

    await service.stop?.(makeServiceCtx());
  });

  it("writes observation markers from target-only transcript identity", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-target-identity-"));
    const service = await startService(config, runtime, { stateDir });
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-target-identity",
      sessionId: "session-id-target-identity",
    };
    setTranscriptRows(ctx.sessionId, [
      {
        id: "assistant-target-only",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      },
    ]);

    try {
      service.getHookHandlers().beforeAgentStart({ prompt: "hello" }, ctx);
      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-target-only",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      });

      await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());
      const markerFile = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      const markerEvents = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { e?: string })
        .flatMap((event) => (event.e ? [event.e] : []));
      expect(markerEvents).toEqual(["gen-start", "gen-end"]);
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts legacy transcript updates with a session file and canonical session key", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-legacy-transcript-"));
    const sessionId = "session-id-legacy-transcript";
    const sessionKey = "agent:agent-1:legacy-transcript";
    const sessionFile = path.join(stateDir, `${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        id: "assistant-legacy",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      })}\n`,
    );
    const service = await startService(config, runtime, { stateDir });
    const ctx = { ...agentCtx, sessionId, sessionKey };

    try {
      service.getHookHandlers().beforeAgentStart({ prompt: "hello" }, ctx);
      transcriptListener?.({
        sessionFile,
        sessionKey,
        messageId: "assistant-legacy",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      });

      await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).not.toHaveBeenCalled();
      expect(mockTrace.generation.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ name: "llm-call-1" }),
      );
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses persisted timing for an active tool result without an event timestamp", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime, { internalDiagnostics: undefined });
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-active-tool-timing",
      sessionId: "session-id-active-tool-timing",
    };
    setTranscriptRows(ctx.sessionId, [
      {
        id: "tool-result-active-timing",
        timestamp: new Date(3_500).toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "call-active-timing",
          toolName: "read",
          content: "skill body",
        },
      },
    ]);

    service.getHookHandlers().beforeAgentStart({ prompt: "read skill" }, ctx);
    transcriptListener?.({
      target: transcriptTarget(ctx),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-active-timing",
            name: "read",
            input: { path: "/workspace/skill.md" },
          },
        ],
        timestamp: new Date(2_000).toISOString(),
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        stopReason: "toolUse",
      },
    });
    await vi.waitFor(() =>
      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({ name: "tool:read", startTime: new Date(2_000) }),
      ),
    );
    mockSpan.update.mockClear();

    transcriptListener?.({
      target: transcriptTarget(ctx),
      messageId: "tool-result-active-timing",
      message: {
        role: "toolResult",
        toolCallId: "call-active-timing",
        toolName: "read",
        content: "skill body",
      },
    });

    await vi.waitFor(() =>
      expect(mockSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({ endTime: new Date(3_500), output: "skill body" }),
      ),
    );
  });

  it("falls back to transcript tool spans and preserves errors without Codex diagnostics", async () => {
    vi.useFakeTimers();
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const service = await startService(config, runtime);
    const { beforeAgentStart, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-late-tool-transcript",
      sessionId: "session-id-late-tool-transcript",
    };

    beforeAgentStart({ prompt: "read skill" }, ctx);
    const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;
    await agentEnd(
      {
        messages: [{ role: "user", content: "read skill" }],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );

    expect(transcriptListener).toBeDefined();
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-bash",
            name: "bash",
            input: { command: "cat /workspace/.openclaw/sandbox-skills/skills/x/SKILL.md" },
          },
        ],
        timestamp: 2_000,
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        stopReason: "toolUse",
        metadata: { _langfuse: { traceId } },
      },
    });
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      message: {
        role: "toolResult",
        toolCallId: "call-bash",
        toolName: "bash",
        content: [{ type: "toolResult", content: "skill body" }],
        isError: true,
        timestamp: 3_000,
        metadata: { _langfuse: { traceId, toolCallId: "call-bash" } },
      },
    });

    await vi.waitFor(() => expect(mockSpan.update).toHaveBeenCalled());
    expect(mockTrace.span).toHaveBeenCalledWith(expect.objectContaining({ name: "tool:bash" }));
    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.anything(),
        level: "ERROR",
        statusMessage: "tool returned an error result",
        metadata: expect.objectContaining({ isError: true }),
      }),
    );

    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled();
    await service.stop?.(makeServiceCtx());
  });

  it("afterToolCall completes tool spans with duration metadata", async () => {
    vi.useFakeTimers();
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, beforeToolCall, afterToolCall } =
      service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-tool-duration" };

    beforeAgentStart({ prompt: "search" }, ctx);
    vi.setSystemTime(1_000);
    await llmInput(
      {
        runId: "run-duration",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        prompt: "search",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    vi.setSystemTime(2_000);
    llmOutput(
      {
        runId: "run-duration",
        sessionId: "s1",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        assistantTexts: ["Need a tool."],
      },
      ctx,
    );

    vi.setSystemTime(43_000);
    beforeToolCall(
      { toolName: "example_api_call", params: {}, toolCallId: "tc-duration" },
      {
        ...toolCtx,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        toolCallId: "tc-duration",
      },
    );
    vi.setSystemTime(44_000);
    afterToolCall(
      {
        toolName: "example_api_call",
        params: {},
        toolCallId: "tc-duration",
        result: "ok",
        durationMs: 996,
      },
      {
        ...toolCtx,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        toolCallId: "tc-duration",
      },
    );

    expect(mockGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:example_api_call",
        metadata: expect.objectContaining({
          toolName: "example_api_call",
          toolCallId: "tc-duration",
        }),
      }),
    );
    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "ok",
        metadata: expect.objectContaining({ durationMs: 996 }),
      }),
    );
  });

  it("afterToolCall preserves result-shaped tool failures", async () => {
    const service = await startService();
    const { beforeAgentStart, beforeToolCall, afterToolCall } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-tool-result-error" };
    const callCtx = {
      ...toolCtx,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolCallId: "tc-result-error",
    };
    const result = {
      content: [{ type: "text", text: "blocked by policy" }],
      details: { status: "blocked", reason: "blocked by policy" },
    };

    beforeAgentStart({ prompt: "search" }, ctx);
    beforeToolCall(
      { toolName: "example_api_call", params: {}, toolCallId: "tc-result-error" },
      callCtx,
    );
    afterToolCall(
      {
        toolName: "example_api_call",
        params: {},
        toolCallId: "tc-result-error",
        result,
        isError: true,
      },
      callCtx,
    );

    expect(mockSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: result,
        level: "ERROR",
        statusMessage: "tool returned an error result",
        metadata: expect.objectContaining({ isError: true }),
      }),
    );
  });

  it("redacts raw tool and agent errors from status messages when tracing redaction is enabled", async () => {
    const service = await startService({
      ...config,
      tracing: { ...config.tracing, redact: true },
    });
    const { beforeAgentStart, beforeToolCall, afterToolCall, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-redacted-status" };
    const callCtx = {
      ...toolCtx,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolCallId: "tc-redacted-error",
    };

    beforeAgentStart({ prompt: "search" }, ctx);
    beforeToolCall(
      { toolName: "example_api_call", params: {}, toolCallId: "tc-redacted-error" },
      callCtx,
    );
    afterToolCall(
      {
        toolName: "example_api_call",
        params: {},
        toolCallId: "tc-redacted-error",
        error: "SECRET_TOKEN raw backend failure",
      },
      callCtx,
    );

    const spanPatch = mockSpan.update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(spanPatch.statusMessage).toBe("tool returned an error result");
    expect(JSON.stringify(spanPatch.statusMessage)).not.toContain("SECRET_TOKEN");

    await agentEnd(
      {
        messages: [{ role: "user", content: "search" }],
        success: false,
        error: "SECRET_TOKEN raw finalization failure",
      },
      ctx,
    );

    const tracePatch = mockTrace.update.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(tracePatch.statusMessage).toBe("agent run failed");
    expect(JSON.stringify(tracePatch.statusMessage)).not.toContain("SECRET_TOKEN");
    await service.stop?.(makeServiceCtx());
  });

  it("treats duplicate llmInput runIds as idempotent", async () => {
    const service = await startService();
    const { beforeAgentStart, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-duplicate-runid" };
    const llmEvent = {
      runId: "run-duplicate",
      sessionId: ctx.sessionId,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      prompt: "hello",
      historyMessages: [],
      imagesCount: 0,
    };

    beforeAgentStart({ prompt: "hello" }, ctx);
    await llmInput(llmEvent, ctx);
    await llmInput(llmEvent, ctx);

    expect(mockTrace.generation).toHaveBeenCalledOnce();
    expect(mockTrace.generation.mock.calls[0][0].name).toBe("llm-call-1");

    llmOutput(
      {
        runId: "run-duplicate",
        sessionId: ctx.sessionId,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        assistantTexts: ["done"],
        usage: { input: 3, output: 2, total: 5 },
      },
      ctx,
    );
    await agentEnd(
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            usage: { input: 3, output: 2, totalTokens: 5 },
          },
        ],
        success: true,
      },
      ctx,
    );

    const tracePatch = mockTrace.update.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { metadata?: { sessionKey?: string; stats?: { llmCallCount: number } } },
      )
      .find((patch) => patch.metadata?.sessionKey === ctx.sessionKey);
    expect(tracePatch).toBeDefined();
    expect(tracePatch.metadata.stats.llmCallCount).toBe(1);
    await service.stop?.(makeServiceCtx());
  });

  it("reconciles batch transcript tool counts with existing live spans", async () => {
    const service = await startService();
    const { beforeAgentStart, beforeToolCall, afterToolCall, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-live-tool-batch-count" };
    const callCtx = {
      ...toolCtx,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolCallId: "tc-live-batch",
    };

    beforeAgentStart({ prompt: "read" }, ctx);
    beforeToolCall(
      { toolName: "read", params: { path: "a" }, toolCallId: "tc-live-batch" },
      callCtx,
    );
    afterToolCall(
      { toolName: "read", params: { path: "a" }, toolCallId: "tc-live-batch", result: "data" },
      callCtx,
    );

    await agentEnd(
      {
        messages: [
          { role: "user", content: "read" },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc-live-batch", name: "read", input: { path: "a" } },
            ],
            provider: "anthropic",
            model: "claude-3-5-sonnet",
          },
          {
            role: "toolResult",
            toolCallId: "tc-live-batch",
            toolName: "read",
            content: "data",
          },
        ],
        success: true,
      },
      ctx,
    );

    const tracePatch = mockTrace.update.mock.calls.at(-1)?.[0] as {
      metadata: { stats: { toolCallCount: number } };
    };
    expect(tracePatch.metadata.stats.toolCallCount).toBe(1);
    expect(mockTrace.span).toHaveBeenCalledTimes(1);
    await service.stop?.(makeServiceCtx());
  });

  it("uses assistant persisted row completion time for transcript tool span starts", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const service = await startService(config, {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    });
    const { beforeAgentStart } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-transcript-tool-row-time",
      sessionId: "session-id-transcript-tool-row-time",
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-row-time", name: "read", input: { path: "a" } }],
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      timestamp: 2_000,
    };
    setTranscriptRows(ctx.sessionId, [
      {
        id: "u-row-time",
        timestamp: "1970-01-01T00:00:01.000Z",
        message: { role: "user", content: "read" },
      },
      {
        id: "a-row-time",
        parentId: "u-row-time",
        timestamp: "1970-01-01T00:00:05.000Z",
        message: assistantMessage,
      },
    ]);

    beforeAgentStart({ prompt: "read" }, ctx);
    transcriptListener?.({
      target: transcriptTarget(ctx),
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      messageId: "a-row-time",
      message: assistantMessage,
    });

    await vi.waitFor(() => expect(mockTrace.span).toHaveBeenCalled());
    const spanArgs = mockTrace.span.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect((spanArgs.startTime as Date).getTime()).toBe(5_000);
    await service.stop?.(makeServiceCtx());
  });
});
