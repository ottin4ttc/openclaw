import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readVisibleSessionTranscriptMessageEntries, resolveTranscriptSessionKeyBySessionId } =
  vi.hoisted(() => ({
    readVisibleSessionTranscriptMessageEntries: vi.fn(),
    resolveTranscriptSessionKeyBySessionId: vi.fn(),
  }));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveTranscriptSessionKeyBySessionId,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries,
}));

import {
  recoverTrace,
  scanIncompleteTraces,
  TRACE_RECOVERY_MAX_AGE_MS,
  TRACE_RECOVERY_MAX_ATTEMPTS,
} from "./recovery.js";
import { bindSdkDeliveryTracker, SdkDeliveryTracker } from "./sdk-delivery.js";
import {
  readTraceLedgerTrace,
  writeObservationEvent,
  writeTraceMarker,
  writeTraceRecoveryMarker,
} from "./trace-ledger.js";

function createLangfuseMock() {
  const queue: Array<{ type: string; body: Record<string, unknown> }> = [];
  let lf: {
    trace: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    flushAsync: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  };
  const on = vi.fn((event: string, listener: (payload: unknown) => void) => {
    const current = listeners.get(event) ?? [];
    current.push(listener);
    listeners.set(event, current);
    return () => {
      const next = (listeners.get(event) ?? []).filter((candidate) => candidate !== listener);
      if (next.length > 0) {
        listeners.set(event, next);
      } else {
        listeners.delete(event);
      }
    };
  });
  const spanUpdate = vi.fn();
  const span = vi.fn();
  const generation = vi.fn();
  const update = vi.fn();
  const enqueue = (type: string, body: Record<string, unknown>): void => {
    queue.push({ type, body });
    lf.flush();
  };
  const trace = vi.fn((body?: Record<string, unknown>) => {
    const id = typeof body?.id === "string" ? body.id : undefined;
    enqueue("trace-create", body ?? {});
    return {
      generation: (generationBody?: Record<string, unknown>) => {
        generation(generationBody);
        enqueue("generation-create", {
          ...generationBody,
          ...(id ? { traceId: id } : {}),
        });
        return {};
      },
      span: (spanBody?: Record<string, unknown>) => {
        span(spanBody);
        const spanId = typeof spanBody?.id === "string" ? spanBody.id : undefined;
        enqueue("span-create", {
          ...spanBody,
          ...(id ? { traceId: id } : {}),
        });
        return {
          update: (updateBody?: Record<string, unknown>) => {
            const mergedBody = {
              ...updateBody,
              ...(spanId ? { id: spanId } : {}),
              ...(id ? { traceId: id } : {}),
            };
            spanUpdate(mergedBody);
            enqueue("span-update", mergedBody);
          },
        };
      },
      update: (updateBody?: Record<string, unknown>) => {
        const mergedBody = { ...updateBody, ...(id ? { id } : {}) };
        update(mergedBody);
        enqueue("trace-create", mergedBody);
      },
    };
  });
  const flush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
    const items = queue.splice(0, 1);
    callback?.(undefined, items);
    if (items.length > 0) {
      emit("flush", items);
    }
  });
  lf = {
    trace,
    flush,
    flushAsync: vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          lf.flush(() => resolve());
        }),
    ),
    on,
  };
  const flushPending = async () =>
    await new Promise<void>((resolve) => {
      lf.flush(() => resolve());
    });
  return {
    lf,
    generation,
    span,
    spanUpdate,
    trace,
    update,
    emit,
    flushAsync: lf.flushAsync,
    flushPending,
  };
}

function writeMarker(params: {
  agentId: string;
  customType?: "langfuse-trace-end" | "langfuse-trace-start";
  sessionId: string;
  stateDir: string;
  timestamp: string;
  traceId: string;
}) {
  const type = params.customType === "langfuse-trace-end" ? "end" : "start";
  writeTraceMarker(
    params.stateDir,
    params.agentId,
    params.sessionId,
    type,
    params.traceId,
    undefined,
    { startedAt: Date.parse(params.timestamp) },
  );
}

