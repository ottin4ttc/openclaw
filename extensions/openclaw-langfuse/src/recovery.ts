import path from "node:path";
import type Langfuse from "langfuse";
import { nativeChildTraceName } from "./native-child.js";
import { buildObservationsFromEntries } from "./observations.js";
import { redactText } from "./redact.js";
import {
  bindSdkDeliveryTracker,
  flushSdkDeliveryThroughWatermark,
  SdkDeliveryTracker,
} from "./sdk-delivery.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import { resolveTranscriptSessionKeyBySessionId } from "./session-transcript-compat.js";
import {
  readSessionMessages,
  readSessionMessagesByIdentity,
  readObservationEvents,
  writeObservationEvent,
  writeTraceRecoveryMarker,
  writeTraceMarker,
} from "./session.js";
import {
  listTraceLedgerTraces,
  readNextTraceStartTimestamp,
  readTraceLedgerTrace,
} from "./trace-ledger.js";
import type { TraceLedgerTraceRecord } from "./trace-ledger.js";
import type { IncompleteTraceInfo, MinimalLogger, SessionEntry } from "./types.js";
import { extractUserMessageText, filterCurrentTurnEntries } from "./utils.js";

export const TRACE_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TRACE_RECOVERY_MAX_ATTEMPTS = 3;

async function recoverNativeChildTrace(
  lf: Langfuse,
  traceRecord: TraceLedgerTraceRecord,
  baseUrl: string,
  stateDir: string | null,
  logger?: MinimalLogger | null,
  deliveryTracker?: SdkDeliveryTracker,
): Promise<number> {
  const { traceId, agentId, sessionId } = traceRecord;
  const tracker = deliveryTracker ?? new SdkDeliveryTracker();
  const localTrackerCleanups = deliveryTracker ? [] : bindSdkDeliveryTracker(lf, tracker, logger);
  try {
    if (!tracker.begin(traceId, traceId, "trace-create")) {
      throw new Error(`delivery ticket cap reached for child recovery trace ${traceId}`);
    }
    lf.trace({
      id: traceId,
      name: nativeChildTraceName(agentId, "recovered"),
      sessionId: traceRecord.sessionKey ?? sessionId,
      input: {
        actorKind: "native-child",
        agentId,
        childThreadId: traceRecord.childThreadId,
        childTurnId: traceRecord.childTurnId,
        recoveryStatus: "partial",
      },
      output: {
        outcome: "partial",
        reason: "child_observation_payload_unavailable",
      },
      metadata: {
        actorKind: "native-child",
        source: "startup-recovery",
        recoveryStatus: "partial",
        recoveryReason: "child_observation_payload_unavailable",
        parentTraceId: traceRecord.parentTraceId,
        ...(traceRecord.parentTraceId
          ? { parentTraceUrl: `${baseUrl.replace(/\/+$/, "")}/trace/${traceRecord.parentTraceId}` }
          : {}),
        spawnObservationId: traceRecord.spawnObservationId,
        childTraceId: traceId,
        childThreadId: traceRecord.childThreadId,
        childTurnId: traceRecord.childTurnId,
      },
    });
    const watermark = tracker.watermark(traceId);
    const delivery = await flushSdkDeliveryThroughWatermark(lf, tracker, traceId, watermark);
    if (!delivery.ok) {
      throw new Error(`${delivery.reason} for child recovery trace ${traceId}`);
    }
    if (!writeTraceMarker(stateDir, agentId, sessionId, "end", traceId, logger)) {
      throw new Error(`failed to write child recovery end marker for trace ${traceId}`);
    }
    return 0;
  } finally {
    tracker.completeTrace(traceId, { preservePending: true });
    for (const cleanup of localTrackerCleanups) {
      cleanup();
    }
  }
}

function recoveryEnv(stateDir: string | null): NodeJS.ProcessEnv {
  return stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env;
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
    const transcriptEntries = await readSessionMessagesByIdentity(
      { agentId, sessionId, sessionKey, env },
      logger,
    );
    if (transcriptEntries.length > 0) {
      return { entries: transcriptEntries, sessionKey };
    }
    logger?.debug?.(
      `Langfuse: transcript empty during recovery for agent=${agentId} session=${sessionId}, trying legacy JSONL fallback`,
    );
  } else {
    logger?.debug?.(
      `Langfuse: no file-backed transcript session key for agent=${agentId} session=${sessionId}, trying direct JSONL fallback`,
    );
  }
  return { entries: readSessionMessages(stateDir, agentId, sessionId, logger), sessionKey };
}

/** Lists incomplete traces from plugin-owned state without scanning session files. */
export function scanIncompleteTraces(
  stateDir: string,
  logger?: MinimalLogger | null,
): IncompleteTraceInfo[] {
  const results: IncompleteTraceInfo[] = [];
  for (const trace of listTraceLedgerTraces(stateDir, logger)) {
    if (trace.status !== "open") {
      continue;
    }
    const attemptCount = trace.recoveryAttempts ?? 0;
    const abandonmentReason =
      trace.startedAt < Date.now() - TRACE_RECOVERY_MAX_AGE_MS
        ? "trace_age_exceeded"
        : attemptCount >= TRACE_RECOVERY_MAX_ATTEMPTS
          ? "attempt_limit_reached"
          : undefined;
    if (abandonmentReason) {
      writeTraceRecoveryMarker(
        stateDir,
        trace.agentId,
        trace.sessionId,
        trace.traceId,
        attemptCount,
        "abandoned",
        logger,
        abandonmentReason,
      );
      continue;
    }
    results.push({
      traceId: trace.traceId,
      agentId: trace.agentId,
      sessionId: trace.sessionId,
      jsonlPath: path.join(
        stateDir,
        "agents",
        trace.agentId,
        "sessions",
        `${trace.sessionId}.jsonl`,
      ),
      ...(attemptCount > 0 ? { recoveryAttempts: attemptCount } : {}),
    });
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
  config: { redactEnabled: boolean; baseUrl?: string },
  stateDir: string | null,
  logger?: MinimalLogger | null,
  deliveryTracker?: SdkDeliveryTracker,
): Promise<number> {
  const { traceId, agentId, sessionId } = traceInfo;
  const traceRecord = readTraceLedgerTrace(stateDir, traceId, logger);
  if (!traceRecord || traceRecord.status !== "open") {
    logger?.debug?.(`Langfuse: skip recovery for trace ${traceId}; trace is not open`);
    return 0;
  }
  if (traceRecord.traceKind === "native-child") {
    return recoverNativeChildTrace(
      lf,
      traceRecord,
      config.baseUrl ?? "https://cloud.langfuse.com",
      stateDir,
      logger,
      deliveryTracker,
    );
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

  const traceStartTimestamp = traceRecord.startedAt;
  const nextTraceBoundaryTimestamp = readNextTraceStartTimestamp(stateDir, traceRecord, logger);
  const traceStartIdx = allEntries.findIndex((entry) => entry.timestamp >= traceStartTimestamp);
  if (traceStartIdx < 0) {
    return 0;
  }

  const traceEndIdx =
    nextTraceBoundaryTimestamp !== undefined
      ? allEntries.findIndex(
          (entry, index) => index > traceStartIdx && entry.timestamp >= nextTraceBoundaryTimestamp,
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
