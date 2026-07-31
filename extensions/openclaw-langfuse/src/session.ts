import fs from "node:fs";
import path from "node:path";
import {
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { SessionEntry, MinimalLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Observation lifecycle event types for the sidecar ledger
// ---------------------------------------------------------------------------

export type ObservationEvent =
  | { e: "gen-start"; traceId: string; id: string; llmCall: number; model: string; ts: string }
  | { e: "gen-end"; traceId: string; id: string; ts: string }
  | { e: "span-start"; traceId: string; id: string; tool: string; toolCallId: string; ts: string }
  | { e: "span-end"; traceId: string; id: string; ts: string };

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

/** Reads the current SQLite-backed transcript through OpenClaw's public session identity API. */
export async function readSessionMessagesByIdentity(
  target: SessionTranscriptTargetParams,
  logger?: MinimalLogger | null,
): Promise<SessionEntry[]> {
  try {
    const entries = await readVisibleSessionTranscriptMessageEntries(target);
    return entries.map((entry) => {
      const message = entry.message as unknown as Record<string, unknown>;
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
  options?: { correlationKey?: string },
): boolean {
  if (!stateDir || !sessionId) {
    return true;
  }
  const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
  const line = `${JSON.stringify({
    type: "custom",
    customType: `langfuse-trace-${type}`,
    data: {
      traceId,
      ...(options?.correlationKey ? { correlationKey: options.correlationKey } : {}),
    },
    timestamp: new Date().toISOString(),
  })}\n`;
  try {
    const dir = path.dirname(markerFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(markerFile, line);
    return true;
  } catch (err: unknown) {
    logger?.warn?.(
      `Langfuse: failed to write trace marker (${type}) to ${markerFile} — ${String(err)}`,
    );
    return false;
  }
}

export type TraceRecoveryOutcome = "started" | "succeeded" | "failed" | "abandoned";

export function writeTraceRecoveryMarker(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  traceId: string,
  attempt: number,
  outcome: TraceRecoveryOutcome,
  logger?: MinimalLogger | null,
  reason?: "trace_age_exceeded" | "attempt_limit_reached",
): boolean {
  if (!stateDir || !sessionId) {
    return true;
  }
  const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
  const line = `${JSON.stringify({
    type: "custom",
    customType: "langfuse-trace-recovery",
    data: {
      traceId,
      attempt,
      outcome,
      ...(reason ? { reason } : {}),
    },
    timestamp: new Date().toISOString(),
  })}\n`;
  try {
    const dir = path.dirname(markerFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(markerFile, line);
    return true;
  } catch (err: unknown) {
    logger?.warn?.(
      `Langfuse: failed to write trace recovery marker (${outcome}) to ${markerFile} — ${String(err)}`,
    );
    return false;
  }
}

export function readOpenTraceMarkerByCorrelation(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  correlationKey: string,
): { traceId: string; timestamp?: number } | undefined {
  if (!stateDir || !sessionId) {
    return undefined;
  }
  let lines: string[];
  try {
    lines = fs
      .readFileSync(resolveMarkerFilePath(stateDir, agentId, sessionId), "utf8")
      .split("\n");
  } catch {
    return undefined;
  }
  const terminalTraceIds = new Set<string>();
  const matchingStarts: Array<{ traceId: string; timestamp?: number }> = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const marker = JSON.parse(line) as {
        customType?: string;
        data?: { traceId?: string; correlationKey?: string; outcome?: string };
        timestamp?: string;
      };
      const traceId = marker.data?.traceId;
      if (!traceId) {
        continue;
      }
      if (marker.customType === "langfuse-trace-end") {
        terminalTraceIds.add(traceId);
      } else if (
        marker.customType === "langfuse-trace-recovery" &&
        marker.data?.outcome === "abandoned"
      ) {
        terminalTraceIds.add(traceId);
      } else if (
        marker.customType === "langfuse-trace-start" &&
        marker.data?.correlationKey === correlationKey
      ) {
        const timestamp = marker.timestamp ? Date.parse(marker.timestamp) : Number.NaN;
        matchingStarts.push({
          traceId,
          ...(Number.isFinite(timestamp) ? { timestamp } : {}),
        });
      }
    } catch {
      continue;
    }
  }
  return matchingStarts.toReversed().find((marker) => !terminalTraceIds.has(marker.traceId));
}

/**
 * Append an observation lifecycle event to the sidecar file.
 * Used to track which observations have been created/completed for
 * incremental display and crash recovery.
 * Non-fatal: errors are logged as warnings only.
 */
export function writeObservationEvent(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  event: ObservationEvent,
  logger?: MinimalLogger | null,
): boolean {
  if (!stateDir || !sessionId) {
    return true;
  }
  const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
  try {
    const dir = path.dirname(markerFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(markerFile, JSON.stringify(event) + "\n");
    return true;
  } catch (err: unknown) {
    logger?.warn?.(
      `Langfuse: failed to write observation event (${event.e}) to ${markerFile} — ${String(err)}`,
    );
    return false;
  }
}

/**
 * Read observation lifecycle events from the sidecar file for a specific trace.
 * Returns the set of observation IDs that have been created (gen-start or span-start).
 */
export function readObservationEvents(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  traceId: string,
  _logger?: MinimalLogger | null,
): {
  createdIds: Set<string>;
  completedIds: Set<string>;
  generationIdsBySlot: Map<number, string>;
  toolSpanIdsByCallId: Map<string, string>;
} {
  const createdIds = new Set<string>();
  const completedIds = new Set<string>();
  const generationIdsBySlot = new Map<number, string>();
  const toolSpanIdsByCallId = new Map<string, string>();
  if (!stateDir || !sessionId) {
    return { createdIds, completedIds, generationIdsBySlot, toolSpanIdsByCallId };
  }
  const markerFile = resolveMarkerFilePath(stateDir, agentId, sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(markerFile, "utf-8");
  } catch {
    return { createdIds, completedIds, generationIdsBySlot, toolSpanIdsByCallId };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.traceId !== traceId) {
        continue;
      }
      const id = parsed.id as string | undefined;
      if (!id) {
        continue;
      }
      if (parsed.e === "gen-start" || parsed.e === "span-start") {
        createdIds.add(id);
      }
      if (parsed.e === "gen-start" && typeof parsed.llmCall === "number") {
        generationIdsBySlot.set(parsed.llmCall, id);
      }
      if (parsed.e === "span-start" && typeof parsed.toolCallId === "string") {
        toolSpanIdsByCallId.set(parsed.toolCallId, id);
      }
      if (parsed.e === "gen-end" || parsed.e === "span-end") {
        completedIds.add(id);
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return { createdIds, completedIds, generationIdsBySlot, toolSpanIdsByCallId };
}
