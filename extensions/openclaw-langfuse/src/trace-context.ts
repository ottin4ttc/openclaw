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

export type DeferredProviderRequestCompletion = {
  endTime: Date;
  startTime?: Date;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number>;
  level?: "ERROR";
  statusMessage?: string;
  metadata: Record<string, unknown>;
};

export type ProviderUsageTotals = {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
};

export type NativeChildLineageStatus = "complete" | "partial" | "unsupported";

export type NativeChildObservation = {
  id: string;
  traceEntry: TraceContextEntry;
  spawnObservationId: string;
  childThreadId: string;
  childTurnId: string;
  ended: boolean;
  pendingTerminalIdentity?: { agentId: string; sessionId: string };
  role?: string;
  model?: string;
  executionContextCallIds?: Set<string>;
  firstExecutionContextSummary?: Record<string, unknown>;
  latestExecutionContextSummary?: Record<string, unknown>;
  traceOutputPublished?: boolean;
};

export type NativeChildLineageState = {
  /** Producer failures are scoped to this turn; one bad diagnostic must not quarantine later traces. */
  producerHealthy: boolean;
  support: "supported" | "unsupported" | "unknown";
  status: NativeChildLineageStatus;
  capability?: {
    eventVersions: number[];
    authoritativeStart: boolean;
    authoritativeTerminal: boolean;
    providerCallOwnership: boolean;
    toolCallOwnership: boolean;
  };
  observations: Map<string, NativeChildObservation>;
  currentChildTurnIds: Map<string, string>;
  /** Child lifecycle may precede the spawn activity item that owns it. */
  pendingChildThreads: Set<string>;
  childTriggeringToolCallIds: Map<string, string>;
  spawnAgentRoles: Map<string, string>; // triggering spawn tool call id -> exact agent_type
  pendingLifecycleEvents: Map<string, unknown[]>;
  sourceEventIds: Set<string>;
  providerCallOwners: Map<string, string>;
  mutations: number;
  pendingJoins: number;
  admittedEvents: number;
  duplicateEvents: number;
  droppedEvents: number;
  activeChildrenAtRootFinalization: number;
  partialReasons: Set<string>;
  drain: "pending" | "not_applicable" | "completed" | "timed_out";
  finalized: boolean;
};

