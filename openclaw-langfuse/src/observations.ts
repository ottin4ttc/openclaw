/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-redundant-type-constituents */
import type Langfuse from "langfuse";
import type { LangfuseTraceClient, LangfuseSpanClient } from "langfuse";
import { redactObject, redactText } from "./redact.js";
import type { TraceContextEntry } from "./trace-context.js";
import type { SessionEntry, MinimalLogger } from "./types.js";
import {
  buildApiMessage,
  buildGenerationOutput,
  extractTextContent,
  generateObservationId,
  hasNonZeroUsage,
  qualifiedModel,
  truncatePayload,
} from "./utils.js";

/**
 * Create Langfuse spans for tool calls found in session messages.
 */
export function createToolSpansFromMessages(
  messages: unknown[],
  entry: TraceContextEntry,
  redactEnabled: boolean,
): void {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as Record<string, unknown> | null;
        if (!b || b.type !== "toolCall") {
          continue;
        }

        entry.toolCallCount += 1;

        // Find matching toolResult
        const toolResultMsg = messages.find((r) => {
          const rm = r as Record<string, unknown>;
          return rm.role === "toolResult" && rm.toolCallId === b.id;
        }) as Record<string, unknown> | undefined;

        const toolInput = truncatePayload(b.input ?? b.args);
        const toolOutput = toolResultMsg ? extractTextContent(toolResultMsg.content) : undefined;

        entry.trace.span({
          name: `tool:${String(b.name ?? "unknown")}`,
          input: redactObject(toolInput, redactEnabled),
          output: toolOutput
            ? redactText(String(truncatePayload(toolOutput)), redactEnabled)
            : undefined,
          metadata: { toolCallId: b.id },
        });
      }
    }
  }
}

