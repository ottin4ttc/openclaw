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
import { retryPendingProviderRequestTerminals, subscribeDiagnosticEvents } from "./diagnostics.js";
import { TraceContextMap } from "./trace-context.js";
import type { TraceContextEntry } from "./trace-context.js";
import {
  configureTraceLedgerStore,
  readTraceLedgerRecordsForTest,
  resetTraceLedgerStoreForTests,
} from "./trace-ledger.js";
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
    resetTraceLedgerStoreForTests();
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
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
        requestForm: "full",
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
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
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
      metadata: {
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        runtimeTransport: "stdio",
        requestForm: "full",
        inputProjection: "unavailable",
      },
    });
    expect(trace.generation.mock.calls[0][0]).not.toHaveProperty("input");
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
        usageDetails: { input: 100, output: 20, total: 120 },
        metadata: expect.objectContaining({
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          runtimeTransport: "stdio",
          scope: "provider-request",
          usageSource: "provider",
          durationMs: 42,
        }),
      }),
    );

    unsubscribe?.();
  });

  it("stores Codex stable context once and emits ordered provider-call deltas", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:context-delta`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-context-delta",
      rootInput: "current request",
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
    const base = {
      runId: "run-context-delta",
      scope: "provider-request" as const,
      sessionKey,
      sessionId: "session-context-delta",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    const firstMessages = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
    ];
    const assistantToolCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-tool-1",
          type: "function",
          function: { name: "lookup", arguments: '{"id":"PT1"}' },
        },
      ],
    };
    const toolResult = {
      role: "tool",
      tool_call_id: "call-tool-1",
      content: '{"name":"candidate"}',
    };

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-1",
        requestForm: "full",
      },
      {
        modelContent: {
          systemPrompt: "system instructions",
          inputMessages: firstMessages,
          toolDefinitions: [{ type: "function", name: "lookup" }],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.completed",
        callId: "provider-call-1",
        durationMs: 12,
        usageSource: "provider",
        usage: { input: 10, output: 2, total: 12 },
      },
      { modelContent: { outputMessages: [assistantToolCall] } },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-2",
        requestForm: "full",
      },
      {
        modelContent: {
          systemPrompt: "system instructions",
          inputMessages: [...firstMessages, assistantToolCall, toolResult],
          toolDefinitions: [{ type: "function", name: "lookup" }],
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(trace.generation.mock.calls[0]?.[0]?.input).toEqual({
      model: "aliyun/qwen3.7-plus",
      messages: [{ role: "user", content: "current request" }],
    });
    expect(trace.generation.mock.calls[1]?.[0]?.input).toEqual({
      model: "aliyun/qwen3.7-plus",
      messages: [assistantToolCall, toolResult],
    });
    expect(contextMap.findActive(sessionKey)?.modelContextMetadata).toBeUndefined();
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("system instructions");
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("old question");

    unsubscribe?.();
  });

  it("projects a linked ws-delta without exporting the accumulated request envelope", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:ws-delta`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-ws-delta",
      rootInput: "current request",
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
    const base = {
      runId: "run-ws-delta",
      scope: "provider-request" as const,
      sessionKey,
      sessionId: "session-ws-delta",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    const firstMessages = [{ role: "user", content: "provider envelope content" }];
    const deltaMessages = [
      {
        role: "assistant",
        tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup" } }],
      },
      { role: "tool", tool_call_id: "tool-1", content: "result" },
    ];

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-1",
        providerRequestIndex: 1,
        requestForm: "full",
      },
      { modelContent: { inputMessages: firstMessages } },
    );
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      callId: "provider-call-1",
      providerRequestIndex: 1,
      responseIdHash: "sha256:response-1",
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-2",
        providerRequestIndex: 2,
        requestForm: "ws-delta",
        previousResponseIdHash: "sha256:response-1",
      },
      { modelContent: { inputMessages: deltaMessages } },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(trace.generation.mock.calls[1]?.[0]).toMatchObject({
      id: "trace-ws-delta-gen-2",
      input: {
        model: "aliyun/qwen3.7-plus",
        messages: deltaMessages,
      },
      metadata: {
        requestForm: "ws-delta",
        inputProjection: "ws-delta-linked",
        previousResponseIdHash: "sha256:response-1",
      },
    });
    expect(JSON.stringify(trace.generation.mock.calls[1]?.[0])).not.toContain(
      "provider envelope content",
    );

    unsubscribe?.();
  });

  it("leaves input absent when ws-delta response linkage is invalid", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:invalid-ws-delta`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-invalid-ws-delta",
      rootInput: "current request",
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
    const base = {
      runId: "run-invalid-ws-delta",
      scope: "provider-request" as const,
      sessionKey,
      sessionId: "session-invalid-ws-delta",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-1",
        providerRequestIndex: 1,
        requestForm: "full",
      },
      { modelContent: { inputMessages: [{ role: "user", content: "full envelope" }] } },
    );
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      callId: "provider-call-1",
      providerRequestIndex: 1,
      responseIdHash: "sha256:expected",
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-2",
        providerRequestIndex: 2,
        requestForm: "ws-delta",
        previousResponseIdHash: "sha256:wrong",
      },
      { modelContent: { inputMessages: [{ role: "tool", content: "private result" }] } },
    );
    await waitForDiagnosticEventsDrained();

    const secondGeneration = trace.generation.mock.calls[1]?.[0];
    expect(secondGeneration).toMatchObject({
      id: "trace-invalid-ws-delta-gen-2",
      metadata: {
        requestForm: "ws-delta",
        inputProjection: "unavailable",
        previousResponseIdHash: "sha256:wrong",
      },
    });
    expect(secondGeneration).not.toHaveProperty("input");
    expect(contextMap.findActive(sessionKey)?.observationReconciliation?.reasons).toContainEqual({
      reason: "input_projection_unavailable",
      source: "provider-request:provider-call-2",
      count: 1,
    });

    unsubscribe?.();
  });

  it("does not export a full request after compaction rewrites the proven prefix", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:compacted-full`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-compacted-full",
      rootInput: "current request",
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
    const base = {
      runId: "run-compacted-full",
      scope: "provider-request" as const,
      sessionKey,
      sessionId: "session-compacted-full",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-1",
        providerRequestIndex: 1,
        requestForm: "full",
      },
      {
        modelContent: {
          inputMessages: [
            { role: "user", content: "old context" },
            { role: "user", content: "current request" },
          ],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "provider-call-2",
        providerRequestIndex: 2,
        requestForm: "full",
      },
      {
        modelContent: {
          inputMessages: [{ role: "user", content: "compacted replacement" }],
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    const secondGeneration = trace.generation.mock.calls[1]?.[0];
    expect(secondGeneration).toMatchObject({
      id: "trace-compacted-full-gen-2",
      metadata: { requestForm: "full", inputProjection: "unavailable" },
    });
    expect(secondGeneration).not.toHaveProperty("input");
    expect(JSON.stringify(secondGeneration)).not.toContain("compacted replacement");

    unsubscribe?.();
  });

  it("keeps complete provider envelopes process-local when root input is unavailable", async () => {
    const { langfuse, trace } = createLangfuseMock();
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
    const currentMessage = { role: "user", content: "current request must survive" };
    const toolDefinitions = Array.from({ length: 20 }, (_, index) => ({
      type: "function",
      name: `tool-${index}`,
      description: "d".repeat(10_000),
    }));

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-large-context",
        callId: "call-large-context",
        scope: "provider-request",
        sessionKey: "agent:openmai-u1:openresponses:large-context",
        sessionId: "session-large-context",
        provider: "codex",
        model: "aliyun/qwen3.7-plus",
        requestForm: "full",
      },
      {
        modelContent: {
          systemPrompt: "系".repeat(MAX_PAYLOAD_BYTES),
          inputMessages: [{ role: "user", content: "old request" }, currentMessage],
          toolDefinitions,
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        requestForm: "full",
        inputProjection: "unavailable",
      },
    });
    expect(trace.generation.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("old request");
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("current request must survive");
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("tool-0");

    unsubscribe?.();
  });

  it("creates follow-up OpenClaw-native generations from provider-request diagnostics", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const hookGeneration = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:main`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-native",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map([["run-native", hookGeneration as never]]),
      pendingGenIds: new Map([["run-native", "trace-native-gen-1"]]),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      rootInput: "run a tool",
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
    const base = {
      runId: "run-native",
      sessionKey,
      sessionId: "session-native",
      agentId,
      provider: "clawos",
      model: "gpt-5.6-sol",
      scope: "provider-request" as const,
      usageSource: "provider" as const,
    };

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "native-call-1",
        startTimeMs: 1_000,
        requestForm: "full",
      },
      {
        modelContent: {
          inputMessages: [{ role: "user", content: "run a tool" }],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.completed",
        callId: "native-call-1",
        startTimeMs: 1_000,
        endTimeMs: 1_040,
        durationMs: 40,
        usage: { input: 100, output: 20, cacheRead: 80, total: 200 },
        responseIdHash: "response-1",
      },
      {
        modelContent: {
          outputMessages: [{ role: "assistant", content: "calling tool" }],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.started",
        callId: "native-call-2",
        startTimeMs: 2_000,
        requestForm: "ws-delta",
        previousResponseIdHash: "response-1",
      },
      {
        modelContent: {
          inputMessages: [{ role: "tool", content: "tool result" }],
        },
      },
    );

    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledOnce());
    expect(trace.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "trace-native-gen-2",
        name: "llm-call-2",
        model: "clawos/gpt-5.6-sol",
        startTime: new Date(2_000),
        input: {
          model: "gpt-5.6-sol",
          messages: [{ role: "tool", content: "tool result" }],
        },
      }),
    );

    emitTrustedDiagnosticEventWithPrivateData(
      {
        ...base,
        type: "model.call.completed",
        callId: "native-call-2",
        startTimeMs: 2_000,
        endTimeMs: 2_060,
        durationMs: 60,
        usage: { input: 200, output: 30, cacheRead: 160, total: 390 },
      },
      {
        modelContent: {
          outputMessages: [{ role: "assistant", content: "done" }],
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(hookGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: {
          input: 100,
          output: 20,
          total: 200,
          cache_read_input_tokens: 80,
        },
      }),
    );
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: new Date(2_060),
        output: [{ role: "assistant", content: "done" }],
        usageDetails: {
          input: 200,
          output: 30,
          total: 390,
          cache_read_input_tokens: 160,
        },
      }),
    );
    expect(contextMap.get(contextKey)).toMatchObject({
      llmCallCount: 2,
      hasProviderRequestGenerations: true,
      providerRequestAugmentedHookGenerations: true,
    });

    unsubscribe?.();
  });

  it("ignores turn-aggregate model diagnostics as per-call generations", async () => {
    const { langfuse, trace } = createLangfuseMock();
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
      type: "model.call.started",
      runId: "run-aggregate",
      callId: "call-aggregate",
      scope: "turn-aggregate",
      sessionKey: "agent:openmai-u1:main",
      sessionId: "session-aggregate",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-aggregate",
      callId: "call-aggregate",
      scope: "turn-aggregate",
      sessionKey: "agent:openmai-u1:main",
      sessionId: "session-aggregate",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
      durationMs: 42,
      usageSource: "turn-aggregate",
      usage: { input: 100, output: 20, total: 120 },
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();

    unsubscribe?.();
  });

  it("accepts unscoped 7.1 provider diagnostics as per-call generations", async () => {
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
      type: "model.call.started",
      runId: "run-unscoped",
      callId: "call-unscoped",
      sessionKey: "agent:openmai-u1:main",
      sessionId: "session-unscoped",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-unscoped",
      callId: "call-unscoped",
      sessionKey: "agent:openmai-u1:main",
      sessionId: "session-unscoped",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
      durationMs: 42,
      usage: { input: 100, output: 20, total: 120 },
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).toHaveBeenCalledOnce();
    expect(trace.generation).toHaveBeenCalledOnce();
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: { input: 100, output: 20, total: 120 },
      }),
    );

    unsubscribe?.();
  });

  it("reuses a diagnostic root trace identity after its first SDK enqueue is rejected", async () => {
    const { langfuse } = createLangfuseMock();
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let rejectRootTrace = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic trace create" && rejectRootTrace) {
          rejectRootTrace = false;
          return false;
        }
        return true;
      },
    );
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
      onBeforeSdkEnqueue,
    });
    const started = {
      type: "model.call.started",
      runId: "run-root-retry",
      callId: "call-root-retry",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:root-retry",
      sessionId: "session-root-retry",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    };

    emitTrustedDiagnosticEvent(started);
    now += 6 * 60 * 1000;
    emitTrustedDiagnosticEvent(started);
    await waitForDiagnosticEventsDrained();

    const markers = readTraceLedgerRecordsForTest(tmpDir).filter(
      (record) => record.kind === "trace" && record.status === "open",
    );
    expect(markers).toHaveLength(1);
    expect(langfuse.trace).toHaveBeenCalledOnce();
    expect(langfuse.trace.mock.calls[0]?.[0].id).toBe(
      markers[0]?.kind === "trace" ? markers[0].traceId : undefined,
    );

    nowSpy.mockRestore();
    unsubscribe?.();
  });

  it("retries a provider terminal after ledger and SDK enqueue failures", async () => {
    const { langfuse, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let rejectTerminalUpdate = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic provider-request generation update" && rejectTerminalUpdate) {
          rejectTerminalUpdate = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const base = {
      runId: "run-retry-terminal",
      callId: "call-retry-terminal",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:retry-terminal",
      sessionId: "session-retry-terminal",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    const terminal = {
      ...base,
      type: "model.call.completed" as const,
      durationMs: 42,
      usage: { input: 100, output: 20, total: 120 },
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    let failLedgerWrite = true;
    configureTraceLedgerStore(tmpDir, {
      register: vi.fn(),
      registerIfAbsent: vi.fn(() => true),
      update: vi.fn(() => {
        if (failLedgerWrite) {
          failLedgerWrite = false;
          throw new Error("ledger unavailable");
        }
        return true;
      }),
      lookup: vi.fn(),
      consume: vi.fn(),
      delete: vi.fn(() => true),
      entries: vi.fn(() => []),
      clear: vi.fn(),
    });
    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();
    expect(generation.update).not.toHaveBeenCalled();

    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();
    expect(generation.update).not.toHaveBeenCalled();

    emitTrustedDiagnosticEvent(terminal);
    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledOnce();
    expect(contextMap.findActive(base.sessionKey)?.providerRequestCompletedCallIds).toEqual(
      new Set([base.callId]),
    );
    const entry = contextMap.findActive(base.sessionKey);
    expect(entry?.observationLedgerIncomplete).not.toBe(true);
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);

    unsubscribe?.();
  });

  it("retries authoritative terminal usage at finalization without updating the generation twice", async () => {
    const { langfuse, generation, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let rejectAuthoritativeUsage = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic finalized usage trace update" && rejectAuthoritativeUsage) {
          rejectAuthoritativeUsage = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const base = {
      runId: "run-retry-authoritative-usage",
      callId: "call-retry-authoritative-usage",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:retry-authoritative-usage",
      sessionId: "session-retry-authoritative-usage",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    const terminal = {
      ...base,
      type: "model.call.completed" as const,
      durationMs: 42,
      usage: { input: 100, output: 20, total: 120 },
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    await waitForDiagnosticEventsDrained();
    const entry = contextMap.findActive(base.sessionKey);
    expect(entry).toBeDefined();
    entry!.finalized = true;

    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledOnce();
    expect(entry?.providerRequestCompletedCallIds?.size ?? 0).toBe(0);
    expect(entry?.providerRequestUsages?.size ?? 0).toBe(0);
    expect(entry?.providerRequestPendingTerminalCommits?.has(base.callId)).toBe(true);

    expect(
      retryPendingProviderRequestTerminals(entry!, (traceId, observationId, eventType, source) =>
        onBeforeSdkEnqueue(traceId, observationId, eventType, source),
      ),
    ).toBe(true);

    expect(generation.update).toHaveBeenCalledOnce();
    expect(entry?.providerRequestCompletedCallIds).toEqual(new Set([base.callId]));
    expect(entry?.providerRequestUsages).toEqual(
      new Map([[base.callId, { input: 100, output: 20, total: 120 }]]),
    );
    expect(entry?.providerRequestPendingTerminalCommits?.size ?? 0).toBe(0);
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);
    expect(
      onBeforeSdkEnqueue.mock.calls.filter(
        (call) => call[3] === "diagnostic finalized usage trace update",
      ),
    ).toHaveLength(2);
    expect(
      trace.update.mock.calls.filter(
        ([update]) =>
          (update as { metadata?: { usage?: unknown } } | undefined)?.metadata?.usage !== undefined,
      ),
    ).toHaveLength(1);

    unsubscribe?.();
  });

  it("retries terminal trace stats without updating the generation twice", async () => {
    const { langfuse, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let traceStatsEnqueues = 0;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic provider-request trace stats") {
          traceStatsEnqueues += 1;
          return traceStatsEnqueues !== 2;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const base = {
      runId: "run-retry-terminal-trace-stats",
      callId: "call-retry-terminal-trace-stats",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:retry-terminal-trace-stats",
      sessionId: "session-retry-terminal-trace-stats",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    const terminal = {
      ...base,
      type: "model.call.completed" as const,
      durationMs: 42,
      usage: { input: 100, output: 20, total: 120 },
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    const entry = contextMap.findActive(base.sessionKey);
    expect(generation.update).toHaveBeenCalledOnce();
    expect(entry?.providerRequestPendingTerminalCommits?.has(base.callId)).toBe(true);

    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledOnce();
    expect(entry?.providerRequestCompletedCallIds).toEqual(new Set([base.callId]));
    expect(entry?.providerRequestPendingTerminalCommits?.size ?? 0).toBe(0);
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);

    unsubscribe?.();
  });

  it("clears a retryable provider start enqueue failure after the diagnostic is retried", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let rejectTraceStats = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic provider-request trace stats" && rejectTraceStats) {
          rejectTraceStats = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const started = {
      type: "model.call.started" as const,
      runId: "run-retry-start",
      callId: "call-retry-start",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:retry-start",
      sessionId: "session-retry-start",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    };

    emitTrustedDiagnosticEvent(started);
    await waitForDiagnosticEventsDrained();

    const entryAfterFailure = contextMap.findActive(started.sessionKey);
    expect(entryAfterFailure?.providerRequestGenerationIndexes?.has(started.callId)).not.toBe(true);
    expect(trace.generation).not.toHaveBeenCalled();

    emitTrustedDiagnosticEvent(started);
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    const entry = contextMap.findActive(started.sessionKey);
    expect(entry?.observationLedgerIncomplete).not.toBe(true);
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);

    unsubscribe?.();
  });

  it("clears a rejected provider start when a terminal-only generation supersedes it", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let rejectStartGeneration = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic provider-request generation" && rejectStartGeneration) {
          rejectStartGeneration = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const base = {
      runId: "run-terminal-supersedes-start",
      callId: "call-terminal-supersedes-start",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:terminal-supersedes-start",
      sessionId: "session-terminal-supersedes-start",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      durationMs: 42,
      usage: { input: 100, output: 20, total: 120 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    const entry = contextMap.findActive(base.sessionKey);
    expect(entry?.providerRequestCompletedCallIds).toEqual(new Set([base.callId]));
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);

    unsubscribe?.();
  });

  it("deduplicates repeated provider starts and retains the private request baseline", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    let rejectModelContext = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic model context trace update" && rejectModelContext) {
          rejectModelContext = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const started = {
      type: "model.call.started" as const,
      runId: "run-retry-context",
      callId: "call-retry-context",
      scope: "provider-request" as const,
      sessionKey: "agent:openmai-u1:openresponses:retry-context",
      sessionId: "session-retry-context",
      provider: "codex",
      model: "clawos/gpt-5.6-sol",
    };
    const privateData = {
      modelContent: {
        systemPrompt: "system",
        inputMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "current request" },
        ],
      },
    };

    emitTrustedDiagnosticEventWithPrivateData(started, privateData);
    emitTrustedDiagnosticEventWithPrivateData(started, privateData);
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    expect(trace.generation.mock.calls[0]?.[0]).toMatchObject({
      metadata: { inputProjection: "unavailable" },
    });
    expect(trace.generation.mock.calls[0]?.[0]).not.toHaveProperty("input");
    const entry = contextMap.findActive(started.sessionKey);
    expect(entry?.previousProviderRequestInputMessages).toEqual(
      privateData.modelContent.inputMessages,
    );
    expect(entry?.providerRequestInputs?.has(started.callId) ?? false).toBe(false);
    expect(entry?.providerRequestInputProjections?.get(started.callId)).toEqual({
      projection: "unavailable",
    });

    unsubscribe?.();
  });

  it("uses provider-request indexes ahead of sparse rollout source order", async () => {
    const { langfuse, trace } = createLangfuseMock();
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
    const base = {
      type: "model.call.started",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:source-order",
      sessionId: "session-source-order",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    emitTrustedDiagnosticEvent({
      ...base,
      callId: "call-late",
      providerRequestIndex: 2,
      rolloutSourceOrder: "0000000000000009",
    });
    emitTrustedDiagnosticEvent({
      ...base,
      callId: "call-early",
      providerRequestIndex: 1,
      rolloutSourceOrder: "0000000000000007",
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(trace.generation.mock.calls[0][0]).toMatchObject({
      id: expect.stringMatching(/-gen-2$/),
      name: "llm-call-2",
    });
    expect(trace.generation.mock.calls[1][0]).toMatchObject({
      id: expect.stringMatching(/-gen-1$/),
      name: "llm-call-1",
    });

    unsubscribe?.();
  });

  it("keeps a provider terminal in its allocated generation slot", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const occupiedGeneration = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:occupied-slot`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-occupied",
      llmCallCount: 1,
      toolCallCount: 0,
      hasProviderRequestGenerations: true,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, occupiedGeneration as never]]),
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
    const base = {
      runId: "run-occupied",
      callId: "call-occupied",
      scope: "provider-request",
      providerRequestIndex: 1,
      sessionKey,
      sessionId: "session-occupied",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      durationMs: 10,
      usage: { input: 4, output: 2, total: 6 },
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledWith(expect.objectContaining({ name: "llm-call-2" }));
    expect(contextMap.get(contextKey)?.completedGenerations.get(1)).toBe(occupiedGeneration);
    expect(contextMap.get(contextKey)?.completedGenerations.get(2)).toBe(generation);
    expect(contextMap.get(contextKey)?.providerRequestGenerationIndexes?.get("call-occupied")).toBe(
      2,
    );

    unsubscribe?.();
  });

  it("processes diagnostics covered by an in-progress finalization barrier", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:openresponses:finalization-barrier`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-finalization-barrier",
      llmCallCount: 0,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map(),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalizationInProgress: true,
      diagnosticAdmissionClosed: true,
      finalizationDiagnosticSequence: 10,
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
    const base = {
      type: "model.call.started",
      runId: "run-finalization-barrier",
      scope: "provider-request",
      sessionKey,
      sessionId: "session-finalization-barrier",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    diagnosticBus.listener?.({ ...base, seq: 9, callId: "call-covered" });
    diagnosticBus.listener?.({ ...base, seq: 11, callId: "call-late" });
    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledTimes(1));

    expect(trace.generation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trace-finalization-barrier-gen-1" }),
    );
    unsubscribe?.();
  });

  it("preserves explicitly reported zero usage without accepting diagnostic cost", async () => {
    const { langfuse, generation } = createLangfuseMock();
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
    const base = {
      runId: "run-zero",
      callId: "call-zero",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:zero",
      sessionId: "session-zero",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      providerRequestIndex: 1,
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      costUsd: 0,
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      },
    });
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: {
          input: 0,
          cache_read_input_tokens: 0,
          output: 0,
          total: 0,
          reasoning_tokens: 0,
        },
      }),
    );
    expect(generation.update.mock.calls[0]?.[0]).not.toHaveProperty("costDetails");

    unsubscribe?.();
  });

  it("omits invalid negative provider cost", async () => {
    const { langfuse, generation } = createLangfuseMock();
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
    const base = {
      runId: "run-negative-cost",
      callId: "call-negative-cost",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:negative-cost",
      sessionId: "session-negative-cost",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      providerRequestIndex: 1,
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      costUsd: -1,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledTimes(1);
    expect(generation.update.mock.calls[0]?.[0]).not.toHaveProperty("costDetails");

    unsubscribe?.();
  });

  it("normalizes Codex cached input without exporting missing cache write as zero", async () => {
    const { langfuse, generation } = createLangfuseMock();
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
    const base = {
      runId: "run-cached",
      callId: "call-cached",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:cached",
      sessionId: "session-cached",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };

    emitTrustedDiagnosticEvent({ ...base, type: "model.call.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "model.call.completed",
      usage: {
        input_tokens: 20000,
        cached_input_tokens: 12000,
        output_tokens: 500,
        reasoning_output_tokens: 100,
        total_tokens: 20500,
      },
    });
    await waitForDiagnosticEventsDrained();

    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: {
          input: 8000,
          cache_read_input_tokens: 12000,
          output: 500,
          total: 20500,
          reasoning_tokens: 100,
        },
      }),
    );
    expect(JSON.stringify(generation.update.mock.calls)).not.toContain(
      "cache_creation_input_tokens",
    );

    unsubscribe?.();
  });

  it("creates native Codex tool spans from started diagnostics before terminal output", async () => {
    const { langfuse, trace, span } = createLangfuseMock();
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
        type: "tool.execution.started",
        runId: "run-tool-start",
        sessionKey: "agent:openmai-u1:openresponses:tool-start",
        sessionId: "session-tool-start",
        toolName: "skills.list",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-start",
        startTimeMs: 1000,
      },
      { toolContent: { toolInput: { authority: { kind: "orchestrator" } } } },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.span).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "tool:skills.list",
        startTime: new Date(1000),
        input: { authority: { kind: "orchestrator" } },
      }),
    );
    expect(span.update).not.toHaveBeenCalled();

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-tool-start",
        sessionKey: "agent:openmai-u1:openresponses:tool-start",
        sessionId: "session-tool-start",
        toolName: "skills.list",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-start",
        endTimeMs: 1075,
        durationMs: 75,
      },
      { toolContent: { toolOutput: { skills: ["example-search"] } } },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.span).toHaveBeenCalledOnce();
    expect(span.update).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: new Date(1075),
        output: { skills: ["example-search"] },
      }),
    );

    unsubscribe?.();
  });

  it("writes a tool span end marker before retrying its SDK update", async () => {
    const { langfuse, span } = createLangfuseMock();
    let rejectTerminalUpdate = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic tool span update" && rejectTerminalUpdate) {
          rejectTerminalUpdate = false;
          return false;
        }
        return true;
      },
    );
    const unsubscribe = await subscribeDiagnosticEvents({
      langfuse: langfuse as never,
      contextMap: new TraceContextMap(),
      logger: mockLogger,
      stateDir: tmpDir,
      redactEnabled: false,
      config,
      promptManager: null,
      internalDiagnostics,
      onBeforeSdkEnqueue,
    });
    const base = {
      runId: "run-tool-delivery-retry",
      sessionKey: "agent:openmai-u1:openresponses:tool-delivery-retry",
      sessionId: "session-tool-delivery-retry",
      toolName: "skills.list",
      toolOwner: "codex-rollout-trace",
      toolCallId: "tool-call-delivery-retry",
    };
    const terminal = {
      ...base,
      type: "tool.execution.completed" as const,
      endTimeMs: 1075,
      durationMs: 75,
    };

    emitTrustedDiagnosticEvent({ ...base, type: "tool.execution.started", startTimeMs: 1000 });
    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    const eventsAfterRejection = readTraceLedgerRecordsForTest(tmpDir).filter(
      (record) => record.kind === "observation" && record.observationKind === "span",
    );
    expect(eventsAfterRejection.filter((event) => event.completedAt)).toHaveLength(1);
    expect(span.update).not.toHaveBeenCalled();

    emitTrustedDiagnosticEvent(terminal);
    await waitForDiagnosticEventsDrained();

    const eventsAfterRetry = readTraceLedgerRecordsForTest(tmpDir).filter(
      (record) => record.kind === "observation" && record.observationKind === "span",
    );
    expect(eventsAfterRetry.filter((event) => event.completedAt)).toHaveLength(1);
    expect(span.update).toHaveBeenCalledOnce();

    unsubscribe?.();
  });

  it("uses replayed source timestamps for native Codex tool spans", async () => {
    const { langfuse, trace, span } = createLangfuseMock();
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
    const base = {
      runId: "run-tool-replayed-timestamp",
      sessionKey: "agent:openmai-u1:openresponses:tool-replayed-timestamp",
      sessionId: "session-tool-replayed-timestamp",
      toolName: "skills.list",
      toolOwner: "codex-native-tool-lifecycle",
      toolCallId: "tool-call-replayed-timestamp",
    };

    emitTrustedDiagnosticEvent({
      ...base,
      type: "tool.execution.started",
      sourceTimestampMs: 1000,
      ts: 9000,
    });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "tool.execution.completed",
      sourceTimestampMs: 1200,
      durationMs: 200,
      ts: 10_000,
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.span).toHaveBeenCalledWith(
      expect.objectContaining({
        startTime: new Date(1000),
      }),
    );
    expect(span.update).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: new Date(1200),
      }),
    );

    unsubscribe?.();
  });

  it("accepts reconciled native Codex tool spans without collecting unrelated tool owners", async () => {
    const { langfuse, trace, span } = createLangfuseMock();
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
    const base = {
      runId: "run-tool-metadata-only",
      sessionKey: "agent:openmai-u1:openresponses:tool-metadata-only",
      sessionId: "session-tool-metadata-only",
      toolName: "skills.list",
      toolOwner: "codex-native-tool-lifecycle",
      toolCallId: "tool-call-metadata-only",
      startTimeMs: 1000,
    };

    emitTrustedDiagnosticEvent({
      ...base,
      type: "tool.execution.completed",
      toolOwner: "browser-tools",
      toolCallId: "unrelated-tool-call",
      endTimeMs: 1100,
      durationMs: 100,
    });
    emitTrustedDiagnosticEvent({ ...base, type: "tool.execution.started" });
    emitTrustedDiagnosticEvent({
      ...base,
      type: "tool.execution.completed",
      endTimeMs: 1200,
      durationMs: 200,
    });
    await waitForDiagnosticEventsDrained();

    expect(trace.span).toHaveBeenCalledOnce();
    expect(trace.span.mock.calls[0]?.[0]).toMatchObject({
      name: "tool:skills.list",
      metadata: expect.objectContaining({
        toolName: "skills.list",
        toolCallId: "tool-call-metadata-only",
      }),
    });
    expect(trace.span.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(span.update).toHaveBeenCalledOnce();
    expect(span.update.mock.calls[0]?.[0]).not.toHaveProperty("input");
    expect(span.update.mock.calls[0]?.[0]).not.toHaveProperty("output");

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

  it("retries a fallback generation after its initial SDK enqueue is rejected", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:agent-1:openresponses:fallback-retry";
    const sessionId = "session-fallback-retry";
    setSessionTranscript(sessionId, [
      {
        timestamp: Date.now(),
        message: { role: "user", content: "retry fallback" },
      },
    ]);
    let rejectFallback = true;
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) => {
        if (source === "diagnostic fallback generation" && rejectFallback) {
          rejectFallback = false;
          return false;
        }
        return true;
      },
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
      onBeforeSdkEnqueue,
    });
    const aggregate = {
      type: "model.usage" as const,
      sessionKey,
      sessionId,
      agentId: "agent-1",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      usage: { input: 10, output: 2, total: 12 },
      durationMs: 10,
    };

    emitTrustedDiagnosticEvent(aggregate);
    await waitForDiagnosticEventsDrained();

    const entryAfterRejection = contextMap.findActive(sessionKey);
    expect(trace.generation).not.toHaveBeenCalled();
    expect(entryAfterRejection?.llmCallCount).toBe(0);

    emitTrustedDiagnosticEvent(aggregate);
    await waitForDiagnosticEventsDrained();

    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledOnce());
    expect(contextMap.findRecent(sessionKey)?.llmCallCount).toBe(1);

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

  it("matches finalized hook traces by runId when aggregate usage totals differ", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const contextKey = TraceContextMap.key(agentId, sessionKey);
    contextMap.create(contextKey, {
      trace: trace as never,
      traceId: "trace-hook-run-id",
      traceMetadata: { trigger: "user" },
      llmCallCount: 2,
      toolCallCount: 1,
      storedUsage: { input: 1_980, output: 17, cacheRead: 10_624, total: 12_621 },
      finalizedUsage: {
        input: 3_889,
        output: 56,
        cacheRead: 21_248,
        cacheWrite: 0,
        total: 25_193,
      },
      runIds: new Set(["run-ingress-1"]),
      lastProvider: "aliyun",
      lastModel: "qwen3.7-plus",
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([
        [1, generation as never],
        [2, generation as never],
      ]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      finalized: true,
      finalizationInProgress: true,
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
      runId: "run-ingress-1",
      sessionKey,
      sessionId: "session-1",
      channel: "webchat",
      agentId,
      provider: "aliyun",
      model: "qwen3.7-plus",
      usage: {
        input: 3_889,
        output: 56,
        cacheRead: 21_248,
        cacheWrite: 0,
        total: 12_621,
      },
      lastCallUsage: {
        input: 1_980,
        output: 17,
        cacheRead: 10_624,
        cacheWrite: 0,
        total: 12_621,
      },
      durationMs: 10,
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();
    expect(contextMap.get(contextKey)?.traceId).toBe("trace-hook-run-id");

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

  it("matches aggregate usage to a finalized hook trace through lastCallUsage", async () => {
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
      storedUsage: { input: 1980, output: 17, cacheRead: 10624, total: 12621 },
      finalizedUsage: {
        input: 14513,
        output: 56,
        cacheRead: 10624,
        cacheWrite: 0,
        total: 25193,
      },
      lastProvider: "aliyun",
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
      finalizationInProgress: true,
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
      provider: "aliyun",
      model: "qwen3.7-plus",
      usage: {
        input: 14513,
        output: 56,
        cacheRead: 10624,
        cacheWrite: 0,
        total: 12621,
      },
      lastCallUsage: {
        input: 1980,
        output: 17,
        cacheRead: 10624,
        cacheWrite: 0,
        total: 12621,
      },
      durationMs: 10,
    });
    await waitForDiagnosticEventsDrained();

    expect(langfuse.trace).not.toHaveBeenCalled();
    expect(trace.generation).not.toHaveBeenCalled();
    expect(contextMap.get(contextKey)?.traceId).toBe("trace-hook");

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
    const completedEntry = contextMap.findActive(sessionKey);
    expect(completedEntry?.toolCallCount).toBe(1);
    expect(completedEntry?.pendingSpans.has("tool-call-1")).toBe(false);
    expect(completedEntry?.completedSpans?.get("tool-call-1")).toBe(span);
    expect(completedEntry?.completedSpanToolCallIds.has("tool-call-1")).toBe(true);
    expect(completedEntry?.diagnosticCorrectedSpanToolCallIds?.has("tool-call-1")).toBe(true);

    unsubscribe?.();
  });

  it("marks completed Codex exec diagnostics as errors for non-zero exit codes", async () => {
    const { langfuse, span } = createLangfuseMock();
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

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "tool.execution.completed",
        runId: "run-1",
        sessionKey,
        sessionId: "session-1",
        toolName: "exec_command",
        toolSource: "core",
        toolOwner: "codex-rollout-trace",
        toolCallId: "tool-call-failed-exec",
        startTimeMs: 1000,
        endTimeMs: 1075,
        durationMs: 75,
      },
      {
        toolContent: {
          toolInput: { cmd: "missing-command" },
          toolOutput: { exit_code: 127, output: "not found" },
        },
      },
    );
    await waitForDiagnosticEventsDrained();

    expect(span.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { exit_code: 127, output: "not found" },
        level: "ERROR",
        statusMessage: "codex_native_tool_nonzero_exit",
        metadata: expect.objectContaining({ isError: true }),
      }),
    );

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

  it("parents sequential rollout tools to their latest preceding provider generations", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const firstSpan = { update: vi.fn(), end: vi.fn() };
    const secondSpan = { update: vi.fn(), end: vi.fn() };
    const firstGeneration = {
      update: vi.fn(),
      end: vi.fn(),
      span: vi.fn().mockReturnValue(firstSpan),
    };
    const secondGeneration = {
      update: vi.fn(),
      end: vi.fn(),
      span: vi.fn().mockReturnValue(secondSpan),
    };
    trace.generation.mockReturnValueOnce(firstGeneration).mockReturnValueOnce(secondGeneration);
    const contextMap = new TraceContextMap();
    const sessionKey = "agent:openmai-u1:openresponses:multi-parent";
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
    const providerEvent = (type: "model.call.started" | "model.call.completed", index: number) => ({
      type,
      runId: "run-multi-parent",
      callId: `call-${index}`,
      scope: "provider-request" as const,
      providerRequestIndex: index,
      sessionKey,
      sessionId: "session-multi-parent",
      provider: "codex",
      model: "baidu/glm-5.2",
      startTimeMs: index * 1_000,
      ...(type === "model.call.completed"
        ? { endTimeMs: index * 1_000 + 100, durationMs: 100, usageSource: "unknown" }
        : {}),
    });
    const toolEvent = (index: number) => ({
      type: "tool.execution.completed" as const,
      runId: "run-multi-parent",
      sessionKey,
      sessionId: "session-multi-parent",
      toolName: `tool-${index}`,
      toolSource: "core" as const,
      toolOwner: "codex-rollout-trace",
      toolCallId: `tool-call-${index}`,
      startTimeMs: index * 1_000 + 110,
      endTimeMs: index * 1_000 + 120,
      durationMs: 10,
    });

    for (const index of [1, 2]) {
      emitTrustedDiagnosticEvent(providerEvent("model.call.started", index));
      emitTrustedDiagnosticEvent(providerEvent("model.call.completed", index));
      emitTrustedDiagnosticEvent(toolEvent(index));
    }
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledTimes(2);
    expect(firstGeneration.span).toHaveBeenCalledOnce();
    expect(firstGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tool:tool-1" }),
    );
    expect(secondGeneration.span).toHaveBeenCalledOnce();
    expect(secondGeneration.span).toHaveBeenCalledWith(
      expect.objectContaining({ name: "tool:tool-2" }),
    );
    expect(trace.span).not.toHaveBeenCalled();

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

  it("adds single-call aggregate usage without non-authoritative diagnostic cost", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-completed-single-call";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    const traceId = "trace-completed-single-call";
    setSessionTranscript(sessionId, [
      {
        timestamp: 1783000000000,
        message: { role: "user", content: "hello" },
      },
      {
        timestamp: 1783000001000,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId,
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      completedGenerationIds: new Map([[1, `${traceId}-gen-1`]]),
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
      sessionId,
      channel: "default",
      agentId,
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 100, output: 20, cacheRead: 40, total: 120 },
      costUsd: 0.5,
      durationMs: 100,
    });
    await vi.waitFor(() =>
      expect(generation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          usageDetails: {
            input: 100,
            output: 20,
            cache_read_input_tokens: 40,
            total: 120,
          },
          metadata: { durationMs: 100 },
        }),
      ),
    );
    expect(generation.update.mock.calls[0]?.[0]).not.toHaveProperty("costDetails");

    unsubscribe?.();
  });

  it("keeps multi-call aggregate usage at trace scope instead of assigning it to the last call", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-aggregate-multi-call";
    const sessionKey = `agent:${agentId}:openresponses:s1`;
    setSessionTranscript(sessionId, [
      {
        timestamp: 1783000000000,
        message: { role: "user", content: "find candidates" },
      },
      {
        timestamp: 1783000001000,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "search",
              arguments: { query: "golang" },
            },
          ],
        },
      },
      {
        timestamp: 1783000002000,
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "search",
          content: [{ type: "text", text: "found" }],
        },
      },
      {
        timestamp: 1783000003000,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
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
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 100, output: 20, cacheRead: 40, total: 160 },
      costUsd: 0.5,
      durationMs: 100,
    });

    await vi.waitFor(() => expect(trace.generation).toHaveBeenCalledTimes(2));
    for (const [update] of generation.update.mock.calls) {
      expect(update).not.toHaveProperty("usageDetails");
      expect(update).not.toHaveProperty("costDetails");
    }
    const aggregateUpdate = trace.update.mock.calls.find(
      ([update]) =>
        (update.metadata as Record<string, unknown> | undefined)?.aggregateUsage !== undefined,
    )?.[0];
    expect(aggregateUpdate?.metadata).toMatchObject({
      aggregateUsage: { input: 100, output: 20, cacheRead: 40, total: 160 },
    });
    expect(aggregateUpdate?.metadata).not.toHaveProperty("aggregateCostUsd");

    unsubscribe?.();
  });

  it("keeps aggregate usage at trace scope when multiple hook generations lack transcript turns", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const firstGeneration = { update: vi.fn(), end: vi.fn() };
    const secondGeneration = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-missing-transcript-turns";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-missing-transcript-turns",
      llmCallCount: 2,
      toolCallCount: 0,
      pendingGenerations: new Map([
        ["run-1", firstGeneration as never],
        ["run-2", secondGeneration as never],
      ]),
      pendingGenIds: new Map([
        ["run-1", "trace-missing-transcript-turns-gen-1"],
        ["run-2", "trace-missing-transcript-turns-gen-2"],
      ]),
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
      sessionId,
      channel: "default",
      agentId,
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 100, output: 20, cacheRead: 40, total: 160 },
      costUsd: 0.5,
      durationMs: 100,
    });

    await vi.waitFor(() => {
      expect(firstGeneration.update).toHaveBeenCalledOnce();
      expect(secondGeneration.update).toHaveBeenCalledOnce();
    });
    for (const generation of [firstGeneration, secondGeneration]) {
      const update = generation.update.mock.calls[0]?.[0];
      expect(update).not.toHaveProperty("usageDetails");
      expect(update).not.toHaveProperty("costDetails");
    }
    const aggregateUpdate = trace.update.mock.calls.find(
      ([update]) =>
        (update.metadata as Record<string, unknown> | undefined)?.aggregateUsage !== undefined,
    )?.[0];
    expect(aggregateUpdate?.metadata).toMatchObject({
      aggregateUsage: { input: 100, output: 20, cacheRead: 40, total: 160 },
    });
    expect(aggregateUpdate?.metadata).not.toHaveProperty("aggregateCostUsd");

    unsubscribe?.();
  });

  it("does not recreate completed hook generations when aggregate transcript turns are unavailable", async () => {
    const { langfuse, trace } = createLangfuseMock();
    const firstGeneration = { update: vi.fn(), end: vi.fn() };
    const secondGeneration = { update: vi.fn(), end: vi.fn() };
    const contextMap = new TraceContextMap();
    const agentId = "openmai-u1";
    const sessionId = "session-completed-without-transcript";
    const sessionKey = `agent:${agentId}:dashboard:s1`;
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace: trace as never,
      traceId: "trace-completed-without-transcript",
      llmCallCount: 2,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([
        [1, firstGeneration as never],
        [2, secondGeneration as never],
      ]),
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
      sessionId,
      channel: "default",
      agentId,
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 100, output: 20, cacheRead: 40, total: 160 },
      costUsd: 0.5,
      durationMs: 100,
    });

    await vi.waitFor(() =>
      expect(trace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            aggregateUsage: { input: 100, output: 20, cacheRead: 40, total: 160 },
          }),
        }),
      ),
    );
    const aggregateUpdate = trace.update.mock.calls.find(
      ([update]) =>
        (update.metadata as Record<string, unknown> | undefined)?.aggregateUsage !== undefined,
    )?.[0];
    expect(aggregateUpdate?.metadata).not.toHaveProperty("aggregateCostUsd");
    expect(trace.generation).not.toHaveBeenCalled();
    expect(firstGeneration.update).not.toHaveBeenCalled();
    expect(secondGeneration.update).not.toHaveBeenCalled();

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
    expect(generationInput).toMatchObject({
      messages: [
        {
          role: "user",
          content: {
            truncated: true,
            original_bytes: expect.any(Number),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ],
      messages_truncation: {
        truncated: true,
        original_count: 1,
        retained_count: 1,
      },
    });

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
      rootInput: "hello",
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
          inputMessages: [
            { role: "user", content: "hello" },
            { role: "tool", content: "tool result" },
          ],
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
          model: "aliyun/qwen3.7-plus",
          messages: [{ role: "user", content: "hello" }],
        },
      }),
    );
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("system");
    expect(JSON.stringify(trace.update.mock.calls)).not.toContain("lookup");
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

  it("uses the recorded observation id when patching a completed hook generation", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const traceId = "trace-existing-recorded-id";
    const recordedGenerationId = `${traceId}-gen-recorded`;
    const agentId = "openmai-u1";
    const sessionKey = "main";
    const onBeforeSdkEnqueue = vi.fn(() => true);
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace,
      traceId,
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      completedGenerationIds: new Map([[1, recordedGenerationId]]),
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
      onBeforeSdkEnqueue,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-recorded-id",
      callId: "call-recorded-id",
      scope: "provider-request",
      agentId,
      sessionKey,
      sessionId: "session-recorded-id",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      startTimeMs: 1000,
    });
    await waitForDiagnosticEventsDrained();

    expect(onBeforeSdkEnqueue).toHaveBeenCalledWith(
      traceId,
      recordedGenerationId,
      "generation-update",
      "diagnostic provider-request claimed generation update",
    );
    expect(generation.update).toHaveBeenCalledOnce();

    unsubscribe?.();
  });

  it("clears a rejected claimed-generation update after terminal delivery succeeds", async () => {
    const { langfuse, trace, generation } = createLangfuseMock();
    const contextMap = new TraceContextMap();
    const traceId = "trace-claimed-terminal";
    const generationId = `${traceId}-gen-1`;
    const agentId = "openmai-u1";
    const sessionKey = "main";
    const onBeforeSdkEnqueue = vi.fn(
      (_traceId: string, _observationId: string, _eventType: string, source: string) =>
        source !== "diagnostic provider-request claimed generation update",
    );
    contextMap.create(TraceContextMap.key(agentId, sessionKey), {
      trace,
      traceId,
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation as never]]),
      completedGenerationIds: new Map([[1, generationId]]),
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
      onBeforeSdkEnqueue,
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-claimed-terminal",
      callId: "call-claimed-terminal",
      scope: "provider-request",
      agentId,
      sessionKey,
      sessionId: "session-claimed-terminal",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      startTimeMs: 1000,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-claimed-terminal",
      callId: "call-claimed-terminal",
      scope: "provider-request",
      agentId,
      sessionKey,
      sessionId: "session-claimed-terminal",
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
      startTimeMs: 1000,
      endTimeMs: 1040,
      durationMs: 40,
      usageSource: "provider",
      usage: { input: 10, output: 2, total: 12 },
    });
    await waitForDiagnosticEventsDrained();

    const entry = contextMap.get(TraceContextMap.key(agentId, sessionKey));
    expect(onBeforeSdkEnqueue).toHaveBeenCalledWith(
      traceId,
      generationId,
      "generation-update",
      "diagnostic provider-request claimed generation update",
    );
    expect(onBeforeSdkEnqueue).toHaveBeenCalledWith(
      traceId,
      generationId,
      "generation-update",
      "diagnostic provider-request generation update",
    );
    expect(generation.update).toHaveBeenCalledOnce();
    expect(entry?.pendingObservationDeliveryFailures?.size ?? 0).toBe(0);

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
      providerRequestGenerationIndexes: new Map([["call-1", 1]]),
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
      runtime: "codex",
      runtimeEngine: "codex-app-server",
      transport: "stdio",
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
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        runtimeTransport: "stdio",
        scope: "provider-request",
        orphanedStart: true,
      }),
    });
    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "ERROR",
        statusMessage: "invalid_request",
        metadata: expect.objectContaining({
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          runtimeTransport: "stdio",
          usageSource: "unknown",
          failureKind: "terminated",
        }),
      }),
    );

    unsubscribe?.();
  });

  it("ignores duplicate terminals and patches a terminal-first generation from a late start", async () => {
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
    const terminal = {
      type: "model.call.completed" as const,
      runId: "run-terminal-first",
      callId: "call-terminal-first",
      scope: "provider-request",
      sessionKey: "agent:openmai-u1:openresponses:s1",
      sessionId: "session-1",
      provider: "codex",
      model: "baidu/glm-5.2",
      runtime: "codex",
      runtimeEngine: "codex-app-server",
      transport: "stdio",
      endTimeMs: 2_000,
      durationMs: 1_000,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };

    emitTrustedDiagnosticEvent(terminal);
    emitTrustedDiagnosticEvent(terminal);
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-terminal-first",
        callId: "call-terminal-first",
        scope: "provider-request",
        sessionKey: "agent:openmai-u1:openresponses:s1",
        sessionId: "session-1",
        provider: "codex",
        model: "baidu/glm-5.2",
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
        startTimeMs: 900,
      },
      { modelContent: { inputMessages: [{ role: "user", content: "hello" }] } },
    );
    await waitForDiagnosticEventsDrained();

    expect(trace.generation).toHaveBeenCalledOnce();
    expect(generation.update).toHaveBeenCalledTimes(2);
    expect(generation.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startTime: new Date(900),
        metadata: expect.objectContaining({
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          runtimeTransport: "stdio",
          inputProjection: "unavailable",
          lateStart: true,
        }),
      }),
    );
    expect(generation.update.mock.calls.at(-1)?.[0]).not.toHaveProperty("input");

    unsubscribe?.();
  });
});
