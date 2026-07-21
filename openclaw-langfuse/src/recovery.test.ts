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

import { recoverTrace, scanIncompleteTraces } from "./recovery.js";

function createLangfuseMock() {
  const generation = vi.fn();
  const update = vi.fn();
  const trace = vi.fn(() => ({ generation, update }));
  return {
    lf: { trace, flushAsync: vi.fn().mockResolvedValue(undefined) },
    generation,
    trace,
    update,
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
  const sessionDir = path.join(params.stateDir, "agents", params.agentId, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.appendFileSync(
    path.join(sessionDir, `${params.sessionId}.langfuse-markers.jsonl`),
    `${JSON.stringify({
      type: "custom",
      customType: params.customType ?? "langfuse-trace-start",
      data: { traceId: params.traceId },
      timestamp: params.timestamp,
    })}\n`,
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
    const markerPath = path.join(
      stateDir,
      "agents",
      agentId,
      "sessions",
      `${sessionId}.langfuse-markers.jsonl`,
    );
    const observationRow = `${JSON.stringify({ e: "span-end", id: "x".repeat(1024) })}\n`;
    fs.appendFileSync(markerPath, observationRow.repeat(80));

    expect(scanIncompleteTraces(stateDir)).toEqual([
      {
        agentId,
        sessionId,
        traceId,
        jsonlPath: path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`),
      },
    ]);
  });

  it("merges inline trace metadata with a partially populated sidecar ledger", () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-partial-sidecar";
    const sidecarTraceId = "trace-from-sidecar";
    const inlineTraceId = "trace-from-inline-metadata";
    writeMarker({
      agentId,
      sessionId,
      stateDir,
      timestamp: new Date().toISOString(),
      traceId: sidecarTraceId,
    });
    const jsonlPath = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    fs.writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        id: "assistant-1",
        message: {
          role: "assistant",
          content: "done",
          metadata: { _langfuse: { traceId: inlineTraceId } },
        },
      })}\n`,
    );

    expect(scanIncompleteTraces(stateDir)).toEqual(
      expect.arrayContaining([
        { agentId, sessionId, traceId: sidecarTraceId, jsonlPath },
        { agentId, sessionId, traceId: inlineTraceId, jsonlPath },
      ]),
    );
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
    const markerPath = path.join(
      stateDir,
      "agents",
      agentId,
      "sessions",
      `${sessionId}.langfuse-markers.jsonl`,
    );
    const observationRow = `${JSON.stringify({ e: "span-end", id: "x".repeat(1024) })}\n`;
    fs.appendFileSync(markerPath, observationRow.repeat(80));
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
    ).resolves.toBe(1);

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

  it("does not recover a sidecar trace when its start marker is newer than every transcript row", async () => {
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
    expect(
      fs.readFileSync(
        path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.langfuse-markers.jsonl`),
        "utf-8",
      ),
    ).not.toContain("langfuse-trace-end");
  });

  it("falls back to legacy JSONL only when a SQLite session key is unavailable", async () => {
    const stateDir = makeStateDir();
    const agentId = "agent-1";
    const sessionId = "session-1";
    const traceId = "trace-1";
    const sessionDir = path.join(stateDir, "agents", agentId, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({
          type: "custom",
          customType: "langfuse-trace-start",
          data: { traceId },
          timestamp: "2026-07-17T03:00:00.000Z",
        }),
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
    const markerPath = path.join(
      stateDir,
      "agents",
      agentId,
      "sessions",
      `${sessionId}.langfuse-markers.jsonl`,
    );
    const jsonlPath = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);

    await expect(
      recoverTrace(
        lf.lf as never,
        { agentId, sessionId, traceId, jsonlPath },
        { redactEnabled: false },
        stateDir,
      ),
    ).rejects.toThrow("flush failed");

    expect(fs.readFileSync(markerPath, "utf-8")).not.toContain("langfuse-trace-end");

    lf.lf.flushAsync.mockResolvedValueOnce(undefined);
    await expect(
      recoverTrace(
        lf.lf as never,
        { agentId, sessionId, traceId, jsonlPath },
        { redactEnabled: false },
        stateDir,
      ),
    ).resolves.toBe(1);
    expect(fs.readFileSync(markerPath, "utf-8")).toContain("langfuse-trace-end");
  });
});