/**
 * Build Langfuse generation and span observations from session entries.
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
    pendingSpans?: Map<string, LangfuseSpanClient>;
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
} {
  const { entryTimestamp, storedUsage, promptClient, pendingSpans, redactEnabled } = options;

  let llmCallCount = 0;
  let toolCallCount = 0;
  let lastAssistantText: string | undefined;
  let lastProvider: string | undefined = options.lastProvider;
  let lastModel: string | undefined = options.lastModel;
  let prevTimestamp: number | undefined;

  const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let hasPerCallUsage = false;

  const assistantCount = turnEntries.filter((e) => e.message.role === "assistant").length;

  // Create a generation for each assistant message in the turn
  for (const te of turnEntries) {
    const msg = te.message;

    if (msg.role === "assistant") {
      llmCallCount += 1;
      const isLast = llmCallCount === assistantCount;

      const assistantTs = te.timestamp;
      const startTime = prevTimestamp ? new Date(prevTimestamp) : new Date(entryTimestamp);
      const endTime = new Date(assistantTs);

      // Build output (D3 format)
      const output = buildGenerationOutput(msg.content, redactEnabled);

      // Build generation input matching LLM API structure: {model, messages}
      // Use ALL session entries up to this assistant message as input.
      // System prompt is recorded once at trace level (metadata.system_prompt),
      // not duplicated in each generation input.
      const allPriorEntries = allEntries.slice(0, allEntries.indexOf(te));
      const accumulatedMessages = allPriorEntries.map((e) => buildApiMessage(e.message));
      const genInput = redactObject(
        {
          model: String(msg.model ?? options.lastModel ?? "unknown"),
          messages: accumulatedMessages,
        },
        redactEnabled,
      );

      // Extract per-call usage from JSONL assistant message
      const msgUsage = msg.usage as Record<string, number> | undefined;
      let genUsage: { input?: number; output?: number; total?: number } | undefined;

      if (hasNonZeroUsage(msgUsage)) {
        hasPerCallUsage = true;
        genUsage = {
          input: msgUsage?.input ?? 0,
          output: msgUsage?.output ?? 0,
          total: msgUsage?.totalTokens ?? msgUsage?.total ?? 0,
          ...(msgUsage?.cacheRead ? { cache_read_input_tokens: msgUsage.cacheRead } : {}),
          ...(msgUsage?.cacheWrite ? { cache_creation_input_tokens: msgUsage.cacheWrite } : {}),
        };
        totalUsage.input += msgUsage?.input ?? 0;
        totalUsage.output += msgUsage?.output ?? 0;
        totalUsage.cacheRead += msgUsage?.cacheRead ?? 0;
        totalUsage.cacheWrite += msgUsage?.cacheWrite ?? 0;
        totalUsage.total += msgUsage?.totalTokens ?? msgUsage?.total ?? 0;
      } else if (isLast && storedUsage) {
        // Fall back to stored usage from llm_output for last generation
        genUsage = {
          input: storedUsage.input,
          output: storedUsage.output,
          total: storedUsage.total,
        };
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
        ...(msgUsage?.cost && typeof msgUsage.cost === "object"
          ? {
              costDetails: {
                input: (msgUsage.cost as Record<string, number>).input ?? 0,
                output: (msgUsage.cost as Record<string, number>).output ?? 0,
                total: (msgUsage.cost as Record<string, number>).total ?? 0,
              },
            }
          : {}),
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

      trace.generation(genData);

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

    prevTimestamp = te.timestamp;
  }

  // Flush generations before creating tool spans to prevent oversized batches.
  // Generation inputs accumulate all prior messages and can be very large;
  // flushing here ensures they are sent in smaller batches rather than being
  // bundled with tool spans into a single request that may exceed server limits.
  if (llmCallCount > 0 && options.langfuseClient) {
    options.langfuseClient.flushAsync().catch(() => {});
  }

  // Create tool spans from JSONL toolCall/toolResult pairs
  if (turnEntries.length > 0) {
    const toolMap = new Map<
      string,
      {
        callTs?: number;
        resultTs?: number;
        toolName?: string;
        input?: unknown;
        result?: unknown;
        error?: string;
      }
    >();
    for (const te of turnEntries) {
      const msg = te.message;
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block?.type === "toolCall" && block.id) {
            const id = String(block.id);
            const existing = toolMap.get(id) ?? {};
            existing.callTs = te.timestamp;
            existing.toolName = String(block.name ?? "unknown");
            existing.input = block.input ?? block.args ?? block.arguments;
            toolMap.set(id, existing);
          }
        }
      }
      if (msg.role === "toolResult" && msg.toolCallId) {
        const id = String(msg.toolCallId);
        const existing = toolMap.get(id) ?? {};
        existing.resultTs = typeof msg.timestamp === "number" ? msg.timestamp : te.timestamp;
        existing.toolName = existing.toolName ?? String(msg.toolName ?? "unknown");
        existing.result = msg.content;
        if (msg.isError) {
          existing.error = extractTextContent(msg.content);
        }
        toolMap.set(id, existing);
      }
    }

    logger?.debug?.(
      `Langfuse: agentEnd toolMap has ${toolMap.size} tool calls, pendingSpans=${pendingSpans?.size ?? 0}`,
    );
    for (const [toolCallId, info] of toolMap) {
      toolCallCount += 1;
      const pendingSpan = pendingSpans?.get(toolCallId);
      if (pendingSpan) {
        const durationMs = info.callTs && info.resultTs ? info.resultTs - info.callTs : undefined;
        pendingSpan.update({
          endTime: info.resultTs ? new Date(info.resultTs) : undefined,
          output: info.error
            ? { error: info.error }
            : redactObject(truncatePayload(info.result), redactEnabled),
          statusMessage: info.error,
          level: info.error ? "ERROR" : "DEFAULT",
          metadata: durationMs != null ? { durationMs } : {},
        });
        pendingSpans?.delete(toolCallId);
        logger?.debug?.(
          `Langfuse: ended pending tool span ${info.toolName} (${toolCallId}) durationMs=${durationMs}`,
        );
      } else if (info.callTs && info.resultTs) {
        const durationMs = info.resultTs - info.callTs;
        logger?.debug?.(
          `Langfuse: creating tool span ${info.toolName} (${toolCallId}) callTs=${info.callTs} resultTs=${info.resultTs} durationMs=${durationMs}`,
        );
        trace.span({
          id: generateObservationId(traceId, "span", toolCallId),
          name: `tool:${info.toolName ?? "unknown"}`,
          startTime: new Date(info.callTs),
          endTime: new Date(info.resultTs),
          input: info.input ? redactObject(truncatePayload(info.input), redactEnabled) : undefined,
          output: info.error
            ? { error: info.error }
            : redactObject(truncatePayload(info.result), redactEnabled),
          statusMessage: info.error,
          level: info.error ? "ERROR" : "DEFAULT",
          metadata: { durationMs },
        });
      } else {
        logger?.warn?.(
          `Langfuse: tool span ${info.toolName} (${toolCallId}) missing timestamps — callTs=${info.callTs} resultTs=${info.resultTs}`,
        );
      }
    }
  }

  // If no per-call usage was found, the totalUsage will remain zeros; caller
  // should fall back to storedUsage via hasPerCallUsage check. We signal this
  // by returning zero totalUsage when hasPerCallUsage is false.
  if (!hasPerCallUsage) {
    totalUsage.input = 0;
    totalUsage.output = 0;
    totalUsage.cacheRead = 0;
    totalUsage.cacheWrite = 0;
    totalUsage.total = 0;
  }

  return { llmCallCount, toolCallCount, lastAssistantText, lastProvider, lastModel, totalUsage };
}
