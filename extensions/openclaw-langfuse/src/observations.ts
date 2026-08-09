/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type Langfuse from "langfuse";
import type { LangfuseGenerationClient, LangfuseTraceClient } from "langfuse";
import { redactObject } from "./redact.js";
import type { SdkDeliveryEventType } from "./sdk-delivery.js";
import type { ObservationEvent } from "./session.js";
import type { SessionEntry, MinimalLogger } from "./types.js";
import {
  buildApiMessage,
  buildGenerationOutput,
  extractTextContent,
  addUsageToTotals,
  findAggregateOnlyUsageEntry,
  generateObservationId,
  isToolCallBlock,
  qualifiedModel,
  truncatePayload,
  usageDetailsFromUsage,
  messageTimestamp,
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

function hasReportedUsageFields(
  usage: Record<string, number> | undefined,
): usage is Record<string, number> {
  return !!usage && Object.values(usage).some((value) => Number.isFinite(value));
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
export async function buildObservationsFromEntries(
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
    generationIdsBySlot?: Map<number, string>;
    toolSpanIdsByCallId?: Map<string, string>;
    existingToolCallIds?: ReadonlySet<string>;
    recordObservationEvent?: (event: ObservationEvent, source: string) => boolean;
    onBeforeSdkEnqueue?: (
      observationId: string,
      eventType: SdkDeliveryEventType,
      source: string,
    ) => boolean | Promise<boolean>;
  },
  logger?: MinimalLogger | null,
): Promise<{
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
  reportedUsageFields: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
    total: boolean;
  };
  completedGenerations: Map<number, LangfuseGenerationClient>;
  completedGenerationIds: Map<number, string>;
  hasReportedUsage: boolean;
  observationBarrierIncomplete: boolean;
  modelContextMetadata: Record<string, unknown>;
  priorConversation?: unknown;
}> {
  const { entryTimestamp, storedUsage, promptClient, redactEnabled } = options;
  const lastTurnEntry = turnEntries.at(-1);
  const lastTurnEntryIndex = lastTurnEntry
    ? entryIndex(allEntries, lastTurnEntry, allEntries.length - 1)
    : allEntries.length - 1;
  // Startup recovery can rebuild an older turn after newer turns already exist.
  // Keep context and per-call deltas bounded to the recovered turn.
  const contextEntries = allEntries.slice(0, lastTurnEntryIndex + 1);
  const firstTurnEntryIndex = turnStartIndex(contextEntries, turnEntries);
  const canonicalContextMessages = contextEntries
    .filter(isTraceContextInputEntry)
    .map((entry) => buildApiMessage(entry.message))
    .filter((message) => (message as Record<string, unknown>).role !== "system");
  const priorMessages = contextEntries
    .slice(0, firstTurnEntryIndex)
    .filter(isTraceContextInputEntry)
    .map((entry) => buildApiMessage(entry.message))
    .filter((message) => (message as Record<string, unknown>).role !== "system");
  const normalizedContext = normalizeModelCallInput({
    model: options.lastModel,
    systemPrompt: options.systemPrompt,
    messages: canonicalContextMessages,
    ...(priorMessages.length > 0 ? { priorMessages } : {}),
    redactEnabled,
  });

  let llmCallCount = 0;
  let toolCallCount = 0;
  let lastAssistantText: string | undefined;
  let lastProvider: string | undefined = options.lastProvider;
  let lastModel: string | undefined = options.lastModel;
  let prevTimestamp: number | undefined;

  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const reportedUsageFields = {
    input: false,
    output: false,
    cacheRead: false,
    cacheWrite: false,
    total: false,
  };
  const completedGenerations = new Map<number, LangfuseGenerationClient>();
  const completedGenerationIds = new Map<number, string>();
  let hasReportedUsage = false;
  let observationBarrierIncomplete = false;
  const toolResultEntries = toolResultEntriesById(turnEntries);
  const emittedToolCallIds = new Set<string>();

  const assistantEntries = turnEntries.filter(isTraceableAssistantEntry);
  const assistantCount = assistantEntries.length;
  const aggregateOnlyUsageEntry = findAggregateOnlyUsageEntry(assistantEntries, turnEntries);
  const aggregateOnlyUsage = aggregateOnlyUsageEntry?.message.usage as
    | Record<string, number>
    | undefined;
  if (hasReportedUsageFields(aggregateOnlyUsage)) {
    hasReportedUsage = true;
    addUsageToTotals(totalUsage, aggregateOnlyUsage);
    markReportedUsageFields(reportedUsageFields, aggregateOnlyUsage);
  }
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
      const currentIdx = entryIndex(contextEntries, te, contextEntries.length);
      const prevAssistantEntry =
        llmCallCount > 1 ? assistantEntries.at(llmCallCount - 2) : undefined;
      const deltaStart = prevAssistantEntry
        ? entryIndex(contextEntries, prevAssistantEntry, firstTurnEntryIndex)
        : firstTurnEntryIndex;
      const deltaEntries = contextEntries.slice(deltaStart, currentIdx);
      const deltaMessages = deltaEntries
        .filter(isTraceContextInputEntry)
        .map((e) => buildApiMessage(e.message));
      const genInput = normalizeModelCallInput({
        model: String(msg.model ?? options.lastModel ?? "unknown"),
        messages: deltaMessages,
        previousMessages: [],
        redactEnabled,
      }).generationInput;

      // Extract per-call usage from JSONL assistant message
      const msgUsage = msg.usage as Record<string, number> | undefined;
      const usageForGeneration = aggregateOnlyUsageEntry === te ? undefined : msgUsage;
      let genUsage: Record<string, number> | undefined;

      if (hasReportedUsageFields(usageForGeneration)) {
        hasReportedUsage = true;
        genUsage = usageDetailsFromUsage(usageForGeneration);
        addUsageToTotals(totalUsage, usageForGeneration);
        markReportedUsageFields(reportedUsageFields, usageForGeneration);
      } else if (isLast && storedUsage && !aggregateOnlyUsageEntry) {
        // Fall back to stored usage from llm_output for last generation
        genUsage = usageDetailsFromUsage(storedUsage as Record<string, number>);
        totalUsage.input += storedUsage.input ?? 0;
        totalUsage.output += storedUsage.output ?? 0;
        totalUsage.cacheRead += storedUsage.cacheRead ?? 0;
        totalUsage.cacheWrite += storedUsage.cacheWrite ?? 0;
        totalUsage.total += storedUsage.total ?? 0;
        hasReportedUsage ||= hasReportedUsageFields(storedUsage as Record<string, number>);
        markReportedUsageFields(reportedUsageFields, storedUsage as Record<string, number>);
      }

      const rawModel = String(msg.model ?? options.lastModel ?? "unknown");
      const provider = String(msg.provider ?? options.lastProvider ?? "");
      const model = qualifiedModel(provider, rawModel);

      const generationId =
        options.generationIdsBySlot?.get(llmCallCount) ??
        generateObservationId(traceId, "gen", llmCallCount);
      const genData = {
        id: generationId,
        name: `llm-call-${llmCallCount}`,
        model,
        startTime,
        endTime,
        input: genInput,
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

      const generationStartEvent: ObservationEvent = {
        e: "gen-start",
        traceId,
        id: generationId,
        llmCall: llmCallCount,
        model,
        ts: startTime.toISOString(),
      };
      const generationEndEvent: ObservationEvent = {
        e: "gen-end",
        traceId,
        id: generationId,
        ts: endTime.toISOString(),
      };
      if (
        options.recordObservationEvent?.(generationStartEvent, "batch generation start") ===
          false ||
        options.recordObservationEvent?.(generationEndEvent, "batch generation end") === false ||
        (await options.onBeforeSdkEnqueue?.(
          generationId,
          "generation-create",
          "batch generation",
        )) === false
      ) {
        observationBarrierIncomplete = true;
        continue;
      }
      const generation = trace.generation(genData);
      completedGenerations.set(llmCallCount, generation);
      completedGenerationIds.set(llmCallCount, generationId);

      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (!isToolCallBlock(block) || typeof block.id !== "string") {
            continue;
          }
          const toolCallId = block.id;
          if (emittedToolCallIds.has(toolCallId) || options.existingToolCallIds?.has(toolCallId)) {
            continue;
          }
          emittedToolCallIds.add(toolCallId);
          const existingSpanId =
            options.toolSpanIdsByCallId?.get(toolCallId) ??
            generateObservationId(traceId, "span", toolCallId);
          const toolName = String(block.name ?? "unknown");
          const resultEntry = toolResultEntries.get(toolCallId);
          const isError = resultEntry?.message.isError === true;
          const spanStartTime = new Date(messageTimestamp(te));
          const spanEndTime = new Date(
            resultEntry ? messageTimestamp(resultEntry) : assistantEndTimestamp(te),
          );
          if (
            options.recordObservationEvent?.(
              {
                e: "span-start",
                traceId,
                id: existingSpanId,
                tool: toolName,
                toolCallId,
                ts: spanStartTime.toISOString(),
              },
              "batch tool span start",
            ) === false ||
            (await options.onBeforeSdkEnqueue?.(
              existingSpanId,
              "span-create",
              "batch tool span",
            )) === false
          ) {
            observationBarrierIncomplete = true;
            continue;
          }
          const span = trace.span({
            id: existingSpanId,
            name: `tool:${toolName}`,
            startTime: spanStartTime,
            input: redactObject(
              truncatePayload(block.input ?? block.args ?? block.arguments ?? {}),
              redactEnabled,
            ),
            metadata: {
              toolName,
              toolCallId,
              source: "startup-recovery",
            },
          });
          if (
            options.recordObservationEvent?.(
              {
                e: "span-end",
                traceId,
                id: existingSpanId,
                ts: spanEndTime.toISOString(),
              },
              "batch tool span end",
            ) === false ||
            (await options.onBeforeSdkEnqueue?.(
              existingSpanId,
              "span-update",
              "batch tool span update",
            )) === false
          ) {
            observationBarrierIncomplete = true;
            continue;
          }
          span.update({
            endTime: spanEndTime,
            output: redactObject(
              truncatePayload(resultEntry ? toolResultOutput(resultEntry.message) : undefined),
              redactEnabled,
            ),
            metadata: {
              toolName,
              toolCallId,
              source: "startup-recovery",
              ...(isError ? { isError: true } : {}),
            },
            ...(isError
              ? { level: "ERROR" as const, statusMessage: "tool returned an error result" }
              : {}),
          });
        }
      }

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
    reportedUsageFields,
    completedGenerations,
    completedGenerationIds,
    hasReportedUsage,
    observationBarrierIncomplete,
    modelContextMetadata: normalizedContext.traceMetadata,
    ...(normalizedContext.priorConversation !== undefined
      ? { priorConversation: normalizedContext.priorConversation }
      : {}),
  };
}

function markReportedUsageFields(
  fields: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
    total: boolean;
  },
  usage: Record<string, number>,
): void {
  fields.input ||= typeof usage.input === "number" && Number.isFinite(usage.input);
  fields.output ||= typeof usage.output === "number" && Number.isFinite(usage.output);
  fields.cacheRead ||= typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead);
  fields.cacheWrite ||= typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite);
  fields.total ||=
    (typeof usage.total === "number" && Number.isFinite(usage.total)) ||
    (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) ||
    fields.input ||
    fields.output;
}