describe("recoverTrace", () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    tempDirs = [];
    readVisibleSessionTranscriptMessageEntries.mockReset();
    resolveTranscriptSessionKeyBySessionId.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function makeStateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-recovery-"));
    tempDirs.push(dir);
    return dir;
  }

  it("recovers an independent child trace as explicitly partial without using root transcript", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-child-recovery";
    const sessionId = "session-child-recovery";
    const traceId = "child-trace-recovery";
    expect(
      writeTraceMarker(stateDir, agentId, sessionId, "start", traceId, undefined, {
        startedAt: Date.parse("2026-08-15T01:00:00.000Z"),
        traceKind: "native-child",
        sessionKey: "agent:agent-child-recovery:conversation-1",
        parentTraceId: "root-trace-recovery",
        spawnObservationId: "root-spawn-recovery",
        childThreadId: "child-thread-recovery",
        childTurnId: "child-turn-recovery",
      }),
    ).toBe(true);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false, baseUrl: "http://localhost:3000/" },
        stateDir,
      ),
    ).resolves.toBe(0);

    expect(resolveTranscriptSessionKeyBySessionId).not.toHaveBeenCalled();
    expect(lf.trace).toHaveBeenCalledWith({
      id: traceId,
      name: "agent-child-recovery:native-child:recovered",
      sessionId: "agent:agent-child-recovery:conversation-1",
      input: {
        actorKind: "native-child",
        agentId: "agent-child-recovery",
        childThreadId: "child-thread-recovery",
        childTurnId: "child-turn-recovery",
        recoveryStatus: "partial",
      },
      output: {
        outcome: "partial",
        reason: "child_observation_payload_unavailable",
      },
      metadata: {
        actorKind: "native-child",
        source: "startup-recovery",
        recoveryStatus: "partial",
        recoveryReason: "child_observation_payload_unavailable",
        parentTraceId: "root-trace-recovery",
        parentTraceUrl: "http://localhost:3000/trace/root-trace-recovery",
        spawnObservationId: "root-spawn-recovery",
        childTraceId: traceId,
        childThreadId: "child-thread-recovery",
        childTurnId: "child-turn-recovery",
      },
    });
    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({
      traceKind: "native-child",
      status: "ended",
      parentTraceId: "root-trace-recovery",
      childTurnId: "child-turn-recovery",
    });
  });

  it("finds an incomplete trace whose start marker is older than the ledger tail", () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-large-ledger";
    const traceId = "trace-before-large-ledger";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: new Date().toISOString(),
      traceId,
    });
    expect(scanIncompleteTraces(stateDir)).toEqual([
      {
        agentId,
        sessionId,
        traceId,
        jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
      },
    ]);
  });

  it("records terminal abandonment for a trace older than the recovery window", () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-expired-recovery";
    const traceId = "trace-expired-recovery";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: new Date(Date.now() - TRACE_RECOVERY_MAX_AGE_MS - 1).toISOString(),
      traceId,
    });

    expect(scanIncompleteTraces(stateDir)).toEqual([]);

    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({
      traceId,
      status: "abandoned",
      recoveryAttempts: 0,
      recoveryOutcome: "abandoned",
      abandonmentReason: "trace_age_exceeded",
    });

    expect(scanIncompleteTraces(stateDir)).toEqual([]);
  });

  it("carries persisted recovery attempts and abandons a trace at the retry limit", () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-recovery-attempts";
    const traceId = "trace-recovery-attempts";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: new Date().toISOString(),
      traceId,
    });
    for (let attempt = 1; attempt < TRACE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      expect(
        writeTraceRecoveryMarker(stateDir, agentId, sessionId, traceId, attempt, "started"),
      ).toBe(true);
      expect(
        writeTraceRecoveryMarker(stateDir, agentId, sessionId, traceId, attempt, "failed"),
      ).toBe(true);
    }

    expect(scanIncompleteTraces(stateDir)).toEqual([
      {
        agentId,
        sessionId,
        traceId,
        jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        recoveryAttempts: TRACE_RECOVERY_MAX_ATTEMPTS - 1,
      },
    ]);

    expect(
      writeTraceRecoveryMarker(
        stateDir,
        agentId,
        sessionId,
        traceId,
        TRACE_RECOVERY_MAX_ATTEMPTS,
        "failed",
      ),
    ).toBe(true);
    expect(scanIncompleteTraces(stateDir)).toEqual([]);

    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({
      traceId,
      status: "abandoned",
      recoveryAttempts: TRACE_RECOVERY_MAX_ATTEMPTS,
      recoveryOutcome: "abandoned",
      abandonmentReason: "attempt_limit_reached",
    });
  });

  it("does not re-add an abandoned trace in the same scan", () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-expired-inline";
    const traceId = "trace-expired-inline";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: new Date(Date.now() - TRACE_RECOVERY_MAX_AGE_MS - 1).toISOString(),
      traceId,
    });
    expect(scanIncompleteTraces(stateDir)).toEqual([]);
    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({
      status: "abandoned",
      recoveryOutcome: "abandoned",
    });
  });

  it("does not recover a completed trace whose end marker is older than the ledger tail", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-complete-large-ledger";
    const traceId = "trace-complete-before-large-ledger";
    const timestamp = new Date().toISOString();
    writeMarker({ agentId, sessionId, stateDir, timestamp, traceId });
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp,
      traceId,
      customType: "langfuse-trace-end",
    });
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(0);
    expect(resolveTranscriptSessionKeyBySessionId).not.toHaveBeenCalled();
  });

  it("recovers sidecar-marked startup traces from the SQLite transcript API", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-1";
    const traceId = "trace-1";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue("agent:agent-1:session-1");
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "user-1",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T03:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        entryId: "assistant-1",
        parentId: "user-1",
        seq: 2,
        createdAt: "2026-07-17T03:00:02.000Z",
        message: {
          role: "assistant",
          content: "answer from sqlite",
          model: "gpt-test",
          provider: "openai",
          timestamp: 2,
          usage: { input: 3, output: 4, total: 7 },
        },
      },
    ]);
    const lf = createLangfuseMock();
    const deliveryTracker = new SdkDeliveryTracker();
    const completeTrace = vi.spyOn(deliveryTracker, "completeTrace");
    const deliveryCleanups = bindSdkDeliveryTracker(lf.lf as never, deliveryTracker);

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
        undefined,
        deliveryTracker,
      ),
    ).resolves.toBe(1);
    expect(completeTrace).toHaveBeenCalledWith(traceId, { preservePending: true });
    for (const cleanup of deliveryCleanups) {
      cleanup();
    }

    expect(resolveTranscriptSessionKeyBySessionId).toHaveBeenCalledWith({
      agentId,
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
      sessionId,
    });
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledWith({
      agentId,
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
      sessionId,
      sessionKey: "agent:agent-1:session-1",
    });
    expect(lf.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "agent:agent-1:session-1",
        metadata: expect.objectContaining({
          sessionId,
          sessionKey: "agent:agent-1:session-1",
        }),
      }),
    );
    expect(lf.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "answer from sqlite",
      }),
    );
    expect(lf.update).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          sessionId,
          sessionKey: "agent:agent-1:session-1",
        }),
        output: "answer from sqlite",
      }),
    );
  });

  it("drains delivered tickets and continues recovery past the per-trace cap", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-ticket-backpressure";
    const traceId = "trace-ticket-backpressure";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue(
      "agent:agent-1:session-ticket-backpressure",
    );
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "user-1",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T03:00:01.000Z",
        message: { role: "user", content: "run tools", timestamp: 1 },
      },
      ...Array.from({ length: 171 }, (_, index) => ({
        entryId: `assistant-${index}`,
        parentId: index === 0 ? "user-1" : `assistant-${index - 1}`,
        seq: index + 2,
        createdAt: new Date(Date.parse("2026-07-17T03:00:02.000Z") + index).toISOString(),
        message: {
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
        },
      })),
    ]);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(342);

    expect(lf.flushAsync).toHaveBeenCalledOnce();
  });

  it("does not recover a trace when its start marker is newer than every transcript row", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-marker-after-transcript";
    const traceId = "trace-marker-after-transcript";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue("agent:agent-1:marker-after-transcript");
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "old-user",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T02:59:00.000Z",
        message: { role: "user", content: "previous turn", timestamp: 1 },
      },
      {
        entryId: "old-assistant",
        parentId: "old-user",
        seq: 2,
        createdAt: "2026-07-17T02:59:01.000Z",
        message: {
          role: "assistant",
          content: "previous answer must not be recovered",
          model: "gpt-test",
          provider: "openai",
          timestamp: 2,
          usage: { input: 3, output: 4, total: 7 },
        },
      },
    ]);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(0);

    expect(lf.trace).not.toHaveBeenCalled();
    expect(lf.lf.flushAsync).not.toHaveBeenCalled();
    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({ status: "open" });
  });

  it("falls back to direct 7.1 JSONL when the registry key is unavailable", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-1";
    const traceId = "trace-1";
    const sessionDir = path.join(stateDir, "agents", agentId, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          id: "user-1",
          timestamp: "2026-07-17T03:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        }),
        JSON.stringify({
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-07-17T03:00:02.000Z",
          message: {
            role: "assistant",
            content: "answer from jsonl",
            model: "gpt-test",
            provider: "openai",
            timestamp: 2,
            usage: { input: 3, output: 4, total: 7 },
          },
        }),
      ].join("\n"),
    );
    resolveTranscriptSessionKeyBySessionId.mockReturnValue(undefined);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        { agentId, sessionId, traceId, jsonlPath },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(1);

    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
    expect(lf.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "answer from jsonl",
      }),
    );
    expect(lf.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
      }),
    );
  });

  it("stops recovery for an older incomplete trace at the next trace start in the same session", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-1";
    const oldTraceId = "trace-old";
    const newTraceId = "trace-new";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId: oldTraceId,
    });
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:10:00.000Z",
      traceId: newTraceId,
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue("agent:agent-1:session-1");
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "old-user",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T03:00:01.000Z",
        message: { role: "user", content: "old turn", timestamp: 1 },
      },
      {
        entryId: "old-assistant",
        parentId: "old-user",
        seq: 2,
        createdAt: "2026-07-17T03:00:02.000Z",
        message: {
          role: "assistant",
          content: "older recovered answer",
          model: "gpt-test",
          provider: "openai",
          timestamp: 2,
          usage: { input: 3, output: 4, total: 7 },
        },
      },
      {
        entryId: "new-user",
        parentId: null,
        seq: 3,
        createdAt: "2026-07-17T03:10:01.000Z",
        message: { role: "user", content: "new turn", timestamp: 3 },
      },
      {
        entryId: "new-assistant",
        parentId: "new-user",
        seq: 4,
        createdAt: "2026-07-17T03:10:02.000Z",
        message: {
          role: "assistant",
          content: "newer answer must not be recovered",
          model: "gpt-test",
          provider: "openai",
          timestamp: 4,
          usage: { input: 5, output: 6, total: 11 },
        },
      },
    ]);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId: oldTraceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(1);

    expect(lf.generation).toHaveBeenCalledTimes(1);
    expect(lf.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "older recovered answer",
      }),
    );
    expect(lf.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "old turn",
        output: "older recovered answer",
      }),
    );
    expect(lf.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        output: "newer answer must not be recovered",
      }),
    );
    const recoveredTraceUpdate = lf.update.mock.calls.find(
      ([update]) => update?.output === "older recovered answer",
    )?.[0];
    expect(recoveredTraceUpdate?.metadata).not.toHaveProperty("prior_conversation");
  });

  it("does not write the recovery end marker when Langfuse flush rejects", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-1";
    const traceId = "trace-1";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue("agent:agent-1:session-1");
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "user-1",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T03:00:01.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        entryId: "assistant-1",
        parentId: "user-1",
        seq: 2,
        createdAt: "2026-07-17T03:00:02.000Z",
        message: {
          role: "assistant",
          content: "answer before failed flush",
          model: "gpt-test",
          provider: "openai",
          timestamp: 2,
          usage: { input: 3, output: 4, total: 7 },
        },
      },
    ]);
    const lf = createLangfuseMock();
    lf.lf.flushAsync.mockRejectedValueOnce(new Error("flush failed"));
    const jsonlPath = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);

    await expect(
      recoverTrace(
        lf.lf as never,
        { agentId, sessionId, traceId, jsonlPath },
        { redactEnabled: false },
        stateDir,
      ),
    ).rejects.toThrow("delivery failed");

    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({ status: "open" });

    lf.lf.flushAsync.mockImplementationOnce(lf.flushPending);
    await expect(
      recoverTrace(
        lf.lf as never,
        { agentId, sessionId, traceId, jsonlPath },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(1);
    expect(readTraceLedgerTrace(stateDir, traceId)).toMatchObject({ status: "ended" });
  });

  it("reuses existing generation and tool span ledger IDs during recovery", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-stable-ledger";
    const traceId = "trace-stable-ledger";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: "2026-07-17T03:00:00.000Z",
      traceId,
    });
    writeObservationEvent(stateDir, agentId, sessionId, {
      e: "gen-start",
      traceId,
      id: "live-generation-id",
      llmCall: 1,
      model: "openai/gpt-test",
      ts: "2026-07-17T03:00:01.000Z",
    });
    writeObservationEvent(stateDir, agentId, sessionId, {
      e: "span-start",
      traceId,
      id: "live-tool-span-id",
      tool: "lookup",
      toolCallId: "tool-1",
      ts: "2026-07-17T03:00:01.100Z",
    });
    resolveTranscriptSessionKeyBySessionId.mockReturnValue("agent:agent-1:stable-ledger");
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "old-user",
        parentId: null,
        createdAt: "2026-07-17T02:59:58.000Z",
        message: { role: "user", content: "old question", timestamp: 0 },
      },
      {
        entryId: "old-assistant",
        parentId: "old-user",
        createdAt: "2026-07-17T02:59:59.000Z",
        message: { role: "assistant", content: "old answer", timestamp: 0 },
      },
      {
        entryId: "user-1",
        parentId: "old-assistant",
        createdAt: "2026-07-17T03:00:00.500Z",
        message: { role: "user", content: "lookup", timestamp: 1 },
      },
      {
        entryId: "assistant-1",
        parentId: "user-1",
        createdAt: "2026-07-17T03:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-1", name: "lookup", input: { q: "x" } }],
          model: "gpt-test",
          provider: "openai",
          timestamp: 2,
          usage: { input: 0, output: 0, total: 0 },
        },
      },
      {
        entryId: "tool-1-result",
        parentId: "assistant-1",
        createdAt: "2026-07-17T03:00:01.500Z",
        message: { role: "toolResult", toolCallId: "tool-1", content: "result", timestamp: 3 },
      },
      {
        entryId: "assistant-2",
        parentId: "tool-1-result",
        createdAt: "2026-07-17T03:00:02.000Z",
        message: {
          role: "assistant",
          content: "done",
          model: "gpt-test",
          provider: "openai",
          timestamp: 4,
          usage: { input: 1, output: 1, total: 2 },
        },
      },
    ]);
    const lf = createLangfuseMock();

    await expect(
      recoverTrace(
        lf.lf as never,
        {
          agentId,
          sessionId,
          traceId,
          jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
        },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(3);

    expect(lf.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "live-generation-id",
        input: {
          model: "gpt-test",
          messages: [{ role: "user", content: "lookup" }],
        },
        usageDetails: { input: 0, output: 0, total: 0 },
      }),
    );
    expect(lf.generation).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          model: "gpt-test",
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tool-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"x"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "tool-1", content: "result" },
          ],
        },
        output: "done",
      }),
    );
    expect(lf.span).toHaveBeenCalledWith(expect.objectContaining({ id: "live-tool-span-id" }));
    expect(lf.update).toHaveBeenCalledWith(
      expect.objectContaining({
        output: "done",
        metadata: expect.objectContaining({
          prior_conversation: [
            { role: "user", content: "old question" },
            { role: "assistant", content: "old answer" },
          ],
          prior_conversation_message_count: 2,
        }),
      }),
    );
  });
});
