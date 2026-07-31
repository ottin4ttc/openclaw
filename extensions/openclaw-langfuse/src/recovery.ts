import fs from "node:fs";
import path from "node:path";
import type Langfuse from "langfuse";
import { resolveTranscriptSessionKeyBySessionId } from "openclaw/plugin-sdk/session-store-runtime";
import { buildObservationsFromEntries } from "./observations.js";
import { redactText } from "./redact.js";
import {
  bindSdkDeliveryTracker,
  flushSdkDeliveryThroughWatermark,
  SdkDeliveryTracker,
} from "./sdk-delivery.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import {
  readSessionMessages,
  readSessionMessagesByIdentity,
  readObservationEvents,
  resolveMarkerFilePath,
  writeObservationEvent,
  writeTraceRecoveryMarker,
  writeTraceMarker,
} from "./session.js";
import type { IncompleteTraceInfo, MinimalLogger, SessionEntry } from "./types.js";
import { extractUserMessageText, filterCurrentTurnEntries } from "./utils.js";

export const TRACE_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TRACE_RECOVERY_MAX_ATTEMPTS = 3;

type ParsedMarkers = {
  starts: Set<string>;
  ends: Set<string>;
  startTimestamps: Map<string, number>;
  recoveryAttempts: Map<string, number>;
  abandoned: Set<string>;
};

/**
 * Parse trace markers from raw file content.
 * Returns sets of started and ended traceIds.
 */
function parseMarkers(raw: string): ParsedMarkers {
  const MARKER_KEYWORD = "langfuse-trace-";
  const starts = new Set<string>();
  const ends = new Set<string>();
  const startTimestamps = new Map<string, number>();
  const recoveryAttempts = new Map<string, number>();
  const abandoned = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.includes(MARKER_KEYWORD)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "custom" && parsed?.data?.traceId) {
        const traceId = String(parsed.data.traceId);
        if (parsed.customType === "langfuse-trace-start") {
          starts.add(traceId);
          const timestamp = parseMarkerTimestamp(parsed.timestamp);
          if (timestamp !== undefined && !startTimestamps.has(traceId)) {
            startTimestamps.set(traceId, timestamp);
          }
        } else if (parsed.customType === "langfuse-trace-end") {
          ends.add(traceId);
        } else if (parsed.customType === "langfuse-trace-recovery") {
          const attempt =
            typeof parsed.data.attempt === "number" && Number.isInteger(parsed.data.attempt)
              ? Math.max(0, parsed.data.attempt)
              : 0;
          recoveryAttempts.set(traceId, Math.max(recoveryAttempts.get(traceId) ?? 0, attempt));
          if (parsed.data.outcome === "abandoned") {
            abandoned.add(traceId);
          }
        }
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return { starts, ends, startTimestamps, recoveryAttempts, abandoned };
}

/**
 * Parse inline _langfuse metadata from JSONL messages.
 * Returns traceIds found in message metadata (from before_message_write hook).
 * These are an additional recovery signal when sidecar markers are unavailable.
 */
