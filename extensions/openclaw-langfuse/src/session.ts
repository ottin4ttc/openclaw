import fs from "node:fs";
import path from "node:path";
import type { SessionTranscriptTargetParams } from "openclaw/plugin-sdk/session-transcript-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "./session-transcript-compat.js";
import type { SessionEntry, MinimalLogger } from "./types.js";
export {
  readObservationEvents,
  readOpenTraceMarkerByCorrelation,
  writeObservationEvent,
  writeTraceMarker,
  writeTraceRecoveryMarker,
} from "./trace-ledger.js";
export type { ObservationEvent, TraceRecoveryOutcome } from "./trace-ledger.js";

/**
 * Read messages from a session JSONL file on disk.
 * Returns entries with timestamps so callers can derive accurate startTime/endTime.
 */
export function readSessionMessages(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  logger?: MinimalLogger | null,
): SessionEntry[] {
  if (!stateDir) {
    logger?.warn?.(`Langfuse: no stateDir available, cannot locate session JSONL`);
    return [];
  }
  const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
  return readSessionMessagesFromFile(sessionFile, logger);
}

/** Reads the 7.1 file-backed transcript through the public legacy target adapter. */
export async function readSessionMessagesByIdentity(
  target: SessionTranscriptTargetParams,
  logger?: MinimalLogger | null,
): Promise<SessionEntry[]> {
  try {
    const entries = await readVisibleSessionTranscriptMessageEntries(target);
    return entries.map((entry) => {
      const message = entry.message as Record<string, unknown>;
      const timestamp = timestampFromPersistedMessage(entry.createdAt, message);
      const sessionEntry: SessionEntry = {
        id: entry.entryId,
        timestamp,
        message,
      };
      if (entry.parentId) {
        sessionEntry.parentId = entry.parentId;
      }
      return sessionEntry;
    });
  } catch (error) {
    logger?.warn?.(
      `Langfuse: failed to read session transcript for agent=${target.agentId ?? "unknown"} session=${target.sessionId} — ${String(error)}`,
    );
    return [];
  }
}

function timestampFromPersistedMessage(
  persistedTimestamp: unknown,
  message: Record<string, unknown>,
): number {
  if (typeof persistedTimestamp === "string") {
    const parsed = Date.parse(persistedTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } else if (typeof persistedTimestamp === "number" && Number.isFinite(persistedTimestamp)) {
    return persistedTimestamp;
  }
  const messageTimestamp = message.timestamp;
  if (typeof messageTimestamp === "string") {
    const parsed = Date.parse(messageTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  } else if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  return Date.now();
}

export function readSessionMessagesFromFile(
  sessionFile: string,
  logger?: MinimalLogger | null,
): SessionEntry[] {
  if (!fs.existsSync(sessionFile)) {
    logger?.warn?.(`Langfuse: session JSONL not found: ${sessionFile}`);
    return [];
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf-8");
  } catch (err: unknown) {
    logger?.warn?.(`Langfuse: failed to read session JSONL: ${sessionFile} — ${String(err)}`);
    return [];
  }

  const lines = raw.split(/\r?\n/);
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.message) {
        const msg = parsed.message as Record<string, unknown>;
        // Derive timestamp: prefer outer entry timestamp (when JSONL line was written,
        // i.e. message completion time) over inner message.timestamp (which for assistant
        // messages is the LLM call initiation time, not completion time).
        const ts = timestampFromPersistedMessage(parsed.timestamp, msg);
        entries.push({
          ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
          ...(typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {}),
          timestamp: ts,
          message: msg,
        });
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return entries;
}