export type TraceContextEntry = {
  trace: LangfuseTraceClient;
  traceId: string; // deterministic trace ID, used for deterministic observation IDs
  actorKind?: "root" | "native-child";
  traceMetadata?: Record<string, unknown>; // last full trace metadata payload; Langfuse update replaces metadata
  llmCallCount: number;
  toolCallCount: number;
  promptMatch?: PromptMatchInfo;
  systemPrompt?: string; // captured from before_prompt_build / llm_input
  rootInput?: unknown; // bounded before_agent_run.prompt projection
  promptInjection?: { prepend?: string; append?: string }; // from Langfuse prompt injection
  promptClient?: unknown; // fetched Langfuse prompt client for generation linking
  pendingGenerations: Map<string, LangfuseGenerationClient>; // keyed by runId
  pendingGenIds: Map<string, string>; // runId → deterministic genId (for sidecar events)
  runIds?: Set<string>; // hook run ids retained after generation finalization for late diagnostics
  completedGenerations: Map<number, LangfuseGenerationClient>; // genIdx → client for usage correction
  completedGenerationIds?: Map<number, string>; // genIdx → actual SDK observation id
  pendingSpans: Map<string, LangfuseSpanClient>; // keyed by toolCallId
  completedSpanToolCallIds: Set<string>; // toolCallIds completed by afterToolCall
  completedSpans?: Map<string, LangfuseSpanClient>; // completed clients retained for authoritative late correction
  toolParentCallIndexes?: Map<string, number>; // toolCallId -> allocated parent generation display index
  diagnosticCorrectedSpanToolCallIds?: Set<string>; // toolCallIds already corrected from Codex rollout data
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
  finalizedUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  }; // immutable turn aggregate retained for late transcript repair
  storedOutput?: string;
  lastModel?: string;
  lastProvider?: string;
  lastRuntime?: string;
  lastRuntimeEngine?: string;
  lastRuntimeTransport?: string;
  lastHistoryLength?: number; // message count consumed by the previous llm_input call
  previousModelInputMessages?: unknown[]; // canonical llm_input hook messages used to derive the next hook delta
  // Provider diagnostics can encode the same messages differently from llm_input hooks.
  // Keep a separate baseline or the first diagnostic update can reintroduce stable history.
  previousProviderRequestInputMessages?: unknown[];
  providerRequestInputs?: Map<string, unknown>; // stable input payload per diagnostic call id
  providerRequestInputProjections?: Map<
    string,
    {
      projection:
        | "first-prompt"
        | "full-request"
        | "proven-prefix"
        | "ws-delta-linked"
        | "unavailable";
      requestForm?: "full" | "ws-delta";
    }
  >; // immutable sink-facing projection provenance per diagnostic call id
  modelContextMetadata?: Record<string, unknown>; // bounded stable system/history trace metadata
  // Publish stable context once per trace; reset only when a late authoritative prompt supplements it.
  modelContextMetadataPublished?: boolean;
  lastGenerationEndTime?: Date; // latest observed LLM/tool completion time for timeline repair
  priorConversation?: unknown; // pre-turn history stored on trace metadata, not per-generation input
  initialMessages?: unknown[]; // historyMessages from first llm_input call
  finalized?: boolean; // set by agent_end; prevents diagnostic handler from overwriting metadata
  finalizationInProgress?: boolean; // claimed before agent_end awaits so duplicate hook registrations cannot finalize twice
  diagnosticAdmissionClosed?: boolean; // permanently rejects diagnostics beyond the captured terminal cursor
  transcriptAdmissionClosed?: boolean; // closes this turn's transcript queue before its final drain and delivery watermark
  deliveryFinalized?: boolean; // true only after SDK delivery and the trace-end marker both succeed
  currentGenerationId?: string; // ID of the most recent generation, used by realtime repair
  hasProviderRequestGenerations?: boolean; // true when stable per-call model diagnostics own LLM generations
  providerRequestAugmentedHookGenerations?: boolean; // true when per-call diagnostics patched hook/JSONL-owned generations
  providerRequestCallCount?: number; // stable per-call model diagnostics seen for this trace
  providerRequestCallIndexes?: Map<string, number>; // diagnostic callId -> stable LLM call index
  providerRequestGenerationIndexes?: Map<string, number>; // diagnostic callId -> allocated generation slot
  providerRequestResponseIdHashes?: Map<number, string>; // generation slot -> hashed Responses response id
  providerRequestCompletedCallIds?: Set<string>; // terminal per-call diagnostics seen by callId
  providerRequestUsages?: Map<string, Record<string, number>>; // authoritative per-call usage keyed by callId
  // Generation delivery may succeed before finalized trace usage; retain only the commit retry.
  providerRequestPendingTerminalCommits?: Map<string, Record<string, number> | undefined>;
  authoritativeProviderUsage?: ProviderUsageTotals;
  deferredProviderRequestCompletions?: Map<number, DeferredProviderRequestCompletion>;
  observationLedgerIncomplete?: boolean;
  pendingObservationDeliveryFailures?: Set<string>;
  finalizationDiagnosticSequence?: number; // diagnostic events at or below this barrier must finish before agent_end
  observationReconciliation?: {
    required: boolean;
    reasons: Array<{ reason: string; source: string; count: number }>;
  };
  nativeChildLineage?: NativeChildLineageState;
  pendingNativeChildDiagnostics?: Array<{
    event: unknown;
    metadata: unknown;
    privateData: unknown;
    childThreadId: string;
    childTurnId?: string;
  }>;
  lastUpdatedAt?: number;
};

function normalizedRuntimeValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function rememberRuntimeIdentity(
  entry: TraceContextEntry,
  identity: {
    runtime?: unknown;
    runtimeEngine?: unknown;
    transport?: unknown;
    runtimeTransport?: unknown;
  },
): void {
  const runtime = normalizedRuntimeValue(identity.runtime);
  const runtimeEngine = normalizedRuntimeValue(identity.runtimeEngine);
  const runtimeTransport = normalizedRuntimeValue(identity.runtimeTransport ?? identity.transport);
  if (runtime) {
    entry.lastRuntime = runtime;
  }
  if (runtimeEngine) {
    entry.lastRuntimeEngine = runtimeEngine;
  }
  if (runtimeTransport) {
    entry.lastRuntimeTransport = runtimeTransport;
  }
  const runtimePatch = runtimeMetadata(entry);
  if (Object.keys(runtimePatch).length > 0) {
    entry.traceMetadata = { ...entry.traceMetadata, ...runtimePatch };
  }
}

