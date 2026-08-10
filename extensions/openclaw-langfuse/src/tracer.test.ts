import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginLogger, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { computeCorrectedStartTimes, finalizeIncrementalObservations } from "./finalize.js";
import { buildObservationsFromEntries } from "./observations.js";
import {
  SDK_DELIVERY_MAX_ACTIVE_TRACES,
  SDK_DELIVERY_MAX_TICKETS_PER_TRACE,
} from "./sdk-delivery.js";
import { createLangfuseService, generateTraceId } from "./service.js";
import { writeObservationEvent } from "./session.js";
import runtimeProjectionMatrix from "./test-fixtures/runtime-projection-matrix.json" with { type: "json" };
import type { TraceContextEntry } from "./trace-context.js";
import {
  configureTraceLedgerStore,
  readTraceLedgerRecordsForTest,
  resetTraceLedgerStoreForTests,
} from "./trace-ledger.js";
import type { TraceLedgerRecord } from "./trace-ledger.js";
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
  sdkEvents,
  diagnosticRuntime,
  sessionTranscriptRuntime,
  sessionStoreRuntime,
} = vi.hoisted(() => {
  let activeTraceId: string | undefined;
  let activeGenerationId: string | undefined;
  let activeSpanId: string | undefined;
  let nextFlushError: unknown;
  const queue: Array<{ type: string; body: Record<string, unknown> }> = [];
  const pendingFlushCallbacks: Array<() => void> = [];
  let pausedFlushCount = 0;
  let pauseAllFlushes = false;
  const enqueue = (type: string, body: Record<string, unknown>): void => {
    queue.push({ type, body });
    mockLangfuseInstance.flush();
  };
  const mockSpan = {
    update: vi.fn((body?: Record<string, unknown>) => {
      enqueue("span-update", {
        ...body,
        ...(activeSpanId ? { id: activeSpanId } : {}),
        ...(activeTraceId ? { traceId: activeTraceId } : {}),
      });
    }),
    end: vi.fn(),
  };
  const mockGeneration = {
    update: vi.fn((body?: Record<string, unknown>) => {
      enqueue("generation-update", {
        ...body,
        ...(activeGenerationId ? { id: activeGenerationId } : {}),
        ...(activeTraceId ? { traceId: activeTraceId } : {}),
      });
    }),
    end: vi.fn(),
    span: vi.fn().mockReturnValue(mockSpan),
  };
  const mockTrace = {
    generation: vi.fn((body?: Record<string, unknown>) => {
      activeGenerationId = typeof body?.id === "string" ? body.id : activeGenerationId;
      enqueue("generation-create", {
        ...(body ?? {}),
        ...(activeTraceId ? { traceId: activeTraceId } : {}),
      });
      return mockGeneration;
    }),
    span: vi.fn((body?: Record<string, unknown>) => {
      activeSpanId = typeof body?.id === "string" ? body.id : activeSpanId;
      enqueue("span-create", {
        ...(body ?? {}),
        ...(activeTraceId ? { traceId: activeTraceId } : {}),
      });
      return mockSpan;
    }),
    update: vi.fn((body?: Record<string, unknown>) => {
      enqueue("trace-create", { ...body, ...(activeTraceId ? { id: activeTraceId } : {}) });
    }),
  };
  const sdkEvents = {
    listeners: new Map<string, Array<(payload: unknown) => void>>(),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const listeners = sdkEvents.listeners.get(event) ?? [];
      listeners.push(listener);
      sdkEvents.listeners.set(event, listeners);
      return () => {
        const next = (sdkEvents.listeners.get(event) ?? []).filter((item) => item !== listener);
        if (next.length === 0) {
          sdkEvents.listeners.delete(event);
        } else {
          sdkEvents.listeners.set(event, next);
        }
      };
    }),
    emit(event: string, payload: unknown): void {
      for (const listener of sdkEvents.listeners.get(event) ?? []) {
        listener(payload);
      }
    },
    takeQueuedItems(): Array<{ type: string; body: Record<string, unknown> }> {
      return queue.splice(0);
    },
    restoreQueuedItems(items: Array<{ type: string; body: Record<string, unknown> }>): void {
      queue.unshift(...items);
    },
    pauseNextFlushes(count = 1): void {
      pausedFlushCount += count;
    },
    pauseFlushes(): void {
      pauseAllFlushes = true;
    },
    resumeFlushes(): void {
      pauseAllFlushes = false;
    },
    releaseNextFlush(): void {
      pendingFlushCallbacks.shift()?.();
    },
    releaseAllFlushes(): void {
      for (const callback of pendingFlushCallbacks.splice(0)) {
        callback();
      }
    },
    failNextFlush(error: unknown): void {
      nextFlushError = error;
    },
    clear(): void {
      sdkEvents.listeners.clear();
      queue.length = 0;
      activeTraceId = undefined;
      activeGenerationId = undefined;
      activeSpanId = undefined;
      nextFlushError = undefined;
      pendingFlushCallbacks.length = 0;
      pausedFlushCount = 0;
      pauseAllFlushes = false;
    },
  };
  const mockLangfuseInstance = {
    trace: vi.fn((body?: Record<string, unknown>) => {
      activeTraceId = typeof body?.id === "string" ? body.id : activeTraceId;
      enqueue("trace-create", body ?? {});
      return mockTrace;
    }),
    shutdownAsync: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      const items = queue.splice(0, 1);
      if (items.length === 0) {
        callback?.();
        return;
      }
      const error = nextFlushError;
      nextFlushError = undefined;
      const complete = () => {
        if (error != null) {
          sdkEvents.emit("warning", error);
        }
        callback?.(error, items);
        sdkEvents.emit("flush", items);
      };
      if (pauseAllFlushes || pausedFlushCount > 0) {
        if (pausedFlushCount > 0) {
          pausedFlushCount -= 1;
        }
        pendingFlushCallbacks.push(complete);
        return;
      }
      complete();
    }),
    flushAsync: vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          mockLangfuseInstance.flush(() => resolve());
        }),
    ),
    getPrompt: vi.fn(),
    on: sdkEvents.on,
  };
  const mockLangfuseConstructor = vi.fn(function () {
    return mockLangfuseInstance;
  });
  const diagnosticRuntime: {
    listener?: (event: Record<string, unknown>, privateData?: Record<string, unknown>) => void;
    unsubscribe: ReturnType<typeof vi.fn>;
    waitForDiagnosticEventsDrained: ReturnType<typeof vi.fn>;
    captureInternalDiagnosticDeliveryCursor: ReturnType<typeof vi.fn>;
    waitForInternalDiagnosticDeliveryCursor: ReturnType<typeof vi.fn>;
  } = {
    unsubscribe: vi.fn(),
    waitForDiagnosticEventsDrained: vi.fn(async () => undefined),
    captureInternalDiagnosticDeliveryCursor: vi.fn((identity?: Record<string, unknown>) => ({
      ...identity,
      sequence: 0,
    })),
    waitForInternalDiagnosticDeliveryCursor: vi.fn(async () => ({ ok: true, deliveredEvents: 0 })),
  };
  const sessionTranscriptRuntime = {
    entriesBySessionId: new Map<string, unknown[]>(),
    readVisibleSessionTranscriptMessageEntries: vi.fn(
      async ({ sessionId }: { sessionId: string }) =>
        sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
    ),
  };
  const sessionStoreRuntime = {
    resolveTranscriptSessionKeyBySessionId: vi.fn(),
  };
  return {
    mockGeneration,
    mockSpan,
    mockTrace,
    mockLangfuseInstance,
    mockLangfuseConstructor,
    sdkEvents,
    diagnosticRuntime,
    sessionTranscriptRuntime,
    sessionStoreRuntime,
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

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveTranscriptSessionKeyBySessionId:
    sessionStoreRuntime.resolveTranscriptSessionKeyBySessionId,
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
  const internalDiagnostics = {
    emit: vi.fn(),
    onEvent: (
      listener: Parameters<
        NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>["onEvent"]
      >[0],
    ) => {
      diagnosticRuntime.listener = (event, privateData) =>
        listener(event as never, {} as never, privateData as never);
      return diagnosticRuntime.unsubscribe;
    },
    captureDeliveryCursor: diagnosticRuntime.captureInternalDiagnosticDeliveryCursor,
    waitForDeliveryCursor: diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor,
  };
  return {
    logger: mockLogger,
    internalDiagnostics,
    ...overrides,
  } as OpenClawPluginServiceContext;
}

function makeLegacyServiceCtxOverrides(): Partial<OpenClawPluginServiceContext> {
  const ctx = makeServiceCtx();
  const diagnostics = ctx.internalDiagnostics;
  if (!diagnostics) {
    return { internalDiagnostics: diagnostics };
  }
  const {
    captureDeliveryCursor: _captureDeliveryCursor,
    waitForDeliveryCursor: _waitForDeliveryCursor,
    ...legacyDiagnostics
  } = diagnostics;
  return {
    internalDiagnostics: legacyDiagnostics as OpenClawPluginServiceContext["internalDiagnostics"],
  };
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

function resolveMarkerFilePath(stateDir: string, agentId: string, sessionId: string): string {
  return path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.langfuse-markers.jsonl`);
}

function readLegacyLedgerMarkerFile(markerFile: string): string {
  const sessionsDir = path.dirname(markerFile);
  const agentId = path.basename(path.dirname(sessionsDir));
  const stateDir = path.dirname(path.dirname(path.dirname(sessionsDir)));
  const sessionId = path.basename(markerFile, ".langfuse-markers.jsonl");
  const records = readTraceLedgerRecordsForTest(stateDir);
  const traceIds = new Set(
    records
      .filter(
        (record) =>
          record.kind === "trace" && record.agentId === agentId && record.sessionId === sessionId,
      )
      .map((record) => (record.kind === "trace" ? record.traceId : "")),
  );
  const rows = records.filter(
    (record) =>
      (record.kind === "trace" && record.agentId === agentId && record.sessionId === sessionId) ||
      (record.kind === "observation" && (traceIds.size === 0 || traceIds.has(record.traceId))),
  );
  const legacyRows: Array<Record<string, unknown>> = [];
  for (const record of rows) {
    if (record.kind === "trace") {
      const timestamp = new Date(record.startedAt).toISOString();
      legacyRows.push({
        customType: "langfuse-trace-start",
        timestamp,
        data: { traceId: record.traceId },
      });
      if (record.status === "ended") {
        legacyRows.push({
          customType: "langfuse-trace-end",
          timestamp,
          data: { traceId: record.traceId },
        });
      }
      if (record.recoveryOutcome) {
        legacyRows.push({
          customType: "langfuse-trace-recovery",
          timestamp,
          data: { traceId: record.traceId, outcome: record.recoveryOutcome },
        });
      }
      continue;
    }
    if (record.startedAt) {
      legacyRows.push({
        e: record.observationKind === "generation" ? "gen-start" : "span-start",
        traceId: record.traceId,
        id: record.id,
        ts: record.startedAt,
        ...(record.llmCall !== undefined ? { llmCall: record.llmCall } : {}),
        ...(record.model ? { model: record.model } : {}),
        ...(record.tool ? { tool: record.tool } : {}),
        ...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
      });
    }
    if (record.completedAt) {
      legacyRows.push({
        e: record.observationKind === "generation" ? "gen-end" : "span-end",
        traceId: record.traceId,
        id: record.id,
        ts: record.completedAt,
      });
    }
  }
  return `${legacyRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

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

type ProjectionRuntime = keyof typeof runtimeProjectionMatrix.runtimes;

function projectionRuntime(runtime: ProjectionRuntime) {
  return runtimeProjectionMatrix.runtimes[runtime];
}

function projectionContext(runtime: ProjectionRuntime, scenario: string) {
  return {
    ...agentCtx,
    runId: `matrix-${runtime}-${scenario}`,
    sessionKey: `agent:agent-1:matrix-${runtime}-${scenario}`,
    sessionId: `matrix-${runtime}-${scenario}`,
  };
}

function projectionRuntimeIdentity(runtime: ProjectionRuntime) {
  return runtime === "codex"
    ? { runtime, runtimeEngine: "codex-app-server", transport: "stdio" }
    : { runtime, runtimeEngine: "embedded-agent-runner", transport: "http" };
}

function finalTraceUpdate(): Record<string, unknown> | undefined {
  return mockTrace.update.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, unknown>)
    .findLast((update) => (update.metadata as Record<string, unknown> | undefined)?.stats);
}

function rootContextUpdate(): Record<string, unknown> | undefined {
  return mockTrace.update.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, unknown>)
    .find((update) => Object.hasOwn(update, "input"));
}

function diagnosticUsage(
  runtime: ProjectionRuntime,
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  },
): Record<string, number> {
  if (runtime === "codex") {
    return {
      input_tokens: usage.input,
      output_tokens: usage.output,
      ...(usage.cacheRead !== undefined ? { cached_input_tokens: usage.cacheRead } : {}),
      total_tokens: usage.total,
    };
  }
  return usage;
}

