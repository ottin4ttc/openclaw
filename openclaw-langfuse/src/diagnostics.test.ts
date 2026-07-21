import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { subscribeDiagnosticEvents } from "./diagnostics.js";
import { TraceContextMap } from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";
import { MAX_PAYLOAD_BYTES, usageDetailsFromUsage } from "./utils.js";

const diagnosticBus = vi.hoisted(() => ({
  listener: undefined as
    | ((event: Record<string, unknown>, privateData?: Record<string, unknown>) => void)
    | undefined,
}));

const sessionTranscriptRuntime = vi.hoisted(() => ({
  entriesBySessionId: new Map<string, unknown[]>(),
  readVisibleSessionTranscriptMessageEntries: vi.fn(
    async ({ sessionId }: { sessionId: string }) =>
      sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
  ),
}));

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", () => ({
  emitTrustedDiagnosticEvent: (event: Record<string, unknown>) => diagnosticBus.listener?.(event),
  emitTrustedDiagnosticEventWithPrivateData: (
    event: Record<string, unknown>,
    privateData?: Record<string, unknown>,
  ) => diagnosticBus.listener?.(event, privateData),
  resetDiagnosticEventsForTest: () => {
    diagnosticBus.listener = undefined;
  },
  waitForDiagnosticEventsDrained: async () => undefined,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries:
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
}));

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

const internalDiagnostics = {
  emit: emitTrustedDiagnosticEventWithPrivateData,
  onEvent: (
    listener: (
      event: Record<string, unknown>,
      metadata: Record<string, unknown>,
      privateData: Record<string, unknown>,
    ) => void,
  ) => {
    diagnosticBus.listener = (event, privateData) => listener(event, {}, privateData ?? {});
    return () => {
      diagnosticBus.listener = undefined;
    };
  },
};

function createLangfuseMock() {
  const span = { update: vi.fn(), end: vi.fn() };
  const generation = { update: vi.fn(), end: vi.fn(), span: vi.fn().mockReturnValue(span) };
  const trace = {
    generation: vi.fn().mockReturnValue(generation),
    span: vi.fn().mockReturnValue(span),
    update: vi.fn(),
  };
  const langfuse = {
    trace: vi.fn().mockReturnValue(trace),
  };
  return { langfuse, trace, generation, span };
}

function setSessionTranscript(sessionId: string, rows: Array<Record<string, unknown>>): void {
  sessionTranscriptRuntime.entriesBySessionId.set(
    sessionId,
    rows.map((row, index) => ({
      entryId: typeof row.id === "string" ? row.id : `entry-${index + 1}`,
      ...(typeof row.parentId === "string" ? { parentId: row.parentId } : {}),
      createdAt:
        typeof row.timestamp === "number"
          ? new Date(row.timestamp).toISOString()
          : String(row.timestamp),
      message: row.message,
    })),
  );
}

