import fs from "node:fs";
import path from "node:path";
import type Langfuse from "langfuse";
import { resolveTranscriptSessionKeyBySessionId } from "openclaw/plugin-sdk/session-store-runtime";
import { buildObservationsFromEntries } from "./observations.js";
import { redactText } from "./redact.js";
import {
  readSessionMessages,
  readSessionMessagesByIdentity,
  resolveMarkerFilePath,
  writeTraceMarker,
} from "./session.js";
import type { IncompleteTraceInfo, MinimalLogger, SessionEntry } from "./types.js";
import { extractUserMessageText, filterCurrentTurnEntries } from "./utils.js";

/**
 * Parse trace markers from raw file content.
 * Returns sets of started and ended traceIds.
 */
function parseMarkers(raw: string): { starts: Set<string>; ends: Set<string> } {
  const MARKER_KEYWORD = "langfuse-trace-";
  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.includes(MARKER_KEYWORD)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "custom" && parsed?.data?.traceId) {
        if (parsed.customType === "langfuse-trace-start") {
          starts.add(String(parsed.data.traceId));
        } else if (parsed.customType === "langfuse-trace-end") {
          ends.add(String(parsed.data.traceId));
        }
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return { starts, ends };
}

/**
 * Parse inline _langfuse metadata from JSONL messages.
 * Returns traceIds found in message metadata (from before_message_write hook).
 * These are an additional recovery signal when sidecar markers are unavailable.
 */
function parseInlineLangfuseMarkers(raw: string): Set<string> {
  const traceIds = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.includes("_langfuse")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const meta = parsed?.message?.metadata?._langfuse;
      if (meta?.traceId) {
        traceIds.add(String(meta.traceId));
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return traceIds;
}

/**
 * Read file content, optionally reading only the tail for large files.
 */
function readFileOrTail(filePath: string, tailBytes: number): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= tailBytes) {
      return fs.readFileSync(filePath, "utf-8");
    }
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(tailBytes);
    fs.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
    fs.closeSync(fd);
    const str = buf.toString("utf-8");
    const firstNewline = str.indexOf("\n");
    return firstNewline >= 0 ? str.slice(firstNewline + 1) : str;
  } catch {
    return null;
  }
}

function readCompleteMarkerLedger(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function recoveryEnv(stateDir: string | null): NodeJS.ProcessEnv {
  return stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env;
}

function parseMarkerTimestamp(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readRecoverySessionMessages(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  logger?: MinimalLogger | null,
): Promise<{ entries: SessionEntry[]; sessionKey?: string }> {
  const env = recoveryEnv(stateDir);
  const sessionKey = resolveTranscriptSessionKeyBySessionId({ agentId, sessionId, env });
  if (sessionKey) {
    const sqliteEntries = await readSessionMessagesByIdentity(
      { agentId, sessionId, sessionKey, env },
      logger,
    );
    if (sqliteEntries.length > 0) {
      return { entries: sqliteEntries, sessionKey };
    }
    logger?.debug?.(
      `Langfuse: SQLite transcript empty during recovery for agent=${agentId} session=${sessionId}, trying legacy JSONL fallback`,
    );
  } else {
    logger?.debug?.(
      `Langfuse: no SQLite transcript session key for agent=${agentId} session=${sessionId}, trying legacy JSONL fallback`,
    );
  }
  return { entries: readSessionMessages(stateDir, agentId, sessionId, logger), sessionKey };
}

/**
 * Scan stateDir for incomplete traces (have trace-start but no trace-end).
 * Prioritizes sidecar `.langfuse-markers.jsonl` files; falls back to scanning
 * session JSONL for backward compatibility with old embedded markers.
 * Only processes files modified in the last 24 hours.
 */
export function scanIncompleteTraces(stateDir: string): IncompleteTraceInfo[] {
  const agentsDir = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const results: IncompleteTraceInfo[] = [];
  const TAIL_BYTES = 64 * 1024;

  let agentDirs: string[];
  try {
    agentDirs = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const agentId of agentDirs) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      continue;
    }

    let allFiles: string[];
    try {
      allFiles = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }

    // Collect session IDs from both sidecar and session JSONL files
    const sidecarFiles = new Set<string>();
    const sessionFiles = new Set<string>();
    for (const f of allFiles) {
      if (f.endsWith(".langfuse-markers.jsonl")) {
        sidecarFiles.add(f.replace(/\.langfuse-markers\.jsonl$/, ""));
      } else if (f.endsWith(".jsonl")) {
        sessionFiles.add(f.replace(/\.jsonl$/, ""));
      }
    }

    // All session IDs to check (sidecar takes priority, fallback to session JSONL)
    const allSessionIds = new Set([...sidecarFiles, ...sessionFiles]);

    for (const sessionId of allSessionIds) {
      const hasSidecar = sidecarFiles.has(sessionId);
      const markerSourceFile = hasSidecar
        ? path.join(sessionsDir, `${sessionId}.langfuse-markers.jsonl`)
        : path.join(sessionsDir, `${sessionId}.jsonl`);
      const sessionJsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);

      try {
        const stat = fs.statSync(markerSourceFile);
        if (stat.mtimeMs < cutoff) {
          continue;
        }
      } catch {
        continue;
      }

      // Current sidecars mix trace markers with observation events. A long turn can push
      // an unmatched trace-start outside a fixed tail, so marker ledgers must be complete.
      const raw = hasSidecar
        ? readCompleteMarkerLedger(markerSourceFile)
        : readFileOrTail(markerSourceFile, TAIL_BYTES);
      if (!raw) {
        continue;
      }

      const { starts, ends } = parseMarkers(raw);

      // If using sidecar but no markers found, skip (don't fallback for empty sidecars)
      // If using session JSONL fallback, markers were already parsed from it
      for (const traceId of starts) {
        if (!ends.has(traceId)) {
          results.push({ traceId, agentId, sessionId, jsonlPath: sessionJsonlPath });
        }
      }

      // Supplementary: check for inline _langfuse metadata in JSONL messages.
      // This catches traces from new openclaw versions where before_message_write
      // injected identifiers but sidecar markers may be incomplete.
      if (fs.existsSync(sessionJsonlPath)) {
        const jsonlRaw = hasSidecar ? readFileOrTail(sessionJsonlPath, TAIL_BYTES) : raw;
        if (jsonlRaw) {
          const inlineTraceIds = parseInlineLangfuseMarkers(jsonlRaw);
          for (const traceId of inlineTraceIds) {
            if (!ends.has(traceId) && !results.some((r) => r.traceId === traceId)) {
              results.push({ traceId, agentId, sessionId, jsonlPath: sessionJsonlPath });
            }
          }
        }
      }
    }
  }

  return results;
}

