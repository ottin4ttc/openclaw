import type {
  PluginStateEntry,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MinimalLogger } from "./types.js";

export const TRACE_LEDGER_NAMESPACE = "trace-ledger-v1";
export const TRACE_LEDGER_MAX_ENTRIES = 40_000;
export const TRACE_LEDGER_TTL_MS = 48 * 60 * 60 * 1000;

export type ObservationEvent =
  | { e: "gen-start"; traceId: string; id: string; llmCall: number; model: string; ts: string }
  | { e: "gen-end"; traceId: string; id: string; ts: string }
  | { e: "span-start"; traceId: string; id: string; tool: string; toolCallId: string; ts: string }
  | { e: "span-end"; traceId: string; id: string; ts: string };

export type TraceRecoveryOutcome = "started" | "succeeded" | "failed" | "abandoned";

export type TraceLedgerTraceRecord = {
  kind: "trace";
  traceId: string;
  agentId: string;
  sessionId: string;
  startedAt: number;
  status: "open" | "ended" | "abandoned";
  correlationKey?: string;
  recoveryAttempts?: number;
  recoveryOutcome?: TraceRecoveryOutcome;
  abandonmentReason?: "trace_age_exceeded" | "attempt_limit_reached";
};

type TraceLedgerObservationRecord = {
  kind: "observation";
  traceId: string;
  id: string;
  observationKind: "generation" | "span";
  startedAt?: string;
  completedAt?: string;
  llmCall?: number;
  model?: string;
  tool?: string;
  toolCallId?: string;
};

export type TraceLedgerRecord = TraceLedgerTraceRecord | TraceLedgerObservationRecord;

const configuredStores = new Map<string, PluginStateSyncKeyedStore<TraceLedgerRecord>>();
const fallbackStores = new Map<string, PluginStateSyncKeyedStore<TraceLedgerRecord>>();

function storeScope(stateDir: string | null): string {
  return stateDir?.trim() || "volatile";
}

function createMemoryStore(): PluginStateSyncKeyedStore<TraceLedgerRecord> {
  const records = new Map<string, PluginStateEntry<TraceLedgerRecord>>();
  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of records) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        records.delete(key);
      }
    }
  };
  const write = (key: string, value: TraceLedgerRecord, ttlMs = TRACE_LEDGER_TTL_MS) => {
    const createdAt = Date.now();
    records.set(key, { key, value, createdAt, expiresAt: createdAt + ttlMs });
  };
  return {
    register(key, value, options) {
      sweep();
      write(key, value, options?.ttlMs);
    },
    registerIfAbsent(key, value, options) {
      sweep();
      if (records.has(key)) {
        return false;
      }
      write(key, value, options?.ttlMs);
      return true;
    },
    update(key, updateValue, options) {
      sweep();
      const next = updateValue(records.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      write(key, next, options?.ttlMs);
      return true;
    },
    lookup(key) {
      sweep();
      return records.get(key)?.value;
    },
    consume(key) {
      sweep();
      const value = records.get(key)?.value;
      records.delete(key);
      return value;
    },
    delete(key) {
      sweep();
      return records.delete(key);
    },
    entries() {
      sweep();
      return [...records.values()].toSorted(
        (left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key),
      );
    },
    clear() {
      records.clear();
    },
  };
}

/** Binds the plugin-owned SQLite store supplied by the public runtime facade. */
export function configureTraceLedgerStore(
  stateDir: string | null,
  store: PluginStateSyncKeyedStore<TraceLedgerRecord>,
): void {
  configuredStores.set(storeScope(stateDir), store);
}

export function resetTraceLedgerStoreForTests(): void {
  configuredStores.clear();
  fallbackStores.clear();
}

function resolveStore(stateDir: string | null): PluginStateSyncKeyedStore<TraceLedgerRecord> {
  const scope = storeScope(stateDir);
  const configuredStore = configuredStores.get(scope);
  if (configuredStore) {
    return configuredStore;
  }
  let store = fallbackStores.get(scope);
  if (!store) {
    store = createMemoryStore();
    fallbackStores.set(scope, store);
  }
  return store;
}

function traceKey(traceId: string): string {
  return `trace:${traceId}`;
}

function observationKey(traceId: string, observationId: string): string {
  return `observation:${traceId}:${observationId}`;
}

