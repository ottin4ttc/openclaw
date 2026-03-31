import fs from "node:fs";
import path from "node:path";
import type { SessionEntry, MinimalLogger } from "./types.js";

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
        let ts: number;
        if (typeof parsed.timestamp === "string") {
          ts = Date.parse(parsed.timestamp);
        } else if (typeof parsed.timestamp === "number") {
          ts = parsed.timestamp;
        } else if (typeof msg.timestamp === "number") {
          ts = msg.timestamp;
        } else {
          ts = Date.now();
        }
        entries.push({ timestamp: ts, message: msg });
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return entries;
}

/**
 * Append a langfuse trace lifecycle marker to the session JSONL file.
 * Used by startup recovery to detect incomplete traces.
 * Non-fatal: errors are logged as warnings only.
 */
export function writeTraceMarker(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  type: "start" | "end",
  traceId: string,
  logger?: MinimalLogger | null,
): void {
  if (!stateDir || !sessionId) {
    return;
  }
  const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
  const line = `{"type":"custom","customType":"langfuse-trace-${type}","data":{"traceId":"${traceId}"},"timestamp":"${new Date().toISOString()}"}\n`;
  try {
    fs.appendFileSync(sessionFile, line);
  } catch (err: unknown) {
    logger?.warn?.(
      `Langfuse: failed to write trace marker (${type}) to ${sessionFile} — ${String(err)}`,
    );
  }
}
