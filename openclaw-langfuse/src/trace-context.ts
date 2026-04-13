import type { LangfuseTraceClient, LangfuseGenerationClient, LangfuseSpanClient } from "langfuse";

export type PromptMatchInfo =
  | {
      name: string;
      version?: number;
      label?: string;
      inject?: string;
      matchRule: string;
    }
  | { matched: false };

export type TraceContextEntry = {
  trace: LangfuseTraceClient;
  traceId: string; // deterministic trace ID, used for deterministic observation IDs
  llmCallCount: number;
  toolCallCount: number;
  promptMatch?: PromptMatchInfo;
  systemPrompt?: string; // captured from before_prompt_build / llm_input
  promptInjection?: { prepend?: string; append?: string }; // from Langfuse prompt injection
  promptClient?: unknown; // fetched Langfuse prompt client for generation linking
  pendingGenerations: Map<string, LangfuseGenerationClient>; // keyed by runId
  pendingGenIds: Map<string, string>; // runId → deterministic genId (for sidecar events)
  completedGenerations: Map<number, LangfuseGenerationClient>; // genIdx → client for usage correction
  pendingSpans: Map<string, LangfuseSpanClient>; // keyed by toolCallId
  completedSpanToolCallIds: Set<string>; // toolCallIds completed by afterToolCall
  createdAt: number;
  timestamp: number; // agent turn start timestamp
  sessionId?: string; // needed to read JSONL in agent_end
  // Stored from llm_input/llm_output for use in agent_end generation creation
  storedUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  storedOutput?: string;
  lastModel?: string;
  lastProvider?: string;
  initialMessages?: unknown[]; // historyMessages from first llm_input call
  finalized?: boolean; // set by agent_end; prevents diagnostic handler from overwriting metadata
  currentGenerationId?: string; // ID of the most recent generation, for parentObservationId on tool spans
  lastGenerationEndTime?: Date; // endTime of most recent generation; used as tool span startTime for correct ordering
};

const MAX_ENTRIES = 1000;
const ORPHAN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class TraceContextMap {
  private map = new Map<string, TraceContextEntry>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  /** Build composite key from agentId and sessionKey */
  static key(agentId?: string, sessionKey?: string): string {
    return `${agentId ?? "unknown"}:${sessionKey ?? "unknown"}`;
  }

  create(key: string, entry: TraceContextEntry): void {
    // If at max, evict oldest
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, entry);
  }

  get(key: string): TraceContextEntry | undefined {
    return this.map.get(key);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  startSweep(): void {
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.map) {
        if (now - entry.createdAt > ORPHAN_TTL_MS) {
          this.map.delete(key);
        }
      }
    }, 60_000); // sweep every minute
    // Don't keep process alive just for sweeping
    if (this.sweepInterval.unref) {
      this.sweepInterval.unref();
    }
  }

  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Find entry that has a pending span for the given toolCallId. */
  findByPendingSpan(toolCallId: string): TraceContextEntry | undefined {
    for (const entry of this.map.values()) {
      if (entry.pendingSpans.has(toolCallId)) {
        return entry;
      }
    }
    return undefined;
  }

  /** Find the most recent non-finalized entry (fallback when ctx.agentId is missing). */
  findActive(): TraceContextEntry | undefined {
    let best: TraceContextEntry | undefined;
    for (const entry of this.map.values()) {
      if (!entry.finalized && (!best || entry.createdAt > best.createdAt)) {
        best = entry;
      }
    }
    return best;
  }
}
