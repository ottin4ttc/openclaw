import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readVisibleSessionTranscriptMessageEntries,
  resolveTranscriptSessionKeyBySessionId,
} from "./session-transcript-compat.js";

describe("7.1 session transcript compatibility", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-71-session-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("reads the public JSONL event facade without writing sessions.json", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const sessionFile = path.join(tempDir, "session-1.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "session-1" }),
        JSON.stringify({
          id: "message-1",
          timestamp: "2026-07-17T03:04:05.000Z",
          message: { role: "user", content: "hello" },
        }),
        "{malformed-json",
        JSON.stringify({
          parentId: "message-1",
          timestamp: 2,
          message: { role: "assistant", content: "world" },
        }),
      ].join("\n"),
      "utf8",
    );

    await expect(
      readVisibleSessionTranscriptMessageEntries({
        agentId: "main",
        sessionFile,
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toEqual([
      {
        entryId: "message-1",
        seq: 1,
        createdAt: "2026-07-17T03:04:05.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        entryId: "entry-2",
        parentId: "message-1",
        seq: 2,
        createdAt: 2,
        message: { role: "assistant", content: "world" },
      },
    ]);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("resolves a session key from the file-backed 7.1 registry without changing it", () => {
    const stateDir = path.join(tempDir, "state");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const stored = `${JSON.stringify({
      "agent:main:main": { sessionId: "session-1", updatedAt: 1 },
    })}\n`;
    fs.writeFileSync(storePath, stored, "utf8");

    expect(
      resolveTranscriptSessionKeyBySessionId({
        agentId: "main",
        sessionId: "session-1",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toBe("agent:main:main");
    expect(fs.readFileSync(storePath, "utf8")).toBe(stored);
  });
});