export function runtimeMetadata(entry: TraceContextEntry): Record<string, string> {
  return {
    ...(entry.lastRuntime ? { runtime: entry.lastRuntime } : {}),
    ...(entry.lastRuntimeEngine ? { runtimeEngine: entry.lastRuntimeEngine } : {}),
    ...(entry.lastRuntimeTransport ? { runtimeTransport: entry.lastRuntimeTransport } : {}),
  };
}

export function isCodexRuntime(entry: TraceContextEntry): boolean {
  const runtime = entry.lastRuntime?.trim().toLowerCase();
  if (runtime) {
    return runtime === "codex" || runtime.startsWith("codex-");
  }
  // Older 7.1 hook payloads did not carry runtime identity. Preserve their
  // established provider name only when no explicit runtime contradicts it.
  return entry.lastProvider?.trim().toLowerCase() === "codex";
}

export function completeProviderRequestUsageTotals(
  entry: TraceContextEntry,
): ProviderUsageTotals | undefined {
  const callCount = entry.providerRequestCallIndexes?.size ?? entry.providerRequestCallCount ?? 0;
  if (
    callCount === 0 ||
    entry.providerRequestCompletedCallIds?.size !== callCount ||
    entry.providerRequestUsages?.size !== callCount
  ) {
    return undefined;
  }

  let input = 0;
  let output = 0;
  let total = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoningTokens = 0;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  let hasReasoningTokens = false;
  for (const usage of entry.providerRequestUsages.values()) {
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    total += usage.totalTokens ?? usage.total ?? 0;
    if (typeof usage.cacheRead === "number") {
      cacheRead += usage.cacheRead;
      hasCacheRead = true;
    }
    if (typeof usage.cacheWrite === "number") {
      cacheWrite += usage.cacheWrite;
      hasCacheWrite = true;
    }
    if (typeof usage.reasoningTokens === "number") {
      reasoningTokens += usage.reasoningTokens;
      hasReasoningTokens = true;
    }
  }
  return {
    input,
    output,
    total,
    ...(hasCacheRead ? { cacheRead } : {}),
    ...(hasCacheWrite ? { cacheWrite } : {}),
    ...(hasReasoningTokens ? { reasoningTokens } : {}),
  };
}

export function resolveCurrentGeneration(
  entry: TraceContextEntry,
): LangfuseGenerationClient | undefined {
  const generationId = entry.currentGenerationId;
  if (!generationId) {
    return undefined;
  }
  const prefix = `${entry.traceId}-gen-`;
  if (generationId.startsWith(prefix)) {
    const generationIndex = Number(generationId.slice(prefix.length));
    if (Number.isInteger(generationIndex) && generationIndex > 0) {
      const completed = entry.completedGenerations.get(generationIndex);
      if (completed) {
        return completed;
      }
    }
  }
  for (const [generationIndex, completedGenerationId] of entry.completedGenerationIds ?? []) {
    if (completedGenerationId === generationId) {
      return entry.completedGenerations.get(generationIndex);
    }
  }
  for (const [pendingKey, pendingGenerationId] of entry.pendingGenIds) {
    if (pendingGenerationId === generationId) {
      return entry.pendingGenerations.get(pendingKey);
    }
  }
  return undefined;
}

const MAX_ENTRIES = 1000;
const ORPHAN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVE_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // long-running turns remain observable
const TRACE_KEY_SEPARATOR = "\u0000";

type TraceContextLookup = {
  traceId?: string;
  runId?: string;
};