function readRecords(stateDir: string | null, logger?: MinimalLogger | null): TraceLedgerRecord[] {
  try {
    return resolveStore(stateDir)
      .entries()
      .map((entry) => entry.value);
  } catch (error) {
    logger?.warn?.(`Langfuse: failed to read trace ledger — ${String(error)}`);
    return [];
  }
}

export function readTraceLedgerRecordsForTest(stateDir: string | null): TraceLedgerRecord[] {
  return readRecords(stateDir);
}

export function readTraceLedgerTrace(
  stateDir: string | null,
  traceId: string,
  logger?: MinimalLogger | null,
): TraceLedgerTraceRecord | undefined {
  try {
    const record = resolveStore(stateDir).lookup(traceKey(traceId));
    return record?.kind === "trace" ? record : undefined;
  } catch (error) {
    logger?.warn?.(`Langfuse: failed to read trace ${traceId} from ledger — ${String(error)}`);
    return undefined;
  }
}

export function listTraceLedgerTraces(
  stateDir: string | null,
  logger?: MinimalLogger | null,
): TraceLedgerTraceRecord[] {
  return readRecords(stateDir, logger)
    .filter((record): record is TraceLedgerTraceRecord => record.kind === "trace")
    .toSorted((left, right) => left.startedAt - right.startedAt);
}

export function readNextTraceStartTimestamp(
  stateDir: string | null,
  trace: TraceLedgerTraceRecord,
  logger?: MinimalLogger | null,
): number | undefined {
  return listTraceLedgerTraces(stateDir, logger).find(
    (candidate) =>
      candidate.agentId === trace.agentId &&
      candidate.sessionId === trace.sessionId &&
      candidate.traceId !== trace.traceId &&
      candidate.startedAt > trace.startedAt,
  )?.startedAt;
}

export function writeTraceMarker(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  type: "start" | "end",
  traceId: string,
  logger?: MinimalLogger | null,
  options?: { correlationKey?: string; startedAt?: number },
): boolean {
  if (!sessionId) {
    return true;
  }
  try {
    const store = resolveStore(stateDir);
    const current = store.lookup(traceKey(traceId));
    const existing = current?.kind === "trace" ? current : undefined;
    const startedAt = existing?.startedAt ?? options?.startedAt ?? Date.now();
    const status = type === "end" ? "ended" : (existing?.status ?? "open");
    store.register(traceKey(traceId), {
      kind: "trace",
      traceId,
      agentId,
      sessionId,
      startedAt,
      status,
      ...(options?.correlationKey || existing?.correlationKey
        ? { correlationKey: options?.correlationKey ?? existing?.correlationKey }
        : {}),
      ...(existing?.recoveryAttempts !== undefined
        ? { recoveryAttempts: existing.recoveryAttempts }
        : {}),
      ...(existing?.recoveryOutcome ? { recoveryOutcome: existing.recoveryOutcome } : {}),
      ...(existing?.abandonmentReason ? { abandonmentReason: existing.abandonmentReason } : {}),
    });
    return true;
  } catch (error) {
    logger?.warn?.(
      `Langfuse: failed to write trace marker (${type}) for trace ${traceId} — ${String(error)}`,
    );
    return false;
  }
}

export function writeTraceRecoveryMarker(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  traceId: string,
  attempt: number,
  outcome: TraceRecoveryOutcome,
  logger?: MinimalLogger | null,
  reason?: "trace_age_exceeded" | "attempt_limit_reached",
): boolean {
  if (!sessionId) {
    return true;
  }
  try {
    const store = resolveStore(stateDir);
    const current = store.lookup(traceKey(traceId));
    const existing = current?.kind === "trace" ? current : undefined;
    store.register(traceKey(traceId), {
      kind: "trace",
      traceId,
      agentId,
      sessionId,
      startedAt: existing?.startedAt ?? Date.now(),
      status: outcome === "abandoned" ? "abandoned" : (existing?.status ?? "open"),
      ...(existing?.correlationKey ? { correlationKey: existing.correlationKey } : {}),
      recoveryAttempts: Math.max(attempt, existing?.recoveryAttempts ?? 0),
      recoveryOutcome: outcome,
      ...(reason ? { abandonmentReason: reason } : {}),
    });
    return true;
  } catch (error) {
    logger?.warn?.(
      `Langfuse: failed to write trace recovery marker (${outcome}) for trace ${traceId} — ${String(error)}`,
    );
    return false;
  }
}

