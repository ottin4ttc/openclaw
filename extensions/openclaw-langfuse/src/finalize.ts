import type Langfuse from "langfuse";
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { redactObject } from "./redact.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import { writeObservationEvent } from "./session.js";
import type { TraceContextEntry } from "./trace-context.js";
import type { SessionEntry } from "./types.js";
import {
  generateObservationId,
  isToolCallBlock,
  qualifiedModel,
  truncatePayload,
  buildApiMessage,
  buildGenerationOutput,
  findAggregateOnlyUsageEntry,
  usageDetailsFromUsage,
  messageTimestamp,
  assistantStartTimestamp,
  assistantEndTimestamp,
  isTraceContextInputEntry,
  isTraceableAssistantEntry,
  normalizeModelCallInput,
} from "./utils.js";

function entryIndex(entries: SessionEntry[], entry: SessionEntry, fallback: number): number {
  const index = entries.indexOf(entry);
  return index >= 0 ? index : fallback;
}

function turnStartIndex(allEntries: SessionEntry[], turnEntries: SessionEntry[]): number {
  const firstTurnEntry = turnEntries[0];
  return firstTurnEntry ? entryIndex(allEntries, firstTurnEntry, 0) : 0;
}

function toolResultEntriesById(turnEntries: SessionEntry[]): Map<string, SessionEntry> {
  const resultEntries = new Map<string, SessionEntry>();
  for (const entry of turnEntries) {
    const msg = entry.message;
    if (msg.role !== "toolResult" && msg.role !== "tool") {
      continue;
    }
    const toolCallId =
      typeof msg.toolCallId === "string"
        ? msg.toolCallId
        : typeof msg.tool_call_id === "string"
          ? msg.tool_call_id
          : undefined;
    if (toolCallId && !resultEntries.has(toolCallId)) {
      resultEntries.set(toolCallId, entry);
    }
  }
  return resultEntries;
}

function toolResultOutput(msg: Record<string, unknown>): unknown {
  if ("content" in msg) {
    return msg.content;
  }
  if ("result" in msg) {
    return msg.result;
  }
  return undefined;
}

function markObservationBarrierIncomplete(entry: TraceContextEntry): void {
  entry.observationLedgerIncomplete = true;
}

function canonicalCostDetails(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cost = value as Record<string, unknown>;
  const details: Record<string, number> = {};
  for (const key of ["input", "output", "total"] as const) {
    const field = cost[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
      continue;
    }
    details[key] = field;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function finalizeToolSpansFromEntries(
  entry: TraceContextEntry,
  turnEntries: SessionEntry[],
  agentId: string,
  sessionId: string,
  redactEnabled: boolean,
  ctx: FinalizeContext,
): void {
  const { logger, stateDir } = ctx;
  const resultEntries = toolResultEntriesById(turnEntries);

  for (const toolEntry of turnEntries) {
    const msg = toolEntry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content as Record<string, unknown>[]) {
      if (!isToolCallBlock(block) || typeof block.id !== "string") {
        continue;
      }

      const toolCallId = block.id;
      if (entry.completedSpanToolCallIds.has(toolCallId)) {
        continue;
      }

      const toolName = String(block.name ?? "unknown");
      const spanId = generateObservationId(entry.traceId, "span", toolCallId);
      const input = block.input ?? block.args ?? block.arguments ?? {};
      let span = entry.pendingSpans.get(toolCallId);
      if (!span) {
        const startTime = new Date(messageTimestamp(toolEntry));
        const startLedgerWritten = writeObservationEvent(
          stateDir,
          agentId,
          sessionId,
          {
            e: "span-start",
            traceId: entry.traceId,
            id: spanId,
            tool: toolName,
            toolCallId,
            ts: startTime.toISOString(),
          },
          logger,
        );
        if (
          !startLedgerWritten ||
          ctx.onBeforeSdkEnqueue?.(entry, spanId, "span-create", "jsonl-finalize span") === false
        ) {
          markObservationBarrierIncomplete(entry);
          continue;
        }
        span = entry.trace.span({
          id: spanId,
          name: `tool:${toolName}`,
          startTime,
          input: redactObject(truncatePayload(input), redactEnabled),
          metadata: {
            toolName,
            toolCallId,
            source: "jsonl-finalize",
          },
        });
        entry.pendingSpans.set(toolCallId, span);
      }

      const resultEntry = resultEntries.get(toolCallId);
      const endTime = new Date(
        resultEntry ? messageTimestamp(resultEntry) : messageTimestamp(toolEntry),
      );
      const outputPayload = resultEntry ? toolResultOutput(resultEntry.message) : undefined;
      const isError = resultEntry?.message.isError === true;
      const endLedgerWritten = writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        { e: "span-end", traceId: entry.traceId, id: spanId, ts: endTime.toISOString() },
        logger,
      );
      if (
        !endLedgerWritten ||
        ctx.onBeforeSdkEnqueue?.(entry, spanId, "span-update", "jsonl-finalize span update") ===
          false
      ) {
        markObservationBarrierIncomplete(entry);
        continue;
      }
      span.update({
        endTime,
        output: redactObject(truncatePayload(outputPayload), redactEnabled),
        metadata: {
          toolName,
          toolCallId,
          source: "jsonl-finalize",
          ...(isError ? { isError: true } : {}),
        },
        ...(isError
          ? {
              level: "ERROR" as const,
              statusMessage: "tool returned an error result",
            }
          : {}),
      });
      entry.pendingSpans.delete(toolCallId);
      (entry.completedSpans ??= new Map()).set(toolCallId, span);
      entry.completedSpanToolCallIds.add(toolCallId);
    }
  }
}