export class TraceContextMap {
  private map = new Map<string, TraceContextEntry>();
  private primaryKeys = new Map<string, Set<string>>();
  private primaryByStorageKey = new Map<string, string>();
  private finalizedAt = new WeakMap<TraceContextEntry, number>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onDelete?: (entry: TraceContextEntry) => void) {}

  /** Build composite key from agentId and sessionKey */
  static key(agentId?: string, sessionKey?: string): string {
    return `${agentId ?? "unknown"}:${sessionKey ?? "unknown"}`;
  }

  create(key: string, entry: TraceContextEntry): void {
    const now = Date.now();
    const storageKey = this.storageKey(key, entry);
    if (this.map.has(storageKey)) {
      this.deleteStorageKey(storageKey);
    }
    entry.lastUpdatedAt = entry.lastUpdatedAt ?? now;
    if (entry.finalized) {
      this.finalizedAt.set(entry, entry.lastUpdatedAt);
    }
    while (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.deleteStorageKey(oldest);
    }
    this.map.set(storageKey, entry);
    this.primaryByStorageKey.set(storageKey, key);
    let keys = this.primaryKeys.get(key);
    if (!keys) {
      keys = new Set();
      this.primaryKeys.set(key, keys);
    }
    keys.add(storageKey);
  }

  get(key: string): TraceContextEntry | undefined {
    const exact = this.map.get(key);
    if (exact) {
      this.touch(exact);
      return exact;
    }
    const entry = this.findByPrimaryKey(key, false) ?? this.findByPrimaryKey(key, true);
    if (entry) {
      this.touch(entry);
    }
    return entry;
  }

  delete(key: string): void {
    if (this.map.has(key)) {
      this.deleteStorageKey(key);
      return;
    }
    const entry = this.findByPrimaryKey(key, false);
    if (entry) {
      this.deleteEntry(entry);
    }
  }

  startSweep(): void {
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.map) {
        if (this.isExpired(entry, now)) {
          this.deleteStorageKey(key);
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
    if (this.onDelete) {
      for (const entry of new Set(this.map.values())) {
        this.onDelete(entry);
      }
    }
    this.map.clear();
    this.primaryKeys.clear();
    this.primaryByStorageKey.clear();
    this.finalizedAt = new WeakMap();
  }

  get size(): number {
    return this.map.size;
  }

  hasActiveEntries(): boolean {
    for (const entry of this.map.values()) {
      if (
        !entry.finalized ||
        [...(entry.nativeChildLineage?.observations.values() ?? [])].some(
          (observation) => !observation.traceEntry.finalized,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Find entry that has a pending span for the given toolCallId. */
  findByPendingSpan(toolCallId: string): TraceContextEntry | undefined {
    for (const entry of this.map.values()) {
      if (entry.pendingSpans.has(toolCallId)) {
        this.touch(entry);
        return entry;
      }
    }
    return undefined;
  }

  findByTraceId(traceId: string): TraceContextEntry | undefined {
    for (const entry of this.map.values()) {
      if (entry.traceId === traceId) {
        this.touch(entry);
        return entry;
      }
    }
    return undefined;
  }

  private storageKey(key: string, entry: TraceContextEntry): string {
    return `${key}${TRACE_KEY_SEPARATOR}${entry.traceId}`;
  }

  private deleteEntry(entry: TraceContextEntry): void {
    for (const [storageKey, stored] of this.map) {
      if (stored === entry) {
        this.deleteStorageKey(storageKey);
        return;
      }
    }
  }

  private deleteStorageKey(storageKey: string): void {
    const entry = this.map.get(storageKey);
    this.map.delete(storageKey);
    const primaryKey = this.primaryByStorageKey.get(storageKey);
    this.primaryByStorageKey.delete(storageKey);
    if (primaryKey) {
      const keys = this.primaryKeys.get(primaryKey);
      keys?.delete(storageKey);
      if (keys?.size === 0) {
        this.primaryKeys.delete(primaryKey);
      }
    }
    if (entry && !this.hasEntryReference(entry)) {
      this.onDelete?.(entry);
    }
  }

  private hasEntryReference(entry: TraceContextEntry): boolean {
    for (const stored of this.map.values()) {
      if (stored === entry) {
        return true;
      }
    }
    return false;
  }

  private touch(entry: TraceContextEntry): void {
    const now = Date.now();
    entry.lastUpdatedAt = now;
    if (entry.finalized && !this.finalizedAt.has(entry)) {
      this.finalizedAt.set(entry, now);
    }
  }

  private isExpired(entry: TraceContextEntry, now: number): boolean {
    const activeChildEntries = [...(entry.nativeChildLineage?.observations.values() ?? [])]
      .map((observation) => observation.traceEntry)
      .filter((childEntry) => !childEntry.finalized);
    if (activeChildEntries.length > 0) {
      const oldestChildStart = Math.min(
        ...activeChildEntries.map((childEntry) => childEntry.createdAt),
      );
      return now - oldestChildStart > ACTIVE_ORPHAN_TTL_MS;
    }
    if (!entry.finalized) {
      return now - entry.createdAt > ACTIVE_ORPHAN_TTL_MS;
    }
    let finalizedAt = this.finalizedAt.get(entry);
    if (finalizedAt === undefined) {
      finalizedAt = now;
      this.finalizedAt.set(entry, finalizedAt);
      entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt ?? 0, finalizedAt);
      return false;
    }
    const lastUpdate = Math.max(finalizedAt, entry.lastUpdatedAt ?? entry.createdAt);
    return now - lastUpdate > ORPHAN_TTL_MS;
  }

  private primaryKeyForStorageKey(storageKey: string): string {
    return (
      this.primaryByStorageKey.get(storageKey) ??
      storageKey.split(TRACE_KEY_SEPARATOR)[0] ??
      storageKey
    );
  }

  private matchesSessionKey(storageKey: string, sessionKey?: string): boolean {
    if (!sessionKey) {
      return true;
    }
    return this.primaryKeyForStorageKey(storageKey).endsWith(`:${sessionKey}`);
  }

  private matchesLookup(entry: TraceContextEntry, lookup?: TraceContextLookup): boolean {
    if (!lookup) {
      return true;
    }
    if (lookup.traceId && entry.traceId !== lookup.traceId) {
      return false;
    }
    if (lookup.runId && !this.entryHasRunId(entry, lookup.runId)) {
      return false;
    }
    return true;
  }

  private entryHasRunId(entry: TraceContextEntry, runId: string): boolean {
    return (
      entry.runIds?.has(runId) === true ||
      entry.pendingGenerations.has(runId) ||
      entry.pendingGenIds.has(runId) ||
      entry.providerRequestCallIndexes?.has(runId) === true ||
      entry.providerRequestCompletedCallIds?.has(runId) === true ||
      entry.providerRequestUsages?.has(runId) === true
    );
  }

  private isNewerForSelection(entry: TraceContextEntry, current: TraceContextEntry): boolean {
    const entryTimestamp = entry.timestamp ?? entry.createdAt;
    const currentTimestamp = current.timestamp ?? current.createdAt;
    if (entryTimestamp !== currentTimestamp) {
      return entryTimestamp > currentTimestamp;
    }
    return entry.createdAt > current.createdAt;
  }

  private newest(
    entries: Iterable<TraceContextEntry>,
    includeFinalized: boolean,
    lookup?: TraceContextLookup,
  ): TraceContextEntry | undefined {
    let best: TraceContextEntry | undefined;
    for (const entry of entries) {
      if ((!includeFinalized && entry.finalized) || !this.matchesLookup(entry, lookup)) {
        continue;
      }
      if (!best || this.isNewerForSelection(entry, best)) {
        best = entry;
      }
    }
    return best;
  }

  private findByPrimaryKey(
    primaryKey: string,
    includeFinalized: boolean,
  ): TraceContextEntry | undefined {
    const storageKeys = this.primaryKeys.get(primaryKey);
    if (!storageKeys) {
      return undefined;
    }
    const entries: TraceContextEntry[] = [];
    for (const storageKey of storageKeys) {
      const entry = this.map.get(storageKey);
      if (entry) {
        entries.push(entry);
      }
    }
    return this.newest(entries, includeFinalized);
  }

  /** Find the most recent non-finalized entry (fallback when ctx.agentId is missing). */
  findActive(sessionKey?: string, lookup?: TraceContextLookup): TraceContextEntry | undefined {
    let best: TraceContextEntry | undefined;
    for (const [key, entry] of this.map) {
      if (!this.matchesSessionKey(key, sessionKey)) {
        continue;
      }
      if (
        !entry.finalized &&
        this.matchesLookup(entry, lookup) &&
        (!best || this.isNewerForSelection(entry, best))
      ) {
        best = entry;
      }
    }
    if (best) {
      this.touch(best);
    }
    return best;
  }

  /** Find the most recent entry, including finalized traces for late transcript repair. */
  findRecent(sessionKey?: string, lookup?: TraceContextLookup): TraceContextEntry | undefined {
    let best: TraceContextEntry | undefined;
    for (const [key, entry] of this.map) {
      if (!this.matchesSessionKey(key, sessionKey)) {
        continue;
      }
      if (this.matchesLookup(entry, lookup) && (!best || this.isNewerForSelection(entry, best))) {
        best = entry;
      }
    }
    if (best) {
      this.touch(best);
    }
    return best;
  }

  /** Find the most recent matching finalized entry for late events that omit a run identifier. */
  findRecentFinalized(
    sessionKey?: string,
    predicate: (entry: TraceContextEntry) => boolean = () => true,
  ): TraceContextEntry | undefined {
    let best: TraceContextEntry | undefined;
    for (const [key, entry] of this.map) {
      if (!entry.finalized || !this.matchesSessionKey(key, sessionKey) || !predicate(entry)) {
        continue;
      }
      if (!best || this.isNewerForSelection(entry, best)) {
        best = entry;
      }
    }
    if (best) {
      this.touch(best);
    }
    return best;
  }
}