describe("Langfuse diagnostic subscription", () => {
  let tmpDir: string;

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
    sessionTranscriptRuntime.entriesBySessionId.clear();
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockImplementation(
      async ({ sessionId }: { sessionId: string }) =>
        sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-diagnostics-"));
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not subscribe to private diagnostics when tracing is disabled", async () => {
    const { langfuse } = createLangfuseMock();
    const onEvent = vi.fn(internalDiagnostics.onEvent);

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config: { ...config, tracing: { ...config.tracing, enabled: false } },
      promptManager: null,
      internalDiagnostics: { ...internalDiagnostics, onEvent },
    });

    expect(unsubscribe).toBeNull();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("creates Langfuse generations from trusted provider-request model call diagnostics", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        scope: "provider-request",
        sessionKey: "agent:openmai-u1:openresponses:s1",
        sessionId: "session-1",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
      },
      {
        modelContent: {
          inputMessages: [{ role: "user", content: "hello" }],
          toolDefinitions: [{ type: "function", name: "lookup" }],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-1",
        scope: "provider-request",
        sessionKey: "agent:openmai-u1:openresponses:s1",
        sessionId: "session-1",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        durationMs: 42,
        usageSource: "provider",
        usage: { input: 100, output: 20, total: 120 },
      },
      {
        modelContent: {
          outputMessages: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    expect(trace.generation.mock.calls[0][0]).toMatchObject({
      name: "llm-call-1",
      model: "codex/aliyun/qwen3.7-plus",
      input: {
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", name: "lookup" }],
      },
    });
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
          durationMs: 42,
        }),
      }),
    );

    unsubscribe?.();
  });

  it("links a synchronously cached prompt to the first diagnostic generation", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const promptClient = { prompt: "cached prompt" };
    const promptManager = {
      resolveSync: vi.fn().mockReturnValue({
        injection: { appendSystemContext: "cached prompt" },
        matchInfo: { name: "gateway", matchRule: "*" },
        promptClient,
      }),
      resolve: vi.fn(),
    };
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: promptManager as never,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-prompt",
      callId: "call-prompt",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:prompt",
      sessionId: "session-prompt",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: promptClient }),
    );
    expect(promptManager.resolve).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it("derives non-unknown session keys for diagnostics that omit sessionKey", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionId: "session-1",
      turnId: "turn-a",
      channel: "default",
      agentId: "openmai-u1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionId: "session-1",
      turnId: "turn-b",
      channel: "default",
      agentId: "openmai-u1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 20, output: 3, total: 23 },
      durationMs: 10,
    });

    await vi.waitFor(() => {
      expect(langfuse.trace).toHaveBeenCalledTimes(2);
      expect(
        contextMap.get(TraceContextMap.key("openmai-u1", "diagnostic:session-1:turn-a"))?.finalized,
      ).toBe(true);
      expect(
        contextMap.get(TraceContextMap.key("openmai-u1", "diagnostic:session-1:turn-b"))?.finalized,
      ).toBe(true);
    });
    expect(langfuse.trace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: "diagnostic:session-1:turn-a",
        metadata: expect.objectContaining({
          sessionKey: "diagnostic:session-1:turn-a",
          sessionId: "session-1",
        }),
      }),
    );
    expect(langfuse.trace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "diagnostic:session-1:turn-b",
        metadata: expect.objectContaining({
          sessionKey: "diagnostic:session-1:turn-b",
          sessionId: "session-1",
        }),
      }),
    );
    expect(contextMap.get(TraceContextMap.key("openmai-u1", "unknown"))).toBeUndefined();
    expect(trace.generation).toHaveBeenCalledTimes(2);

    unsubscribe?.();
  });

  it("redacts fallback generation user metadata", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const sessionKey = "agent:agent-1:openresponses:redacted";
    setSessionTranscript("session-redacted", [
      {
        timestamp: Date.now(),
        message: { role: "user", content: "private prompt text" },
      },
    ]);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: true,
      config: { ...config, tracing: { ...config.tracing, redact: true } },
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-redacted",
      agentId: "agent-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });

    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledOnce());
    expect(trace.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ lastUserInput: "[REDACTED]" }),
      }),
    );
    expect(JSON.stringify(trace.generation.mock.calls)).not.toContain("private prompt text");

    unsubscribe?.();
  });

  it("rotates diagnostic-only aggregate traces after each completed turn", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "default",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });
    await vi.waitFor(() => expect(contextMap.get(contextKey)?.finalized).toBe(true));
    const firstEntry = contextMap.get(contextKey);

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "default",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 20, output: 3, total: 23 },
      durationMs: 20,
    });

    await vi.waitFor(() => {
      expect(langfuse.trace).toHaveBeenCalledTimes(2);
      expect(contextMap.get(contextKey)?.finalized).toBe(true);
    });
    expect(firstEntry?.finalized).toBe(true);
    expect(trace.generation).toHaveBeenCalledTimes(2);

    unsubscribe?.();
  });

  it("does not create a duplicate diagnostic trace for late usage from a finalized hook run", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-hook",
      traceMetadata: { trigger: "user" },
      llmCallCount: 1,
      toolCallCount: 0,
      storedUsage: { input: 10, output: 2, total: 12 },
      lastProvider: "codex",
      lastModel: "aliyun/qwen3.7-plus",
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: Date.now(),
      timestamp: Date.now(),
    });
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "webchat",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();
    expect(contextMap.get(contextKey)?.traceId).toBe("trace-hook");
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("agent_end already finalized"),
    );

    unsubscribe?.();
  });

  it("matches late usage to the final provider request when trace usage is aggregated", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-hook",
      traceMetadata: { trigger: "user" },
      llmCallCount: 2,
      toolCallCount: 1,
      storedUsage: { input: 2150, output: 44, cacheRead: 19072, total: 21266 },
      authoritativeProviderUsage: {
        input: 23002,
        output: 79,
        cacheRead: 19072,
        cacheWrite: 0,
        total: 42153,
      },
      providerRequestUsages: new Map<string, Record<string, number>>([
        ["call-1", { input: 20852, output: 35, total: 20887 }],
        ["call-2", { input: 2150, output: 44, cacheRead: 19072, total: 21266 }],
      ]),
      lastProvider: "codex",
      lastModel: "aliyun/qwen3.7-plus",
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([
        [1, generation as never],
        [2, generation as never],
      ]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: Date.now(),
      timestamp: Date.now(),
    });
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "webchat",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 2150, output: 44, cacheRead: 19072, total: 21266 },
      durationMs: 10,
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();
    expect(contextMap.get(contextKey)?.traceId).toBe("trace-hook");
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("agent_end already finalized"),
    );

    unsubscribe?.();
  });

  it("matches late aggregate usage against older finalized turns in the same session", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "agent-1";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const createFinalizedEntry = (
      traceId: string,
      timestamp: number,
      usage: { input: number; output: number; total: number },
    ): TraceContextEntry => ({
      trace: trace as never,
      traceId,
      traceMetadata: { trigger: "user" },
      llmCallCount: 1,
      toolCallCount: 0,
      storedUsage: usage,
      lastProvider: "codex",
      lastModel: "provider/model",
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: timestamp,
      timestamp,
    });
    const olderEntry = createFinalizedEntry("trace-older", 100, {
      input: 10,
      output: 2,
      total: 12,
    });
    const newerEntry = createFinalizedEntry("trace-newer", 200, {
      input: 20,
      output: 3,
      total: 23,
    });
    contextMap.create(contextKey, olderEntry);
    contextMap.create(contextKey, newerEntry);
    const findRecentFinalized = vi.spyOn(contextMap, "findRecentFinalized");
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "webchat",
      agentId,
      provider: "codex",
      model: "provider/model",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });
    await waitForDiagnosticEventsDrained();

    expect(findRecentFinalized).toHaveReturnedWith(olderEntry);
    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();

    unsubscribe?.();
  });

  it("does not create aggregate observations if agent_end finalizes during transcript read", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const entry: TraceContextEntry = {
      trace: trace as never,
      traceId: "trace-hook",
      traceMetadata: { trigger: "user" },
      llmCallCount: 0,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    };
    contextMap.create(contextKey, entry);

    let resolveTranscript!: (value: unknown[]) => void;
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockImplementationOnce(
      async () =>
        await new Promise<unknown[]>((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      channel: "webchat",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });
    await vi.waitFor(() =>
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).toHaveBeenCalled(),
    );
    entry.finalized = true;
    resolveTranscript([]);

    await vi.waitFor(() =>
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("finalized during transcript read"),
      ),
    );
    expect(trace.generation).not.toHaveBeenCalled();
    expect(langfuse.trace).not.toHaveBeenCalled();

    unsubscribe?.();
  });

  it("creates one complete span from private Codex rollout tool diagnostics", async () => {
    const { langfuse, trace, span } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:openmai-u1:openresponses:s1";
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    const event = {
      type: "tool.execution.completed" as const,
      runId: "run-1",
      sessionKey,
      sessionId: "session-1",
      toolName: "skills.list",
      toolSource: "core" as const,
      toolOwner: "codex-rollout-trace",
      toolCallId: "tool-call-1",
      startTimeMs: 1000,
      endTimeMs: 1075,
      durationMs: 75,
    };
    const privateData = {
      toolContent: {
        toolInput: { authority: { kind: "orchestrator" } },
        toolOutput: { skills: ["example-search"], warnings: [] },
      },
    };
    emitTrustedDiagnosticEventWithPrivateData(event, privateData);
    emitTrustedDiagnosticEventWithPrivateData(event, privateData);
    await waitForDiagnosticEventsDrained();

    expect(trace.span).toHaveBeenCalledOnce();
    expect(trace.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:skills.list",
        startTime: new Date(1000),
        input: { authority: { kind: "orchestrator" } },
        metadata: expect.objectContaining({
          toolCallId: "tool-call-1",
          source: "diagnostic-tool-content",
        }),
      }),
    );
    expect(span.update).toHaveBeenCalledOnce();
    expect(span.update).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: new Date(1075),
        output: { skills: ["example-search"], warnings: [] },
        metadata: expect.objectContaining({ durationMs: 75 }),
      }),
    );
    expect(contextMap.findActive(sessionKey)?.toolCallCount).toBe(1);

    unsubscribe?.();
  });

  it("parents private Codex rollout tool spans to the active provider generation", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:openmai-u1:openresponses:s1";
    contextMap.create(TraceContextMap.key("openmai-u1", sessionKey), {
      trace,
      traceId: "trace-existing",
      llmCallCount: 0,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      providerRequestCallIndexes: new Map(),
      deferredProviderRequestCompletions: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    } satisfies TraceContextEntry);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "baidu/glm-5.2",
      startTimeMs: 1000,
    });
    await waitForDiagnosticEventsDrained();
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-1",
        sessionKey,
        sessionId: "session-1",
        toolName: "skills.list",
        toolSource: "core",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-1",
        startTimeMs: 1200,
        endTimeMs: 1225,
        durationMs: 25,
      },
      {
        toolContent: {
          toolInput: {},
          toolOutput: { skills: ["example-search"] },
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.span).not.toHaveBeenCalled();
    expect(generation.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:skills.list",
      }),
    );

    unsubscribe?.();
  });

  it("updates an existing tool span without creating a duplicate observation", async () => {
    const { langfuse, trace, generation, span } = createLangfuseMock();
    const oldSpan = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:openmai-u1:openresponses:s1";
    contextMap.create(TraceContextMap.key("openmai-u1", sessionKey), {
      trace,
      traceId: "trace-existing",
      llmCallCount: 0,
      toolCallCount: 1,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpans: new Map([["tool-call-1", oldSpan as never]]),
      completedSpanToolCallIds: new Set(["tool-call-1"]),
      providerRequestCallIndexes: new Map(),
      deferredProviderRequestCompletions: new Map(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    } satisfies TraceContextEntry);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "baidu/glm-5.2",
      startTimeMs: 900,
    });
    await waitForDiagnosticEventsDrained();
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-1",
        sessionKey,
        sessionId: "session-1",
        toolName: "skills.list",
        toolSource: "core",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-1",
        startTimeMs: 1000,
        endTimeMs: 1075,
        durationMs: 75,
      },
      {
        toolContent: {
          toolInput: { authority: { kind: "orchestrator" } },
          toolOutput: { skills: ["example-search"], warnings: [] },
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.span).not.toHaveBeenCalled();
    expect(generation.span).not.toHaveBeenCalled();
    expect(oldSpan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: new Date(1000),
        endTime: new Date(1075),
        input: { authority: { kind: "orchestrator" } },
        output: { skills: ["example-search"], warnings: [] },
      }),
    );
    expect(span.update).not.toHaveBeenCalled();
    expect(contextMap.findActive(sessionKey)?.toolCallCount).toBe(1);

    unsubscribe?.();
  });

  it("bounds authoritative Codex rollout tool payloads for ingestion", async () => {
    const { langfuse, span } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:openmai-u1:openresponses:s1";
    const exactPayload = "x".repeat(110 * 1024);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-1",
        sessionKey,
        sessionId: "session-1",
        toolName: "exec_command",
        toolSource: "core",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-large",
        startTimeMs: 1000,
        endTimeMs: 1075,
        durationMs: 75,
      },
      {
        toolContent: {
          toolInput: { command: exactPayload },
          toolOutput: { output: exactPayload },
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    const update = span.update.mock.calls.at(-1)?.[0];
    expect(update).toBeDefined();
    expect(typeof update.input).toBe("string");
    expect(typeof update.output).toBe("string");
    expect(Buffer.byteLength(update.input, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(update.output, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(update.input).toContain("[truncated: original size");
    expect(update.output).toContain("[truncated: original size");

    unsubscribe?.();
  });

  it("bounds aggregate fallback generation payloads when redaction is disabled", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-large-fallback";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const hugePrompt = "prompt ".repeat(MAX_PAYLOAD_BYTES);
    const hugeOutput = "output ".repeat(MAX_PAYLOAD_BYTES);
    setSessionTranscript(sessionId, [
      {
        timestamp: 1783000000000,
        message: { role: "user", content: hugePrompt },
      },
      {
        timestamp: 1783000001000,
        message: { role: "assistant", content: [{ type: "text", text: hugeOutput }] },
      },
    ]);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId,
      channel: "default",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });

    await vi.waitFor(() =>
      expect(generation.update).toHaveBeenCalledWith(
        expect.objectContaining({ output: expect.stringContaining("[truncated: original size") }),
      ),
    );
    const generationInput = trace.generation.mock.calls[0]?.[0]?.input;
    const generationUpdate = generation.update.mock.calls.at(-1)?.[0];
    expect(Buffer.byteLength(JSON.stringify(generationInput), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(typeof generationUpdate?.output).toBe("string");
    expect(Buffer.byteLength(String(generationUpdate?.output), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(String(generationUpdate?.output)).toContain("[truncated: original size");

    unsubscribe?.();
  });

  it("bounds aggregate fallback structured input after building the full payload", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-large-structured-input";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const systemPrompt = "system-secret ".repeat(MAX_PAYLOAD_BYTES);
    const userPrompt = "user-secret ".repeat(MAX_PAYLOAD_BYTES);
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-structured-input",
      traceMetadata: { trigger: "user" },
      llmCallCount: 0,
      toolCallCount: 0,
      systemPrompt,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });
    setSessionTranscript(sessionId, [
      {
        timestamp: 1783000000000,
        message: { role: "user", content: userPrompt },
      },
    ]);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId,
      channel: "default",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    });

    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledOnce());
    const generationInput = trace.generation.mock.calls[0]?.[0]?.input;
    expect(Buffer.byteLength(JSON.stringify(generationInput), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(JSON.stringify(generationInput)).toContain("[truncated: original size");

    unsubscribe?.();
  });

  it("patches existing hook generations with trusted provider-request model content", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const traceId = "trace-existing";
    const agentId = "openmai-u1";
    const sessionKey = "main";
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace,
      traceId,
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["hook-run", generation as never]]),
      pendingGenIds: new Map([["hook-run", `${traceId}-gen-1`]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      providerRequestCallIndexes: new Map(),
      deferredProviderRequestCompletions: new Map(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    } satisfies TraceContextEntry);
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        scope: "provider-request",
        agentId,
        sessionKey,
        sessionId: "session-1",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        startTimeMs: 1000,
      },
      {
        modelContent: {
          systemPrompt: "system",
          inputMessages: [{ role: "user", content: "hello" }],
          toolDefinitions: [{ type: "function", name: "lookup" }],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        runId: "run-1",
        callId: "call-1",
        scope: "provider-request",
        agentId,
        sessionKey,
        sessionId: "session-1",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        startTimeMs: 1000,
        endTimeMs: 1042,
        durationMs: 42,
        usageSource: "provider",
        usage: { input: 100, output: 20, total: 120, cacheRead: 80, reasoningTokens: 7 },
      },
      {
        modelContent: {
          outputMessages: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).not.toHaveBeenCalled();
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex/aliyun/qwen3.7-plus",
        startTime: new Date(1000),
        input: {
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "function", name: "lookup" }],
        },
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: new Date(1000),
        endTime: new Date(1042),
        output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
        usageDetails: {
          input: 100,
          output: 20,
          total: 120,
          cache_read_input_tokens: 80,
          reasoning_tokens: 7,
        },
      }),
    );

    unsubscribe?.();
  });

  it("preserves sparse provider usage without fabricating token counters", () => {
    expect(usageDetailsFromUsage({ reasoningTokens: 7 })).toEqual({ reasoning_tokens: 7 });
  });

  it("does not create aggregate transcript generations after provider-request diagnostics exist", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });
    const agentId = "openmai-u1";
    const sessionId = "session-1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const finalOutput = "x".repeat(MAX_PAYLOAD_BYTES * 2);
    setSessionTranscript(sessionId, [
      {
        timestamp: 1783000000000,
        message: { role: "user", content: "只回复一行：qwen codex hotfix alive" },
      },
      {
        timestamp: 1783000001000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "example_api_call",
              input: { path: "/ping" },
            },
          ],
          usage: { input: 0, output: 0, totalTokens: 0 },
          __openclaw: { mirrorIdentity: "turn-1:tool:tool-1:call" },
        },
      },
      {
        timestamp: 1783000002000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalOutput }],
          usage: { input: 22592, output: 43, totalTokens: 22635 },
        },
      },
    ]);

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 4810,
      usageSource: "provider",
      usage: { input: 22592, output: 43, total: 22635 },
    });
    await waitForDiagnosticEventsDrained();
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId,
      channel: "default",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 22592, output: 43, total: 22635 },
      durationMs: 4810,
    });

    await vi.waitFor(() =>
      expect(trace.update).toHaveBeenCalledWith(
        expect.objectContaining({ output: expect.stringContaining("[truncated: original size") }),
      ),
    );
    expect(trace.generation).toHaveBeenCalledOnce();
    expect(trace.span).not.toHaveBeenCalled();
    expect(trace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.stringContaining("[truncated: original size"),
        metadata: expect.objectContaining({
          aggregateUsage: { input: 22592, output: 43, total: 22635 },
          lastModel: {
            provider: "codex",
            model: "aliyun/qwen3.7-plus",
          },
          stats: expect.objectContaining({
            llmCallCount: 1,
            toolCallCount: 1,
          }),
        }),
      }),
    );
    const aggregateUpdate = trace.update.mock.calls.at(-1)?.[0];
    expect(typeof aggregateUpdate?.output).toBe("string");
    expect(Buffer.byteLength(String(aggregateUpdate?.output), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );

    unsubscribe?.();
  });

  it("links the first provider-request diagnostic to an existing hook-owned generation", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-1",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["run-1", generation as never]]),
      pendingGenIds: new Map([["run-1", "trace-1-gen-1"]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).not.toHaveBeenCalled();
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
        }),
      }),
    );
    expect(contextMap.get(contextKey)?.pendingGenerations.size).toBe(0);
    expect(contextMap.get(contextKey)?.pendingGenIds.size).toBe(0);
    expect(contextMap.get(contextKey)?.completedGenerations.get(1)).toBe(generation);

    unsubscribe?.();
  });

  it("updates a provider generation completed by transcript before provider completion drains", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-1",
      llmCallCount: 1,
      toolCallCount: 0,
      hasProviderRequestGenerations: true,
      providerRequestCallCount: 1,
      providerRequestCallIndexes: new Map([["call-1", 1]]),
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).not.toHaveBeenCalled();
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
        }),
      }),
    );
    expect(contextMap.get(contextKey)?.completedGenerations.get(1)).toBe(generation);

    unsubscribe?.();
  });

  it("creates later provider-request generations when hook-owned generations stop at the first call", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const hookGeneration = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-1",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["run-1", hookGeneration as never]]),
      pendingGenIds: new Map([["run-1", "trace-1-gen-1"]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-2",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 55,
      usageSource: "provider",
      usage: { input: 200, output: 30, total: 230 },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-3",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-3",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 57,
      usageSource: "provider",
      usage: { input: 300, output: 40, total: 340 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(trace.generation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "trace-1-gen-2",
        name: "llm-call-2",
      }),
    );
    expect(trace.generation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "trace-1-gen-3",
        name: "llm-call-3",
      }),
    );
    expect(hookGeneration.update).toHaveBeenCalledTimes(2);
    expect(hookGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "codex/aliyun/qwen3.7-plus",
      }),
    );
    expect(hookGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
          durationMs: 42,
        }),
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 200, output: 30, total: 230 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
          durationMs: 55,
        }),
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 300, output: 40, total: 340 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
          durationMs: 57,
        }),
      }),
    );
    expect(contextMap.get(contextKey)?.llmCallCount).toBe(3);
    const deferred = contextMap.get(contextKey)?.deferredProviderRequestCompletions;
    expect(deferred?.size ?? 0).toBe(0);

    unsubscribe?.();
  });

  it("updates finalized JSONL generations from late provider-request diagnostics without duplicating", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-1",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      runIds: new Set(["run-1"]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      ts: Date.parse("2026-07-02T09:00:01.000Z"),
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
      ts: Date.parse("2026-07-02T09:00:05.000Z"),
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).not.toHaveBeenCalled();
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          scope: "provider-request",
          usageSource: "provider",
        }),
      }),
    );

    unsubscribe?.();
  });

  it("creates late provider-request generations when finalized JSONL slots are missing", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-1",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      runIds: new Set(["run-1"]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-2",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 55,
      usageSource: "provider",
      usage: { input: 200, output: 30, total: 230 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(trace.generation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "trace-1-gen-1",
        name: "llm-call-1",
      }),
    );
    expect(trace.generation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "trace-1-gen-2",
        name: "llm-call-2",
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 200, output: 30, total: 230 },
      }),
    );
    expect(
      contextMap.get(TraceContextMap.key(agentId, sessionKey))?.completedGenerations.size,
    ).toBe(2);

    unsubscribe?.();
  });

  it("routes a late provider completion to its original finalized turn", async () => {
    const { langfuse } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const previousGeneration = { update: vi.fn(), end: vi.fn(), span: vi.fn() };
    const previousTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };
    const currentGeneration = { update: vi.fn(), end: vi.fn(), span: vi.fn() };
    const currentTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };

    contextMap.create(contextKey, {
      trace: previousTrace as never,
      traceId: "trace-previous",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["call-previous", previousGeneration as never]]),
      pendingGenIds: new Map([["call-previous", "trace-previous-gen-1"]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      providerRequestCallCount: 1,
      providerRequestCallIndexes: new Map([["call-previous", 1]]),
      finalized: true,
      createdAt: Date.now() - 100,
      timestamp: Date.now() - 100,
    });
    contextMap.create(contextKey, {
      trace: currentTrace as never,
      traceId: "trace-current",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["call-current", currentGeneration as never]]),
      pendingGenIds: new Map([["call-current", "trace-current-gen-1"]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      providerRequestCallCount: 1,
      providerRequestCallIndexes: new Map([["call-current", 1]]),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-previous",
      callId: "call-previous",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      durationMs: 42,
      usageSource: "provider",
      usage: { input: 100, output: 20, total: 120 },
    });

    await vi.waitFor(() => expect(previousGeneration.update).toHaveBeenCalledOnce());
    expect(currentGeneration.update).not.toHaveBeenCalled();
    expect(contextMap.findActive(sessionKey, { runId: "call-current" })?.traceId).toBe(
      "trace-current",
    );

    unsubscribe?.();
  });

  it("does not attach an unmatched provider request to the previous finalized turn", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const previousTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };

    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: previousTrace as never,
      traceId: "trace-previous",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      runIds: new Set(["run-previous"]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      createdAt: Date.now() - 100,
      timestamp: Date.now() - 100,
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-current",
      callId: "call-current",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    });
    await waitForDiagnosticEventsDrained();

    expect(previousTrace.generation).not.toHaveBeenCalled();
    expect(langfuse.trace).toHaveBeenCalledOnce();
    expect(trace.generation).toHaveBeenCalledWith(expect.objectContaining({ name: "llm-call-1" }));

    unsubscribe?.();
  });

  it("keeps unmatched aggregate usage on the active turn when prior usage is identical", async () => {
    const { langfuse } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const previousTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };
    const currentGeneration = { update: vi.fn(), end: vi.fn(), span: vi.fn() };
    const currentTrace = {
      generation: vi.fn().mockReturnValue(currentGeneration),
      span: vi.fn(),
      update: vi.fn(),
    };

    contextMap.create(contextKey, {
      trace: previousTrace as never,
      traceId: "trace-previous",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      storedUsage: { input: 100, output: 20, total: 120 },
      lastProvider: "codex",
      lastModel: "aliyun/qwen3.7-plus",
      finalized: true,
      createdAt: Date.now() - 100,
      timestamp: Date.now() - 100,
    });
    contextMap.create(contextKey, {
      trace: currentTrace as never,
      traceId: "trace-current",
      llmCallCount: 0,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 100, output: 20, total: 120 },
      durationMs: 10,
    });

    await vi.waitFor(() => expect(currentTrace.generation).toHaveBeenCalledOnce());
    expect(previousTrace.generation).not.toHaveBeenCalled();
    expect(previousTrace.update).not.toHaveBeenCalled();
    expect(currentTrace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          trigger: "diagnostic",
          stats: expect.objectContaining({
            llmCallCount: 1,
          }),
        }),
      }),
    );

    unsubscribe?.();
  });

  it("keeps matching late aggregate usage on the prior finalized turn when active usage differs", async () => {
    const { langfuse } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    const previousTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };
    const currentTrace = { generation: vi.fn(), span: vi.fn(), update: vi.fn() };

    contextMap.create(contextKey, {
      trace: previousTrace as never,
      traceId: "trace-previous",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      storedUsage: { input: 100, output: 20, total: 120 },
      lastProvider: "codex",
      lastModel: "aliyun/qwen3.7-plus",
      finalized: true,
      createdAt: Date.now() - 100,
      timestamp: Date.now() - 100,
    });
    contextMap.create(contextKey, {
      trace: currentTrace as never,
      traceId: "trace-current",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      storedUsage: { input: 200, output: 30, total: 230 },
      lastProvider: "codex",
      lastModel: "aliyun/qwen3.7-plus",
      createdAt: Date.now(),
      timestamp: Date.now(),
    });

    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap,
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey,
      sessionId: "session-1",
      agentId,
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 100, output: 20, total: 120 },
      durationMs: 10,
    });

    await waitForDiagnosticEventsDrained();
    expect(previousTrace.generation).not.toHaveBeenCalled();
    expect(currentTrace.generation).not.toHaveBeenCalled();
    expect(previousTrace.update).not.toHaveBeenCalled();
    expect(currentTrace.update).not.toHaveBeenCalled();
    expect(langfuse.trace).not.toHaveBeenCalled();

    unsubscribe?.();
  });

  it("creates a missing-start provider-request generation and marks model call errors", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.error",
      runId: "run-err",
      callId: "call-err",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:s1",
      sessionId: "session-1",
      provider: "codex",
      model: "baidu/glm-5.2",
      durationMs: 1000,
      usageSource: "unknown",
      errorCategory: "invalid_request",
      failureKind: "terminated",
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    expect(trace.generation.mock.calls[0][0]).toMatchObject({
      name: "llm-call-1",
      model: "codex/baidu/glm-5.2",
      metadata: expect.objectContaining({
        scope: "provider-request",
        orphanedStart: true,
      }),
    });
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "ERROR",
        statusMessage: "invalid_request",
        metadata: expect.objectContaining({
          usageSource: "unknown",
          failureKind: "terminated",
        }),
      }),
    );

    unsubscribe?.();
  });
});