/**
 * Compute corrected startTimes for each generation from JSONL timeline.
 * gen-1 starts at entryTimestamp; gen-N starts after the last toolResult before it.
 * This keeps the generation timeline aligned with the transcript order.
 */
export function computeCorrectedStartTimes(
  assistantMsgs: SessionEntry[],
  turnEntries: SessionEntry[],
  entryTimestamp: number,
): (number | undefined)[] {
  return assistantMsgs.map((assistantEntry, i) => {
    if (i === 0) {
      return entryTimestamp;
    }

    // Find the last toolResult timestamp before this assistant message.
    // Scan all entries (no early break) to handle potentially out-of-order JSONL writes.
    const assistantTs = assistantStartTimestamp(assistantEntry);
    let lastToolResultTs: number | undefined;
    for (const te of turnEntries) {
      if (messageTimestamp(te) >= assistantTs) {
        continue;
      }
      if (te.message.role === "toolResult") {
        const ts = messageTimestamp(te);
        if (!lastToolResultTs || ts > lastToolResultTs) {
          lastToolResultTs = ts;
        }
      }
    }
    // Fall back to previous assistant message timestamp if no toolResult found
    const previousAssistant = assistantMsgs[i - 1];
    return (
      lastToolResultTs ??
      (previousAssistant ? assistantEndTimestamp(previousAssistant) : entryTimestamp)
    );
  });
}

export interface FinalizeContext {
  logger: PluginLogger | null;
  stateDir: string | null;
  langfuseClient: Langfuse | null;
  onBeforeSdkEnqueue?: (
    entry: TraceContextEntry,
    observationId: string,
    eventType: SdkDeliveryEventType,
    source: string,
  ) => boolean;
}

/**
 * Finalize incremental observations in agentEnd.
 * Completes orphan generations from the incremental path (llmInput/llmOutput)
 * and keeps tool activity as generation content plus trace metadata only.
 */