function parseInlineLangfuseMarkers(raw: string): Map<string, number | undefined> {
  const traceIds = new Map<string, number | undefined>();
  for (const line of raw.split("\n")) {
    if (!line.includes("_langfuse")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const meta = parsed?.message?.metadata?.["_langfuse"];
      if (meta?.traceId) {
        traceIds.set(
          String(meta.traceId),
          parseMarkerTimestamp(parsed.timestamp) ?? parseMarkerTimestamp(parsed.message?.timestamp),
        );
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
export function scanIncompleteTraces(
  stateDir: string,
  logger?: MinimalLogger | null,
): IncompleteTraceInfo[] {
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
        if (!hasSidecar && stat.mtimeMs < cutoff) {
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

      const { starts, ends, startTimestamps, recoveryAttempts, abandoned } = parseMarkers(raw);

      // If using sidecar but no markers found, skip (don't fallback for empty sidecars)
      // If using session JSONL fallback, markers were already parsed from it
      for (const traceId of starts) {
        if (ends.has(traceId) || abandoned.has(traceId)) {
          continue;
        }
        const attemptCount = recoveryAttempts.get(traceId) ?? 0;
        const startedAt = startTimestamps.get(traceId);
        const abandonmentReason =
          startedAt !== undefined && startedAt < Date.now() - TRACE_RECOVERY_MAX_AGE_MS
            ? "trace_age_exceeded"
            : attemptCount >= TRACE_RECOVERY_MAX_ATTEMPTS
              ? "attempt_limit_reached"
              : undefined;
        if (abandonmentReason) {
          if (
            writeTraceRecoveryMarker(
              stateDir,
              agentId,
              sessionId,
              traceId,
              attemptCount,
              "abandoned",
              logger,
              abandonmentReason,
            )
          ) {
            abandoned.add(traceId);
          }
          continue;
        }
        results.push({
          traceId,
          agentId,
          sessionId,
          jsonlPath: sessionJsonlPath,
          ...(attemptCount > 0 ? { recoveryAttempts: attemptCount } : {}),
        });
      }

      // Supplementary: check for inline _langfuse metadata in JSONL messages.
      // This catches traces from new openclaw versions where before_message_write
      // injected identifiers but sidecar markers may be incomplete.
      if (fs.existsSync(sessionJsonlPath)) {
        const jsonlRaw = hasSidecar ? readFileOrTail(sessionJsonlPath, TAIL_BYTES) : raw;
        if (jsonlRaw) {
          const inlineTraceIds = parseInlineLangfuseMarkers(jsonlRaw);
          for (const [traceId, inlineStartedAt] of inlineTraceIds) {
            if (
              ends.has(traceId) ||
              abandoned.has(traceId) ||
              results.some((r) => r.traceId === traceId)
            ) {
              continue;
            }
            const attemptCount = recoveryAttempts.get(traceId) ?? 0;
            const abandonmentReason =
              inlineStartedAt !== undefined &&
              inlineStartedAt < Date.now() - TRACE_RECOVERY_MAX_AGE_MS
                ? "trace_age_exceeded"
                : attemptCount >= TRACE_RECOVERY_MAX_ATTEMPTS
                  ? "attempt_limit_reached"
                  : undefined;
            if (abandonmentReason) {
              if (
                writeTraceRecoveryMarker(
                  stateDir,
                  agentId,
                  sessionId,
                  traceId,
                  attemptCount,
                  "abandoned",
                  logger,
                  abandonmentReason,
                )
              ) {
                abandoned.add(traceId);
              }
              continue;
            }
            results.push({
              traceId,
              agentId,
              sessionId,
              jsonlPath: sessionJsonlPath,
              ...(attemptCount > 0 ? { recoveryAttempts: attemptCount } : {}),
            });
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
  deliveryTracker?: SdkDeliveryTracker,
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
      const candidate = allEntries[i];
      if (candidate && candidate.timestamp >= traceStartTimestamp) {
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

  const firstTurnEntry = turnEntries[0];
  if (!firstTurnEntry) {
    return 0;
  }
  const entryTimestamp = traceStartTimestamp ?? firstTurnEntry.timestamp;
  const ledger = readObservationEvents(stateDir, agentId, sessionId, traceId, logger);

  const tracker = deliveryTracker ?? new SdkDeliveryTracker();
  const localTrackerCleanups = deliveryTracker ? [] : bindSdkDeliveryTracker(lf, tracker, logger);
  const beginDelivery = async (
    observationId: string,
    eventType: SdkDeliveryEventType,
    source: string,
  ): Promise<boolean> => {
    if (tracker.begin(traceId, observationId, eventType)) {
      return true;
    }
    const watermark = tracker.watermark(traceId);
    const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, watermark);
    if (!delivery.ok) {
      logger?.warn?.(
        `Langfuse: ${delivery.reason} while draining SDK delivery tickets before ${source} during recovery (traceId=${traceId}, observationId=${observationId})`,
      );
      return false;
    }
    const accepted = tracker.begin(traceId, observationId, eventType);
    if (!accepted) {
      logger?.warn?.(
        `Langfuse: SDK delivery ticket cap remained exhausted before ${source} during recovery (traceId=${traceId}, observationId=${observationId})`,
      );
    }
    return accepted;
  };

  try {
    if (!(await beginDelivery(traceId, "trace-create", "trace create"))) {
      throw new Error(`delivery ticket cap reached for recovery trace ${traceId}`);
    }
    // Create trace with the original traceId (Langfuse upsert ensures idempotency).
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

    const obsResult = await buildObservationsFromEntries(trace, traceId, turnEntries, allEntries, {
      entryTimestamp,
      redactEnabled: config.redactEnabled,
      generationIdsBySlot: ledger.generationIdsBySlot,
      toolSpanIdsByCallId: ledger.toolSpanIdsByCallId,
      recordObservationEvent: (event) =>
        writeObservationEvent(stateDir, agentId, sessionId, event, logger),
      onBeforeSdkEnqueue: beginDelivery,
    });

    // Extract user message for trace input
    const userEntry = turnEntries.find((e) => e.message.role === "user");
    const userInputText = userEntry ? extractUserMessageText(userEntry.message.content) : undefined;

    const hasPerCallUsage = obsResult.hasReportedUsage;

    if (!(await beginDelivery(traceId, "trace-create", "trace update"))) {
      throw new Error(`delivery ticket cap reached for recovery trace update ${traceId}`);
    }
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
              ...(obsResult.reportedUsageFields.input
                ? { inputTokens: obsResult.totalUsage.input }
                : {}),
              ...(obsResult.reportedUsageFields.output
                ? { outputTokens: obsResult.totalUsage.output }
                : {}),
              ...(obsResult.reportedUsageFields.cacheRead
                ? { cacheReadInputTokens: obsResult.totalUsage.cacheRead }
                : {}),
              ...(obsResult.reportedUsageFields.cacheWrite
                ? { cacheWriteInputTokens: obsResult.totalUsage.cacheWrite }
                : {}),
              ...(obsResult.reportedUsageFields.total
                ? { totalTokens: obsResult.totalUsage.total }
                : {}),
            }
          : undefined,
        lastModel:
          obsResult.lastModel || obsResult.lastProvider
            ? { provider: obsResult.lastProvider, model: obsResult.lastModel }
            : undefined,
        ...obsResult.modelContextMetadata,
      },
    });

    if (obsResult.observationBarrierIncomplete) {
      throw new Error(`observation identity reconciliation failed for recovery trace ${traceId}`);
    }

    const watermark = tracker.watermark(traceId);
    const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, watermark);
    if (!delivery.ok) {
      throw new Error(`${delivery.reason} for recovery trace ${traceId}`);
    }

    if (!writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger)) {
      throw new Error(`failed to write recovery end marker for trace ${traceId}`);
    }
    return obsResult.llmCallCount + obsResult.toolCallCount;
  } finally {
    tracker.completeTrace(traceId, { preservePending: true });
    for (const cleanup of localTrackerCleanups) {
      cleanup();
    }
  }
}
