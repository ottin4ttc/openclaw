/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type Langfuse from "langfuse";
import type { LangfuseGenerationClient, LangfuseTraceClient } from "langfuse";
import { redactObject } from "./redact.js";
import type { SessionEntry, MinimalLogger } from "./types.js";
import {
  buildApiMessage,
  buildGenerationOutput,
  extractTextContent,
  addUsageToTotals,
  findAggregateOnlyUsageEntry,
  generateObservationId,
  hasNonZeroUsage,
  isToolCallBlock,
  qualifiedModel,
  truncatePayload,
  usageDetailsFromUsage,
  messageTimestamp,
  assistantEndTimestamp,
  isTraceContextInputEntry,
  isTraceableAssistantEntry,
} from "./utils.js";

function entryIndex(entries: SessionEntry[], entry: SessionEntry, fallback: number): number {
  const index = entries.indexOf(entry);
  return index >= 0 ? index : fallback;
}

function turnStartIndex(allEntries: SessionEntry[], turnEntries: SessionEntry[]): number {
  const firstTurnEntry = turnEntries[0];
  return firstTurnEntry ? entryIndex(allEntries, firstTurnEntry, 0) : 0;
}

export function countToolCallsFromMessages(messages: unknown[]): number {
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown> | null;
        if (isToolCallBlock(b) && b.id) {
          toolCallIds.add(String(b.id));
        }
      }
    }
  }
  return toolCallIds.size;
}

/**
 * Build Langfuse generation observations from session entries.
 * Extracted from agentEnd so the same logic can be used for startup recovery.
 * Returns aggregated counts and usage for trace metadata.
 */