export function finalizeIncrementalObservations(
  entry: TraceContextEntry,
  turnEntries: SessionEntry[],
  allEntries: SessionEntry[],
  agentId: string,
  sessionId: string,
  redactEnabled: boolean,
  ctx: FinalizeContext,
): void {
  const { logger, stateDir } = ctx;
  const assistantMsgs = turnEntries.filter(isTraceableAssistantEntry);
  const aggregateOnlyUsageEntry = findAggregateOnlyUsageEntry(assistantMsgs, turnEntries);
  const firstTurnEntryIndex = turnStartIndex(allEntries, turnEntries);
  const orphanCompletedGenIdxs = new Set<number>();

  // 1. Complete orphan pending generations (llmOutput didn't fire)
  if (entry.pendingGenerations.size > 0) {
    logger?.debug?.(
      `Langfuse: agentEnd completing ${entry.pendingGenerations.size} orphan generation(s)`,
    );
    // Match orphan generations to JSONL assistant messages by their gen index
    // (extracted from genId like "traceId-gen-N"), not positional order.
    // This handles the case where some generations were completed by llmOutput
    // and only a subset remains as orphans.
    for (const [runId, pendingGen] of entry.pendingGenerations) {
      const genId = entry.pendingGenIds.get(runId);
      // Extract 0-based index from genId (e.g., "xxx-gen-1" → 0)
      const genNum = genId ? parseInt(genId.split("-gen-")[1] ?? "0", 10) : 0;
      const assistantEntry = assistantMsgs[genNum > 0 ? genNum - 1 : 0];
      const msg = assistantEntry?.message;
      const endTime = assistantEntry ? new Date(assistantEndTimestamp(assistantEntry)) : new Date();
      // Use buildGenerationOutput to correctly format tool_use/toolCall content,
      // not just extractTextContent which drops tool calls.
      const output = msg?.content
        ? buildGenerationOutput(msg.content, redactEnabled)
        : entry.storedOutput
          ? entry.storedOutput
          : undefined;
      const msgUsage = msg?.usage as Record<string, number> | undefined;
      const usageForGeneration = aggregateOnlyUsageEntry === assistantEntry ? undefined : msgUsage;
      const usageDetails = usageDetailsFromUsage(usageForGeneration);
      if (genId) {
        const endLedgerWritten = writeObservationEvent(
          stateDir,
          agentId,
          sessionId,
          { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
          logger,
        );
        if (
          !endLedgerWritten ||
          ctx.onBeforeSdkEnqueue?.(
            entry,
            genId,
            "generation-update",
            "jsonl-finalize generation update",
          ) === false
        ) {
          markObservationBarrierIncomplete(entry);
          continue;
        }
      }
      pendingGen.update({
        endTime,
        output:
          output !== undefined && output !== null && output !== ""
            ? truncatePayload(output)
            : undefined,
        ...(usageDetails ? { usageDetails } : {}),
        metadata: {
          provider: String(msg?.provider ?? entry.lastProvider ?? ""),
          model: msg?.model ?? entry.lastModel,
          stopReason: msg?.stopReason,
        },
      });
      entry.pendingGenIds.delete(runId);
      const completedGenIdx = genNum > 0 ? genNum : entry.completedGenerations.size + 1;
      entry.completedGenerations.set(completedGenIdx, pendingGen);
      if (genId) {
        (entry.completedGenerationIds ??= new Map()).set(completedGenIdx, genId);
      }
      orphanCompletedGenIdxs.add(completedGenIdx);
    }
    entry.pendingGenerations.clear();
  }

  // 1b. Metadata correction: update completed generations with output, startTime,
  // usageDetails, costDetails, and metadata from JSONL (authoritative source).
  // - Output: rebuilt from JSONL msg.content (fixes null output for tool_use responses)
  // - startTime: corrected from JSONL timestamps (fixes observation ordering)
  // - costDetails: only sent when canonical transcript usage explicitly reports cost
  const providerRequestOwnsGenerations =
    entry.hasProviderRequestGenerations || entry.providerRequestAugmentedHookGenerations;
  const providerSlots = new Set(entry.providerRequestGenerationIndexes?.values() ?? []);
  const exactProviderOrdinalCorrelation =
    providerRequestOwnsGenerations &&
    providerSlots.size === assistantMsgs.length &&
    assistantMsgs.length === entry.completedGenerations.size &&
    [...providerSlots].every((slot) => slot >= 1 && slot <= assistantMsgs.length);

  // Compute corrected startTimes from JSONL timeline so observations appear in correct order.
  // gen-1 starts at entry.timestamp; gen-N starts after the last toolResult before it.
  const correctedStartTimes = computeCorrectedStartTimes(
    assistantMsgs,
    turnEntries,
    entry.timestamp,
  );

  for (let i = 0; i < assistantMsgs.length; i++) {
    const genIdx = i + 1; // 1-based
    if (providerRequestOwnsGenerations) {
      if (!exactProviderOrdinalCorrelation) {
        continue;
      }
      const assistantEntry = assistantMsgs[i];
      const completedGen = entry.completedGenerations.get(genIdx);
      if (!assistantEntry || !completedGen) {
        continue;
      }
      const costDetails = canonicalCostDetails(
        (assistantEntry.message.usage as Record<string, unknown> | undefined)?.cost,
      );
      if (!costDetails) {
        continue;
      }
      const genId =
        entry.completedGenerationIds?.get(genIdx) ??
        generateObservationId(entry.traceId, "gen", genIdx);
      if (
        ctx.onBeforeSdkEnqueue?.(
          entry,
          genId,
          "generation-update",
          "jsonl-finalize provider generation cost update",
        ) === false
      ) {
        markObservationBarrierIncomplete(entry);
        continue;
      }
      completedGen.update({
        costDetails,
      });
      continue;
    }
    if (orphanCompletedGenIdxs.has(genIdx)) {
      continue;
    }

    const completedGen = entry.completedGenerations.get(genIdx);
    if (!completedGen) {
      continue;
    }

    const assistantEntry = assistantMsgs[i];
    if (!assistantEntry) {
      continue;
    }
    const msg = assistantEntry.message;
    const msgUsage = msg.usage as Record<string, number> | undefined;
    const usageForGeneration = aggregateOnlyUsageEntry === assistantEntry ? undefined : msgUsage;

    // Rebuild output from JSONL ground truth — fixes null output for tool_use responses
    const correctedOutput = msg.content
      ? truncatePayload(buildGenerationOutput(msg.content, redactEnabled))
      : undefined;

    const costDetails = canonicalCostDetails(msgUsage?.cost);

    // Corrected startTime from JSONL timeline
    const correctedStart = correctedStartTimes[i];
    const correctedEnd = assistantEndTimestamp(assistantEntry);
    const usageDetails = usageDetailsFromUsage(usageForGeneration);

    const genId =
      entry.completedGenerationIds?.get(genIdx) ??
      generateObservationId(entry.traceId, "gen", genIdx);
    // The generation already emitted gen-end when it became completed. This pass
    // only corrects SDK metadata; another ledger end would look like a second lifecycle.
    if (
      ctx.onBeforeSdkEnqueue?.(
        entry,
        genId,
        "generation-update",
        "jsonl-finalize completed generation update",
      ) === false
    ) {
      markObservationBarrierIncomplete(entry);
      continue;
    }

    completedGen.update({
      ...(correctedOutput !== undefined ? { output: correctedOutput } : {}),
      ...(correctedStart ? { startTime: new Date(correctedStart) } : {}),
      endTime: new Date(correctedEnd),
      ...(usageDetails ? { usageDetails } : {}),
      ...(costDetails ? { costDetails } : {}),
      metadata: {
        provider: String(msg.provider ?? entry.lastProvider ?? ""),
        model: msg.model ?? entry.lastModel,
        stopReason: msg.stopReason,
        ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
      },
      ...(msg.stopReason === "error" && msg.errorMessage
        ? { statusMessage: String(msg.errorMessage), level: "ERROR" as const }
        : {}),
    });
  }

  // 1c. Gap fill: create generations for LLM calls where llmInput/llmOutput didn't fire.
  // In multi-tool-use turns the hook system may only fire for the first LLM call;
  // subsequent calls are only visible in JSONL assistant messages.
  if (!providerRequestOwnsGenerations && assistantMsgs.length > entry.llmCallCount) {
    logger?.debug?.(
      `Langfuse: gap fill — ${assistantMsgs.length} assistant messages but only ${entry.llmCallCount} generation(s), creating ${assistantMsgs.length - entry.llmCallCount} missing generation(s)`,
    );
    for (let i = entry.llmCallCount; i < assistantMsgs.length; i++) {
      const genIdx = i + 1; // 1-based
      entry.llmCallCount = genIdx;
      const te = assistantMsgs[i];
      if (!te) {
        continue;
      }
      const msg = te.message;
      const genId = generateObservationId(entry.traceId, "gen", genIdx);

      // Use corrected startTime from JSONL timeline (after preceding tool results)
      const correctedStart = correctedStartTimes[i];
      const previousAssistantEntry = i > 0 ? assistantMsgs[i - 1] : undefined;
      const startTime = correctedStart
        ? new Date(correctedStart)
        : new Date(
            previousAssistantEntry
              ? assistantEndTimestamp(previousAssistantEntry)
              : entry.timestamp,
          );
      const endTime = new Date(assistantEndTimestamp(te));

      const output = buildGenerationOutput(msg.content, redactEnabled);

      // Build input as a delta: previous assistant response plus the tool results
      // since then, not the full accumulated session history.
      const currentIdx = entryIndex(allEntries, te, allEntries.length);
      const deltaStart = previousAssistantEntry
        ? entryIndex(allEntries, previousAssistantEntry, firstTurnEntryIndex)
        : firstTurnEntryIndex;
      const deltaEntries = allEntries.slice(deltaStart, currentIdx);
      const deltaMessages = deltaEntries
        .filter(isTraceContextInputEntry)
        .map((e) => buildApiMessage(e.message));
      const genInput = normalizeModelCallInput({
        model: String(msg.model ?? entry.lastModel ?? "unknown"),
        messages: deltaMessages,
        previousMessages: [],
        redactEnabled,
      }).generationInput;

      const msgUsage = msg.usage as Record<string, number> | undefined;
      const usageForGeneration = aggregateOnlyUsageEntry === te ? undefined : msgUsage;
      const genUsage = usageDetailsFromUsage(usageForGeneration);
      const gapCostDetails = canonicalCostDetails(msgUsage?.cost);

      const rawModel = String(msg.model ?? entry.lastModel ?? "unknown");
      const provider = String(msg.provider ?? entry.lastProvider ?? "");
      const model = qualifiedModel(provider, rawModel);

      const startLedgerWritten = writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        {
          e: "gen-start",
          traceId: entry.traceId,
          id: genId,
          llmCall: genIdx,
          model,
          ts: startTime.toISOString(),
        },
        logger,
      );
      const endLedgerWritten = writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
        logger,
      );
      if (
        !startLedgerWritten ||
        !endLedgerWritten ||
        ctx.onBeforeSdkEnqueue?.(
          entry,
          genId,
          "generation-create",
          "jsonl-finalize gap generation",
        ) === false
      ) {
        markObservationBarrierIncomplete(entry);
        continue;
      }

      const generation = entry.trace.generation({
        id: genId,
        name: `llm-call-${genIdx}`,
        model,
        startTime,
        endTime,
        input: genInput,
        output: truncatePayload(output),
        usageDetails: genUsage,
        ...(gapCostDetails ? { costDetails: gapCostDetails } : {}),
        metadata: {
          provider,
          model: msg.model,
          stopReason: msg.stopReason,
          ...(msg.errorMessage ? { errorMessage: msg.errorMessage } : {}),
        },
        ...(msg.stopReason === "error" && msg.errorMessage
          ? { statusMessage: String(msg.errorMessage), level: "ERROR" as const }
          : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(entry.promptClient ? { prompt: entry.promptClient as any } : {}),
      });
      entry.completedGenerations.set(genIdx, generation);
      (entry.completedGenerationIds ??= new Map()).set(genIdx, genId);

      if (provider) {
        entry.lastProvider = provider;
      }
      if (model) {
        entry.lastModel = model;
      }
    }
  }

  const toolCallIds = new Set<string>();
  for (const te of turnEntries) {
    const msg = te.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (isToolCallBlock(block) && block.id) {
          toolCallIds.add(String(block.id));
        }
      }
    }
  }
  if (toolCallIds.size > entry.toolCallCount) {
    entry.toolCallCount = toolCallIds.size;
  }
  if (!providerRequestOwnsGenerations) {
    finalizeToolSpansFromEntries(entry, turnEntries, agentId, sessionId, redactEnabled, ctx);
  }
}
