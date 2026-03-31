import fs from "node:fs";
import path from "node:path";
import type Langfuse from "langfuse";
import { buildObservationsFromEntries } from "./observations.js";
import { redactText } from "./redact.js";
import { readSessionMessages, writeTraceMarker } from "./session.js";
import type { IncompleteTraceInfo, MinimalLogger } from "./types.js";
import { extractUserMessageText, filterCurrentTurnEntries } from "./utils.js";

/**
 * Scan stateDir for incomplete traces (have trace-start but no trace-end).
 * Only processes JSONL files modified in the last 24 hours.
 */
export function scanIncompleteTraces(stateDir: string): IncompleteTraceInfo[] {
  const agentsDir = path.join(stateDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const results: IncompleteTraceInfo[] = [];

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

    let sessionFiles: string[];
    try {
      sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of sessionFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          continue;
        }
      } catch {
        continue;
      }

      // Scan for trace markers efficiently. JSONL files can be very large (hundreds of MB
      // for long sessions). Markers are short lines (~120 bytes) appended at turn boundaries.
      // Strategy: read only the last TAIL_BYTES of the file — this covers all recent turns
      // while avoiding loading the entire file into memory.
      const MARKER_KEYWORD = "langfuse-trace-";
      const TAIL_BYTES = 64 * 1024; // 64KB tail — covers many turns of markers
      let raw: string;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= TAIL_BYTES) {
          raw = fs.readFileSync(filePath, "utf-8");
        } else {
          // Read only the tail of the file
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(TAIL_BYTES);
          fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
          fs.closeSync(fd);
          // Skip first partial line (we may have landed mid-line)
          const str = buf.toString("utf-8");
          const firstNewline = str.indexOf("\n");
          raw = firstNewline >= 0 ? str.slice(firstNewline + 1) : str;
        }
      } catch {
        continue;
      }

      const starts = new Set<string>();
      const ends = new Set<string>();

      // Fast scan: only JSON.parse lines that contain the marker keyword
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

      // Find traces that started but never ended
      const sessionId = file.replace(/\.jsonl$/, "");
      for (const traceId of starts) {
        if (!ends.has(traceId)) {
          results.push({ traceId, agentId, sessionId, jsonlPath: filePath });
        }
      }
    }
  }

  return results;
}

/**
 * Recover a single incomplete trace by rebuilding observations from JSONL.
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

  const allEntries = readSessionMessages(stateDir, agentId, sessionId, logger);
  if (allEntries.length === 0) {
    return 0;
  }

  // Find entries belonging to this trace: everything after the trace-start marker
  // We need to re-read the raw file to find the trace-start marker timestamp,
  // then filter entries that come after it.
  let traceStartIdx = -1;
  // Re-read raw JSONL to find trace-start position relative to message entries
  let raw: string;
  try {
    raw = fs.readFileSync(traceInfo.jsonlPath, "utf-8");
  } catch {
    return 0;
  }

  // Find the line index of the trace-start marker to determine which entries belong to this trace
  const lines = raw.split(/\r?\n/);
  let messageLineIdx = 0;
  let traceStartTimestamp: number | undefined;
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
        // Record timestamp of trace-start marker
        if (typeof parsed.timestamp === "string") {
          traceStartTimestamp = Date.parse(parsed.timestamp);
        } else if (typeof parsed.timestamp === "number") {
          traceStartTimestamp = parsed.timestamp;
        }
        traceStartIdx = messageLineIdx;
      } else if (parsed?.message) {
        messageLineIdx++;
      }
    } catch {
      /* ignore */
    }
  }

  if (traceStartIdx < 0) {
    return 0;
  }

  // Get entries after the trace-start marker
  const entriesAfterStart = allEntries.slice(traceStartIdx);
  const turnEntries = filterCurrentTurnEntries(
    entriesAfterStart.length > 0 ? entriesAfterStart : allEntries,
  );

  if (turnEntries.length === 0) {
    return 0;
  }

  const entryTimestamp = traceStartTimestamp ?? turnEntries[0].timestamp;

  // Create trace with the original traceId (Langfuse upsert ensures idempotency)
  const trace = lf.trace({
    id: traceId,
    name: agentId,
    sessionId,
    metadata: {
      agentId,
      sessionId,
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

  // Write trace-end marker to prevent re-recovery on next startup
  writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger);

  // Flush to Langfuse
  await lf.flushAsync();

  return obsResult.llmCallCount + obsResult.toolCallCount;
}
