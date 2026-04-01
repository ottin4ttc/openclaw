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
 * Resolve the path to the sidecar marker file for a session.
 * Markers are stored separately from the session JSONL to avoid breaking
 * SessionManager's parentId DAG chain.
 */
export function resolveMarkerFilePath(
  stateDir: string,
  agentId: string,
  sessionId: string,
): string {
  return path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.langfuse-markers.jsonl`);
}

/**
 * Append a langfuse trace lifecycle marker to a sidecar file.
 * Written to `{sessionId}.langfuse-markers.jsonl` (NOT the session JSONL)
 * so the SessionManager parentId DAG chain stays intact.
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
  const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
  const line = `{"type":"custom","customType":"langfuse-trace-${type}","data":{"traceId":"${traceId}"},"timestamp":"${new Date().toISOString()}"}\n`;
  try {
    const dir = path.dirname(markerFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(markerFile, line);
  } catch (err: unknown) {
    logger?.warn?.(
      `Langfuse: failed to write trace marker (${type}) to ${markerFile} — ${String(err)}`,
    );
  }
}