/**
 * Recover a single incomplete trace by rebuilding observations from the canonical transcript.
 * Writes a trace-end marker after successful recovery and flushes to Langfuse.
 * Returns the number of created observations.
 */
export async function recoverTrace(
  lf: Langfuse,
  traceInfo: IncompleteTraceInfo,
  config: { redactEnabled: boolean },
  stateDir: string | null,
  logger?: MinimalLogger | null,
): Promise<number> {
  const { traceId, agentId, sessionId } = traceInfo;
  const sidecarPath = resolveMarkerFilePath(stateDir ?? "", agentId, sessionId);
  const markerRaw = readCompleteMarkerLedger(sidecarPath);
  if (markerRaw) {
    const { ends } = parseMarkers(markerRaw);
    if (ends.has(traceId)) {
      logger?.debug?.(
        `Langfuse: skip recovery for trace ${traceId}; end marker appeared before recovery`,
      );
      return 0;
    }
  }

  const { entries: allEntries, sessionKey } = await readRecoverySessionMessages(
    stateDir,
    agentId,
    sessionId,
    logger,
  );
  if (allEntries.length === 0) {
    return 0;
  }

  // Find entries belonging to this trace: everything after the trace-start marker.
  // First try to read trace-start timestamp from sidecar marker file,
  // then fall back to scanning the session JSONL for old embedded markers.
  let traceStartIdx = -1;
  let traceStartTimestamp: number | undefined;
  let nextTraceBoundaryTimestamp: number | undefined;

  // Try sidecar file first
  let foundInSidecar = false;
  try {
    const sidecarRaw = fs.readFileSync(sidecarPath, "utf-8");
    for (const line of sidecarRaw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (
          parsed?.type === "custom" &&
          parsed?.customType === "langfuse-trace-start" &&
          parsed?.data?.traceId === traceId
        ) {
          traceStartTimestamp = parseMarkerTimestamp(parsed.timestamp);
          foundInSidecar = true;
          continue;
        }
        if (
          foundInSidecar &&
          parsed?.type === "custom" &&
          parsed?.customType === "langfuse-trace-start" &&
          parsed?.data?.traceId !== traceId
        ) {
          nextTraceBoundaryTimestamp = parseMarkerTimestamp(parsed.timestamp);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* sidecar not found — fall through to JSONL scan */
  }

  // Re-read raw JSONL to find trace-start position relative to message entries
  let lines: string[] = [];
  try {
    const raw = fs.readFileSync(traceInfo.jsonlPath, "utf-8");
    lines = raw.split(/\r?\n/);
  } catch {
    if (!foundInSidecar) {
      return 0;
    }
  }

  let messageLineIdx = 0;
  let nextTraceBoundaryIdx = -1;
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (
        parsed?.type === "custom" &&
        parsed?.customType === "langfuse-trace-start" &&
        parsed?.data?.traceId === traceId
      ) {
        // Found old embedded marker — use its timestamp if sidecar didn't have one
        if (!foundInSidecar) {
          traceStartTimestamp = parseMarkerTimestamp(parsed.timestamp);
        }
        traceStartIdx = messageLineIdx;
      } else if (
        traceStartIdx >= 0 &&
        parsed?.type === "custom" &&
        parsed?.customType === "langfuse-trace-start" &&
        parsed?.data?.traceId !== traceId
      ) {
        nextTraceBoundaryIdx = messageLineIdx;
        if (nextTraceBoundaryTimestamp === undefined) {
          nextTraceBoundaryTimestamp = parseMarkerTimestamp(parsed.timestamp);
        }
        break;
      } else if (parsed?.message) {
        messageLineIdx++;
      }
    } catch {
      /* ignore */
    }
  }

  // If marker was in sidecar but not in JSONL, use timestamp to find position
  if (foundInSidecar && traceStartIdx < 0 && traceStartTimestamp) {
    // Find the first message entry at or after the trace-start timestamp
    for (let i = 0; i < allEntries.length; i++) {
      if (allEntries[i].timestamp >= traceStartTimestamp) {
        traceStartIdx = i;
        break;
      }
    }
  }

  if (traceStartIdx < 0) {
    return 0;
  }

  const traceEndIdx =
    nextTraceBoundaryIdx >= 0
      ? nextTraceBoundaryIdx
      : nextTraceBoundaryTimestamp !== undefined
        ? allEntries.findIndex(
            (entry, index) =>
              index > traceStartIdx && entry.timestamp >= nextTraceBoundaryTimestamp,
          )
        : -1;

  // Get entries after the trace-start marker
  const entriesAfterStart = allEntries.slice(
    traceStartIdx,
    traceEndIdx >= 0 ? traceEndIdx : undefined,
  );
  const turnEntries = filterCurrentTurnEntries(entriesAfterStart);

  if (turnEntries.length === 0) {
    return 0;
  }

  const entryTimestamp = traceStartTimestamp ?? turnEntries[0].timestamp;

  // Create trace with the original traceId (Langfuse upsert ensures idempotency)
  const trace = lf.trace({
    id: traceId,
    name: agentId,
    sessionId: sessionKey ?? sessionId,
    metadata: {
      agentId,
      sessionId,
      sessionKey,
      timestamp: entryTimestamp,
      source: "startup-recovery",
    },
  });

  const obsResult = buildObservationsFromEntries(trace, traceId, turnEntries, allEntries, {
    entryTimestamp,
    redactEnabled: config.redactEnabled,
  });

  // Extract user message for trace input
  const userEntry = turnEntries.find((e) => e.message.role === "user");
  const userInputText = userEntry ? extractUserMessageText(userEntry.message.content) : undefined;

  const hasPerCallUsage =
    obsResult.totalUsage.input > 0 ||
    obsResult.totalUsage.output > 0 ||
    obsResult.totalUsage.total > 0;

  trace.update({
    input: userInputText ? redactText(userInputText, config.redactEnabled) : undefined,
    output: obsResult.lastAssistantText
      ? redactText(obsResult.lastAssistantText, config.redactEnabled)
      : undefined,
    metadata: {
      agentId,
      sessionId,
      sessionKey,
      timestamp: entryTimestamp,
      source: "startup-recovery",
      stats: {
        llmCallCount: obsResult.llmCallCount,
        toolCallCount: obsResult.toolCallCount,
      },
      usage: hasPerCallUsage
        ? {
            inputTokens: obsResult.totalUsage.input,
            outputTokens: obsResult.totalUsage.output,
            totalTokens: obsResult.totalUsage.total,
          }
        : undefined,
      lastModel:
        obsResult.lastModel || obsResult.lastProvider
          ? { provider: obsResult.lastProvider, model: obsResult.lastModel }
          : undefined,
    },
  });

  // Flush to Langfuse
  await lf.flushAsync();

  // Write trace-end marker only after Langfuse accepts the buffered recovery.
  writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger);

  return obsResult.llmCallCount + obsResult.toolCallCount;
}