export function buildObservationsFromEntries(
  trace: LangfuseTraceClient,
  traceId: string,
  turnEntries: SessionEntry[],
  allEntries: SessionEntry[],
  options: {
    entryTimestamp: number;
    systemPrompt?: string;
    storedUsage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    promptClient?: unknown;
    lastModel?: string;
    lastProvider?: string;
    redactEnabled: boolean;
    langfuseClient?: Langfuse;
  },
  logger?: MinimalLogger | null,
): {
  llmCallCount: number;
  toolCallCount: number;
  lastAssistantText?: string;
  lastProvider?: string;
  lastModel?: string;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  completedGenerations: Map<number, LangfuseGenerationClient>;
} {
  const { entryTimestamp, storedUsage, promptClient, redactEnabled } = options;

  let llmCallCount = 0;
  let toolCallCount = 0;
  let lastAssistantText: string | undefined;
  let lastProvider: string | undefined = options.lastProvider;
  let lastModel: string | undefined = options.lastModel;
  let prevTimestamp: number | undefined;

  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const completedGenerations = new Map<number, LangfuseGenerationClient>();
  let hasReportedUsage = false;

  const assistantEntries = turnEntries.filter(isTraceableAssistantEntry);
  const assistantCount = assistantEntries.length;
  const aggregateOnlyUsageEntry = findAggregateOnlyUsageEntry(assistantEntries, turnEntries);
  const aggregateOnlyUsage = aggregateOnlyUsageEntry?.message.usage as
    | Record<string, number>
    | undefined;
  if (hasNonZeroUsage(aggregateOnlyUsage)) {
    hasReportedUsage = true;
    addUsageToTotals(totalUsage, aggregateOnlyUsage);
  }
  const firstTurnEntryIndex = turnStartIndex(allEntries, turnEntries);

  // Create a generation for each assistant message in the turn
  for (const te of turnEntries) {
    const msg = te.message;

    if (isTraceableAssistantEntry(te)) {
      llmCallCount += 1;
      const isLast = llmCallCount === assistantCount;

      const assistantTs = assistantEndTimestamp(te);
      const startTime = prevTimestamp ? new Date(prevTimestamp) : new Date(entryTimestamp);
      const endTime = new Date(assistantTs);

      // Build output (D3 format)
      const output = buildGenerationOutput(msg.content, redactEnabled);

      // Build generation input as a delta: previous assistant response plus
      // tool results since then, not the full accumulated session history.
      // System prompt is recorded once at trace level (metadata.system_prompt),
      // not duplicated in each generation input.
      const currentIdx = entryIndex(allEntries, te, allEntries.length);
      const prevAssistantEntry =
        llmCallCount > 1 ? assistantEntries.at(llmCallCount - 2) : undefined;
      const deltaStart = prevAssistantEntry
        ? entryIndex(allEntries, prevAssistantEntry, firstTurnEntryIndex)
        : firstTurnEntryIndex;
      const deltaEntries = allEntries.slice(deltaStart, currentIdx);
      const deltaMessages = deltaEntries
        .filter(isTraceContextInputEntry)
        .map((e) => buildApiMessage(e.message));
      const genInput = redactObject(
        {
          model: String(msg.model ?? options.lastModel ?? "unknown"),
          messages: deltaMessages,
        },
        redactEnabled,
      );

      // Extract per-call usage from JSONL assistant message
      const msgUsage = msg.usage as Record<string, number> | undefined;
      const usageForGeneration = aggregateOnlyUsageEntry === te ? undefined : msgUsage;
      let genUsage: Record<string, number> | undefined;

      if (hasNonZeroUsage(usageForGeneration)) {
        hasReportedUsage = true;
        genUsage = usageDetailsFromUsage(usageForGeneration);
        addUsageToTotals(totalUsage, usageForGeneration);
      } else if (isLast && storedUsage && !aggregateOnlyUsageEntry) {
        // Fall back to stored usage from llm_output for last generation
        genUsage = usageDetailsFromUsage(storedUsage as Record<string, number>);
        totalUsage.input += storedUsage.input ?? 0;
        totalUsage.output += storedUsage.output ?? 0;
        totalUsage.cacheRead += storedUsage.cacheRead ?? 0;
        totalUsage.cacheWrite += storedUsage.cacheWrite ?? 0;
        totalUsage.total += storedUsage.total ?? 0;
      }

      const rawModel = String(msg.model ?? options.lastModel ?? "unknown");
      const provider = String(msg.provider ?? options.lastProvider ?? "");
      const model = qualifiedModel(provider, rawModel);

      const genData = {
        id: generateObservationId(traceId, "gen", llmCallCount),
        name: `llm-call-${llmCallCount}`,
        model,
        startTime,
        endTime,
        input: truncatePayload(genInput),
        output: truncatePayload(output),
        usageDetails: genUsage as Record<string, number> | undefined,
        ...(() => {
          const batchCostObj = msgUsage?.cost as Record<string, number> | undefined;
          const batchHasRealCost =
            batchCostObj &&
            typeof batchCostObj === "object" &&
            ((batchCostObj.input ?? 0) > 0 ||
              (batchCostObj.output ?? 0) > 0 ||
              (batchCostObj.total ?? 0) > 0);
          return batchHasRealCost
            ? {
                costDetails: {
                  input: batchCostObj.input ?? 0,
                  output: batchCostObj.output ?? 0,
                  total: batchCostObj.total ?? 0,
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
          ? {
              statusMessage: String(msg.errorMessage),
              level: "ERROR" as const,
            }
          : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...(promptClient ? { prompt: promptClient as any } : {}),
      };

      const generation = trace.generation(genData);
      completedGenerations.set(llmCallCount, generation);

      // Track last assistant text for trace output
      const text = extractTextContent(msg.content);
      if (text) {
        lastAssistantText = text;
      }
      lastProvider = provider;
      lastModel = model;
    } else {
      // non-assistant entries (user, toolResult) are captured via allEntries
    }

    if (isTraceableAssistantEntry(te)) {
      prevTimestamp = assistantEndTimestamp(te);
    } else if (isTraceContextInputEntry(te)) {
      prevTimestamp = messageTimestamp(te);
    }
  }

  // Flush generations before final trace metadata updates to prevent oversized batches.
  // Generation inputs accumulate all prior messages and can be very large;
  // flushing here ensures they are sent in smaller batches rather than being
  // bundled into a single request that may exceed server limits.
  if (llmCallCount > 0 && options.langfuseClient) {
    options.langfuseClient.flushAsync().catch(() => {});
  }

  toolCallCount = countToolCallsFromMessages(turnEntries.map((entry) => entry.message));
  logger?.debug?.(`Langfuse: counted ${toolCallCount} tool call(s) from JSONL`);

  // If no provider or aggregate usage was found, signal the caller to use its
  // stored turn-level fallback by returning zero totals.
  if (!hasReportedUsage) {
    totalUsage.input = 0;
    totalUsage.output = 0;
    totalUsage.cacheRead = 0;
    totalUsage.cacheWrite = 0;
    totalUsage.total = 0;
  }

  return {
    llmCallCount,
    toolCallCount,
    lastAssistantText,
    lastProvider,
    lastModel,
    totalUsage,
    completedGenerations,
  };
}
