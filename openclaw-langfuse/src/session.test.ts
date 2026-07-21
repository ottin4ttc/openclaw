import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readVisibleSessionTranscriptMessageEntries } = vi.hoisted(() => ({
  readVisibleSessionTranscriptMessageEntries: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries,
}));

import { readSessionMessagesByIdentity, readSessionMessagesFromFile } from "./session.js";

describe("readSessionMessagesByIdentity", () => {
  beforeEach(() => {
    readVisibleSessionTranscriptMessageEntries.mockReset();
  });

  it("projects SQLite transcript entries into Langfuse session entries", async () => {
    readVisibleSessionTranscriptMessageEntries.mockResolvedValue([
      {
        entryId: "message-1",
        parentId: null,
        seq: 1,
        createdAt: "2026-07-17T03:04:05.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        entryId: "message-2",
        parentId: "message-1",
        seq: 2,
        createdAt: "not-a-date",
        message: {
          role: "assistant",
          content: "world",
          timestamp: "2026-07-17T03:04:06.000Z",
        },
      },
    ]);

    await expect(
      readSessionMessagesByIdentity({
        agentId: "agent-1",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:main",
      }),
    ).resolves.toEqual([
      {
        id: "message-1",
        timestamp: Date.parse("2026-07-17T03:04:05.000Z"),
        message: { role: "user", content: "hello", timestamp: 1 },
      },
      {
        id: "message-2",
        parentId: "message-1",
        timestamp: Date.parse("2026-07-17T03:04:06.000Z"),
        message: {
          role: "assistant",
          content: "world",
          timestamp: "2026-07-17T03:04:06.000Z",
        },
      },
    ]);
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledWith({
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:main",
    });
  });

  it("logs and returns no entries when the transcript read fails", async () => {
    const logger = { warn: vi.fn() };
    readVisibleSessionTranscriptMessageEntries.mockRejectedValue(new Error("read failed"));

    await expect(
      readSessionMessagesByIdentity(
        {
          agentId: "agent-1",
          sessionId: "session-1",
          sessionKey: "agent:agent-1:main",
        },
        logger,
      ),
    ).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to read session transcript"),
    );
  });
});

describe("readSessionMessagesFromFile", () => {
  it("falls back when a persisted string timestamp is malformed", () => {
    const now = 987_654;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-session-"));
    const file = path.join(dir, "session.jsonl");
    try {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            id: "message-1",
            timestamp: "not-a-date",
            message: { role: "user", content: "hello", timestamp: 1234 },
          }),
          JSON.stringify({
            id: "message-2",
            timestamp: "also-not-a-date",
            message: { role: "assistant", content: "world" },
          }),
        ].join("\n"),
      );

      expect(readSessionMessagesFromFile(file)).toEqual([
        {
          id: "message-1",
          timestamp: 1234,
          message: { role: "user", content: "hello", timestamp: 1234 },
        },
        {
          id: "message-2",
          timestamp: now,
          message: { role: "assistant", content: "world" },
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