function emitMatrixModelStart(params: {
  runtime: ProjectionRuntime;
  ctx: ReturnType<typeof projectionContext>;
  callIndex: number;
  inputMessages: unknown[];
}): void {
  const runtimeConfig = projectionRuntime(params.runtime);
  diagnosticRuntime.listener?.(
    {
      type: "model.call.started",
      runId: params.ctx.runId,
      callId: `${params.ctx.runId}-call-${params.callIndex}`,
      providerRequestIndex: params.callIndex,
      ...(params.runtime === "codex" ? { scope: "provider-request" } : {}),
      sessionKey: params.ctx.sessionKey,
      sessionId: params.ctx.sessionId,
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      ...projectionRuntimeIdentity(params.runtime),
      requestForm: "full",
      startTimeMs: 1_000 + params.callIndex * 100,
    },
    {
      modelContent: {
        systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
        inputMessages: params.inputMessages,
        toolDefinitions: [{ type: "function", name: "lookup" }],
      },
    },
  );
}

function emitMatrixModelTerminal(params: {
  runtime: ProjectionRuntime;
  ctx: ReturnType<typeof projectionContext>;
  callIndex: number;
  outputMessages: unknown[];
  usage: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  };
}): void {
  const runtimeConfig = projectionRuntime(params.runtime);
  diagnosticRuntime.listener?.(
    {
      type: "model.call.completed",
      runId: params.ctx.runId,
      callId: `${params.ctx.runId}-call-${params.callIndex}`,
      providerRequestIndex: params.callIndex,
      ...(params.runtime === "codex" ? { scope: "provider-request" } : {}),
      sessionKey: params.ctx.sessionKey,
      sessionId: params.ctx.sessionId,
      provider: runtimeConfig.provider,
      model: runtimeConfig.model,
      ...projectionRuntimeIdentity(params.runtime),
      startTimeMs: 1_000 + params.callIndex * 100,
      endTimeMs: 1_050 + params.callIndex * 100,
      durationMs: 50,
      usageSource: "provider",
      usage: diagnosticUsage(params.runtime, params.usage),
    },
    { modelContent: { outputMessages: params.outputMessages } },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LangfuseService tracer", () => {
  beforeEach(() => {
    startedServices = [];
    vi.clearAllMocks();
    sdkEvents.clear();
    diagnosticRuntime.listener = undefined;
    diagnosticRuntime.waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
    diagnosticRuntime.captureInternalDiagnosticDeliveryCursor.mockImplementation(
      (identity?: Record<string, unknown>) => ({
        ...identity,
        sequence: 0,
      }),
    );
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValue({
      ok: true,
      deliveredEvents: 0,
    });
    sessionTranscriptRuntime.entriesBySessionId.clear();
    sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries.mockImplementation(
      async ({ sessionId }: { sessionId: string }) =>
        sessionTranscriptRuntime.entriesBySessionId.get(sessionId) ?? [],
    );
    sessionStoreRuntime.resolveTranscriptSessionKeyBySessionId.mockReset();
    sessionStoreRuntime.resolveTranscriptSessionKeyBySessionId.mockReturnValue(undefined);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (typeof file === "string" && file.endsWith(".langfuse-markers.jsonl")) {
        const text = readLegacyLedgerMarkerFile(file);
        const encodingRequested =
          typeof options === "string" ||
          (typeof options === "object" && options !== null && "encoding" in options);
        return encodingRequested ? text : Buffer.from(text);
      }
      return originalReadFileSync(file, options as never) as never;
    });
    resetTraceLedgerStoreForTests();
  });

  afterEach(async () => {
    for (const service of startedServices.reverse()) {
      await service.stop?.(makeServiceCtx());
    }
    vi.useRealTimers();
    diagnosticRuntime.listener = undefined;
    vi.restoreAllMocks();
  });

  it("warns when gateway diagnostics are unavailable", async () => {
    const service = await startService(config, undefined, { internalDiagnostics: undefined });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("hooks.allowConversationAccess"),
    );
    await service.stop?.(makeServiceCtx({ internalDiagnostics: undefined }));
  });

  it("creates trace on before_agent_run", async () => {
    const service = await startService();
    const { beforeAgentRun } = service.getHookHandlers();

    beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);

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

  it("projects root input when llm_input has to materialize a fallback trace", async () => {
    const service = await startService();
    const { llmInput } = service.getHookHandlers();

    llmInput(
      {
        runId: "run-llm-input-fallback",
        sessionId: agentCtx.sessionId,
        provider: "openai",
        model: "clawos/gpt-5.6-sol",
        systemPrompt: "system context",
        prompt: "hello from fallback",
        historyMessages: [{ role: "assistant", content: "prior reply" }],
        imagesCount: 0,
      },
      agentCtx,
    );

    expect(mockLangfuseInstance.trace).toHaveBeenCalledOnce();
    expect(rootContextUpdate()).toMatchObject({ input: "hello from fallback" });
    const metadata = rootContextUpdate()?.metadata as Record<string, unknown>;
    expect(metadata.system_prompt).toBe("system context");
    expect(metadata.prior_conversation).toEqual([{ role: "assistant", content: "prior reply" }]);
  });

  it("fails open when before_agent_run tracing throws", async () => {
    const service = await startService();
    const { beforeAgentRun } = service.getHookHandlers();
    mockLangfuseInstance.trace.mockImplementationOnce(() => {
      throw new Error("trace creation failed");
    });

    expect(beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx)).toEqual({
      outcome: "pass",
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Langfuse: before_agent_run tracing failed open — Error: trace creation failed",
      ),
    );
  });

  it("reuses the recovery marker trace id after the SDK active-trace cap rejects start", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-root-cap-"));
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const service = await startService(config, undefined, { stateDir });
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const targetCtx = {
      ...agentCtx,
      agentId: "agent-root-cap-target",
      sessionKey: "agent:agent-root-cap-target:session-1",
      sessionId: "session-root-cap-target",
      runId: "run-root-cap-target",
    };

    try {
      sdkEvents.pauseFlushes();
      for (let index = 0; index < SDK_DELIVERY_MAX_ACTIVE_TRACES; index += 1) {
        beforeAgentRun(
          { prompt: `occupy ${index}`, messages: [] },
          {
            ...agentCtx,
            agentId: `agent-root-cap-${index}`,
            sessionKey: `agent:agent-root-cap-${index}:session-1`,
            sessionId: `session-root-cap-${index}`,
            runId: `run-root-cap-${index}`,
          },
        );
      }
      beforeAgentRun({ prompt: "target", messages: [] }, targetCtx);

      expect(mockLangfuseInstance.trace).toHaveBeenCalledTimes(SDK_DELIVERY_MAX_ACTIVE_TRACES);
      const markerFile = resolveMarkerFilePath(stateDir, targetCtx.agentId, targetCtx.sessionId);
      const markerTraceIds = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            (
              JSON.parse(line) as {
                data?: { traceId?: string };
              }
            ).data?.traceId,
        )
        .filter((traceId): traceId is string => Boolean(traceId));
      expect(markerTraceIds).toHaveLength(1);

      now += 6 * 60 * 1000;
      sdkEvents.resumeFlushes();
      sdkEvents.releaseAllFlushes();
      llmInput(
        {
          runId: targetCtx.runId,
          sessionId: targetCtx.sessionId,
          provider: "openai",
          model: "gpt-test",
          prompt: "target",
        },
        targetCtx,
      );

      expect(mockLangfuseInstance.trace).toHaveBeenCalledTimes(SDK_DELIVERY_MAX_ACTIVE_TRACES + 1);
      expect(mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id).toBe(markerTraceIds[0]);
      const allMarkerTraceIds = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            (
              JSON.parse(line) as {
                data?: { traceId?: string };
              }
            ).data?.traceId,
        )
        .filter((traceId): traceId is string => Boolean(traceId));
      expect(allMarkerTraceIds).toEqual(markerTraceIds);
    } finally {
      nowSpy.mockRestore();
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("flushes each bounded event separately for the self-hosted proxy", async () => {
    const service = await startService();

    expect(mockLangfuseConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ flushAt: 1, flushInterval: 1000 }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("captures the final diagnostic barrier by logical session identity", async () => {
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-session-barrier",
      sessionKey: "agent:agent-1:session-barrier",
      sessionId: "session-session-barrier",
    };
    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);

    await agentEnd(
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 1, output: 1, totalTokens: 2 },
          },
        ],
        success: true,
        durationMs: 10,
      },
      ctx,
    );

    expect(diagnosticRuntime.captureInternalDiagnosticDeliveryCursor).toHaveBeenCalledWith({
      runId: ctx.runId,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
    });
    await service.stop?.(makeServiceCtx());
  });

  it("drains legacy diagnostics by run id when session key is absent", async () => {
    const service = await startService(config, undefined, makeLegacyServiceCtxOverrides());
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-legacy-diagnostic-drain",
      sessionKey: undefined,
      sessionId: "session-legacy-diagnostic-drain",
    };
    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);

    diagnosticRuntime.listener?.({
      type: "model.call.started",
      runId: ctx.runId,
      callId: "legacy-provider-call",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "openai",
      model: "gpt-5.5",
      runtime: "openclaw",
      runtimeEngine: "embedded-agent-runner",
      transport: "auto",
      startTimeMs: 1_000,
    });
    await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());
    let diagnosticDrainCount = 0;
    diagnosticRuntime.waitForDiagnosticEventsDrained.mockImplementation(async () => {
      diagnosticDrainCount += 1;
      if (diagnosticDrainCount !== 2) {
        return;
      }
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        runId: ctx.runId,
        callId: "legacy-provider-call",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "openai",
        model: "gpt-5.5",
        runtime: "openclaw",
        runtimeEngine: "embedded-agent-runner",
        transport: "auto",
        startTimeMs: 1_000,
        endTimeMs: 1_050,
        usage: { input: 2, output: 1, total: 3 },
      });
    });

    await agentEnd(
      {
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            provider: "openai",
            model: "gpt-5.5",
            usage: { input: 2, output: 1, totalTokens: 3 },
          },
        ],
        success: true,
        durationMs: 10,
      },
      ctx,
    );

    expect(mockTrace.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          runtime: "openclaw",
          runtimeEngine: "embedded-agent-runner",
          runtimeTransport: "auto",
        }),
      }),
    );
    expect(mockGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        endTime: new Date(1_050),
        metadata: expect.objectContaining({
          runtime: "openclaw",
          runtimeEngine: "embedded-agent-runner",
          runtimeTransport: "auto",
        }),
      }),
    );
  });

  it("skips the end marker when the SDK flush callback reports ingestion failure", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-sdk-warning-"));
    try {
      const service = await startService(config, undefined, { stateDir });
      const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:sdk-warning",
        sessionId: "session-sdk-warning",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      sdkEvents.failNextFlush(new Error("ingestion rejected"));
      llmInput(
        {
          runId: "run-sdk-warning",
          sessionId: ctx.sessionId,
          provider: "openai",
          model: "gpt-5.5",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );

      await agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 0, output: 0, totalTokens: 0 },
            },
          ],
          success: true,
          durationMs: 10,
        },
        ctx,
      );

      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      const markerRaw = fs.readFileSync(markerPath, "utf8");
      expect(markerRaw).toContain("langfuse-trace-start");
      expect(markerRaw).not.toContain("langfuse-trace-end");
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("delivery failed"));
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("keeps transcript admission closed and retries agentEnd from the canonical snapshot", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-sdk-late-repair-"));
    let transcriptListener: TranscriptListener | undefined;
    try {
      const service = await startService(
        config,
        {
          events: {
            onSessionTranscriptUpdate: (listener: TranscriptListener) => {
              transcriptListener = listener;
              return vi.fn();
            },
          },
        },
        { stateDir },
      );
      const { beforeAgentRun, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:sdk-late-repair",
        sessionId: "session-sdk-late-repair",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;
      sdkEvents.failNextFlush(new Error("ingestion rejected"));

      await agentEnd(
        {
          messages: [{ role: "user", content: "hello" }],
          success: true,
          durationMs: 10,
        },
        ctx,
      );

      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");
      expect(mockTrace.generation).not.toHaveBeenCalled();

      const lateMessage = {
        role: "assistant",
        content: [{ type: "text", text: "late repair" }],
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: 2, output: 2, totalTokens: 4 },
        stopReason: "stop",
        metadata: { _langfuse: { traceId } },
      };
      setTranscriptRows(ctx.sessionId, [
        {
          id: "assistant-after-failed-delivery",
          timestamp: new Date().toISOString(),
          message: lateMessage,
        },
      ]);
      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-after-failed-delivery",
        message: lateMessage,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mockTrace.generation).not.toHaveBeenCalled();

      await agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "late repair" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 2, output: 2, totalTokens: 4 },
            },
          ],
          success: true,
          durationMs: 20,
        },
        ctx,
      );

      expect(mockTrace.generation).toHaveBeenCalledOnce();
      expect(fs.readFileSync(markerPath, "utf8")).toContain("langfuse-trace-end");
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("waits for an earlier automatic request after the final flush has returned", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-sdk-inflight-"));
    try {
      const service = await startService(config, undefined, { stateDir });
      const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:sdk-inflight",
        sessionId: "session-sdk-inflight",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      sdkEvents.pauseNextFlushes();
      llmInput(
        {
          runId: "run-sdk-inflight",
          sessionId: ctx.sessionId,
          provider: "openai",
          model: "gpt-5.5",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );

      let settled = false;
      const finalization = agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ],
          success: true,
          durationMs: 10,
        },
        ctx,
      ).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled());

      expect(settled).toBe(false);
      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");

      sdkEvents.releaseNextFlush();
      await finalization;

      expect(fs.readFileSync(markerPath, "utf8")).toContain("langfuse-trace-end");
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("returns after the delivery budget and writes the end marker after late SDK acceptance", async () => {
    vi.useFakeTimers();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-sdk-late-acceptance-"));
    try {
      const service = await startService(config, undefined, { stateDir });
      const { beforeAgentRun, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:sdk-late-acceptance",
        sessionId: "session-sdk-late-acceptance",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);

      sdkEvents.pauseNextFlushes();
      const finalization = agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ],
          success: true,
          durationMs: 10,
        },
        ctx,
      );
      await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(5_000);
      await finalization;

      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("continuing in background"),
      );

      sdkEvents.releaseNextFlush();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(fs.readFileSync(markerPath, "utf8")).toContain("langfuse-trace-end"),
      );
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("skips the end marker when enqueue processing errors without a flush", async () => {
    vi.useFakeTimers();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-sdk-enqueue-error-"));
    try {
      const service = await startService(config, undefined, { stateDir });
      const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:sdk-enqueue-error",
        sessionId: "session-sdk-enqueue-error",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      sdkEvents.pauseNextFlushes();
      llmInput(
        {
          runId: "run-sdk-enqueue-error",
          sessionId: ctx.sessionId,
          provider: "openai",
          model: "gpt-5.5",
          prompt: "hello",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );
      sdkEvents.emit("error", new Error("enqueue failed"));

      const finalization = agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ],
          success: true,
          durationMs: 10,
        },
        ctx,
      );
      await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_010);
      await finalization;

      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("continuing in background"),
      );

      await vi.advanceTimersByTimeAsync(60_010);
      await vi.waitFor(() =>
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("delivery timeout")),
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying final delivery once"),
      );
      expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
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

    service.getHookHandlers().beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);
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

    service.getHookHandlers().beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);
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

  it("marks a recent trace incomplete when its transcript queue drops an update", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-recent-queue-drop-"));
    const service = await startService(
      config,
      {
        events: {
          onSessionTranscriptUpdate: (listener: TranscriptListener) => {
            transcriptListener = listener;
            return vi.fn();
          },
        },
      },
      { stateDir },
    );
    try {
      const { beforeAgentRun, agentEnd } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:recent-queue-drop",
        sessionId: "session-recent-queue-drop",
      };
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-oversized-recent-update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("transcript queue limit reached"),
      );
      expect(
        sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries,
      ).not.toHaveBeenCalled();
      sdkEvents.failNextFlush(new Error("ingestion rejected"));
      mockLangfuseInstance.flush();
      await agentEnd(
        {
          messages: [{ role: "user", content: "hello" }],
          success: true,
          durationMs: 10,
        },
        ctx,
      );

      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");
      expect(
        mockTrace.update.mock.calls.some((call: unknown[]) =>
          JSON.stringify(call[0]).includes("transcript_queue_drop"),
        ),
      ).toBe(true);
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("attributes a dropped transcript update to its persisted trace instead of the active turn", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-owned-queue-drop-"));
    const service = await startService(
      config,
      {
        events: {
          onSessionTranscriptUpdate: (listener: TranscriptListener) => {
            transcriptListener = listener;
            return vi.fn();
          },
        },
      },
      { stateDir },
    );
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const sessionKey = "agent:agent-1:owned-queue-drop";
    const previousCtx = {
      ...agentCtx,
      runId: "run-owned-queue-drop-previous",
      sessionKey,
      sessionId: "session-owned-queue-drop-previous",
    };
    const activeCtx = {
      ...agentCtx,
      runId: "run-owned-queue-drop-active",
      sessionKey,
      sessionId: "session-owned-queue-drop-active",
    };

    try {
      beforeAgentRun({ prompt: "previous", messages: [] }, previousCtx);
      const previousTraceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;
      sdkEvents.failNextFlush(new Error("ingestion rejected"));
      mockLangfuseInstance.flush();
      await agentEnd(
        {
          messages: [
            { role: "user", content: "previous" },
            {
              role: "assistant",
              content: [{ type: "text", text: "previous done" }],
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ],
          success: true,
          durationMs: 10,
        },
        previousCtx,
      );

      beforeAgentRun({ prompt: "active", messages: [] }, activeCtx);
      transcriptListener?.({
        target: transcriptTarget(previousCtx),
        messageId: "assistant-owned-oversized-update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          metadata: { _langfuse: { traceId: previousTraceId } },
        },
      });

      await agentEnd(
        {
          messages: [{ role: "user", content: "active" }],
          success: true,
          durationMs: 10,
        },
        activeCtx,
      );

      const activeMarkerPath = resolveMarkerFilePath(
        stateDir,
        activeCtx.agentId,
        activeCtx.sessionId,
      );
      await vi.waitFor(
        () => expect(fs.readFileSync(activeMarkerPath, "utf8")).toContain("langfuse-trace-end"),
        { timeout: 15_000 },
      );
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("bounds a large final trace update below the self-hosted proxy limit", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const largeText = "x".repeat(300 * 1024);
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:large-trace-update",
      sessionId: "session-large-trace-update",
    };
    beforeAgentRun({ prompt: largeText, messages: [] }, ctx);
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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:provider-usage",
      sessionId: "session-provider-usage",
    };
    beforeAgentRun({ prompt: "run tools", messages: [] }, ctx);

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

  it("does not duplicate a diagnostic-owned generation when llmInput arrives later", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-diagnostic-first",
      sessionKey: "agent:agent-1:diagnostic-first",
      sessionId: "session-diagnostic-first",
    };
    beforeAgentRun({ prompt: "run a tool", messages: [] }, ctx);

    diagnosticRuntime.listener?.({
      type: "model.call.started",
      runId: ctx.runId,
      callId: "diagnostic-call-1",
      providerRequestIndex: 1,
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "codex",
      model: "baidu/deepseek-v4-pro",
      startTimeMs: 1_000,
    });
    await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());

    llmInput(
      {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        provider: "codex",
        model: "baidu/deepseek-v4-pro",
        prompt: "run a tool",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );

    expect(mockTrace.generation).toHaveBeenCalledOnce();
    expect(mockTrace.generation.mock.calls[0]?.[0]).toMatchObject({
      id: expect.stringMatching(/-gen-1$/),
      name: "llm-call-1",
    });
    await service.stop?.(makeServiceCtx());
  });

  it("finalizes OpenClaw-native per-call diagnostics without transcript gap fill", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-native-realtime",
      sessionKey: "agent:agent-1:native-realtime",
      sessionId: "session-native-realtime",
    };
    beforeAgentRun({ prompt: "run a tool", messages: [] }, ctx);
    llmInput(
      {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        prompt: "run a tool",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );

    for (const [index, usage] of [
      { input: 100, output: 10, cacheRead: 20, total: 130 },
      { input: 120, output: 15, cacheRead: 30, total: 165 },
    ].entries()) {
      const callId = `native-call-${index + 1}`;
      diagnosticRuntime.listener?.({
        type: "model.call.started",
        runId: ctx.runId,
        callId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        startTimeMs: 1_000 + index * 100,
      });
      if (index === 1) {
        await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledTimes(2));
      }
      diagnosticRuntime.listener?.({
        type: "model.call.completed",
        runId: ctx.runId,
        callId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        startTimeMs: 1_000 + index * 100,
        endTimeMs: 1_050 + index * 100,
        durationMs: 50,
        usageSource: "provider",
        usage,
      });
    }

    expect(mockTrace.generation).toHaveBeenCalledTimes(2);
    await agentEnd(
      {
        messages: [
          { role: "user", content: "run a tool" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "exec", arguments: {} }],
            provider: "clawos",
            model: "gpt-5.6-sol",
            usage: { input: 100, output: 10, cacheRead: 20, totalTokens: 130 },
          },
          { role: "toolResult", toolCallId: "tool-1", content: "done" },
          {
            role: "assistant",
            content: [{ type: "text", text: "finished" }],
            provider: "clawos",
            model: "gpt-5.6-sol",
            usage: { input: 120, output: 15, cacheRead: 30, totalTokens: 165 },
          },
        ],
        success: true,
        durationMs: 200,
      },
      ctx,
    );

    expect(mockTrace.generation).toHaveBeenCalledTimes(2);
    expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining("gap fill"));
    expect(mockTrace.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          stats: expect.objectContaining({ llmCallCount: 2 }),
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

  it("keeps native hook history out of provider-request generation updates", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-native-provider-delta",
      sessionKey: "agent:agent-1:native-provider-delta",
      sessionId: "session-native-provider-delta",
    };
    beforeAgentRun(
      {
        prompt: "current request",
        messages: [],
        priorMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      },
      ctx,
    );
    llmInput(
      {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        prompt: "current request",
        historyMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
        imagesCount: 0,
      },
      ctx,
    );

    diagnosticRuntime.listener?.(
      {
        type: "model.call.started",
        runId: ctx.runId,
        callId: "native-provider-call-1",
        scope: "provider-request",
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        startTimeMs: 1_000,
      },
      {
        modelContent: {
          systemPrompt: "system instructions",
          inputMessages: [
            { role: "user", content: "[timestamp] old question" },
            { role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
            { role: "user", content: "[timestamp] current request" },
          ],
          toolDefinitions: [{ type: "function", name: "exec" }],
        },
      },
    );

    await vi.waitFor(() =>
      expect(mockGeneration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            model: "gpt-5.6-sol",
            messages: [{ role: "user", content: "current request" }],
          },
        }),
      ),
    );
    expect(mockTrace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          prior_conversation: [
            { role: "user", content: "old question" },
            { role: "assistant", content: "old answer" },
          ],
        }),
      }),
    );
    await service.stop?.(makeServiceCtx());
  });

  it("rejects provider diagnostics after terminal admission closes", async () => {
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-late-provider-completion",
      sessionKey: "agent:agent-1:late-provider-completion",
      sessionId: "session-late-provider-completion",
    };
    beforeAgentRun({ prompt: "run tools", messages: [] }, ctx);

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
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValueOnce({
      ok: false,
      reason: "producer_incomplete",
      deliveredEvents: 3,
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
    const traceUpdateCountAfterAgentEnd = mockTrace.update.mock.calls.length;

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

    expect(mockTrace.update).toHaveBeenCalledTimes(traceUpdateCountAfterAgentEnd);
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
    await service.stop?.(makeServiceCtx());
  });

  it("falls back to turn usage when provider-request usage coverage is incomplete", async () => {
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:partial-provider-usage",
      sessionId: "session-partial-provider-usage",
    };
    beforeAgentRun({ prompt: "run tools", messages: [] }, ctx);

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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:late-provider-usage",
      sessionId: "session-late-provider-usage",
    };
    beforeAgentRun({ prompt: "run tools", messages: [] }, ctx);

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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:late-finalized-usage",
      sessionId: "session-late-finalized-usage",
    };
    beforeAgentRun({ prompt: "continue", messages: [] }, ctx);

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
    const { beforeAgentRun } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:legacy-transcript-update",
      sessionId: "session-legacy-transcript-update",
    };
    beforeAgentRun({ prompt: "continue", messages: [] }, ctx);

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
    const { beforeAgentRun, llmInput } = service.getHookHandlers();

    beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);
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
    const { beforePromptBuild, beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-prompt-link" };

    beforePromptBuild({ prompt: "hello", messages: [] }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
    const { beforeAgentRun, llmInput } = secondService.getHookHandlers();
    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx2 = { ...agentCtx, sessionKey: "session-key-incr" };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx2);
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

    // Generation and root trace expose the reply as soon as llmOutput fires.
    const genClient =
      mockTrace.generation.mock.results[mockTrace.generation.mock.results.length - 1].value;
    expect(genClient.update).toHaveBeenCalledOnce();
    const updateArgs = genClient.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("The answer is 4.");
    expect(mockTrace.update).toHaveBeenCalledWith({ output: "The answer is 4." });

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

  it("preserves non-Codex cache and canonical cost details during finalization", () => {
    const generation = { update: vi.fn(), end: vi.fn() };
    const entry = {
      trace: mockTrace,
      traceId: "trace-anthropic-cache",
      llmCallCount: 1,
      toolCallCount: 0,
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: 1_000,
      timestamp: 1_000,
    } as unknown as TraceContextEntry;
    const turnEntries = [
      { timestamp: 2_000, message: { role: "user", content: "hello" } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "anthropic",
          model: "claude-sonnet-4.6",
          stopReason: "stop",
          usage: {
            input: 3,
            output: 93,
            cacheRead: 45065,
            cacheWrite: 148,
            totalTokens: 45309,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          },
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

    expect(generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        usageDetails: {
          input: 3,
          output: 93,
          cache_read_input_tokens: 45065,
          cache_creation_input_tokens: 148,
          total: 45309,
        },
        costDetails: { input: 0.001, output: 0.002, total: 0.003 },
      }),
    );
  });

  it("adds provider generation cost only with exact canonical slot correlation", () => {
    const generation = { update: vi.fn(), end: vi.fn() };
    const entry = {
      trace: mockTrace,
      traceId: "trace-provider-cost",
      llmCallCount: 1,
      toolCallCount: 0,
      hasProviderRequestGenerations: true,
      providerRequestGenerationIndexes: new Map([["provider-call-1", 1]]),
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: 1_000,
      timestamp: 1_000,
    } as unknown as TraceContextEntry;
    const turnEntries = [
      { timestamp: 2_000, message: { role: "user", content: "hello" } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          usage: { cost: { input: 0.01, output: 0.02, total: 0.03 } },
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

    expect(generation.update).toHaveBeenCalledOnce();
    expect(generation.update).toHaveBeenCalledWith({
      costDetails: { input: 0.01, output: 0.02, total: 0.03 },
    });
  });

  it("omits provider generation cost when canonical slot correlation is incomplete", () => {
    const generation = { update: vi.fn(), end: vi.fn() };
    const entry = {
      trace: mockTrace,
      traceId: "trace-provider-cost-mismatch",
      llmCallCount: 2,
      toolCallCount: 0,
      hasProviderRequestGenerations: true,
      providerRequestGenerationIndexes: new Map([["provider-call-2", 2]]),
      pendingGenerations: new Map(),
      pendingGenIds: new Map(),
      completedGenerations: new Map([[1, generation]]),
      pendingSpans: new Map(),
      completedSpanToolCallIds: new Set(),
      createdAt: 1_000,
      timestamp: 1_000,
    } as unknown as TraceContextEntry;
    const turnEntries = [
      { timestamp: 2_000, message: { role: "user", content: "hello" } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          usage: { cost: { input: 0.01, output: 0.02, total: 0.03 } },
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
    const { beforeAgentRun, llmInput, llmOutput } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:provider-aggregate-race",
    };

    beforeAgentRun({ prompt: "use tools", messages: [] }, ctx);
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
    const { beforeAgentRun, llmInput, beforeToolCall, afterToolCall } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "agent:agent-1:codex-tool-parent" };

    beforeAgentRun({ prompt: "use a tool", messages: [] }, ctx);
    llmInput(
      {
        runId: "turn-run",
        sessionId: ctx.sessionId,
        provider: "ClawOS",
        model: "baidu/glm-5.2",
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
        prompt: "use a tool",
        historyMessages: [],
        imagesCount: 0,
      },
      ctx,
    );
    expect(mockTrace.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          provider: "ClawOS",
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          runtimeTransport: "stdio",
        }),
      }),
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
      provider: "ClawOS",
      model: "glm-5.2",
      runtime: "codex",
      runtimeEngine: "codex-app-server",
      transport: "stdio",
      startTimeMs: 1_000,
    });
    diagnosticRuntime.listener?.({
      type: "model.call.completed",
      runId: "turn-run",
      callId: "provider-call-1",
      scope: "provider-request",
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      provider: "ClawOS",
      model: "glm-5.2",
      runtime: "codex",
      runtimeEngine: "codex-app-server",
      transport: "stdio",
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
    const { beforeAgentRun, llmInput, beforeToolCall, afterToolCall } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "agent:agent-1:anthropic-provider-diagnostics",
      sessionId: "session-anthropic-provider-diagnostics",
    };

    beforeAgentRun({ prompt: "use a tool", messages: [] }, ctx);
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

  it("finalizes after a fallback tool span supersedes a rejected live span", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-tool-fallback-delivery-"));
    const service = await startService(config, undefined, { stateDir });
    const { beforeAgentRun, beforeToolCall, afterToolCall, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      agentId: "agent-tool-fallback-delivery",
      sessionKey: "agent:agent-tool-fallback-delivery:session-1",
      sessionId: "session-tool-fallback-delivery",
    };

    try {
      sdkEvents.pauseFlushes();
      beforeAgentRun({ prompt: "use tools", messages: [] }, ctx);
      for (let index = 0; index < SDK_DELIVERY_MAX_TICKETS_PER_TRACE - 2; index += 1) {
        const toolCallId = `capacity-tool-${index}`;
        beforeToolCall(
          { toolName: "read", params: { index }, toolCallId },
          { ...toolCtx, sessionKey: ctx.sessionKey, toolName: "read", toolCallId },
        );
      }
      const rejectedToolCallId = "rejected-tool";
      beforeToolCall(
        { toolName: "read", params: { target: true }, toolCallId: rejectedToolCallId },
        {
          ...toolCtx,
          sessionKey: ctx.sessionKey,
          toolName: "read",
          toolCallId: rejectedToolCallId,
        },
      );
      expect(mockTrace.span).toHaveBeenCalledTimes(SDK_DELIVERY_MAX_TICKETS_PER_TRACE - 2);

      sdkEvents.resumeFlushes();
      sdkEvents.releaseAllFlushes();
      afterToolCall(
        {
          toolName: "read",
          params: { target: true },
          toolCallId: rejectedToolCallId,
          result: "done",
        },
        {
          ...toolCtx,
          sessionKey: ctx.sessionKey,
          toolName: "read",
          toolCallId: rejectedToolCallId,
        },
      );
      expect(mockTrace.span).toHaveBeenCalledTimes(SDK_DELIVERY_MAX_TICKETS_PER_TRACE - 1);

      await agentEnd(
        {
          messages: [
            { role: "user", content: "use tools", timestamp: 1 },
            { role: "assistant", content: "done", timestamp: 2 },
          ],
          success: true,
        },
        ctx,
      );

      expect(
        fs.readFileSync(resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId), "utf8"),
      ).toContain("langfuse-trace-end");
    } finally {
      await service.stop?.(makeServiceCtx({ stateDir }));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not schedule a redundant live debounce flush from llmInput", async () => {
    vi.useFakeTimers();
    const service = await startService();
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx2 = { ...agentCtx, sessionKey: "session-key-nonblocking-flush" };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx2);
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
    expect(mockLangfuseInstance.flushAsync).not.toHaveBeenCalled();
  });

  it("agentEnd keeps tool calls in generation output without creating tool spans", async () => {
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx3 = { ...agentCtx, sessionKey: "session-key-toolspan" };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx3);
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

    // Recovery creates two generations and a first-class tool span.
    const genCalls = mockTrace.generation.mock.calls.filter((c: unknown[]) =>
      (c[0] as Record<string, unknown>).name?.toString().startsWith("llm-call-"),
    );
    expect(genCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockTrace.span).toHaveBeenCalledTimes(1);
  });

  it("finalizes trace on agent_end with structured metadata", async () => {
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();

    beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);
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

    expect(mockTrace.update).toHaveBeenCalledTimes(2);
    const updateArgs = mockTrace.update.mock.calls.at(-1)?.[0];
    expect(updateArgs.output).toBe("The answer is 4.");
    expect(updateArgs.metadata.stats.success).toBe(true);
    expect(updateArgs.metadata.stats.llmCallCount).toBe(1);
  });

  it("full multi-turn sequence with tools", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, beforeToolCall, afterToolCall, agentEnd } =
      service.getHookHandlers();

    beforeAgentRun({ prompt: "Do some work", messages: [] }, agentCtx);

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

    // Root output is visible after each llm_output, then agent_end publishes the
    // canonical transcript-backed value with final statistics.
    expect(mockTrace.update).toHaveBeenCalledTimes(4);
    expect(mockTrace.update.mock.calls[1]?.[0]).toMatchObject({ output: "ok1" });
    expect(mockTrace.update.mock.calls[2]?.[0]).toMatchObject({ output: "final answer" });
    const updateArgs = mockTrace.update.mock.calls.at(-1)?.[0];
    expect(updateArgs.output).toBe("final answer");
    expect(updateArgs.metadata.stats.llmCallCount).toBe(2);
    expect(updateArgs.metadata.stats.toolCallCount).toBe(1);
  });

  describe("release-critical runtime projection matrix", () => {
    it.each(["openclaw", "codex"] as const)(
      "projects successful-tool-loop exactly for %s",
      async (runtime) => {
        const service = await startService();
        const { beforeAgentRun, llmInput, beforeToolCall, afterToolCall, agentEnd } =
          service.getHookHandlers();
        const ctx = projectionContext(runtime, "successful-tool-loop");
        const runtimeConfig = projectionRuntime(runtime);
        const fixture = runtimeProjectionMatrix.successfulToolLoop;
        const firstMessages = [
          ...runtimeProjectionMatrix.context.priorMessages,
          { role: "user", content: runtimeProjectionMatrix.context.prompt },
        ];

        beforeAgentRun(
          {
            prompt: runtimeProjectionMatrix.context.prompt,
            messages: [],
            systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
            priorMessages: runtimeProjectionMatrix.context.priorMessages,
          },
          ctx,
        );
        if (runtime === "openclaw") {
          llmInput(
            {
              runId: ctx.runId,
              sessionId: ctx.sessionId,
              provider: runtimeConfig.provider,
              model: runtimeConfig.model,
              prompt: runtimeProjectionMatrix.context.prompt,
              historyMessages: runtimeProjectionMatrix.context.priorMessages,
              imagesCount: 0,
            },
            ctx,
          );
        }

        emitMatrixModelStart({ runtime, ctx, callIndex: 1, inputMessages: firstMessages });
        emitMatrixModelTerminal({
          runtime,
          ctx,
          callIndex: 1,
          outputMessages: [fixture.firstOutput],
          usage: runtime === "codex" ? fixture.codexUsage[0] : fixture.openclawUsage[0],
        });
        await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());

        if (runtime === "codex") {
          diagnosticRuntime.listener?.(
            {
              type: "tool.execution.started",
              runId: ctx.runId,
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              toolName: "lookup",
              toolOwner: "codex-rollout-trace",
              toolCallId: "matrix-tool-1",
              startTimeMs: 1_175,
            },
            { toolContent: { toolInput: fixture.toolInput } },
          );
          diagnosticRuntime.listener?.(
            {
              type: "tool.execution.completed",
              runId: ctx.runId,
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              toolName: "lookup",
              toolOwner: "codex-rollout-trace",
              toolCallId: "matrix-tool-1",
              endTimeMs: 1_225,
              durationMs: 50,
            },
            { toolContent: { toolOutput: fixture.toolOutput } },
          );
        } else {
          const matrixToolCtx = {
            ...toolCtx,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            toolName: "lookup",
            toolCallId: "matrix-tool-1",
          };
          beforeToolCall(
            {
              toolName: "lookup",
              toolCallId: "matrix-tool-1",
              params: fixture.toolInput,
            },
            matrixToolCtx,
          );
          afterToolCall(
            {
              toolName: "lookup",
              toolCallId: "matrix-tool-1",
              params: fixture.toolInput,
              result: fixture.toolOutput,
              durationMs: 50,
            },
            matrixToolCtx,
          );
        }

        emitMatrixModelStart({
          runtime,
          ctx,
          callIndex: 2,
          inputMessages: [...firstMessages, fixture.firstOutput, fixture.toolResult],
        });
        emitMatrixModelTerminal({
          runtime,
          ctx,
          callIndex: 2,
          outputMessages: [
            {
              role: "assistant",
              content: [{ type: "output_text", text: fixture.finalOutput }],
            },
          ],
          usage: runtime === "codex" ? fixture.codexUsage[1] : fixture.openclawUsage[1],
        });
        await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledTimes(2));

        const canonicalUsage = runtime === "codex" ? fixture.codexUsage : fixture.openclawUsage;
        await agentEnd(
          {
            messages: [
              { role: "user", content: runtimeProjectionMatrix.context.prompt },
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "matrix-tool-1",
                    name: "lookup",
                    arguments: fixture.toolInput,
                  },
                ],
                provider: runtimeConfig.provider,
                model: runtimeConfig.model,
                usage: {
                  ...canonicalUsage[0],
                  totalTokens: canonicalUsage[0].total,
                  cost: { input: 0.001, output: 0.002, total: 0.003 },
                },
              },
              {
                role: "toolResult",
                toolCallId: "matrix-tool-1",
                toolName: "lookup",
                content: JSON.stringify(fixture.toolOutput),
              },
              {
                role: "assistant",
                content: [{ type: "text", text: fixture.finalOutput }],
                provider: runtimeConfig.provider,
                model: runtimeConfig.model,
                usage: {
                  ...canonicalUsage[1],
                  totalTokens: canonicalUsage[1].total,
                  cost: { input: 0.004, output: 0.005, total: 0.009 },
                },
              },
            ],
            success: true,
            durationMs: 300,
          },
          ctx,
        );

        expect(rootContextUpdate()).toMatchObject({
          input: runtimeProjectionMatrix.context.prompt,
          metadata: {
            system_prompt: runtimeProjectionMatrix.context.systemPrompt,
            prior_conversation: runtimeProjectionMatrix.context.priorMessages,
          },
        });
        expect(mockTrace.generation.mock.calls.map((call) => call[0]?.input)).toEqual([
          {
            model: runtimeConfig.model,
            messages: [{ role: "user", content: runtimeProjectionMatrix.context.prompt }],
          },
          {
            model: runtimeConfig.model,
            messages: [fixture.firstOutput, fixture.toolResult],
          },
        ]);
        const runtimeGenerationUpdates = mockGeneration.update.mock.calls
          .map((call) => call[0] as Record<string, unknown>)
          .filter((update) => {
            const metadata = update.metadata as Record<string, unknown> | undefined;
            return update.endTime !== undefined && metadata?.runtime === runtime;
          });
        expect(runtimeGenerationUpdates.length).toBeGreaterThanOrEqual(2);
        for (const update of runtimeGenerationUpdates) {
          expect(update.metadata).toMatchObject({
            runtime,
            runtimeEngine: runtime === "codex" ? "codex-app-server" : "embedded-agent-runner",
            runtimeTransport: runtime === "codex" ? "stdio" : "http",
          });
        }
        const spanCreates = [
          ...mockTrace.span.mock.calls.map((call) => call[0]),
          ...mockGeneration.span.mock.calls.map((call) => call[0]),
        ];
        expect(spanCreates).toHaveLength(1);
        expect(spanCreates[0]).toMatchObject({
          name: "tool:lookup",
          input: fixture.toolInput,
          metadata: expect.objectContaining({ toolCallId: "matrix-tool-1" }),
        });
        expect(mockSpan.update).toHaveBeenCalledWith(
          expect.objectContaining({ output: fixture.toolOutput }),
        );
        const usageUpdates = mockGeneration.update.mock.calls
          .map((call) => call[0] as Record<string, unknown>)
          .filter((update) => update.usageDetails);
        expect(usageUpdates).toHaveLength(2);
        if (runtime === "codex") {
          expect(usageUpdates[0]?.usageDetails).toEqual({
            input: 60,
            output: 12,
            cache_read_input_tokens: 20,
            total: 92,
          });
          expect(JSON.stringify(usageUpdates)).not.toContain("cache_creation_input_tokens");
        } else {
          expect(usageUpdates[0]?.usageDetails).toEqual({
            input: 80,
            output: 12,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
            total: 117,
          });
          expect(mockGeneration.update).toHaveBeenCalledWith(
            expect.objectContaining({
              costDetails: { input: 0.004, output: 0.005, total: 0.009 },
            }),
          );
        }
        expect(finalTraceUpdate()).toMatchObject({
          output: fixture.finalOutput,
          metadata: {
            system_prompt: runtimeProjectionMatrix.context.systemPrompt,
            prior_conversation: runtimeProjectionMatrix.context.priorMessages,
            prior_conversation_bytes: Buffer.byteLength(
              JSON.stringify(runtimeProjectionMatrix.context.priorMessages),
              "utf8",
            ),
            prior_conversation_truncated: false,
            prior_conversation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            prior_conversation_message_count: runtimeProjectionMatrix.context.priorMessages.length,
            prior_conversation_retained_message_count:
              runtimeProjectionMatrix.context.priorMessages.length,
            stats: {
              success: true,
              llmCallCount: 2,
              toolCallCount: 1,
            },
          },
        });
      },
    );

    it.each(["openclaw", "codex"] as const)(
      "projects failed-turn-with-partial-output exactly for %s",
      async (runtime) => {
        const service = await startService();
        const { beforeAgentRun, agentEnd } = service.getHookHandlers();
        const ctx = projectionContext(runtime, "failed-partial");
        const runtimeConfig = projectionRuntime(runtime);

        beforeAgentRun(
          {
            prompt: runtimeProjectionMatrix.context.prompt,
            messages: [],
            systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
            priorMessages: runtimeProjectionMatrix.context.priorMessages,
          },
          ctx,
        );
        await agentEnd(
          {
            messages: [
              { role: "user", content: runtimeProjectionMatrix.context.prompt },
              {
                role: "assistant",
                content: [{ type: "text", text: runtimeProjectionMatrix.failedTurn.partialOutput }],
                provider: runtimeConfig.provider,
                model: runtimeConfig.model,
              },
            ],
            success: false,
            error: runtimeProjectionMatrix.failedTurn.error,
            durationMs: 50,
          },
          ctx,
        );

        expect(finalTraceUpdate()).toMatchObject({
          output: runtimeProjectionMatrix.failedTurn.partialOutput,
          metadata: {
            stats: {
              success: false,
              llmCallCount: 1,
              toolCallCount: 0,
            },
          },
        });
        expect(finalTraceUpdate()?.output).not.toContain(runtimeProjectionMatrix.failedTurn.error);
      },
    );

    it.each(["openclaw", "codex"] as const)(
      "projects failed-turn-without-output exactly for %s",
      async (runtime) => {
        const service = await startService();
        const { beforeAgentRun, agentEnd } = service.getHookHandlers();
        const ctx = projectionContext(runtime, "failed-without-output");

        beforeAgentRun(
          {
            prompt: runtimeProjectionMatrix.context.prompt,
            messages: [],
            systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
            priorMessages: runtimeProjectionMatrix.context.priorMessages,
          },
          ctx,
        );
        await agentEnd(
          {
            messages: [{ role: "user", content: runtimeProjectionMatrix.context.prompt }],
            success: false,
            error: runtimeProjectionMatrix.failedTurn.error,
            durationMs: 50,
          },
          ctx,
        );

        const finalUpdate = finalTraceUpdate();
        expect(finalUpdate).toBeDefined();
        expect(finalUpdate).not.toHaveProperty("output");
        expect(finalUpdate).toMatchObject({
          statusMessage: runtimeProjectionMatrix.failedTurn.error,
          level: "ERROR",
          metadata: {
            stats: {
              success: false,
              llmCallCount: 0,
              toolCallCount: 0,
            },
          },
        });
      },
    );

    it.each(["openclaw", "codex"] as const)(
      "projects reply-budget-timeout-and-completion exactly for %s",
      async (runtime) => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `langfuse-matrix-${runtime}-`));
        try {
          const service = await startService(config, undefined, { stateDir });
          const { beforeAgentRun, agentEnd } = service.getHookHandlers();
          const ctx = projectionContext(runtime, "reply-budget-timeout");
          const runtimeConfig = projectionRuntime(runtime);

          beforeAgentRun(
            {
              prompt: runtimeProjectionMatrix.context.prompt,
              messages: [],
              systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
              priorMessages: runtimeProjectionMatrix.context.priorMessages,
            },
            ctx,
          );
          sdkEvents.pauseNextFlushes();
          const finalization = agentEnd(
            {
              messages: [
                { role: "user", content: runtimeProjectionMatrix.context.prompt },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
                    },
                  ],
                  provider: runtimeConfig.provider,
                  model: runtimeConfig.model,
                },
              ],
              success: true,
              durationMs: 50,
            },
            ctx,
          );
          await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce());
          await finalization;

          const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
          expect(finalTraceUpdate()).toMatchObject({
            output: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
          });
          expect(fs.readFileSync(markerPath, "utf8")).not.toContain("langfuse-trace-end");
          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("continuing in background"),
          );

          sdkEvents.releaseNextFlush();
          await vi.waitFor(() =>
            expect(fs.readFileSync(markerPath, "utf8")).toContain("langfuse-trace-end"),
          );
          expect(
            fs
              .readFileSync(markerPath, "utf8")
              .split("\n")
              .filter((line) => line.includes("langfuse-trace-end")),
          ).toHaveLength(1);
        } finally {
          fs.rmSync(stateDir, { force: true, recursive: true });
        }
      },
    );

    it.each(["openclaw", "codex"] as const)(
      "projects oversized-redacted-context exactly for %s",
      async (runtime) => {
        const redactedConfig: LangfusePluginConfig = {
          ...config,
          tracing: { ...config.tracing, redact: true },
        };
        const service = await startService(redactedConfig);
        const { beforeAgentRun, llmInput } = service.getHookHandlers();
        const ctx = projectionContext(runtime, "oversized-redacted-context");
        const runtimeConfig = projectionRuntime(runtime);
        const oversized = runtimeProjectionMatrix.oversizedRedactedContext;
        const priorMessages = Array.from({ length: oversized.messageCount }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${oversized.secret}:${index}:${"x".repeat(oversized.messageSize)}`,
        }));
        const systemPrompt = `${oversized.secret}:${"s".repeat(120 * 1024)}`;

        beforeAgentRun(
          {
            prompt: runtimeProjectionMatrix.context.prompt,
            messages: [],
            systemPrompt,
            priorMessages,
          },
          ctx,
        );
        if (runtime === "openclaw") {
          llmInput(
            {
              runId: ctx.runId,
              sessionId: ctx.sessionId,
              provider: runtimeConfig.provider,
              model: runtimeConfig.model,
              prompt: runtimeProjectionMatrix.context.prompt,
              historyMessages: priorMessages,
              imagesCount: 0,
            },
            ctx,
          );
        } else {
          emitMatrixModelStart({
            runtime,
            ctx,
            callIndex: 1,
            inputMessages: [
              ...priorMessages,
              { role: "user", content: runtimeProjectionMatrix.context.prompt },
            ],
          });
          await vi.waitFor(() => expect(mockTrace.generation).toHaveBeenCalledOnce());
        }

        const rootUpdate = rootContextUpdate();
        const metadata = rootUpdate?.metadata as Record<string, unknown>;
        expect(rootUpdate?.input).toBe("[REDACTED]");
        expect(metadata.system_prompt).toBe("[REDACTED]");
        expect(metadata.system_prompt_truncated).toBe(false);
        expect(metadata.prior_conversation_truncated).toBe(false);
        expect(metadata.prior_conversation_message_count).toBe(oversized.messageCount);
        expect(metadata.prior_conversation).toEqual([]);
        expect(metadata.prior_conversation_retained_message_count).toBe(0);
        expect(JSON.stringify(rootUpdate)).not.toContain(oversized.secret);
        expect(JSON.stringify(mockTrace.generation.mock.calls)).not.toContain(oversized.secret);
        expect(mockTrace.generation.mock.calls[0]?.[0]?.input).toEqual({
          model: runtimeConfig.model,
          messages: "[REDACTED]",
        });
      },
    );

    it.each(["openclaw", "codex"] as const)(
      "projects duplicate-out-of-order-terminals exactly for %s",
      async (runtime) => {
        const service = await startService();
        const { beforeAgentRun, beforeToolCall, afterToolCall, agentEnd } =
          service.getHookHandlers();
        const ctx = projectionContext(runtime, "duplicate-out-of-order");
        const runtimeConfig = projectionRuntime(runtime);
        const terminal = {
          type: "model.call.completed" as const,
          runId: ctx.runId,
          callId: `${ctx.runId}-terminal-first`,
          providerRequestIndex: 1,
          ...(runtime === "codex" ? { scope: "provider-request" } : {}),
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          provider: runtimeConfig.provider,
          model: runtimeConfig.model,
          endTimeMs: 2_000,
          durationMs: 1_000,
          usageSource: "provider",
          usage: diagnosticUsage(runtime, {
            input: 0,
            output: 0,
            cacheRead: 0,
            total: 0,
          }),
        };

        beforeAgentRun(
          {
            prompt: runtimeProjectionMatrix.context.prompt,
            messages: [],
            systemPrompt: runtimeProjectionMatrix.context.systemPrompt,
            priorMessages: runtimeProjectionMatrix.context.priorMessages,
          },
          ctx,
        );
        diagnosticRuntime.listener?.(terminal, {
          modelContent: {
            outputMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
                  },
                ],
              },
            ],
          },
        });
        diagnosticRuntime.listener?.(terminal, {
          modelContent: {
            outputMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
                  },
                ],
              },
            ],
          },
        });
        diagnosticRuntime.listener?.(
          {
            type: "model.call.started",
            runId: ctx.runId,
            callId: terminal.callId,
            providerRequestIndex: 1,
            ...(runtime === "codex" ? { scope: "provider-request" } : {}),
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            provider: runtimeConfig.provider,
            model: runtimeConfig.model,
            requestForm: "full",
            startTimeMs: 900,
          },
          {
            modelContent: {
              inputMessages: [{ role: "user", content: runtimeProjectionMatrix.context.prompt }],
            },
          },
        );

        if (runtime === "codex") {
          const toolTerminal = {
            type: "tool.execution.completed" as const,
            runId: ctx.runId,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            toolName: "lookup",
            toolOwner: "codex-rollout-trace",
            toolCallId: "matrix-terminal-tool",
            endTimeMs: 2_100,
            durationMs: 100,
          };
          diagnosticRuntime.listener?.(toolTerminal, {
            toolContent: { toolOutput: runtimeProjectionMatrix.successfulToolLoop.toolOutput },
          });
          diagnosticRuntime.listener?.(toolTerminal, {
            toolContent: { toolOutput: runtimeProjectionMatrix.successfulToolLoop.toolOutput },
          });
          diagnosticRuntime.listener?.(
            {
              type: "tool.execution.started",
              runId: ctx.runId,
              sessionKey: ctx.sessionKey,
              sessionId: ctx.sessionId,
              toolName: "lookup",
              toolOwner: "codex-rollout-trace",
              toolCallId: "matrix-terminal-tool",
              startTimeMs: 1_950,
            },
            {
              toolContent: { toolInput: runtimeProjectionMatrix.successfulToolLoop.toolInput },
            },
          );
        } else {
          const matrixToolCtx = {
            ...toolCtx,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            toolName: "lookup",
            toolCallId: "matrix-terminal-tool",
          };
          const terminalTool = {
            toolName: "lookup",
            toolCallId: "matrix-terminal-tool",
            params: runtimeProjectionMatrix.successfulToolLoop.toolInput,
            result: runtimeProjectionMatrix.successfulToolLoop.toolOutput,
            durationMs: 100,
          };
          afterToolCall(terminalTool, matrixToolCtx);
          afterToolCall(terminalTool, matrixToolCtx);
          beforeToolCall(
            {
              toolName: "lookup",
              toolCallId: "matrix-terminal-tool",
              params: runtimeProjectionMatrix.successfulToolLoop.toolInput,
            },
            matrixToolCtx,
          );
        }

        await vi.waitFor(() => {
          expect(mockTrace.generation).toHaveBeenCalledOnce();
          expect(mockTrace.span.mock.calls.length + mockGeneration.span.mock.calls.length).toBe(1);
        });
        await agentEnd(
          {
            messages: [
              { role: "user", content: runtimeProjectionMatrix.context.prompt },
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
                  },
                ],
                provider: runtimeConfig.provider,
                model: runtimeConfig.model,
              },
            ],
            success: true,
            durationMs: 100,
          },
          ctx,
        );

        expect(mockTrace.generation).toHaveBeenCalledOnce();
        expect(
          mockGeneration.update.mock.calls.filter((call) => call[0]?.usageDetails),
        ).toHaveLength(1);
        expect(
          mockGeneration.update.mock.calls.find((call) => call[0]?.usageDetails)?.[0]?.usageDetails,
        ).toEqual({
          input: 0,
          output: 0,
          cache_read_input_tokens: 0,
          total: 0,
        });
        expect(mockGeneration.update.mock.calls.at(-1)?.[0]).not.toHaveProperty("output");
        expect(mockSpan.update.mock.calls.filter((call) => call[0]?.output)).toHaveLength(1);
        expect(finalTraceUpdate()).toMatchObject({
          output: runtimeProjectionMatrix.successfulToolLoop.finalOutput,
          metadata: {
            stats: {
              success: true,
              llmCallCount: 1,
              toolCallCount: 1,
            },
          },
        });
      },
    );
  });

  it("disabled service skips all hooks", async () => {
    const disabledConfig: LangfusePluginConfig = {
      tracing: { enabled: true },
      // No keys → disabled
    };
    const service = await startService(disabledConfig);
    const { beforeAgentRun, llmInput, llmOutput, beforeToolCall, afterToolCall, agentEnd } =
      service.getHookHandlers();

    // None of these should throw, and none should call langfuse
    beforeAgentRun({ prompt: "hello", messages: [] }, agentCtx);
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

  it("agentEnd creates trace and observations even without prior beforeAgentRun (restart resilience)", async () => {
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

    // Simulate: gateway restarted, so no beforeAgentRun/llmInput/llmOutput was called.
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

    // Recovery emits first-class tool spans alongside model generations.
    expect(mockTrace.span).toHaveBeenCalledTimes(2);

    // Trace should be finalized
    expect(mockTrace.update).toHaveBeenCalledOnce();
    const updateArgs = mockTrace.update.mock.calls[0][0];
    expect(updateArgs.output).toBe("搜索成功！找到了3位候选人。");
    expect(updateArgs.metadata.stats.llmCallCount).toBe(3);
    expect(updateArgs.metadata.stats.success).toBe(true);
  });

  it("recovers live observation identities and transcript payloads after a gateway service restart", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-gateway-restart-"));
    const ctx = {
      ...agentCtx,
      runId: "run-gateway-restart",
      sessionKey: "agent:agent-restart:gateway-restart",
      sessionId: "session-gateway-restart",
      agentId: "agent-restart",
    };
    sessionStoreRuntime.resolveTranscriptSessionKeyBySessionId.mockReturnValue(ctx.sessionKey);

    try {
      const firstService = await startService(config, undefined, { stateDir });
      const firstHooks = firstService.getHookHandlers();
      firstHooks.beforeAgentRun({ prompt: "restart recovery", messages: [] }, ctx);
      firstHooks.llmInput(
        {
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          provider: "clawos",
          model: "gpt-5.6-sol",
          prompt: "restart recovery",
          historyMessages: [],
          imagesCount: 0,
        },
        ctx,
      );
      firstHooks.beforeToolCall(
        { toolName: "lookup", params: { query: "restart" }, toolCallId: "tool-restart-1" },
        { ...ctx, toolName: "lookup", toolCallId: "tool-restart-1" },
      );

      const markerFile = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      const firstLedger = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const traceStart = firstLedger.find((entry) => entry.customType === "langfuse-trace-start");
      const traceId = String((traceStart?.data as { traceId?: string } | undefined)?.traceId);
      const generationId = String(firstLedger.find((entry) => entry.e === "gen-start")?.id);
      const spanId = String(firstLedger.find((entry) => entry.e === "span-start")?.id);
      expect(traceId).not.toBe("undefined");
      expect(generationId).not.toBe("undefined");
      expect(spanId).not.toBe("undefined");
      const traceStartedAtMs = Date.parse(String(traceStart?.timestamp));
      expect(Number.isFinite(traceStartedAtMs)).toBe(true);
      const transcriptTimestamp = (offsetMs: number) =>
        new Date(traceStartedAtMs + offsetMs).toISOString();

      setTranscriptRows(ctx.sessionId, [
        {
          id: "restart-user",
          timestamp: transcriptTimestamp(1_000),
          message: { role: "user", content: "restart recovery" },
        },
        {
          id: "restart-assistant-tool",
          parentId: "restart-user",
          timestamp: transcriptTimestamp(2_000),
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-restart-1",
                name: "lookup",
                input: { query: "restart" },
              },
            ],
            provider: "clawos",
            model: "gpt-5.6-sol",
            usage: { input: 100, output: 10, cacheRead: 20, totalTokens: 130 },
          },
        },
        {
          id: "restart-tool-result",
          parentId: "restart-assistant-tool",
          timestamp: transcriptTimestamp(3_000),
          message: {
            role: "toolResult",
            toolCallId: "tool-restart-1",
            toolName: "lookup",
            content: "recovered",
          },
        },
        {
          id: "restart-assistant-final",
          parentId: "restart-tool-result",
          timestamp: transcriptTimestamp(4_000),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "restart recovery complete" }],
            provider: "clawos",
            model: "gpt-5.6-sol",
            usage: { input: 120, output: 15, cacheRead: 30, totalTokens: 165 },
          },
        },
      ]);

      await firstService.stop?.(makeServiceCtx({ stateDir }));
      sdkEvents.takeQueuedItems();
      vi.clearAllMocks();
      sessionStoreRuntime.resolveTranscriptSessionKeyBySessionId.mockReturnValue(ctx.sessionKey);

      const secondService = await startService(config, undefined, { stateDir });
      await vi.waitFor(() =>
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining(`recovered trace ${traceId}`),
        ),
      );

      expect(mockLangfuseInstance.trace).toHaveBeenCalledWith(
        expect.objectContaining({ id: traceId, sessionId: ctx.sessionKey }),
      );
      expect(mockTrace.generation).toHaveBeenCalledWith(
        expect.objectContaining({
          id: generationId,
          output: {
            content: null,
            tool_calls: [
              {
                id: "tool-restart-1",
                type: "function",
                function: {
                  name: "lookup",
                  arguments: '{"query":"restart"}',
                },
              },
            ],
          },
          usageDetails: expect.objectContaining({
            input: 100,
            cache_read_input_tokens: 20,
            output: 10,
          }),
        }),
      );
      expect(mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          id: spanId,
          input: { query: "restart" },
        }),
      );
      expect(mockSpan.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: "recovered",
        }),
      );
      expect(mockTrace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: "restart recovery complete",
          metadata: expect.objectContaining({
            source: "startup-recovery",
            stats: { llmCallCount: 2, toolCallCount: 1 },
          }),
        }),
      );
      expect(fs.readFileSync(markerFile, "utf8")).toContain("langfuse-trace-end");
      const recoveryRows = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.customType === "langfuse-trace-recovery");
      expect(recoveryRows).toEqual([
        expect.objectContaining({
          data: { traceId, outcome: "succeeded" },
        }),
      ]);

      await secondService.stop?.(makeServiceCtx({ stateDir }));
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("drains SDK tickets and completes a large live agentEnd batch", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-live-ticket-backpressure-"));
    const service = await startService(config, undefined, { stateDir });
    const { agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      agentId: "agent-live-ticket-backpressure",
      sessionKey: "agent:agent-live-ticket-backpressure:session-1",
      sessionId: "session-live-ticket-backpressure",
    };

    try {
      await agentEnd(
        {
          messages: [
            { role: "user", content: "run tools", timestamp: 1 },
            ...Array.from({ length: 171 }, (_, index) => ({
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: `tool-${index}`,
                  name: "test-tool",
                  input: { index },
                },
              ],
              model: "gpt-test",
              provider: "openai",
              timestamp: index + 2,
            })),
          ],
          success: true,
        },
        ctx,
      );

      expect(mockTrace.generation).toHaveBeenCalledTimes(171);
      expect(mockTrace.span).toHaveBeenCalledTimes(171);
      expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("ticket cap remained exhausted"),
      );
      expect(
        fs.readFileSync(resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId), "utf8"),
      ).toContain("langfuse-trace-end");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
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

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    await Promise.all([agentEnd(event, ctx), agentEnd(event, ctx)]);

    expect(mockTrace.generation).toHaveBeenCalledOnce();
    expect(mockTrace.update).toHaveBeenCalledTimes(2);
    await service.stop?.(makeServiceCtx());
  });

  it("finalize rebuilds tool_use output from JSONL (not null)", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-tooluse-output" };

    beforeAgentRun({ prompt: "search", messages: [] }, ctx);
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

  it("finalize preserves explicitly reported zero costDetails", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-zero-cost" };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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

    const genClient = mockTrace.generation.mock.results[0].value;
    const updateCalls = genClient.update.mock.calls;
    expect(updateCalls).toContainEqual([
      expect.objectContaining({
        costDetails: { input: 0, output: 0, total: 0 },
      }),
    ]);
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

  it("does not append a second gen-end ledger event when correcting a completed generation", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-generation-correction-"));
    const completedGen = { update: vi.fn(), end: vi.fn() };
    const agentId = "agent-1";
    const sessionId = "session-1";
    const traceId = "trace-test";
    const genId = `${traceId}-gen-1`;
    const turnEntries = [
      { timestamp: 1_000, message: { role: "user", content: "search", timestamp: 1_000 } },
      {
        timestamp: 3_000,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "qwen3.7-plus",
          provider: "aliyun",
          stopReason: "stop",
          timestamp: 2_000,
        },
      },
    ] as unknown as SessionEntry[];

    try {
      writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        {
          e: "gen-start",
          traceId,
          id: genId,
          llmCall: 1,
          model: "aliyun/qwen3.7-plus",
          ts: new Date(1_500).toISOString(),
        },
        mockLogger,
      );
      writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        { e: "gen-end", traceId, id: genId, ts: new Date(2_500).toISOString() },
        mockLogger,
      );

      finalizeIncrementalObservations(
        makeTraceEntry({
          traceId,
          llmCallCount: 1,
          completedGenerations: new Map([[1, completedGen as never]]),
          completedGenerationIds: new Map([[1, genId]]),
          timestamp: 1_500,
        }),
        turnEntries,
        turnEntries,
        agentId,
        sessionId,
        false,
        { logger: mockLogger, stateDir, langfuseClient: null },
      );

      const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
      const generationEnds = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { e?: string; id?: string })
        .filter((event) => event.e === "gen-end" && event.id === genId);
      expect(generationEnds).toHaveLength(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("batch recovery uses assistant row completion timestamps", async () => {
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

    await buildObservationsFromEntries(
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

    expect(mockTrace.span).toHaveBeenCalledTimes(1);
  });

  it("batch observation gen-1 input starts at current turn boundary", async () => {
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

    await buildObservationsFromEntries(
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

  it("keeps aggregate-only usage at trace level without assigning it to a generation", async () => {
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

    const result = await buildObservationsFromEntries(
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
    const { beforeAgentRun, llmInput, beforeToolCall } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-parent-obs" };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-1" };

    beforeAgentRun({ prompt: "What is 2+2?", messages: [] }, ctx);
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

  it("uses 7.1 before_agent_run messages as prior_conversation metadata", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-history-current" };

    beforeAgentRun(
      {
        prompt: "What is 2+2?",
        messages: [
          { role: "user", content: "prior question" },
          { role: "assistant", content: "prior answer" },
        ],
      },
      ctx,
    );
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
    const { beforeAgentRun, llmInput, llmOutput } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-delta-2" };

    beforeAgentRun({ prompt: "What is 2+2?", messages: [] }, ctx);
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
    const input = gen2Args.input as { messages: Array<Record<string, unknown>> };
    expect(input.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "calc", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tc1",
        content: "4",
      },
    ]);
  });

  it("llmInput stores pre-turn history once as prior_conversation metadata", async () => {
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-prior-conv" };

    beforeAgentRun(
      {
        prompt: "New question",
        messages: [],
        systemPrompt: "system instructions",
        priorMessages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
        ],
      },
      ctx,
    );
    await llmInput(
      {
        runId: "run-prior-1",
        sessionId: "session-id-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "New question",
        systemPrompt: "system instructions",
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
    expect(priorConversationUpdates.length).toBeGreaterThanOrEqual(1);
    const priorConversation = (
      priorConversationUpdates[0][0] as Record<string, Record<string, unknown>>
    ).metadata.prior_conversation as Array<{ role: string }>;
    expect(priorConversation.map((m) => m.role)).toEqual(["user", "assistant"]);
    const contextMetadata = (
      priorConversationUpdates[0][0] as Record<string, Record<string, unknown>>
    ).metadata;
    expect(contextMetadata).toMatchObject({
      system_prompt: "system instructions",
      system_prompt_bytes: Buffer.byteLength(JSON.stringify("system instructions"), "utf8"),
      system_prompt_truncated: false,
      system_prompt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      prior_conversation_bytes: Buffer.byteLength(JSON.stringify(priorConversation), "utf8"),
      prior_conversation_truncated: false,
      prior_conversation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      prior_conversation_message_count: 2,
    });

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
    expect(finalUpdate?.metadata).toMatchObject(contextMetadata);
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
      const { beforeAgentRun, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:openresponses:transcript-timing",
        sessionId: "session-id-transcript-timing",
      };

      beforeAgentRun({ prompt: "search candidates", messages: [] }, ctx);
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
      const firstGenEndTime = firstGenPatch?.endTime;
      expect(firstGenEndTime).toBeInstanceOf(Date);
      if (!(firstGenEndTime instanceof Date)) {
        throw new Error("expected the first generation to include an end time");
      }
      expect(firstGenEndTime.toISOString()).toBe("2026-07-01T11:49:39.196Z");

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
      const { beforeAgentRun } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "agent:agent-1:openresponses:provider-transcript",
        sessionId: "session-id-provider-transcript",
      };
      beforeAgentRun({ prompt: "search candidates", messages: [] }, ctx);
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

  it("keeps batch generations immutable after terminal admission closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T10:00:00.000Z"));
    const service = await startService();
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-batch-late-provider",
      sessionKey: "agent:agent-1:openresponses:batch-late-provider",
      sessionId: "session-id-batch-late-provider",
    };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValueOnce({
      ok: false,
      reason: "producer_incomplete",
      deliveredEvents: 0,
    });
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
    const updateCountAfterAgentEnd = batchGenerationClient.update.mock.calls.length;

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
    expect(batchGenerationClient.update).toHaveBeenCalledTimes(updateCountAfterAgentEnd);
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
      const { beforeAgentRun, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "session-key-reasoning-skip",
        sessionId: "session-id-reasoning-skip",
      };

      beforeAgentRun({ prompt: "只回复一行：qwen codex verify alive", messages: [] }, ctx);
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

  it("skips Codex reasoning-only assistant rows in batch observations", async () => {
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

    const result = await buildObservationsFromEntries(
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
      const { beforeAgentRun, llmInput } = service.getHookHandlers();
      const ctx = {
        ...agentCtx,
        sessionKey: "session-key-tool-mirror-skip",
        sessionId: "session-id-tool-mirror-skip",
      };

      beforeAgentRun({ prompt: "find golang candidates", messages: [] }, ctx);
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

  it("skips Codex transcript-only tool call mirrors in batch observations", async () => {
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

    const result = await buildObservationsFromEntries(
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

  it("rejects transcript generation repair after terminal admission closes", async () => {
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
    const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-late-transcript",
      sessionKey: "session-key-late-transcript",
      sessionId: "session-id-late-transcript",
    };

    beforeAgentRun({ prompt: "只回复一行：codex path fixed", messages: [] }, ctx);
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

    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValueOnce({
      ok: false,
      reason: "producer_incomplete",
      deliveredEvents: 0,
    });
    await agentEnd(
      {
        messages: [{ role: "user", content: "只回复一行：codex path fixed" }],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );
    const generationUpdateCountAfterAgentEnd = genClient.update.mock.calls.length;
    const traceUpdateCountAfterAgentEnd = mockTrace.update.mock.calls.length;

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
        usage: { input: 23443, output: 8, cacheRead: 23000, cacheWrite: 0 },
        stopReason: "stop",
        metadata: { _langfuse: { traceId } },
      },
    });

    expect(mockTrace.generation).toHaveBeenCalledTimes(1);
    expect(genClient.update).toHaveBeenCalledTimes(generationUpdateCountAfterAgentEnd);
    expect(mockTrace.update).toHaveBeenCalledTimes(traceUpdateCountAfterAgentEnd);
    expect(mockTrace.update.mock.calls.at(-1)?.[0]).not.toHaveProperty("output");
    await service.stop?.(makeServiceCtx());
  });

  it("rejects persisted-row repair after terminal admission closes", async () => {
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
    const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-late-row-timing",
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

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValueOnce({
      ok: false,
      reason: "producer_incomplete",
      deliveredEvents: 0,
    });
    await agentEnd(
      {
        messages: [{ role: "user", content: "hello" }],
        success: true,
        durationMs: 1_000,
      },
      ctx,
    );
    const generationUpdateCountAfterAgentEnd = generation.update.mock.calls.length;
    const traceUpdateCountAfterAgentEnd = mockTrace.update.mock.calls.length;
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

    expect(generation.update).toHaveBeenCalledTimes(generationUpdateCountAfterAgentEnd);
    expect(mockTrace.update).toHaveBeenCalledTimes(traceUpdateCountAfterAgentEnd);
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
    const { beforeAgentRun, llmInput, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-late-transcript-owner-mismatch",
      sessionId: "session-id-late-transcript-owner-mismatch",
    };

    beforeAgentRun({ prompt: "first turn", messages: [] }, ctx);
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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-finalize-during-transcript",
      sessionId: "session-id-finalize-during-transcript",
    };

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
    beforeAgentRun({ prompt: "replacement turn", messages: [] }, ctx);
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
    const { beforeAgentRun } = service.getHookHandlers();
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

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
      service.getHookHandlers().beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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

  it("does not enqueue a terminal transcript generation when gen-end persistence fails", async () => {
    let transcriptListener: TranscriptListener | undefined;
    const runtime: Parameters<typeof createLangfuseService>[2] = {
      events: {
        onSessionTranscriptUpdate: (listener: TranscriptListener) => {
          transcriptListener = listener;
          return vi.fn();
        },
      },
    };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-gen-end-failure-"));
    const service = await startService(config, runtime, { stateDir });
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-gen-end-failure",
      sessionId: "session-id-gen-end-failure",
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "codex",
      model: "aliyun/qwen3.7-plus",
    };
    setTranscriptRows(ctx.sessionId, [
      {
        id: "assistant-gen-end-failure",
        timestamp: new Date().toISOString(),
        message: assistantMessage,
      },
    ]);

    try {
      let ledgerUpdates = 0;
      const ledgerRecords = new Map<string, TraceLedgerRecord>();
      const failingLedgerStore = {
        register: vi.fn((key: string, value: TraceLedgerRecord) => {
          ledgerRecords.set(key, value);
        }),
        registerIfAbsent: vi.fn(() => true),
        update: vi.fn(
          (
            key: string,
            updateValue: (current?: TraceLedgerRecord) => TraceLedgerRecord | undefined,
          ) => {
            ledgerUpdates += 1;
            if (ledgerUpdates === 2) {
              throw new Error("gen-end persistence failed");
            }
            const next = updateValue(ledgerRecords.get(key));
            if (next === undefined) {
              return false;
            }
            ledgerRecords.set(key, next);
            return true;
          },
        ),
        lookup: vi.fn((key: string) => ledgerRecords.get(key)),
        consume: vi.fn((key: string) => {
          const value = ledgerRecords.get(key);
          ledgerRecords.delete(key);
          return value;
        }),
        delete: vi.fn((key: string) => ledgerRecords.delete(key)),
        entries: vi.fn(() =>
          [...ledgerRecords].map(([key, value]) => ({ key, value, createdAt: 0 })),
        ),
        clear: vi.fn(() => ledgerRecords.clear()),
      } satisfies PluginStateSyncKeyedStore<TraceLedgerRecord>;
      configureTraceLedgerStore(stateDir, failingLedgerStore);

      service.getHookHandlers().beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-gen-end-failure",
        message: assistantMessage,
      });

      await vi.waitFor(() =>
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining("failed to write observation event (gen-end)"),
        ),
      );
      expect(mockTrace.generation).not.toHaveBeenCalled();
      const markerFile = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      const markerEvents = fs
        .readFileSync(markerFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { e?: string })
        .flatMap((event) => (event.e ? [event.e] : []));
      expect(markerEvents).toEqual(["gen-start"]);
    } finally {
      vi.restoreAllMocks();
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
      service.getHookHandlers().beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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

    service.getHookHandlers().beforeAgentRun({ prompt: "read skill", messages: [] }, ctx);
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

  it("rejects transcript tool repair after terminal admission closes", async () => {
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
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-late-tool-transcript",
      sessionKey: "session-key-late-tool-transcript",
      sessionId: "session-id-late-tool-transcript",
    };

    beforeAgentRun({ prompt: "read skill", messages: [] }, ctx);
    const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockResolvedValueOnce({
      ok: false,
      reason: "producer_incomplete",
      deliveredEvents: 0,
    });
    await agentEnd(
      {
        messages: [{ role: "user", content: "read skill" }],
        success: true,
        durationMs: 1000,
      },
      ctx,
    );
    const spanCreateCountAfterAgentEnd = mockTrace.span.mock.calls.length;
    const spanUpdateCountAfterAgentEnd = mockSpan.update.mock.calls.length;

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

    expect(mockTrace.span).toHaveBeenCalledTimes(spanCreateCountAfterAgentEnd);
    expect(mockSpan.update).toHaveBeenCalledTimes(spanUpdateCountAfterAgentEnd);
    await service.stop?.(makeServiceCtx());
  });

  it("afterToolCall completes tool spans with duration metadata", async () => {
    vi.useFakeTimers();
    const service = await startService();
    const { beforeAgentRun, llmInput, llmOutput, beforeToolCall, afterToolCall } =
      service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-tool-duration" };

    beforeAgentRun({ prompt: "search", messages: [] }, ctx);
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
    const { beforeAgentRun, beforeToolCall, afterToolCall } = service.getHookHandlers();
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

    beforeAgentRun({ prompt: "search", messages: [] }, ctx);
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
    const { beforeAgentRun, beforeToolCall, afterToolCall, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-redacted-status" };
    const callCtx = {
      ...toolCtx,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolCallId: "tc-redacted-error",
    };

    beforeAgentRun({ prompt: "search", messages: [] }, ctx);
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
    const { beforeAgentRun, llmInput, llmOutput, agentEnd } = service.getHookHandlers();
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

    beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
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
      .find((patch) => patch.metadata?.sessionKey === ctx.sessionKey && patch.metadata.stats);
    expect(tracePatch).toBeDefined();
    expect(tracePatch.metadata.stats.llmCallCount).toBe(1);
    await service.stop?.(makeServiceCtx());
  });

  it("reconciles batch transcript tool counts with existing live spans", async () => {
    const service = await startService();
    const { beforeAgentRun, beforeToolCall, afterToolCall, agentEnd } = service.getHookHandlers();
    const ctx = { ...agentCtx, sessionKey: "session-key-live-tool-batch-count" };
    const callCtx = {
      ...toolCtx,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
      toolCallId: "tc-live-batch",
    };

    beforeAgentRun({ prompt: "read", messages: [] }, ctx);
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

  it("drains transcript updates arriving during finalization before writing the end marker", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-transcript-finalization-"));
    let transcriptListener: TranscriptListener | undefined;
    let releaseDiagnosticDrain: (() => void) | undefined;
    const diagnosticDrain = new Promise<void>((resolve) => {
      releaseDiagnosticDrain = resolve;
    });
    diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor.mockImplementationOnce(async () => {
      await diagnosticDrain;
      return { ok: true, deliveredEvents: 0 };
    });
    const service = await startService(
      config,
      {
        events: {
          onSessionTranscriptUpdate: (listener: TranscriptListener) => {
            transcriptListener = listener;
            return vi.fn();
          },
        },
      },
      { stateDir },
    );
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-transcript-finalization",
      sessionKey: "session-key-transcript-finalization",
      sessionId: "session-id-transcript-finalization",
    };

    try {
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      const finalization = agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "initial" }],
              provider: "openai",
              model: "gpt-5.5",
            },
          ],
          success: true,
        },
        ctx,
      );
      await vi.waitFor(() =>
        expect(diagnosticRuntime.waitForInternalDiagnosticDeliveryCursor).toHaveBeenCalledOnce(),
      );

      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-during-finalization",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "late" }],
          provider: "openai",
          model: "gpt-5.5",
        },
      });
      releaseDiagnosticDrain?.();
      await finalization;

      const markerRaw = fs.readFileSync(
        resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId),
        "utf8",
      );
      expect(markerRaw).toContain("langfuse-trace-end");
      expect(
        mockTrace.update.mock.calls
          .map((call) => call[0])
          .find((update) => update?.metadata?.observationReconciliation)?.metadata
          ?.observationReconciliation,
      ).toBeUndefined();
    } finally {
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("closes transcript admission before the final delivery flush", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "langfuse-transcript-admission-"));
    let transcriptListener: TranscriptListener | undefined;
    let releaseFinalFlush: (() => void) | undefined;
    const finalFlush = new Promise<void>((resolve) => {
      releaseFinalFlush = resolve;
    });
    mockLangfuseInstance.flushAsync.mockImplementationOnce(async () => {
      await finalFlush;
      mockLangfuseInstance.flush();
    });
    const service = await startService(
      config,
      {
        events: {
          onSessionTranscriptUpdate: (listener: TranscriptListener) => {
            transcriptListener = listener;
            return vi.fn();
          },
        },
      },
      { stateDir },
    );
    const { beforeAgentRun, agentEnd } = service.getHookHandlers();
    const ctx = {
      ...agentCtx,
      runId: "run-transcript-admission",
      sessionKey: "session-key-transcript-admission",
      sessionId: "session-id-transcript-admission",
    };

    try {
      beforeAgentRun({ prompt: "hello", messages: [] }, ctx);
      const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;
      const finalization = agentEnd(
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              provider: "openai",
              model: "gpt-5.5",
            },
          ],
          success: true,
        },
        ctx,
      );
      await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce());

      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "assistant-after-transcript-barrier",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-after-transcript-barrier",
              name: "read",
              input: { path: "late" },
            },
          ],
          provider: "openai",
          model: "gpt-5.5",
          metadata: { _langfuse: { traceId } },
        },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(mockTrace.span).not.toHaveBeenCalled();
      releaseFinalFlush?.();
      await finalization;

      const markerRaw = fs.readFileSync(
        resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId),
        "utf8",
      );
      expect(markerRaw).toContain("langfuse-trace-end");
    } finally {
      releaseFinalFlush?.();
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("closes transcript admission for diagnostic-owned finalization", async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "langfuse-diagnostic-transcript-admission-"),
    );
    let transcriptListener: TranscriptListener | undefined;
    let releaseFinalFlush: (() => void) | undefined;
    const finalFlush = new Promise<void>((resolve) => {
      releaseFinalFlush = resolve;
    });
    mockLangfuseInstance.flushAsync.mockImplementationOnce(async () => {
      await finalFlush;
      mockLangfuseInstance.flush();
    });
    const service = await startService(
      config,
      {
        events: {
          onSessionTranscriptUpdate: (listener: TranscriptListener) => {
            transcriptListener = listener;
            return vi.fn();
          },
        },
      },
      { stateDir },
    );
    const ctx = {
      ...agentCtx,
      sessionKey: "session-key-diagnostic-transcript-admission",
      sessionId: "session-id-diagnostic-transcript-admission",
    };
    setTranscriptRows(ctx.sessionId, [
      {
        id: "diagnostic-user",
        timestamp: "2026-07-28T03:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        id: "diagnostic-assistant",
        parentId: "diagnostic-user",
        timestamp: "2026-07-28T03:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          provider: "clawos",
          model: "gpt-5.6-sol",
          usage: { input: 10, output: 2, totalTokens: 12 },
        },
      },
    ]);

    try {
      diagnosticRuntime.listener?.({
        type: "model.usage",
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        provider: "clawos",
        model: "gpt-5.6-sol",
        usage: { input: 10, output: 2, total: 12 },
        durationMs: 1000,
      });
      await vi.waitFor(() => expect(mockLangfuseInstance.flushAsync).toHaveBeenCalledOnce());
      const traceId = mockLangfuseInstance.trace.mock.calls.at(-1)?.[0].id as string;

      transcriptListener?.({
        target: transcriptTarget(ctx),
        messageId: "diagnostic-assistant-after-transcript-barrier",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "diagnostic-tool-after-transcript-barrier",
              name: "read",
              input: { path: "late" },
            },
          ],
          provider: "clawos",
          model: "gpt-5.6-sol",
          metadata: { _langfuse: { traceId } },
        },
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(mockTrace.span).not.toHaveBeenCalled();
      releaseFinalFlush?.();
      const markerPath = resolveMarkerFilePath(stateDir, ctx.agentId, ctx.sessionId);
      await vi.waitFor(() =>
        expect(fs.readFileSync(markerPath, "utf8")).toContain("langfuse-trace-end"),
      );
    } finally {
      releaseFinalFlush?.();
      await service.stop?.(makeServiceCtx());
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
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
    const { beforeAgentRun } = service.getHookHandlers();
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

    beforeAgentRun({ prompt: "read", messages: [] }, ctx);
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
