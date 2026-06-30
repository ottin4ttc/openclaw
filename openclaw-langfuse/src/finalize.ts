import type Langfuse from "langfuse";
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { redactObject } from "./redact.js";
import { writeObservationEvent, readObservationEvents } from "./session.js";
import type { TraceContextEntry } from "./trace-context.js";
import type { SessionEntry } from "./types.js";
import {
  generateObservationId,
  isToolCallBlock,
  qualifiedModel,
  extractTextContent,
  truncatePayload,
  buildApiMessage,
  buildGenerationOutput,
} from "./utils.js";

/**
 * Compute corrected startTimes for each generation from JSONL timeline.
 * gen-1 starts at entryTimestamp; gen-N starts after the last toolResult before it.
 * This ensures generations appear after the tool spans that feed them in Langfuse UI.
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
    const assistantTs = assistantEntry.timestamp;
    let lastToolResultTs: number | undefined;
    for (const te of turnEntries) {
      if (te.timestamp >= assistantTs) {
        continue;
      }
      if (te.message.role === "toolResult") {
        const ts = typeof te.message.timestamp === "number" ? te.message.timestamp : te.timestamp;
        if (!lastToolResultTs || ts > lastToolResultTs) {
          lastToolResultTs = ts;
        }
      }
    }
    // Fall back to previous assistant message timestamp if no toolResult found
    return lastToolResultTs ?? assistantMsgs[i - 1]?.timestamp ?? entryTimestamp;
  });
}

export interface FinalizeContext {
  logger: PluginLogger | null;
  stateDir: string | null;
  langfuseClient: Langfuse | null;
}

/**
 * Finalize incremental observations in agentEnd.
 * Completes orphan generations/spans from the incremental path (llmInput/llmOutput/
 * beforeToolCall/afterToolCall) and creates fallback spans for tool calls only
 * visible in JSONL.
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
  const { logger, stateDir, langfuseClient } = ctx;

  // 1. Complete orphan pending generations (llmOutput didn't fire)
  if (entry.pendingGenerations.size > 0) {
    logger?.debug?.(
      `Langfuse: agentEnd completing ${entry.pendingGenerations.size} orphan generation(s)`,
    );
    // Match orphan generations to JSONL assistant messages by their gen index
    // (extracted from genId like "traceId-gen-N"), not positional order.
    // This handles the case where some generations were completed by llmOutput
    // and only a subset remains as orphans.
    const assistantEntries = turnEntries.filter((e) => e.message.role === "assistant");
    for (const [runId, pendingGen] of entry.pendingGenerations) {
      const genId = entry.pendingGenIds.get(runId);
      // Extract 0-based index from genId (e.g., "xxx-gen-1" → 0)
      const genNum = genId ? parseInt(genId.split("-gen-")[1] ?? "0", 10) : 0;
      const assistantEntry = assistantEntries[genNum > 0 ? genNum - 1 : 0];
      const msg = assistantEntry?.message;
      const endTime = assistantEntry ? new Date(assistantEntry.timestamp) : new Date();
      // Use buildGenerationOutput to correctly format tool_use/toolCall content,
      // not just extractTextContent which drops tool calls.
      const output = msg?.content
        ? buildGenerationOutput(msg.content, redactEnabled)
        : entry.storedOutput
          ? entry.storedOutput
          : undefined;
      const msgUsage = msg?.usage as Record<string, number> | undefined;
      pendingGen.update({
        endTime,
        output:
          output !== undefined && output !== null && output !== ""
            ? truncatePayload(output)
            : undefined,
        ...(msgUsage &&
        (msgUsage.input ||
          msgUsage.output ||
          msgUsage.totalTokens ||
          msgUsage.cacheRead ||
          msgUsage.cacheWrite)
          ? {
              usageDetails: {
                input: msgUsage.input ?? 0,
                output: msgUsage.output ?? 0,
                total: msgUsage.totalTokens ?? msgUsage.total ?? 0,
                ...(msgUsage.cacheRead ? { cache_read_input_tokens: msgUsage.cacheRead } : {}),
                ...(msgUsage.cacheWrite
                  ? { cache_creation_input_tokens: msgUsage.cacheWrite }
                  : {}),
              },
            }
          : {}),
        metadata: {
          provider: String(msg?.provider ?? entry.lastProvider ?? ""),
          model: msg?.model ?? entry.lastModel,
          stopReason: msg?.stopReason,
        },
      });
      entry.pendingGenIds.delete(runId);
      if (genId) {
        writeObservationEvent(
          stateDir,
          agentId,
          sessionId,
          { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
          logger,
        );
      }
    }
    entry.pendingGenerations.clear();
  }

  // 1b. Metadata correction: update completed generations with output, startTime,
  // usageDetails, costDetails, and metadata from JSONL (authoritative source).
  // - Output: rebuilt from JSONL msg.content (fixes null output for tool_use responses)
  // - startTime: corrected from JSONL timestamps (fixes observation ordering)
  // - costDetails: only sent when non-zero (avoids overriding Langfuse auto-calculation)
  const assistantMsgs = turnEntries.filter((e) => e.message.role === "assistant");
  logger?.info?.(
    `Langfuse: section 1b — turnEntries=${turnEntries.length} assistantMsgs=${assistantMsgs.length} completedGenerations=${entry.completedGenerations.size} llmCallCount=${entry.llmCallCount}`,
  );

  // Compute corrected startTimes from JSONL timeline so observations appear in correct order.
  // gen-1 starts at entry.timestamp; gen-N starts after the last toolResult before it.
  const correctedStartTimes = computeCorrectedStartTimes(
    assistantMsgs,
    turnEntries,
    entry.timestamp,
  );

  for (let i = 0; i < assistantMsgs.length; i++) {
    const genIdx = i + 1; // 1-based
    const completedGen = entry.completedGenerations.get(genIdx);
    if (!completedGen) {
      logger?.info?.(`Langfuse: section 1b — SKIP genIdx=${genIdx} (not in completedGenerations)`);
      continue;
    }
    logger?.info?.(`Langfuse: section 1b — FOUND genIdx=${genIdx}`);

    const msg = assistantMsgs[i].message;
    const msgUsage = msg.usage as Record<string, number> | undefined;
    logger?.debug?.(
      `Langfuse: usage correction genIdx=${genIdx} — msgUsage=${JSON.stringify(msgUsage ? { input: msgUsage.input, output: msgUsage.output, cacheRead: msgUsage.cacheRead, cacheWrite: msgUsage.cacheWrite, total: msgUsage.totalTokens ?? msgUsage.total } : null)}`,
    );

    // Rebuild output from JSONL ground truth — fixes null output for tool_use responses
    const correctedOutput = msg.content
      ? truncatePayload(buildGenerationOutput(msg.content, redactEnabled))
      : undefined;
    logger?.info?.(
      `Langfuse: finalize 1b genIdx=${genIdx} — msg.content=${msg.content ? "truthy" : "falsy"} correctedOutput=${correctedOutput !== undefined ? typeof correctedOutput : "undefined"}`,
    );

    // Only send costDetails when provider returns real (non-zero) cost data
    const costObj = msgUsage?.cost as Record<string, number> | undefined;
    const hasRealCost =
      costObj &&
      typeof costObj === "object" &&
      ((costObj.input ?? 0) > 0 || (costObj.output ?? 0) > 0 || (costObj.total ?? 0) > 0);

    // Corrected startTime from JSONL timeline
    const correctedStart = correctedStartTimes[i];

    completedGen.update({
      ...(correctedOutput !== undefined ? { output: correctedOutput } : {}),
      ...(correctedStart ? { startTime: new Date(correctedStart) } : {}),
      ...(msgUsage && (msgUsage.input || msgUsage.output || msgUsage.totalTokens || msgUsage.total)
        ? {
            usageDetails: {
              input: msgUsage.input ?? 0,
              output: msgUsage.output ?? 0,
              total: msgUsage.totalTokens ?? msgUsage.total ?? 0,
              ...(msgUsage.cacheRead ? { cache_read_input_tokens: msgUsage.cacheRead } : {}),
              ...(msgUsage.cacheWrite ? { cache_creation_input_tokens: msgUsage.cacheWrite } : {}),
            },
          }
        : {}),
      ...(hasRealCost
        ? {
            costDetails: {
              input: costObj.input ?? 0,
              output: costObj.output ?? 0,
              total: costObj.total ?? 0,
            },
          }
        : {}),
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
  entry.completedGenerations.clear();

  // 1c. Gap fill: create generations for LLM calls where llmInput/llmOutput didn't fire.
  // In multi-tool-use turns the hook system may only fire for the first LLM call;
  // subsequent calls are only visible in JSONL assistant messages.
  if (assistantMsgs.length > entry.llmCallCount) {
    logger?.debug?.(
      `Langfuse: gap fill — ${assistantMsgs.length} assistant messages but only ${entry.llmCallCount} generation(s), creating ${assistantMsgs.length - entry.llmCallCount} missing generation(s)`,
    );
    for (let i = entry.llmCallCount; i < assistantMsgs.length; i++) {
      const genIdx = i + 1; // 1-based
      entry.llmCallCount = genIdx;
      const te = assistantMsgs[i];
      const msg = te.message;
      const genId = generateObservationId(entry.traceId, "gen", genIdx);

      // Use corrected startTime from JSONL timeline (after preceding tool results)
      const correctedStart = correctedStartTimes[i];
      const startTime = correctedStart
        ? new Date(correctedStart)
        : new Date(i > 0 ? assistantMsgs[i - 1].timestamp : entry.timestamp);
      const endTime = new Date(te.timestamp);

      const output = buildGenerationOutput(msg.content, redactEnabled);

      // Build input: all session entries prior to this assistant message
      const allPriorEntries = allEntries.slice(0, allEntries.indexOf(te));
      const accumulatedMessages = allPriorEntries.map((e) => buildApiMessage(e.message));
      const genInput = redactObject(
        { model: String(msg.model ?? entry.lastModel ?? "unknown"), messages: accumulatedMessages },
        redactEnabled,
      );

      const msgUsage = msg.usage as Record<string, number> | undefined;
      let genUsage: Record<string, number> | undefined;
      if (
        msgUsage &&
        (msgUsage.input || msgUsage.output || msgUsage.totalTokens || msgUsage.total)
      ) {
        genUsage = {
          input: msgUsage.input ?? 0,
          output: msgUsage.output ?? 0,
          total: msgUsage.totalTokens ?? msgUsage.total ?? 0,
          ...(msgUsage.cacheRead ? { cache_read_input_tokens: msgUsage.cacheRead } : {}),
          ...(msgUsage.cacheWrite ? { cache_creation_input_tokens: msgUsage.cacheWrite } : {}),
        };
      }

      const rawModel = String(msg.model ?? entry.lastModel ?? "unknown");
      const provider = String(msg.provider ?? entry.lastProvider ?? "");
      const model = qualifiedModel(provider, rawModel);

      entry.trace.generation({
        id: genId,
        name: `llm-call-${genIdx}`,
        model,
        startTime,
        endTime,
        input: truncatePayload(genInput),
        output: truncatePayload(output),
        usageDetails: genUsage,
        ...(() => {
          const gapCostObj = msgUsage?.cost as Record<string, number> | undefined;
          const gapHasRealCost =
            gapCostObj &&
            typeof gapCostObj === "object" &&
            ((gapCostObj.input ?? 0) > 0 ||
              (gapCostObj.output ?? 0) > 0 ||
              (gapCostObj.total ?? 0) > 0);
          return gapHasRealCost
            ? {
                costDetails: {
                  input: gapCostObj.input ?? 0,
                  output: gapCostObj.output ?? 0,
                  total: gapCostObj.total ?? 0,
                },
              }
            : {};
        })(),
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

      writeObservationEvent(
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
      writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        { e: "gen-end", traceId: entry.traceId, id: genId, ts: endTime.toISOString() },
        logger,
      );

      if (provider) {
        entry.lastProvider = provider;
      }
      if (model) {
        entry.lastModel = model;
      }
    }
    // Flush gap-filled generations before creating tool spans
    langfuseClient?.flushAsync().catch((e: unknown) => {
      logger?.debug?.(`Langfuse: flushAsync failed (gap-fill): ${String(e)}`);
    });
  }

  // Build toolResult map from JSONL once — reused by both orphan span completion and fallback spans
  const toolResultMap = new Map<string, { ts: number; content: unknown; error?: string }>();
  for (const te of turnEntries) {
    const msg = te.message;
    if (msg.role === "toolResult" && msg.toolCallId) {
      const id = String(msg.toolCallId);
      toolResultMap.set(id, {
        ts: typeof msg.timestamp === "number" ? msg.timestamp : te.timestamp,
        content: msg.content,
        error: msg.isError ? extractTextContent(msg.content) : undefined,
      });
    }
  }

  // 2. Complete orphan pending spans (afterToolCall didn't fire)
  const completedOrphanSpanIds = new Set<string>();
  if (entry.pendingSpans.size > 0) {
    logger?.debug?.(`Langfuse: agentEnd completing ${entry.pendingSpans.size} orphan span(s)`);
    for (const [toolCallId, span] of entry.pendingSpans) {
      const result = toolResultMap.get(toolCallId);
      const endTime = result ? new Date(result.ts) : new Date();
      span.update({
        endTime,
        output: result?.error
          ? { error: result.error }
          : result?.content
            ? redactObject(truncatePayload(result.content), redactEnabled)
            : undefined,
        statusMessage: result?.error,
        level: result?.error ? "ERROR" : "DEFAULT",
      });
      completedOrphanSpanIds.add(toolCallId);
      const spanId = generateObservationId(entry.traceId, "span", toolCallId);
      writeObservationEvent(
        stateDir,
        agentId,
        sessionId,
        { e: "span-end", traceId: entry.traceId, id: spanId, ts: endTime.toISOString() },
        logger,
      );
    }
    entry.pendingSpans.clear();
  }

  // 3. Create fallback spans for tool calls in JSONL not tracked by beforeToolCall
  const { createdIds: existingSpanIds } = readObservationEvents(
    stateDir,
    agentId,
    sessionId,
    entry.traceId,
    logger,
  );
  for (const toolCallId of entry.completedSpanToolCallIds) {
    existingSpanIds.add(generateObservationId(entry.traceId, "span", toolCallId));
  }
  for (const toolCallId of completedOrphanSpanIds) {
    existingSpanIds.add(generateObservationId(entry.traceId, "span", toolCallId));
  }
  let fallbackSpanCount = 0;
  for (const te of turnEntries) {
    const msg = te.message;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (!isToolCallBlock(block) || !block.id) {
          continue;
        }
        const toolCallId = String(block.id);
        const spanId = generateObservationId(entry.traceId, "span", toolCallId);
        if (existingSpanIds.has(spanId)) {
          continue;
        } // already created

        // Look up toolResult from shared map (O(1) instead of O(n) find)
        const result = toolResultMap.get(toolCallId);
        if (!result) {
          continue;
        }

        const callTs = te.timestamp;

        entry.trace.span({
          id: spanId,
          name: `tool:${String(block.name ?? "unknown")}`,
          startTime: new Date(callTs),
          endTime: new Date(result.ts),
          input: block.input
            ? redactObject(truncatePayload(block.input), redactEnabled)
            : undefined,
          output: result.error
            ? { error: result.error }
            : redactObject(truncatePayload(result.content), redactEnabled),
          statusMessage: result.error,
          level: result.error ? "ERROR" : "DEFAULT",
          metadata: { durationMs: result.ts - callTs },
        });
        fallbackSpanCount++;
      }
    }
  }
  if (fallbackSpanCount > 0) {
    logger?.debug?.(
      `Langfuse: agentEnd created ${fallbackSpanCount} fallback tool span(s) from JSONL`,
    );
  }
}