export function readOpenTraceMarkerByCorrelation(
  stateDir: string | null,
  agentId: string,
  sessionId: string,
  correlationKey: string,
): { traceId: string; timestamp?: number } | undefined {
  const record = listTraceLedgerTraces(stateDir)
    .toReversed()
    .find(
      (record) =>
        record.agentId === agentId &&
        record.sessionId === sessionId &&
        record.correlationKey === correlationKey &&
        record.status === "open",
    );
  return record ? { traceId: record.traceId, timestamp: record.startedAt } : undefined;
}

function observationRecordFromEvent(
  event: ObservationEvent,
  current?: TraceLedgerObservationRecord,
): TraceLedgerObservationRecord {
  const observationKind = event.e === "gen-start" || event.e === "gen-end" ? "generation" : "span";
  if (event.e === "gen-start") {
    return {
      kind: "observation",
      traceId: event.traceId,
      id: event.id,
      observationKind,
      startedAt: event.ts,
      ...(current?.completedAt ? { completedAt: current.completedAt } : {}),
      llmCall: event.llmCall,
      model: event.model,
    };
  }
  if (event.e === "span-start") {
    return {
      kind: "observation",
      traceId: event.traceId,
      id: event.id,
      observationKind,
      startedAt: event.ts,
      ...(current?.completedAt ? { completedAt: current.completedAt } : {}),
      tool: event.tool,
      toolCallId: event.toolCallId,
    };
  }
  return {
    kind: "observation",
    traceId: event.traceId,
    id: event.id,
    observationKind: current?.observationKind ?? observationKind,
    ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
    completedAt: event.ts,
    ...(current?.llmCall !== undefined ? { llmCall: current.llmCall } : {}),
    ...(current?.model ? { model: current.model } : {}),
    ...(current?.tool ? { tool: current.tool } : {}),
    ...(current?.toolCallId ? { toolCallId: current.toolCallId } : {}),
  };
}

export function writeObservationEvent(
  stateDir: string | null,
  _agentId: string,
  sessionId: string,
  event: ObservationEvent,
  logger?: MinimalLogger | null,
): boolean {
  if (!sessionId) {
    return true;
  }
  try {
    const store = resolveStore(stateDir);
    const key = observationKey(event.traceId, event.id);
    const update = store.update;
    if (update) {
      return update(key, (current) =>
        observationRecordFromEvent(event, current?.kind === "observation" ? current : undefined),
      );
    }
    const current = store.lookup(key);
    store.register(
      key,
      observationRecordFromEvent(event, current?.kind === "observation" ? current : undefined),
    );
    return true;
  } catch (error) {
    logger?.warn?.(
      `Langfuse: failed to write observation event (${event.e}) for trace ${event.traceId} — ${String(error)}`,
    );
    return false;
  }
}

export function readObservationEvents(
  stateDir: string | null,
  _agentId: string,
  sessionId: string,
  traceId: string,
  logger?: MinimalLogger | null,
): {
  createdIds: Set<string>;
  completedIds: Set<string>;
  generationIdsBySlot: Map<number, string>;
  toolSpanIdsByCallId: Map<string, string>;
} {
  const createdIds = new Set<string>();
  const completedIds = new Set<string>();
  const generationIdsBySlot = new Map<number, string>();
  const toolSpanIdsByCallId = new Map<string, string>();
  if (!sessionId) {
    return { createdIds, completedIds, generationIdsBySlot, toolSpanIdsByCallId };
  }
  for (const record of readRecords(stateDir, logger)) {
    if (record.kind !== "observation" || record.traceId !== traceId) {
      continue;
    }
    if (record.startedAt) {
      createdIds.add(record.id);
    }
    if (record.completedAt) {
      completedIds.add(record.id);
    }
    if (record.llmCall !== undefined) {
      generationIdsBySlot.set(record.llmCall, record.id);
    }
    if (record.toolCallId) {
      toolSpanIdsByCallId.set(record.toolCallId, record.id);
    }
  }
  return { createdIds, completedIds, generationIdsBySlot, toolSpanIdsByCallId };
}
