import fs from "node:fs/promises";
import path from "node:path";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { fingerprintCodexLogValue } from "./attempt-diagnostics.js";
import type { CodexAppServerClient } from "./client.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];
type ModelCallStartedInput = Extract<TrustedDiagnosticEventInput, { type: "model.call.started" }>;
type RolloutTraceModelBaseFields = Omit<
  ModelCallStartedInput,
  "callId" | "scope" | "startTimeMs" | "type"
>;

type RolloutTraceLog = {
  debug(message: string, data?: Record<string, unknown>): void;
};

type RolloutTraceContentCapture = {
  inputMessages?: boolean;
  outputMessages?: boolean;
  systemPrompt?: boolean;
  toolDefinitions?: boolean;
  toolInputs?: boolean;
  toolOutputs?: boolean;
};

type ToolParamsSummary =
  | { kind: "object" }
  | { kind: "array"; length: number }
  | { kind: "string"; length: number }
  | { kind: "truncated"; originalBytes?: number }
  | { kind: "number" | "boolean" | "null" | "undefined" | "other" };

type ProviderRequestBaseFields = RolloutTraceModelBaseFields & {
  callId: string;
  scope: "provider-request";
  provider: string;
  model: string;
  upstreamRequestIdHash?: string;
};

type RawPayloadRef = {
  raw_payload_id?: unknown;
  path?: unknown;
};

type RawTracePayload = {
  type?: unknown;
  inference_call_id?: unknown;
  thread_id?: unknown;
  codex_turn_id?: unknown;
  model?: unknown;
  provider_name?: unknown;
  request_payload?: unknown;
  response_payload?: unknown;
  partial_response_payload?: unknown;
  response_id?: unknown;
  upstream_request_id?: unknown;
  error?: unknown;
  reason?: unknown;
  tool_call_id?: unknown;
  invocation_payload?: unknown;
  result_payload?: unknown;
  status?: unknown;
  duration_ms?: unknown;
  durationMs?: unknown;
};

type RawTraceEvent = {
  seq?: unknown;
  wall_time_unix_ms?: unknown;
  thread_id?: unknown;
  codex_turn_id?: unknown;
  payload?: unknown;
};

type InferenceStarted = {
  event: RawTraceEvent;
  payload: RawTracePayload;
  callId: string;
  requestPayloadRef?: RawPayloadRef;
};

type InferenceTerminal = {
  event: RawTraceEvent;
  payload: RawTracePayload;
  callId: string;
  kind: "completed" | "failed" | "cancelled";
  responseId?: string;
  responsePayloadRef?: RawPayloadRef;
  upstreamRequestId?: string;
};

type ToolStarted = {
  event: RawTraceEvent;
  callId: string;
  invocationPayloadRef?: RawPayloadRef;
};

type ToolTerminal = {
  event: RawTraceEvent;
  callId: string;
  resultPayloadRef?: RawPayloadRef;
  status: string;
};

const CODEX_PROVIDER_REQUEST_ID_HASH_NAMESPACE = "openclaw:codex:provider-request-id:v1";
const CODEX_RESPONSE_ID_HASH_NAMESPACE = "openclaw:codex:response-id:v1";
const PROCESSED_ROLLOUT_TURN_TTL_MS = 10 * 60 * 1000;
const PROCESSED_ROLLOUT_TURN_MAX_ENTRIES = 512;
type ProcessedRolloutTurn = {
  completed: boolean;
  emittedEventKeys: Set<string>;
  emittedToolLifecycleKeys: Set<string>;
  updatedAt: number;
};
const processedRolloutTurns = new Map<string, ProcessedRolloutTurn>();
const ROLLOUT_TRACE_READ_STATE_TTL_MS = 60 * 60 * 1000;
const ROLLOUT_TRACE_READ_STATE_MAX_ENTRIES = 128;
const ROLLOUT_TRACE_PENDING_TURN_MAX_ENTRIES = 64;
const ROLLOUT_TRACE_MAX_EVENTS_PER_TURN = 2048;
const ROLLOUT_TRACE_MAX_EVENT_BYTES_PER_TURN = 4 * 1024 * 1024;
const ROLLOUT_TRACE_MAX_EVENT_BYTES_PER_STATE = 8 * 1024 * 1024;
const ROLLOUT_TRACE_MAX_EVENT_BYTES_GLOBAL = 32 * 1024 * 1024;
const ROLLOUT_TRACE_MAX_SKIPPED_PAYLOAD_REFS_PER_TURN = 256;
const ROLLOUT_TRACE_MAX_SKIPPED_PAYLOAD_REF_BYTES_PER_TURN = 256 * 1024;
const ROLLOUT_TRACE_READ_CHUNK_BYTES = 64 * 1024;
const ROLLOUT_TRACE_MAX_PARTIAL_LINE_BYTES = 1024 * 1024;
const ROLLOUT_TRACE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ROLLOUT_TRACE_PAYLOAD_EDGE_BYTES = 128 * 1024;
const ROLLOUT_TRACE_SETTLE_TIMEOUT_MS = 500;
const ROLLOUT_TRACE_SETTLE_INTERVAL_MS = 25;
const ROLLOUT_TRACE_BACKGROUND_SETTLE_TIMEOUT_MS = 30_000;
const ROLLOUT_TRACE_BACKGROUND_SETTLE_INITIAL_INTERVAL_MS = 100;
const ROLLOUT_TRACE_BACKGROUND_SETTLE_MAX_INTERVAL_MS = 2_000;
const ROLLOUT_TRACE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const CODEX_ATTEMPT_DIAGNOSTIC_DRAIN_TIMEOUT_MS = 500;
type RolloutTraceReadState = {
  offset: number;
  partialLine: Buffer;
  eventsByTurn: Map<string, RawTraceEvent[]>;
  eventBytesByTurn: Map<string, number>;
  totalEventBytes: number;
  totalSkippedPayloadRefBytes: number;
  skippedTurns: Set<string>;
  skippedPayloadRefsByTurn: Map<string, Set<string>>;
  skippedPayloadRefBytesByTurn: Map<string, number>;
  skippedPayloadRefOverflowTurns: Set<string>;
  skippedPayloadRefMetadataEvicted: boolean;
  updatedAt: number;
};
const rolloutTraceReadStates = new Map<string, RolloutTraceReadState>();
// Reserve bytes across concurrent bundle reads before advancing offsets. Budget pressure may
// evict idle caches, including active monitors; their append-only trace files remain authoritative.
const rolloutTraceReadsInFlight = new Map<string, number>();
let rolloutTraceReservedReadBytes = 0;
const preparedRolloutTraceRoots = new Set<string>();
const rolloutTracePruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
type RolloutTraceBackgroundDrain = {
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
};
const rolloutTraceBackgroundDrains = new Map<string, RolloutTraceBackgroundDrain>();
const rolloutTraceDrainChains = new Map<string, Promise<unknown>>();
const activeRolloutTraceTurns = new Map<string, number>();
const activeRolloutTraceRoots = new Map<string, Map<string, number>>();
const activeRolloutTraceBundleOwners = new Map<string, Set<CodexAppServerClient>>();
const liveRolloutTraceClientsByThread = new Map<string, Set<CodexAppServerClient>>();
const rolloutTraceClientBundles = new WeakMap<
  CodexAppServerClient,
  {
    bundleDirs: Set<string>;
    rootsByThread: Map<string, { traceRoot: string; threadId: string }>;
  }
>();
export const CODEX_ROLLOUT_TRACE_ROOT_ENV_VAR = "CODEX_ROLLOUT_TRACE_ROOT";

type RolloutTraceDiagnosticsParams = {
  traceRoot?: string;
  threadId: string;
  turnId: string;
  baseFields: RolloutTraceModelBaseFields;
  capture?: RolloutTraceContentCapture;
  emitToolDiagnostics?: boolean;
  log?: RolloutTraceLog;
};

type RolloutTraceDrainOptions = {
  allowBackgroundDrain?: boolean;
};

export type CodexRolloutTraceMonitor = {
  finalDrain(): Promise<CodexRolloutTraceFinalDrainResult>;
  stop(): void;
};

export type CodexRolloutTraceFinalDrainResult = Readonly<{
  emitted: number;
  complete: boolean;
  reason?: "incomplete_rollout" | "read_error" | "trace_unavailable";
  emittedToolLifecycleKeys?: readonly string[];
}>;

type CodexRolloutTraceDiagnosticsPassResult = CodexRolloutTraceFinalDrainResult & {
  settled: boolean;
};

export function resolveCodexRolloutTraceRootDir(agentDir: string): string {
  return path.join(agentDir, "codex-home", "rollout-traces");
}

export async function prepareCodexRolloutTraceRoot(traceRoot: string): Promise<string> {
  await fs.mkdir(traceRoot, { recursive: true });
  const resolvedRoot = path.resolve(traceRoot);
  const firstUse = !preparedRolloutTraceRoots.has(resolvedRoot);
  preparedRolloutTraceRoots.add(resolvedRoot);
  if (firstUse) {
    await pruneCodexRolloutTraceBundles(traceRoot);
    scheduleCodexRolloutTracePrune(resolvedRoot);
  }
  return traceRoot;
}

/** Protects bundles owned by a live app-server client and reclaims them after it exits. */
export async function registerCodexRolloutTraceClient(params: {
  traceRoot: string;
  threadId: string;
  client: CodexAppServerClient;
}): Promise<void> {
  const rootThreadKey = rolloutTraceRootThreadKey(params.traceRoot, params.threadId);
  let registration = rolloutTraceClientBundles.get(params.client);
  if (!registration) {
    registration = { bundleDirs: new Set(), rootsByThread: new Map() };
    rolloutTraceClientBundles.set(params.client, registration);
    params.client.addCloseHandler(() => {
      const closedRegistration = rolloutTraceClientBundles.get(params.client);
      if (!closedRegistration) {
        return;
      }
      rolloutTraceClientBundles.delete(params.client);
      for (const closedRootThreadKey of closedRegistration.rootsByThread.keys()) {
        const clients = liveRolloutTraceClientsByThread.get(closedRootThreadKey);
        clients?.delete(params.client);
        if (clients?.size === 0) {
          liveRolloutTraceClientsByThread.delete(closedRootThreadKey);
        }
      }
      for (const bundleDir of closedRegistration.bundleDirs) {
        const owners = activeRolloutTraceBundleOwners.get(bundleDir);
        owners?.delete(params.client);
        if (owners?.size === 0) {
          // A client close can race the attempt's terminal drain. Keep an
          // incomplete bundle until the final drain or the periodic TTL prune
          // so provider failures and cancellations are not discarded.
          activeRolloutTraceBundleOwners.delete(bundleDir);
        }
      }
      for (const rootThread of closedRegistration.rootsByThread.values()) {
        void cleanupClosedClientRolloutTraceBundles(rootThread).catch(() => undefined);
      }
    });
  }
  registration.rootsByThread.set(rootThreadKey, {
    traceRoot: params.traceRoot,
    threadId: params.threadId,
  });
  const clients = liveRolloutTraceClientsByThread.get(rootThreadKey) ?? new Set();
  clients.add(params.client);
  liveRolloutTraceClientsByThread.set(rootThreadKey, clients);
  for (const bundleDir of await listTraceBundleDirs(params.traceRoot)) {
    await bindRolloutTraceBundleToLiveOwners(params.traceRoot, bundleDir);
  }
}

const CODEX_ROLLOUT_TRACE_MAX_COMPLETED_BUNDLES = 2;
const CODEX_ROLLOUT_TRACE_MAX_AGE_MS = 60 * 60 * 1000;

function scheduleCodexRolloutTracePrune(traceRoot: string): void {
  if (rolloutTracePruneTimers.has(traceRoot)) {
    return;
  }
  const timer = setTimeout(() => {
    void runCodexRolloutTracePrune(traceRoot);
  }, ROLLOUT_TRACE_PRUNE_INTERVAL_MS);
  timer.unref();
  rolloutTracePruneTimers.set(traceRoot, timer);
}

async function runCodexRolloutTracePrune(traceRoot: string): Promise<void> {
  rolloutTracePruneTimers.delete(traceRoot);
  try {
    await fs.access(traceRoot);
  } catch {
    preparedRolloutTraceRoots.delete(traceRoot);
    return;
  }
  try {
    await pruneCodexRolloutTraceBundles(traceRoot);
  } catch {
    // Cleanup is best-effort and must never make the Codex runtime unstable.
  } finally {
    scheduleCodexRolloutTracePrune(traceRoot);
  }
}

/** Retains current traces and removes old crash remnants or excess completed bundles. */
export async function pruneCodexRolloutTraceBundles(
  traceRoot: string,
  now = Date.now(),
): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(traceRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const completedCandidates: Array<{ cleanupDir: string; modifiedAtMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateRoot = path.resolve(traceRoot, entry.name);
    const bundleDirs = await listTraceBundleDirs(candidateRoot).catch(() => []);
    const bundleStates = (
      await Promise.all(
        bundleDirs.map(async (bundleDir) => {
          const traceFile = path.join(bundleDir, "trace.jsonl");
          try {
            const [stat, completed] = await Promise.all([
              fs.stat(traceFile),
              traceBundleHasEnded(traceFile),
            ]);
            return { modifiedAtMs: stat.mtimeMs, completed };
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((bundle): bundle is { modifiedAtMs: number; completed: boolean } => Boolean(bundle));
    const rootStat = await fs.stat(candidateRoot).catch(() => undefined);
    const modifiedAtMs =
      bundleStates.length > 0
        ? Math.max(...bundleStates.map((bundle) => bundle.modifiedAtMs))
        : (rootStat?.mtimeMs ?? 0);
    const stale = modifiedAtMs > 0 && now - modifiedAtMs > CODEX_ROLLOUT_TRACE_MAX_AGE_MS;
    if (bundleStates.length === 0 || bundleStates.some((bundle) => !bundle.completed)) {
      for (const bundleDir of bundleDirs) {
        await bindRolloutTraceBundleToLiveOwners(traceRoot, bundleDir);
      }
      const active = bundleDirs.some(
        (bundleDir) => (activeRolloutTraceBundleOwners.get(path.resolve(bundleDir))?.size ?? 0) > 0,
      );
      if (stale && !active) {
        await removeRolloutTraceBundle(candidateRoot);
      }
      continue;
    }
    completedCandidates.push({ cleanupDir: candidateRoot, modifiedAtMs });
  }
  const completedBundles = completedCandidates.toSorted(
    (left, right) => right.modifiedAtMs - left.modifiedAtMs,
  );
  for (let index = 0; index < completedBundles.length; index += 1) {
    const bundle = completedBundles[index];
    if (
      bundle &&
      (index >= CODEX_ROLLOUT_TRACE_MAX_COMPLETED_BUNDLES ||
        now - bundle.modifiedAtMs > CODEX_ROLLOUT_TRACE_MAX_AGE_MS)
    ) {
      await removeRolloutTraceBundle(bundle.cleanupDir);
    }
  }
}

async function bindRolloutTraceBundleToLiveOwners(
  traceRoot: string,
  bundleDir: string,
): Promise<void> {
  const threadId = await readTraceBundleRootThreadId(bundleDir);
  if (!threadId) {
    return;
  }
  const clients = liveRolloutTraceClientsByThread.get(
    rolloutTraceRootThreadKey(traceRoot, threadId),
  );
  if (!clients || clients.size === 0) {
    return;
  }
  const resolvedBundleDir = path.resolve(bundleDir);
  const owners = activeRolloutTraceBundleOwners.get(resolvedBundleDir) ?? new Set();
  for (const client of clients) {
    owners.add(client);
    rolloutTraceClientBundles.get(client)?.bundleDirs.add(resolvedBundleDir);
  }
  activeRolloutTraceBundleOwners.set(resolvedBundleDir, owners);
}

async function cleanupClosedClientRolloutTraceBundles(params: {
  traceRoot: string;
  threadId: string;
}): Promise<void> {
  for (const bundleDir of await listTraceBundleDirs(params.traceRoot)) {
    if ((await readTraceBundleRootThreadId(bundleDir)) !== params.threadId) {
      continue;
    }
    // Rebind any other live client for this thread; cleanup is deferred to the
    // terminal drain or periodic TTL prune to avoid a close/drain race.
    await bindRolloutTraceBundleToLiveOwners(params.traceRoot, bundleDir);
  }
}

function rolloutTraceRootThreadKey(traceRoot: string, threadId: string): string {
  return `${path.resolve(traceRoot)}:${threadId}`;
}

async function removeRolloutTraceBundle(bundleDir: string): Promise<void> {
  await fs.rm(bundleDir, { recursive: true, force: true });
  const resolvedRoot = path.resolve(bundleDir);
  for (const stateKey of rolloutTraceReadStates.keys()) {
    if (stateKey === resolvedRoot || stateKey.startsWith(`${resolvedRoot}${path.sep}`)) {
      rolloutTraceReadStates.delete(stateKey);
    }
  }
  for (const activeBundleDir of activeRolloutTraceBundleOwners.keys()) {
    if (
      activeBundleDir === resolvedRoot ||
      activeBundleDir.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      const owners = activeRolloutTraceBundleOwners.get(activeBundleDir);
      for (const client of owners ?? []) {
        rolloutTraceClientBundles.get(client)?.bundleDirs.delete(activeBundleDir);
      }
      activeRolloutTraceBundleOwners.delete(activeBundleDir);
    }
  }
}

async function readTraceBundleRootThreadId(bundleDir: string): Promise<string | undefined> {
  try {
    const manifest = asObject(
      JSON.parse(await fs.readFile(path.join(bundleDir, "manifest.json"), "utf8")),
    );
    return stringValue(manifest?.root_thread_id);
  } catch {
    return undefined;
  }
}

async function traceBundleHasEnded(traceFile: string): Promise<boolean> {
  const handle = await fs.open(traceFile, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, ROLLOUT_TRACE_READ_CHUNK_BYTES);
    if (length === 0) {
      return false;
    }
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      .some((line) => traceEventPayloadType(line) === "rollout_ended");
  } finally {
    await handle.close();
  }
}

function traceEventPayloadType(line: string): string | undefined {
  try {
    const event = asObject(JSON.parse(line) as unknown);
    return stringValue(asObject(event?.payload)?.type);
  } catch {
    return undefined;
  }
}

export async function emitCodexRolloutTraceProviderRequestDiagnostics(
  params: RolloutTraceDiagnosticsParams,
): Promise<number> {
  return serialCodexRolloutTraceDrain(params, async () => {
    return (await emitCodexRolloutTraceProviderRequestDiagnosticsPass(params)).emitted;
  });
}

export async function drainCodexRolloutTraceProviderRequestDiagnostics(
  params: RolloutTraceDiagnosticsParams,
  options: RolloutTraceDrainOptions = {},
): Promise<number> {
  return serialCodexRolloutTraceDrain(
    params,
    async () =>
      (await drainCodexRolloutTraceProviderRequestDiagnosticsUnserialized(params, options)).emitted,
  );
}

export async function finalizeCodexRolloutTraceProviderRequestDiagnostics(
  params: RolloutTraceDiagnosticsParams,
): Promise<CodexRolloutTraceFinalDrainResult> {
  const activeKey = registerActiveRolloutTraceTurn(params);
  try {
    return await serialCodexRolloutTraceDrain(params, () =>
      drainCodexRolloutTraceProviderRequestDiagnosticsUnserialized(params, {
        allowBackgroundDrain: false,
      }),
    );
  } catch (error) {
    params.log?.debug("codex rollout trace final drain failed", {
      error: formatTraceError(error),
      traceRoot: params.traceRoot,
      threadId: params.threadId,
      turnId: params.turnId,
    });
    return {
      emitted: 0,
      complete: false,
      reason: "read_error",
      ...rolloutTraceToolLifecycleCoverage(params),
    };
  } finally {
    releaseActiveRolloutTraceTurn(params, activeKey);
  }
}

export function startCodexRolloutTraceMonitor(
  params: RolloutTraceDiagnosticsParams & { intervalMs?: number },
): CodexRolloutTraceMonitor {
  let stopped = false;
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finalDrainPromise: Promise<CodexRolloutTraceFinalDrainResult> | undefined;
  const activeKey = registerActiveRolloutTraceTurn(params);
  let activeReleased = false;
  const releaseActive = () => {
    if (activeReleased) {
      return;
    }
    activeReleased = true;
    releaseActiveRolloutTraceTurn(params, activeKey);
  };
  const intervalMs = params.intervalMs ?? ROLLOUT_TRACE_BACKGROUND_SETTLE_INITIAL_INTERVAL_MS;
  const poll = async () => {
    if (stopped || draining) {
      return;
    }
    draining = true;
    try {
      await emitCodexRolloutTraceProviderRequestDiagnostics(params);
    } catch (error) {
      params.log?.debug("codex rollout trace monitor poll skipped", {
        error: formatTraceError(error),
        traceRoot: params.traceRoot,
        threadId: params.threadId,
        turnId: params.turnId,
      });
    } finally {
      draining = false;
      if (!stopped) {
        timer = setTimeout(() => {
          void poll();
        }, intervalMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(() => {
    void poll();
  }, intervalMs);
  timer.unref();
  const stopPolling = () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return {
    async finalDrain() {
      if (finalDrainPromise) {
        return finalDrainPromise;
      }
      if (stopped) {
        releaseActive();
        return {
          emitted: 0,
          complete: false,
          reason: "trace_unavailable",
          ...rolloutTraceToolLifecycleCoverage(params),
        };
      }
      // Establish the producer boundary before waiting behind an in-flight poll.
      // Otherwise that poll could schedule more work after this final drain.
      stopPolling();
      finalDrainPromise = serialCodexRolloutTraceDrain(params, () =>
        drainCodexRolloutTraceProviderRequestDiagnosticsUnserialized(params, {
          allowBackgroundDrain: false,
        }),
      )
        .catch((error: unknown): CodexRolloutTraceFinalDrainResult => {
          params.log?.debug("codex rollout trace monitor final drain skipped", {
            error: formatTraceError(error),
            traceRoot: params.traceRoot,
            threadId: params.threadId,
            turnId: params.turnId,
          });
          return {
            emitted: 0,
            complete: false,
            reason: "read_error",
            ...rolloutTraceToolLifecycleCoverage(params),
          };
        })
        .finally(releaseActive);
      return finalDrainPromise;
    },
    stop() {
      stopPolling();
      if (!finalDrainPromise) {
        releaseActive();
      }
    },
  };
}

async function drainCodexRolloutTraceProviderRequestDiagnosticsUnserialized(
  params: RolloutTraceDiagnosticsParams,
  options: RolloutTraceDrainOptions = {},
): Promise<CodexRolloutTraceFinalDrainResult> {
  const deadline = Date.now() + ROLLOUT_TRACE_SETTLE_TIMEOUT_MS;
  const allowBackgroundDrain = options.allowBackgroundDrain ?? true;
  const drainKey = codexRolloutTraceBackgroundDrainKey(params);
  if (!allowBackgroundDrain && drainKey) {
    cancelCodexRolloutTraceBackgroundDrain(drainKey);
  }
  let emitted = 0;
  while (true) {
    const finalDrain = !allowBackgroundDrain;
    const result = await emitCodexRolloutTraceProviderRequestDiagnosticsPass(params, {
      allowEmptyTurnCompletion: finalDrain,
      sealCompletedTurn: finalDrain,
    });
    emitted += result.emitted;
    if (result.settled) {
      return {
        emitted,
        complete: result.complete,
        ...(result.emittedToolLifecycleKeys
          ? { emittedToolLifecycleKeys: result.emittedToolLifecycleKeys }
          : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    if (Date.now() >= deadline) {
      if (!allowBackgroundDrain && result.reason === "incomplete_rollout") {
        const reconciled = await emitCodexRolloutTraceProviderRequestDiagnosticsPass(params, {
          allowEmptyTurnCompletion: true,
          sealCompletedTurn: true,
          reconcileMissingToolTerminals: true,
        });
        emitted += reconciled.emitted;
        if (reconciled.settled) {
          return {
            emitted,
            complete: reconciled.complete,
            ...(reconciled.emittedToolLifecycleKeys
              ? { emittedToolLifecycleKeys: reconciled.emittedToolLifecycleKeys }
              : {}),
            ...(reconciled.reason ? { reason: reconciled.reason } : {}),
          };
        }
      }
      if (allowBackgroundDrain) {
        scheduleCodexRolloutTraceBackgroundDrain(params);
      }
      return {
        emitted,
        complete: false,
        reason: result.reason ?? "incomplete_rollout",
        ...(result.emittedToolLifecycleKeys
          ? { emittedToolLifecycleKeys: result.emittedToolLifecycleKeys }
          : {}),
      };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ROLLOUT_TRACE_SETTLE_INTERVAL_MS);
    });
  }
}

async function serialCodexRolloutTraceDrain<T>(
  params: RolloutTraceDiagnosticsParams,
  operation: () => Promise<T>,
): Promise<T> {
  const key = params.traceRoot?.trim() ? path.resolve(params.traceRoot) : undefined;
  if (!key) {
    return operation();
  }
  const previous = rolloutTraceDrainChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  rolloutTraceDrainChains.set(key, next);
  try {
    return await next;
  } finally {
    if (rolloutTraceDrainChains.get(key) === next) {
      rolloutTraceDrainChains.delete(key);
    }
  }
}

export async function waitForCodexAttemptDiagnosticEventsDrained(
  waitForDrain: (timeoutMs: number) => Promise<void>,
  timeoutMs = CODEX_ATTEMPT_DIAGNOSTIC_DRAIN_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      waitForDrain(timeoutMs).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function scheduleCodexRolloutTraceBackgroundDrain(params: RolloutTraceDiagnosticsParams): void {
  const key = codexRolloutTraceBackgroundDrainKey(params);
  if (!key) {
    return;
  }
  if (rolloutTraceBackgroundDrains.has(key)) {
    return;
  }
  const deadline = Date.now() + ROLLOUT_TRACE_BACKGROUND_SETTLE_TIMEOUT_MS;
  let intervalMs = ROLLOUT_TRACE_BACKGROUND_SETTLE_INITIAL_INTERVAL_MS;
  const scheduleNext = () => {
    const timer = setTimeout(() => {
      void runCodexRolloutTraceBackgroundDrain(params, key, deadline, () => {
        intervalMs = Math.min(intervalMs * 2, ROLLOUT_TRACE_BACKGROUND_SETTLE_MAX_INTERVAL_MS);
        scheduleNext();
      });
    }, intervalMs);
    timer.unref();
    rolloutTraceBackgroundDrains.set(key, { timer, cancelled: false });
  };
  scheduleNext();
}

async function runCodexRolloutTraceBackgroundDrain(
  params: RolloutTraceDiagnosticsParams,
  key: string,
  deadline: number,
  scheduleNext: () => void,
): Promise<void> {
  const drain = rolloutTraceBackgroundDrains.get(key);
  if (!drain || drain.cancelled) {
    return;
  }
  try {
    const result = await serialCodexRolloutTraceDrain(params, () =>
      emitCodexRolloutTraceProviderRequestDiagnosticsPass(params),
    );
    const currentDrain = rolloutTraceBackgroundDrains.get(key);
    if (!currentDrain || currentDrain.cancelled) {
      return;
    }
    if (result.settled || Date.now() >= deadline) {
      rolloutTraceBackgroundDrains.delete(key);
      return;
    }
  } catch {
    if (Date.now() >= deadline) {
      rolloutTraceBackgroundDrains.delete(key);
      return;
    }
  }
  scheduleNext();
}

function codexRolloutTraceBackgroundDrainKey(
  params: RolloutTraceDiagnosticsParams,
): string | undefined {
  if (!params.traceRoot?.trim()) {
    return undefined;
  }
  return `${path.resolve(params.traceRoot)}:${params.threadId}:${params.turnId}`;
}

function rolloutTraceToolLifecycleCoverage(
  params: RolloutTraceDiagnosticsParams,
): Pick<CodexRolloutTraceFinalDrainResult, "emittedToolLifecycleKeys"> {
  const turnKey = codexRolloutTraceBackgroundDrainKey(params);
  const keys = turnKey ? processedRolloutTurns.get(turnKey)?.emittedToolLifecycleKeys : undefined;
  return keys && keys.size > 0 ? { emittedToolLifecycleKeys: [...keys] } : {};
}

function registerActiveRolloutTraceTurn(params: RolloutTraceDiagnosticsParams): string | undefined {
  const key = codexRolloutTraceBackgroundDrainKey(params);
  if (!key || !params.traceRoot?.trim()) {
    return undefined;
  }
  const traceRoot = path.resolve(params.traceRoot);
  const turnKey = rolloutTraceTurnKey(params.threadId, params.turnId);
  activeRolloutTraceTurns.set(key, (activeRolloutTraceTurns.get(key) ?? 0) + 1);
  const activeTurns = activeRolloutTraceRoots.get(traceRoot) ?? new Map<string, number>();
  activeTurns.set(turnKey, (activeTurns.get(turnKey) ?? 0) + 1);
  activeRolloutTraceRoots.set(traceRoot, activeTurns);
  return key;
}

function releaseActiveRolloutTraceTurn(
  params: RolloutTraceDiagnosticsParams,
  key: string | undefined,
): void {
  if (!key || !params.traceRoot?.trim()) {
    return;
  }
  const activeCount = activeRolloutTraceTurns.get(key) ?? 0;
  if (activeCount <= 1) {
    activeRolloutTraceTurns.delete(key);
  } else {
    activeRolloutTraceTurns.set(key, activeCount - 1);
  }
  const traceRoot = path.resolve(params.traceRoot);
  const activeTurns = activeRolloutTraceRoots.get(traceRoot);
  const turnKey = rolloutTraceTurnKey(params.threadId, params.turnId);
  const rootActiveCount = activeTurns?.get(turnKey) ?? 0;
  if (rootActiveCount <= 1) {
    activeTurns?.delete(turnKey);
  } else {
    activeTurns?.set(turnKey, rootActiveCount - 1);
  }
  if (activeTurns?.size === 0) {
    activeRolloutTraceRoots.delete(traceRoot);
  }
}

export function activeRolloutTraceTurnRegistrationCountForTest(
  params: RolloutTraceDiagnosticsParams,
): number {
  const key = codexRolloutTraceBackgroundDrainKey(params);
  return key ? (activeRolloutTraceTurns.get(key) ?? 0) : 0;
}

function isActiveRolloutTraceReadState(stateKey: string): boolean {
  const state = rolloutTraceReadStates.get(stateKey);
  if (!state) {
    return false;
  }
  for (const [traceRoot, activeTurns] of activeRolloutTraceRoots) {
    if (stateKey !== traceRoot && !stateKey.startsWith(`${traceRoot}${path.sep}`)) {
      continue;
    }
    for (const turnKey of activeTurns.keys()) {
      if (
        state.eventsByTurn.has(turnKey) ||
        state.skippedTurns.has(turnKey) ||
        state.skippedPayloadRefsByTurn.has(turnKey) ||
        state.skippedPayloadRefOverflowTurns.has(turnKey)
      ) {
        return true;
      }
    }
  }
  return false;
}

function cancelCodexRolloutTraceBackgroundDrain(key: string): void {
  const drain = rolloutTraceBackgroundDrains.get(key);
  if (!drain) {
    return;
  }
  drain.cancelled = true;
  clearTimeout(drain.timer);
  rolloutTraceBackgroundDrains.delete(key);
}

async function emitCodexRolloutTraceProviderRequestDiagnosticsPass(
  params: RolloutTraceDiagnosticsParams,
  options: {
    allowEmptyTurnCompletion?: boolean;
    sealCompletedTurn?: boolean;
    reconcileMissingToolTerminals?: boolean;
  } = {},
): Promise<CodexRolloutTraceDiagnosticsPassResult> {
  if (!params.traceRoot?.trim()) {
    return {
      emitted: 0,
      settled: true,
      complete: false,
      reason: "trace_unavailable",
    };
  }
  const traceRoot = params.traceRoot;
  const turnKey = `${path.resolve(traceRoot)}:${params.threadId}:${params.turnId}`;
  pruneProcessedRolloutTurns();
  const turnState = processedRolloutTurns.get(turnKey) ?? {
    completed: false,
    emittedEventKeys: new Set<string>(),
    emittedToolLifecycleKeys: new Set<string>(),
    updatedAt: Date.now(),
  };
  if (turnState.completed) {
    return {
      emitted: 0,
      settled: true,
      complete: true,
      ...rolloutTraceToolLifecycleCoverage(params),
    };
  }
  processedRolloutTurns.set(turnKey, turnState);
  let emitted = 0;
  let observed = false;
  let complete = true;
  let readFailed = false;
  let unreadBundle = false;
  let backpressured = false;
  try {
    const bundleDirs = await listTraceBundleDirs(traceRoot);
    for (const bundleDir of bundleDirs) {
      let result: {
        emitted: number;
        observed: boolean;
        complete: boolean;
        backpressured: boolean;
      };
      try {
        result = await emitTraceBundleDiagnostics({
          ...params,
          traceRoot,
          bundleDir,
          allowEmptyTurnCompletion: options.allowEmptyTurnCompletion,
          reconcileMissingToolTerminals: options.reconcileMissingToolTerminals,
          emittedEventKeys: turnState.emittedEventKeys,
          emittedToolLifecycleKeys: turnState.emittedToolLifecycleKeys,
        });
      } catch (error) {
        const associated = rolloutTraceBundleHasTurnAssociation({
          bundleDir,
          threadId: params.threadId,
          turnId: params.turnId,
          emittedEventKeys: turnState.emittedEventKeys,
        });
        readFailed ||= associated;
        unreadBundle ||= isMissingTraceFileError(error);
        params.log?.debug("codex rollout trace bundle diagnostics skipped", {
          error: formatTraceError(error),
          traceRoot: params.traceRoot,
          bundleDir,
          threadId: params.threadId,
          turnId: params.turnId,
        });
        continue;
      }
      emitted += result.emitted;
      backpressured ||= result.backpressured;
      if (result.observed) {
        observed = true;
        complete &&= result.complete;
      }
    }
  } catch (error) {
    readFailed = true;
    unreadBundle ||= isMissingTraceFileError(error);
    params.log?.debug("codex rollout trace diagnostics skipped", {
      error: formatTraceError(error),
      traceRoot: params.traceRoot,
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }
  const now = Date.now();
  const passComplete = observed && complete && !readFailed && !backpressured;
  // Polling can observe codex_turn_ended before every lifecycle append becomes readable.
  // Only the explicit final drain establishes the producer boundary and seals dedupe state.
  turnState.completed = options.sealCompletedTurn === true && passComplete;
  if (turnState.completed) {
    releaseRolloutTraceTurnEvents(traceRoot, params.threadId, params.turnId);
  }
  turnState.updatedAt = now;
  return {
    emitted,
    settled: passComplete || (!observed && !readFailed && !unreadBundle && !backpressured),
    complete: passComplete,
    ...rolloutTraceToolLifecycleCoverage(params),
    ...(!passComplete
      ? {
          reason: readFailed
            ? ("read_error" as const)
            : observed || backpressured
              ? ("incomplete_rollout" as const)
              : ("trace_unavailable" as const),
        }
      : {}),
  };
}

function isMissingTraceFileError(error: unknown): boolean {
  return stringValue(asObject(error)?.code) === "ENOENT";
}

function rolloutTraceBundleHasTurnAssociation(params: {
  bundleDir: string;
  threadId: string;
  turnId: string;
  emittedEventKeys: Set<string>;
}): boolean {
  const bundleKey = path.resolve(params.bundleDir);
  for (const eventKey of params.emittedEventKeys) {
    if (eventKey.startsWith(`${bundleKey}:`)) {
      return true;
    }
  }
  const state = rolloutTraceReadStates.get(bundleKey);
  const turnKey = rolloutTraceTurnKey(params.threadId, params.turnId);
  return Boolean(
    state?.eventsByTurn.has(turnKey) ||
    state?.skippedTurns.has(turnKey) ||
    state?.skippedPayloadRefsByTurn.has(turnKey),
  );
}

function pruneProcessedRolloutTurns(now = Date.now()): void {
  for (const [key, state] of processedRolloutTurns) {
    if (activeRolloutTraceTurns.has(key)) {
      continue;
    }
    if (
      now - state.updatedAt > PROCESSED_ROLLOUT_TURN_TTL_MS ||
      processedRolloutTurns.size > PROCESSED_ROLLOUT_TURN_MAX_ENTRIES
    ) {
      processedRolloutTurns.delete(key);
    }
  }
}

async function emitTraceBundleDiagnostics(params: {
  traceRoot: string;
  bundleDir: string;
  threadId: string;
  turnId: string;
  baseFields: RolloutTraceModelBaseFields;
  capture?: RolloutTraceContentCapture;
  emitToolDiagnostics?: boolean;
  log?: RolloutTraceLog;
  allowEmptyTurnCompletion?: boolean;
  reconcileMissingToolTerminals?: boolean;
  emittedEventKeys: Set<string>;
  emittedToolLifecycleKeys: Set<string>;
}): Promise<{
  emitted: number;
  observed: boolean;
  complete: boolean;
  backpressured: boolean;
}> {
  const emitToolDiagnostics = params.emitToolDiagnostics !== false;
  const readResult = await readTraceEvents(params.bundleDir, params.threadId, params.turnId);
  const events = readResult.events;
  const startedByCallId = new Map<string, InferenceStarted>();
  const terminalByCallId = new Map<string, InferenceTerminal>();
  const toolStartedByCallId = new Map<string, ToolStarted>();
  const toolTerminalByCallId = new Map<string, ToolTerminal>();
  let turnEndedEvent: RawTraceEvent | undefined;
  for (const event of events) {
    const payload = asObject(event.payload) as RawTracePayload | undefined;
    if (!payload || !matchesTraceTurn(event, payload, params.threadId, params.turnId)) {
      continue;
    }
    const type = stringValue(payload.type);
    if (
      type === "codex_turn_ended" &&
      (!turnEndedEvent || eventSeq(event) > eventSeq(turnEndedEvent))
    ) {
      turnEndedEvent = event;
    }
    const callId = stringValue(payload.inference_call_id);
    if (callId && type === "inference_started") {
      startedByCallId.set(callId, {
        event,
        payload,
        callId,
        requestPayloadRef: asPayloadRef(payload.request_payload),
      });
    } else if (callId && type === "inference_completed") {
      terminalByCallId.set(callId, {
        event,
        payload,
        callId,
        kind: "completed",
        responseId: stringValue(payload.response_id),
        responsePayloadRef: asPayloadRef(payload.response_payload),
        upstreamRequestId: stringValue(payload.upstream_request_id),
      });
    } else if (callId && (type === "inference_failed" || type === "inference_cancelled")) {
      terminalByCallId.set(callId, {
        event,
        payload,
        callId,
        kind: type === "inference_failed" ? "failed" : "cancelled",
        responsePayloadRef: asPayloadRef(payload.partial_response_payload),
        upstreamRequestId: stringValue(payload.upstream_request_id),
      });
    } else if (type === "tool_call_started") {
      const toolCallId = stringValue(payload.tool_call_id);
      if (toolCallId) {
        toolStartedByCallId.set(toolCallId, {
          event,
          callId: toolCallId,
          invocationPayloadRef: asPayloadRef(payload.invocation_payload),
        });
      }
    } else if (type === "tool_call_ended") {
      const toolCallId = stringValue(payload.tool_call_id);
      const status = stringValue(payload.status);
      if (toolCallId && status) {
        toolTerminalByCallId.set(toolCallId, {
          event,
          callId: toolCallId,
          resultPayloadRef: asPayloadRef(payload.result_payload),
          status,
        });
      }
    }
  }

  const turnEnded = turnEndedEvent !== undefined;
  const skipped = rolloutTraceBundleHasSkippedTurn(
    params.bundleDir,
    params.threadId,
    params.turnId,
  );
  const observed = startedByCallId.size > 0 || toolStartedByCallId.size > 0 || turnEnded || skipped;
  const observedAnyLifecycle =
    observed || terminalByCallId.size > 0 || toolTerminalByCallId.size > 0;
  const inferenceCallIds = new Set([...startedByCallId.keys(), ...terminalByCallId.keys()]);
  const toolCallIds = new Set([...toolStartedByCallId.keys(), ...toolTerminalByCallId.keys()]);
  const state = rolloutTraceReadStates.get(path.resolve(params.bundleDir));
  const turnKey = rolloutTraceTurnKey(params.threadId, params.turnId);
  const hasEvictedLifecycleRecords = Boolean(
    state?.skippedPayloadRefsByTurn.has(turnKey) ||
    state?.skippedPayloadRefOverflowTurns.has(turnKey),
  );
  // Terminal-only records are complete lifecycle records because emission synthesizes
  // their missing starts below. Only an explicit final drain may seal an empty turn:
  // regular polling can observe the turn boundary before the final lifecycle append.
  const hasLifecycleRecords =
    inferenceCallIds.size > 0 ||
    (emitToolDiagnostics && toolCallIds.size > 0) ||
    hasEvictedLifecycleRecords;
  const inferenceLifecycleComplete = [...inferenceCallIds].every((callId) =>
    terminalByCallId.has(callId),
  );
  const missingToolTerminalCallIds = [...toolStartedByCallId.keys()].filter(
    (callId) => !toolTerminalByCallId.has(callId),
  );
  const reconcileMissingToolTerminals =
    params.reconcileMissingToolTerminals === true &&
    !readResult.backpressured &&
    !skipped &&
    turnEnded &&
    inferenceLifecycleComplete;
  const complete =
    !readResult.backpressured &&
    !skipped &&
    turnEnded &&
    (hasLifecycleRecords || params.allowEmptyTurnCompletion === true) &&
    inferenceLifecycleComplete &&
    (!emitToolDiagnostics ||
      [...toolCallIds].every(
        (callId) => toolTerminalByCallId.has(callId) || reconcileMissingToolTerminals,
      ));
  const providerRequestIndexes = new Map(
    [...inferenceCallIds]
      .toSorted((left, right) => {
        const leftEvent = startedByCallId.get(left)?.event ?? terminalByCallId.get(left)?.event;
        const rightEvent = startedByCallId.get(right)?.event ?? terminalByCallId.get(right)?.event;
        return eventSeq(leftEvent ?? {}) - eventSeq(rightEvent ?? {});
      })
      .map((callId, index) => [callId, index + 1]),
  );

  let emitted = 0;
  const bundleKey = path.resolve(params.bundleDir);
  for (const event of events.toSorted((left, right) => eventSeq(left) - eventSeq(right))) {
    const payload = asObject(event.payload) as RawTracePayload | undefined;
    if (!payload || !matchesTraceTurn(event, payload, params.threadId, params.turnId)) {
      continue;
    }
    const type = stringValue(payload.type);
    const callId = stringValue(payload.inference_call_id);
    if (type === "inference_started" && callId) {
      const eventKey = `${bundleKey}:inference-started:${callId}`;
      if (params.emittedEventKeys.has(eventKey)) {
        continue;
      }
      const started = startedByCallId.get(callId);
      const terminal = terminalByCallId.get(callId);
      if (!started) {
        continue;
      }
      // Request form is lifecycle provenance, not optional content capture. Read the
      // bounded local payload for classification, then export content only per capture.
      const requestPayload = await readPayloadJson(params.bundleDir, started.requestPayloadRef);
      const startedContent = buildTraceModelContent({
        capture: params.capture,
        requestPayload,
      });
      const requestEvidence = providerRequestEvidence(requestPayload);
      const baseFields = buildProviderRequestBaseFields({
        baseFields: params.baseFields,
        callId,
        started,
        terminal,
      });
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          ...baseFields,
          startTimeMs: eventWallTimeMs(started.event),
          providerRequestIndex: providerRequestIndexes.get(callId),
          ...requestEvidence,
          rolloutSourceOrder: rolloutTraceSourceOrder(started.event),
        } as TrustedDiagnosticEventInput,
        modelContentPrivateData(startedContent),
      );
      params.emittedEventKeys.add(eventKey);
      emitted += 1;
      continue;
    }
    const terminal = callId ? terminalByCallId.get(callId) : undefined;
    if (
      terminal &&
      (type === "inference_completed" ||
        type === "inference_failed" ||
        type === "inference_cancelled")
    ) {
      const eventKey = `${bundleKey}:inference-terminal:${terminal.callId}`;
      if (params.emittedEventKeys.has(eventKey)) {
        continue;
      }
      const started = startedByCallId.get(terminal.callId);
      const terminalStart = resolveTerminalOnlyStart(terminal.event, terminal.payload);
      const startEvent = started?.event;
      const syntheticStartEventKey = `${bundleKey}:inference-started:${terminal.callId}`;
      if (!started && !params.emittedEventKeys.has(syntheticStartEventKey)) {
        const baseFields = buildProviderRequestBaseFields({
          baseFields: params.baseFields,
          callId: terminal.callId,
          started,
          terminal,
        });
        emitTrustedDiagnosticEventWithPrivateData({
          type: "model.call.started",
          ...baseFields,
          startTimeMs: terminalStart.startTimeMs,
          syntheticStart: true,
          startTimeSource: terminalStart.startTimeSource,
          providerRequestIndex: providerRequestIndexes.get(terminal.callId),
          rolloutSourceOrder: rolloutTraceSourceOrder(terminal.event),
        } as TrustedDiagnosticEventInput);
        params.emittedEventKeys.add(syntheticStartEventKey);
        emitted += 1;
      }
      const responsePayload = await readPayloadJson(params.bundleDir, terminal.responsePayloadRef);
      const usage = extractTraceTokenUsage(responsePayload);
      const completedContent = buildTraceModelContent({
        capture: params.capture,
        responsePayload,
      });
      const baseFields = buildProviderRequestBaseFields({
        baseFields: params.baseFields,
        callId: terminal.callId,
        started,
        terminal,
      });
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: terminal.kind === "completed" ? "model.call.completed" : "model.call.error",
          ...baseFields,
          startTimeMs: startEvent ? eventWallTimeMs(startEvent) : terminalStart.startTimeMs,
          endTimeMs: eventWallTimeMs(terminal.event),
          durationMs: startEvent
            ? traceDurationMs(startEvent, terminal.event)
            : terminalStart.durationMs,
          usageSource: usage ? "provider" : "unknown",
          providerRequestIndex: providerRequestIndexes.get(terminal.callId),
          ...(terminal.responseId
            ? {
                responseIdHash: fingerprintCodexLogValue(
                  CODEX_RESPONSE_ID_HASH_NAMESPACE,
                  terminal.responseId,
                ),
              }
            : {}),
          rolloutSourceOrder: rolloutTraceSourceOrder(terminal.event),
          ...(terminal.kind === "completed"
            ? {}
            : {
                errorCategory: terminal.kind === "cancelled" ? "aborted" : "error",
                ...(terminal.kind === "cancelled" ? { failureKind: "aborted" } : {}),
              }),
          ...(usage ? { usage } : {}),
        } as TrustedDiagnosticEventInput,
        privateModelCallData({
          modelContent: completedContent,
          errorMessage:
            terminal.kind === "completed"
              ? undefined
              : boundedTraceFailureMessage(terminal.payload.error ?? terminal.payload.reason),
        }),
      );
      params.emittedEventKeys.add(eventKey);
      emitted += 1;
      continue;
    }
    if (!emitToolDiagnostics) {
      continue;
    }
    if (type === "tool_call_started") {
      const toolCallId = stringValue(payload.tool_call_id);
      if (!toolCallId) {
        continue;
      }
      const eventKey = `${bundleKey}:tool-started:${toolCallId}`;
      if (params.emittedEventKeys.has(eventKey)) {
        continue;
      }
      const toolStarted = toolStartedByCallId.get(toolCallId);
      if (!toolStarted) {
        continue;
      }
      const invocationPayload = await readPayloadJson(
        params.bundleDir,
        toolStarted.invocationPayloadRef,
      );
      const tool = parseToolInvocation(invocationPayload) ?? fallbackToolInvocation();
      emitTrustedDiagnosticEventWithPrivateData(
        {
          ...toolStartedDiagnosticFields({
            baseFields: params.baseFields,
            tool,
            toolCallId,
            event: toolStarted.event,
          }),
          rolloutSourceOrder: rolloutTraceSourceOrder(toolStarted.event),
        } as TrustedDiagnosticEventInput,
        toolStartedPrivateData(params.capture, tool),
      );
      params.emittedEventKeys.add(eventKey);
      params.emittedToolLifecycleKeys.add(`started:${toolCallId}`);
      emitted += 1;
      continue;
    }
    if (type !== "tool_call_ended") {
      continue;
    }
    const toolCallId = stringValue(payload.tool_call_id);
    const eventKey = toolCallId ? `${bundleKey}:tool-terminal:${toolCallId}` : undefined;
    if (eventKey && params.emittedEventKeys.has(eventKey)) {
      continue;
    }
    const toolTerminal = toolCallId ? toolTerminalByCallId.get(toolCallId) : undefined;
    const toolStarted = toolCallId ? toolStartedByCallId.get(toolCallId) : undefined;
    if (!toolTerminal || !toolCallId) {
      continue;
    }
    const terminalStart = resolveTerminalOnlyStart(toolTerminal.event, payload);
    const startEvent = toolStarted?.event;
    const invocationPayload = await readPayloadJson(
      params.bundleDir,
      toolStarted?.invocationPayloadRef,
    );
    const tool = parseToolInvocation(invocationPayload) ?? fallbackToolInvocation();
    const startedEventKey = `${bundleKey}:tool-started:${toolCallId}`;
    if (!params.emittedEventKeys.has(startedEventKey)) {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          ...toolStartedDiagnosticFields({
            baseFields: params.baseFields,
            tool,
            toolCallId,
            event: startEvent,
          }),
          syntheticStart: !toolStarted,
          startTimeSource: toolStarted ? "source" : terminalStart.startTimeSource,
          startTimeMs: startEvent ? eventWallTimeMs(startEvent) : terminalStart.startTimeMs,
          sourceTimestampMs: startEvent ? eventWallTimeMs(startEvent) : terminalStart.startTimeMs,
          rolloutSourceOrder: rolloutTraceSourceOrder(toolStarted?.event ?? toolTerminal.event),
        } as TrustedDiagnosticEventInput,
        toolStartedPrivateData(params.capture, tool),
      );
      params.emittedEventKeys.add(startedEventKey);
      // Langfuse tool spans cannot replace their start after a terminal update.
      // Treat this synthetic start as coverage so native fallback cannot replay out of order.
      params.emittedToolLifecycleKeys.add(`started:${toolCallId}`);
      emitted += 1;
    }
    const resultPayload = await readPayloadJson(params.bundleDir, toolTerminal.resultPayloadRef);
    const toolOutput = parseToolOutput(resultPayload);
    const durationMs = startEvent
      ? traceDurationMs(startEvent, toolTerminal.event)
      : terminalStart.durationMs;
    const baseFields = toolDiagnosticBaseFields(params.baseFields);
    const toolContent = {
      ...(params.capture?.toolInputs ? { toolInput: tool.input } : {}),
      ...(params.capture?.toolOutputs ? { toolOutput } : {}),
    };
    const privateData = Object.keys(toolContent).length > 0 ? { toolContent } : undefined;
    const commonFields = {
      ...baseFields,
      toolName: tool.name,
      toolSource: "core" as const,
      toolOwner: "codex-rollout-trace",
      toolCallId: toolTerminal.callId,
      paramsSummary: summarizeToolInput(tool.input),
      startTimeMs: startEvent ? eventWallTimeMs(startEvent) : terminalStart.startTimeMs,
      endTimeMs: eventWallTimeMs(toolTerminal.event),
      sourceTimestampMs: eventWallTimeMs(toolTerminal.event),
      durationMs,
      rolloutSourceOrder: rolloutTraceSourceOrder(toolTerminal.event),
    };
    if (toolTerminal.status === "completed") {
      emitTrustedDiagnosticEventWithPrivateData(
        { type: "tool.execution.completed", ...commonFields } as TrustedDiagnosticEventInput,
        privateData,
      );
    } else {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "tool.execution.error",
          ...commonFields,
          errorCategory: `codex_native_tool_${toolTerminal.status}`,
        } as TrustedDiagnosticEventInput,
        privateData,
      );
    }
    if (eventKey) {
      params.emittedEventKeys.add(eventKey);
    }
    params.emittedToolLifecycleKeys.add(`terminal:${toolCallId}`);
    emitted += 1;
  }
  if (emitToolDiagnostics && reconcileMissingToolTerminals && turnEndedEvent) {
    for (const toolCallId of missingToolTerminalCallIds.toSorted((left, right) => {
      return (
        eventSeq(toolStartedByCallId.get(left)?.event ?? {}) -
        eventSeq(toolStartedByCallId.get(right)?.event ?? {})
      );
    })) {
      const eventKey = `${bundleKey}:tool-terminal:${toolCallId}`;
      if (params.emittedEventKeys.has(eventKey)) {
        continue;
      }
      const toolStarted = toolStartedByCallId.get(toolCallId);
      if (!toolStarted) {
        continue;
      }
      const invocationPayload = await readPayloadJson(
        params.bundleDir,
        toolStarted.invocationPayloadRef,
      );
      const tool = parseToolInvocation(invocationPayload) ?? fallbackToolInvocation();
      const toolContent = {
        ...(params.capture?.toolInputs ? { toolInput: tool.input } : {}),
        ...(params.capture?.toolOutputs
          ? {
              toolOutput: {
                status: "error",
                errorCode: "tool_terminal_missing",
              },
            }
          : {}),
      };
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "tool.execution.error",
          ...toolDiagnosticBaseFields(params.baseFields),
          toolName: tool.name,
          toolSource: "core",
          toolOwner: "codex-rollout-trace",
          toolCallId,
          paramsSummary: summarizeToolInput(tool.input),
          startTimeMs: eventWallTimeMs(toolStarted.event),
          endTimeMs: eventWallTimeMs(turnEndedEvent),
          sourceTimestampMs: eventWallTimeMs(turnEndedEvent),
          durationMs: traceDurationMs(toolStarted.event, turnEndedEvent),
          rolloutSourceOrder: rolloutTraceSourceOrder(turnEndedEvent),
          errorCategory: "codex_native_tool_missing_terminal",
          errorCode: "tool_terminal_missing",
          terminalReason: "failed",
        } as TrustedDiagnosticEventInput,
        Object.keys(toolContent).length > 0 ? { toolContent } : undefined,
      );
      params.emittedEventKeys.add(eventKey);
      params.emittedToolLifecycleKeys.add(`terminal:${toolCallId}`);
      emitted += 1;
    }
  }
  if (complete || (skipped && turnEnded)) {
    // A skipped turn cannot be reconstructed after its terminal boundary.
    // Keep the incomplete result, but release payload files that no retry can consume.
    await removeTraceTurnPayloads({
      bundleDir: params.bundleDir,
      events,
      threadId: params.threadId,
      turnId: params.turnId,
      log: params.log,
    });
  }
  return {
    emitted,
    observed: observedAnyLifecycle,
    complete,
    backpressured: readResult.backpressured,
  };
}

async function removeTraceTurnPayloads(params: {
  bundleDir: string;
  events: RawTraceEvent[];
  threadId: string;
  turnId: string;
  log?: RolloutTraceLog;
}): Promise<void> {
  const payloadPaths = new Set<string>();
  for (const event of params.events) {
    const payload = asObject(event.payload) as RawTracePayload | undefined;
    if (!payload || !matchesTraceTurn(event, payload, params.threadId, params.turnId)) {
      continue;
    }
    collectRawPayloadPaths(params.bundleDir, payload, payloadPaths);
  }
  for (const payloadPath of skippedTraceTurnPayloadPaths(
    params.bundleDir,
    params.threadId,
    params.turnId,
  )) {
    payloadPaths.add(payloadPath);
  }
  if (skippedTraceTurnPayloadRefsOverflow(params.bundleDir, params.threadId, params.turnId)) {
    await removeOverflowSkippedTraceTurnPayloads(params);
  }
  for (const payloadPath of payloadPaths) {
    await removeTracePayloadPath(params, payloadPath);
  }
}

async function removeOverflowSkippedTraceTurnPayloads(params: {
  bundleDir: string;
  threadId: string;
  turnId: string;
  log?: RolloutTraceLog;
}): Promise<void> {
  const traceFile = path.join(params.bundleDir, "trace.jsonl");
  try {
    await forEachBoundedTraceFileLine(traceFile, async (line) => {
      let event: RawTraceEvent;
      try {
        const parsed = JSON.parse(line.toString("utf8")) as unknown;
        if (!asObject(parsed)) {
          return;
        }
        event = parsed as RawTraceEvent;
      } catch {
        return;
      }
      const payload = asObject(event.payload) as RawTracePayload | undefined;
      if (!payload || !matchesTraceTurn(event, payload, params.threadId, params.turnId)) {
        return;
      }
      const payloadPaths = new Set<string>();
      collectRawPayloadPaths(params.bundleDir, payload, payloadPaths);
      for (const payloadPath of payloadPaths) {
        await removeTracePayloadPath(params, payloadPath);
      }
    });
  } catch (error) {
    params.log?.debug("codex rollout trace payload rescan skipped", {
      error: formatTraceError(error),
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }
}

async function forEachBoundedTraceFileLine(
  traceFile: string,
  visit: (line: Buffer) => Promise<void>,
): Promise<void> {
  const handle = await fs.open(traceFile, "r");
  let partialLine = Buffer.alloc(0);
  let discardUntilNewline = false;
  try {
    const stat = await handle.stat();
    let position = 0;
    while (position < stat.size) {
      const length = Math.min(ROLLOUT_TRACE_READ_CHUNK_BYTES, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) {
          continue;
        }
        const segment = data.subarray(lineStart, index);
        if (!discardUntilNewline) {
          if (partialLine.length + segment.length <= ROLLOUT_TRACE_MAX_PARTIAL_LINE_BYTES) {
            const line =
              partialLine.length > 0 ? Buffer.concat([partialLine, segment]) : Buffer.from(segment);
            await visit(line);
          }
        }
        partialLine = Buffer.alloc(0);
        discardUntilNewline = false;
        lineStart = index + 1;
      }
      const tail = data.subarray(lineStart);
      if (discardUntilNewline || tail.length === 0) {
        continue;
      }
      if (partialLine.length + tail.length > ROLLOUT_TRACE_MAX_PARTIAL_LINE_BYTES) {
        partialLine = Buffer.alloc(0);
        discardUntilNewline = true;
      } else {
        partialLine =
          partialLine.length > 0 ? Buffer.concat([partialLine, tail]) : Buffer.from(tail);
      }
    }
    if (!discardUntilNewline && partialLine.length > 0) {
      await visit(partialLine);
    }
  } finally {
    await handle.close();
  }
}

async function removeTracePayloadPath(
  params: { log?: RolloutTraceLog; threadId: string; turnId: string },
  payloadPath: string,
): Promise<void> {
  try {
    await fs.rm(payloadPath, { force: true });
  } catch (error) {
    params.log?.debug("codex rollout trace payload cleanup skipped", {
      error: formatTraceError(error),
      payloadPath,
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }
}

function collectRawPayloadPaths(bundleDir: string, value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRawPayloadPaths(bundleDir, item, paths);
    }
    return;
  }
  const object = asObject(value);
  if (!object) {
    return;
  }
  if (stringValue(object.raw_payload_id) && stringValue(object.path)) {
    const payloadPath = resolveBundlePayloadPath(bundleDir, object as RawPayloadRef);
    if (payloadPath) {
      paths.add(payloadPath);
    }
    return;
  }
  for (const nested of Object.values(object)) {
    collectRawPayloadPaths(bundleDir, nested, paths);
  }
}

function toolDiagnosticBaseFields(baseFields: RolloutTraceModelBaseFields) {
  const runId = stringValue(baseFields.runId);
  const sessionKey = stringValue(baseFields.sessionKey);
  const sessionId = stringValue(baseFields.sessionId);
  return {
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

function toolStartedDiagnosticFields(params: {
  baseFields: RolloutTraceModelBaseFields;
  tool: { name: string; input: unknown };
  toolCallId: string;
  event?: RawTraceEvent;
}) {
  const startTimeMs = params.event ? eventWallTimeMs(params.event) : undefined;
  return {
    type: "tool.execution.started" as const,
    ...toolDiagnosticBaseFields(params.baseFields),
    toolName: params.tool.name,
    toolSource: "core" as const,
    toolOwner: "codex-rollout-trace",
    toolCallId: params.toolCallId,
    paramsSummary: summarizeToolInput(params.tool.input),
    ...(startTimeMs !== undefined ? { startTimeMs, sourceTimestampMs: startTimeMs } : {}),
  };
}

function toolStartedPrivateData(
  capture: RolloutTraceContentCapture | undefined,
  tool: { input: unknown },
) {
  if (!capture?.toolInputs) {
    return undefined;
  }
  return { toolContent: { toolInput: tool.input } };
}

function parseToolInvocation(value: unknown): { name: string; input: unknown } | undefined {
  const invocation = asObject(value);
  const toolName = stringValue(invocation?.tool_name);
  if (!invocation || !toolName) {
    return undefined;
  }
  const namespace = stringValue(invocation.tool_namespace);
  const payload = asObject(invocation.payload);
  const payloadType = stringValue(payload?.type);
  const truncatedPayload = truncatedPayloadCaptureMetadata(payload);
  let input: unknown = truncatedPayload ?? payload;
  if (payloadType === "function") {
    input = parseJsonString(payload?.arguments);
  } else if (payloadType === "custom") {
    input = { input: payload?.input };
  } else if (payloadType === "tool_search") {
    input = payload?.arguments;
  }
  return {
    name: namespace ? `${namespace}.${toolName}` : toolName,
    input,
  };
}

function fallbackToolInvocation(): { name: string; input: unknown } {
  return {
    name: "codex.native_tool",
    input: undefined,
  };
}

function parseToolOutput(value: unknown): unknown {
  const payload = asObject(value);
  if (!payload) {
    return value;
  }
  const truncatedPayload = truncatedPayloadCaptureMetadata(payload);
  if (truncatedPayload) {
    return truncatedPayload;
  }
  if (payload.type === "direct_response") {
    const responseItem = asObject(payload.response_item);
    if (!responseItem || responseItem.output === undefined) {
      return responseItem;
    }
    return parseJsonString(responseItem.output);
  }
  if (payload.type === "code_mode_response") {
    return payload.value;
  }
  if (payload.type === "error") {
    return { error: payload.error };
  }
  return value;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function summarizeToolInput(value: unknown): ToolParamsSummary {
  if (value === null) {
    return { kind: "null" as const };
  }
  if (value === undefined) {
    return { kind: "undefined" as const };
  }
  const truncated = truncatedPayloadCaptureMetadata(asObject(value));
  if (truncated) {
    return {
      kind: "truncated" as const,
      ...(truncated.originalBytes !== undefined ? { originalBytes: truncated.originalBytes } : {}),
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array" as const, length: value.length };
  }
  if (typeof value === "object") {
    return { kind: "object" as const };
  }
  if (typeof value === "string") {
    return { kind: "string" as const, length: value.length };
  }
  if (typeof value === "number") {
    return { kind: "number" };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean" };
  }
  return { kind: "other" as const };
}

async function listTraceBundleDirs(traceRoot: string): Promise<string[]> {
  const root = path.resolve(traceRoot);
  const bundleDirs: string[] = [];
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (!candidate) {
      continue;
    }
    try {
      await fs.access(path.join(candidate.dir, "manifest.json"));
      bundleDirs.push(candidate.dir);
      continue;
    } catch {
      // Shared roots may group bundles under one per-attempt directory.
    }
    if (candidate.depth >= 2) {
      continue;
    }
    const entries = await fs.readdir(candidate.dir, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory()) {
        pending.push({ dir: path.join(candidate.dir, entry.name), depth: candidate.depth + 1 });
      }
    }
  }
  return bundleDirs.toSorted();
}

async function readTraceEvents(
  bundleDir: string,
  threadId: string,
  turnId: string,
): Promise<{ events: RawTraceEvent[]; backpressured: boolean }> {
  const traceFile = path.join(bundleDir, "trace.jsonl");
  const stateKey = path.resolve(bundleDir);
  rolloutTraceReadsInFlight.set(stateKey, (rolloutTraceReadsInFlight.get(stateKey) ?? 0) + 1);
  try {
    pruneRolloutTraceReadStates();
    let state = rolloutTraceReadStates.get(stateKey);
    if (!state) {
      pruneRolloutTraceReadStatesForEntry(stateKey);
      if (rolloutTraceReadStates.size >= ROLLOUT_TRACE_READ_STATE_MAX_ENTRIES) {
        return { events: [], backpressured: true };
      }
      state = {
        offset: 0,
        partialLine: Buffer.alloc(0),
        eventsByTurn: new Map(),
        eventBytesByTurn: new Map(),
        totalEventBytes: 0,
        totalSkippedPayloadRefBytes: 0,
        skippedTurns: new Set(),
        skippedPayloadRefsByTurn: new Map(),
        skippedPayloadRefBytesByTurn: new Map(),
        skippedPayloadRefOverflowTurns: new Set(),
        skippedPayloadRefMetadataEvicted: false,
        updatedAt: Date.now(),
      };
      rolloutTraceReadStates.set(stateKey, state);
    }
    let backpressured = false;
    const handle = await fs.open(traceFile, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < state.offset) {
        state.offset = 0;
        state.partialLine = Buffer.alloc(0);
        state.eventsByTurn.clear();
        state.eventBytesByTurn.clear();
        state.totalEventBytes = 0;
        state.totalSkippedPayloadRefBytes = 0;
        state.skippedTurns.clear();
        state.skippedPayloadRefsByTurn.clear();
        state.skippedPayloadRefBytesByTurn.clear();
        state.skippedPayloadRefOverflowTurns.clear();
        state.skippedPayloadRefMetadataEvicted = false;
      }
      let position = state.offset;
      while (position < stat.size) {
        const desiredLength = Math.min(ROLLOUT_TRACE_READ_CHUNK_BYTES, stat.size - position);
        const reservedLength = reserveRolloutTraceReadBytes(stateKey, desiredLength);
        if (reservedLength === 0) {
          backpressured = true;
          break;
        }
        try {
          const chunk = Buffer.allocUnsafe(reservedLength);
          const { bytesRead } = await handle.read(chunk, 0, reservedLength, position);
          if (bytesRead === 0) {
            break;
          }
          position += bytesRead;
          collectTraceEventLines(state, chunk.subarray(0, bytesRead));
        } finally {
          rolloutTraceReservedReadBytes = Math.max(
            0,
            rolloutTraceReservedReadBytes - reservedLength,
          );
        }
      }
      state.offset = position;
      state.updatedAt = Date.now();
      enforceRolloutTraceReadStateBudget(state);
      pruneRolloutTraceReadStates();
    } finally {
      await handle.close();
    }
    const turnKey = rolloutTraceTurnKey(threadId, turnId);
    // A trace read can race an inference terminal event. Keep the turn buffer
    // until the caller emits a complete pair or normal state pruning expires it.
    return {
      events: state.eventsByTurn.get(turnKey) ?? [],
      backpressured,
    };
  } finally {
    const remainingReads = (rolloutTraceReadsInFlight.get(stateKey) ?? 1) - 1;
    if (remainingReads > 0) {
      rolloutTraceReadsInFlight.set(stateKey, remainingReads);
    } else {
      rolloutTraceReadsInFlight.delete(stateKey);
    }
  }
}

function collectTraceEventLines(state: RolloutTraceReadState, chunk: Buffer): void {
  const data = state.partialLine.length > 0 ? Buffer.concat([state.partialLine, chunk]) : chunk;
  let lineStart = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a) {
      continue;
    }
    collectTraceEventLine(state, data.subarray(lineStart, index));
    lineStart = index + 1;
  }
  state.partialLine = Buffer.from(data.subarray(lineStart));
  if (state.partialLine.length > ROLLOUT_TRACE_MAX_PARTIAL_LINE_BYTES) {
    state.partialLine = Buffer.alloc(0);
  }
}

function collectTraceEventLine(state: RolloutTraceReadState, line: Buffer): void {
  if (line.length === 0) {
    return;
  }
  try {
    const event = JSON.parse(line.toString("utf8")) as unknown;
    if (!asObject(event)) {
      return;
    }
    const traceEvent = event as RawTraceEvent;
    const threadId = stringValue(traceEvent.thread_id);
    const turnId = stringValue(traceEvent.codex_turn_id);
    if (!threadId || !turnId) {
      return;
    }
    const turnKey = rolloutTraceTurnKey(threadId, turnId);
    if (state.skippedTurns.has(turnKey)) {
      collectSkippedTraceTurnMetadata(state, turnKey, traceEvent, line.length);
      return;
    }
    if (state.skippedPayloadRefsByTurn.has(turnKey)) {
      collectSkippedTraceTurnMetadata(state, turnKey, traceEvent, line.length);
      return;
    }
    const events = state.eventsByTurn.get(turnKey) ?? [];
    const nextBytes = (state.eventBytesByTurn.get(turnKey) ?? 0) + line.length;
    if (
      events.length >= ROLLOUT_TRACE_MAX_EVENTS_PER_TURN ||
      nextBytes > ROLLOUT_TRACE_MAX_EVENT_BYTES_PER_TURN
    ) {
      markRolloutTraceTurnSkipped(state, turnKey, events, traceEvent, line.length);
      state.skippedTurns.add(turnKey);
      enforceRolloutTraceReadStateBudget(state);
      return;
    }
    events.push(traceEvent);
    state.eventsByTurn.set(turnKey, events);
    state.totalEventBytes += line.length;
    state.eventBytesByTurn.set(turnKey, nextBytes);
    enforceRolloutTraceReadStateBudget(state);
  } catch {
    // Ignore malformed complete lines; a trailing partial line is retained separately.
  }
}

function rolloutTraceTurnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function markRolloutTraceTurnSkipped(
  state: RolloutTraceReadState,
  turnKey: string,
  events: RawTraceEvent[],
  currentEvent: RawTraceEvent,
  currentLineBytes: number,
): void {
  const payloadRefs = createSkippedPayloadRefAccumulator();
  for (const event of [...events, currentEvent]) {
    collectTraceEventPayloadRefs(event, payloadRefs);
  }
  deleteRolloutTraceTurn(state, turnKey);
  storeSkippedPayloadRefs(state, turnKey, payloadRefs);
  collectSkippedTraceTurnMetadata(state, turnKey, currentEvent, currentLineBytes);
}

function collectSkippedTraceTurnMetadata(
  state: RolloutTraceReadState,
  turnKey: string,
  event: RawTraceEvent,
  lineBytes: number,
): void {
  const payloadRefs = createSkippedPayloadRefAccumulator(
    state.skippedPayloadRefsByTurn.get(turnKey),
    state.skippedPayloadRefBytesByTurn.get(turnKey),
    state.skippedPayloadRefOverflowTurns.has(turnKey),
  );
  collectTraceEventPayloadRefs(event, payloadRefs);
  storeSkippedPayloadRefs(state, turnKey, payloadRefs);
  const payload = asObject(event.payload) as RawTracePayload | undefined;
  if (
    payload &&
    stringValue(payload.type) === "codex_turn_ended" &&
    !state.eventsByTurn.has(turnKey)
  ) {
    state.eventsByTurn.set(turnKey, [event]);
    state.eventBytesByTurn.set(turnKey, lineBytes);
    state.totalEventBytes += lineBytes;
    enforceRolloutTraceReadStateBudget(state);
  }
}

type SkippedPayloadRefAccumulator = {
  paths: Set<string>;
  bytes: number;
  overflow: boolean;
};

function createSkippedPayloadRefAccumulator(
  paths: Set<string> = new Set(),
  bytes = 0,
  overflow = false,
): SkippedPayloadRefAccumulator {
  return { paths: new Set(paths), bytes, overflow };
}

function collectTraceEventPayloadRefs(
  event: RawTraceEvent,
  accumulator: SkippedPayloadRefAccumulator,
): void {
  const payload = asObject(event.payload);
  if (payload) {
    collectRawPayloadRefPaths(payload, accumulator);
  }
}

function collectRawPayloadRefPaths(
  value: unknown,
  accumulator: SkippedPayloadRefAccumulator,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRawPayloadRefPaths(item, accumulator);
    }
    return;
  }
  const object = asObject(value);
  if (!object) {
    return;
  }
  const relativePath = stringValue(object.path);
  if (stringValue(object.raw_payload_id) && relativePath) {
    if (accumulator.paths.has(relativePath)) {
      return;
    }
    const pathBytes = Buffer.byteLength(relativePath, "utf8");
    if (
      accumulator.paths.size >= ROLLOUT_TRACE_MAX_SKIPPED_PAYLOAD_REFS_PER_TURN ||
      accumulator.bytes + pathBytes > ROLLOUT_TRACE_MAX_SKIPPED_PAYLOAD_REF_BYTES_PER_TURN
    ) {
      accumulator.overflow = true;
      return;
    }
    accumulator.paths.add(relativePath);
    accumulator.bytes += pathBytes;
    return;
  }
  for (const nested of Object.values(object)) {
    collectRawPayloadRefPaths(nested, accumulator);
  }
}

function storeSkippedPayloadRefs(
  state: RolloutTraceReadState,
  turnKey: string,
  accumulator: SkippedPayloadRefAccumulator,
): void {
  const previousBytes = state.skippedPayloadRefBytesByTurn.get(turnKey) ?? 0;
  state.totalSkippedPayloadRefBytes = Math.max(
    0,
    state.totalSkippedPayloadRefBytes - previousBytes + accumulator.bytes,
  );
  if (accumulator.paths.size > 0) {
    state.skippedPayloadRefsByTurn.set(turnKey, accumulator.paths);
    state.skippedPayloadRefBytesByTurn.set(turnKey, accumulator.bytes);
  } else {
    state.skippedPayloadRefsByTurn.delete(turnKey);
    state.skippedPayloadRefBytesByTurn.delete(turnKey);
  }
  if (accumulator.overflow) {
    state.skippedPayloadRefOverflowTurns.add(turnKey);
  } else {
    state.skippedPayloadRefOverflowTurns.delete(turnKey);
  }
}

function skippedTraceTurnPayloadPaths(
  bundleDir: string,
  threadId: string,
  turnId: string,
): string[] {
  const state = rolloutTraceReadStates.get(path.resolve(bundleDir));
  const refs = state?.skippedPayloadRefsByTurn.get(rolloutTraceTurnKey(threadId, turnId)) ?? [];
  return [...refs]
    .map((payloadRefPath) => resolveBundlePayloadPath(bundleDir, { path: payloadRefPath }))
    .filter((payloadPath): payloadPath is string => Boolean(payloadPath));
}

function skippedTraceTurnPayloadRefsOverflow(
  bundleDir: string,
  threadId: string,
  turnId: string,
): boolean {
  const state = rolloutTraceReadStates.get(path.resolve(bundleDir));
  return Boolean(
    state?.skippedPayloadRefMetadataEvicted ||
    state?.skippedPayloadRefOverflowTurns.has(rolloutTraceTurnKey(threadId, turnId)),
  );
}

function rolloutTraceBundleHasSkippedTurn(
  bundleDir: string,
  threadId: string,
  turnId: string,
): boolean {
  return Boolean(
    rolloutTraceReadStates
      .get(path.resolve(bundleDir))
      ?.skippedTurns.has(rolloutTraceTurnKey(threadId, turnId)),
  );
}

function releaseRolloutTraceTurnEvents(traceRoot: string, threadId: string, turnId: string): void {
  const resolvedRoot = path.resolve(traceRoot);
  const turnKey = rolloutTraceTurnKey(threadId, turnId);
  for (const [stateKey, state] of rolloutTraceReadStates) {
    const relative = path.relative(resolvedRoot, stateKey);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    deleteRolloutTraceTurn(state, turnKey);
  }
}

function deleteRolloutTraceTurn(state: RolloutTraceReadState, turnKey: string): void {
  state.totalEventBytes = Math.max(
    0,
    state.totalEventBytes - (state.eventBytesByTurn.get(turnKey) ?? 0),
  );
  state.eventsByTurn.delete(turnKey);
  state.eventBytesByTurn.delete(turnKey);
  deleteSkippedRolloutTraceTurnState(state, turnKey);
}

function skipBufferedRolloutTraceTurn(state: RolloutTraceReadState, turnKey: string): void {
  moveBufferedRolloutTraceTurnToSkippedPayloadRefs(state, turnKey);
  state.skippedTurns.add(turnKey);
}

function tombstoneBufferedRolloutTraceTurn(state: RolloutTraceReadState, turnKey: string): void {
  moveBufferedRolloutTraceTurnToSkippedPayloadRefs(state, turnKey);
  state.skippedTurns.delete(turnKey);
}

function moveBufferedRolloutTraceTurnToSkippedPayloadRefs(
  state: RolloutTraceReadState,
  turnKey: string,
): void {
  const events = state.eventsByTurn.get(turnKey) ?? [];
  const payloadRefs = createSkippedPayloadRefAccumulator(
    state.skippedPayloadRefsByTurn.get(turnKey),
    state.skippedPayloadRefBytesByTurn.get(turnKey),
    state.skippedPayloadRefOverflowTurns.has(turnKey),
  );
  for (const event of events) {
    collectTraceEventPayloadRefs(event, payloadRefs);
  }
  state.totalEventBytes = Math.max(
    0,
    state.totalEventBytes - (state.eventBytesByTurn.get(turnKey) ?? 0),
  );
  state.eventsByTurn.delete(turnKey);
  state.eventBytesByTurn.delete(turnKey);
  storeSkippedPayloadRefs(state, turnKey, payloadRefs);
}

function deleteSkippedRolloutTraceTurnState(state: RolloutTraceReadState, turnKey: string): void {
  state.skippedTurns.delete(turnKey);
  state.totalSkippedPayloadRefBytes = Math.max(
    0,
    state.totalSkippedPayloadRefBytes - (state.skippedPayloadRefBytesByTurn.get(turnKey) ?? 0),
  );
  state.skippedPayloadRefsByTurn.delete(turnKey);
  state.skippedPayloadRefBytesByTurn.delete(turnKey);
  state.skippedPayloadRefOverflowTurns.delete(turnKey);
}

function evictRolloutTraceTurnState(state: RolloutTraceReadState, turnKey: string): void {
  if (
    state.skippedPayloadRefsByTurn.has(turnKey) ||
    state.skippedPayloadRefOverflowTurns.has(turnKey)
  ) {
    // Once an index is evicted, completed turns rescan the bounded JSONL stream
    // so payload cleanup remains complete without retaining an unbounded key set.
    state.skippedPayloadRefMetadataEvicted = true;
  }
  deleteRolloutTraceTurn(state, turnKey);
}

function retainedRolloutTraceTurnCount(state: RolloutTraceReadState): number {
  return new Set([
    ...state.eventsByTurn.keys(),
    ...state.skippedTurns,
    ...state.skippedPayloadRefsByTurn.keys(),
    ...state.skippedPayloadRefOverflowTurns,
  ]).size;
}

function enforceRolloutTraceReadStateBudget(state: RolloutTraceReadState): void {
  while (
    retainedRolloutTraceTurnCount(state) > ROLLOUT_TRACE_PENDING_TURN_MAX_ENTRIES ||
    state.totalEventBytes + state.totalSkippedPayloadRefBytes + state.partialLine.length >
      ROLLOUT_TRACE_MAX_EVENT_BYTES_PER_STATE
  ) {
    const overEntryBudget =
      retainedRolloutTraceTurnCount(state) > ROLLOUT_TRACE_PENDING_TURN_MAX_ENTRIES;
    if (overEntryBudget) {
      const oldestBufferedTurn = state.eventsByTurn.keys().next().value;
      if (oldestBufferedTurn) {
        tombstoneBufferedRolloutTraceTurn(state, oldestBufferedTurn);
        continue;
      }
    }
    const oldestKey =
      state.eventsByTurn.keys().next().value ??
      state.skippedTurns.values().next().value ??
      state.skippedPayloadRefsByTurn.keys().next().value;
    if (!oldestKey) {
      state.partialLine = Buffer.alloc(0);
      break;
    }
    if (state.eventsByTurn.has(oldestKey)) {
      skipBufferedRolloutTraceTurn(state, oldestKey);
    } else {
      evictRolloutTraceTurnState(state, oldestKey);
    }
  }
}

function pruneRolloutTraceReadStates(now = Date.now()): void {
  for (const [key, state] of rolloutTraceReadStates) {
    if (
      now - state.updatedAt > ROLLOUT_TRACE_READ_STATE_TTL_MS &&
      !isProtectedRolloutTraceReadState(key)
    ) {
      rolloutTraceReadStates.delete(key);
    }
  }
  while (rolloutTraceReadStates.size > ROLLOUT_TRACE_READ_STATE_MAX_ENTRIES) {
    const oldestInactive = oldestInactiveRolloutTraceReadState();
    if (!oldestInactive) {
      break;
    }
    rolloutTraceReadStates.delete(oldestInactive[0]);
  }
  let totalBytes = [...rolloutTraceReadStates.values()].reduce(
    (sum, state) =>
      sum + state.totalEventBytes + state.totalSkippedPayloadRefBytes + state.partialLine.length,
    0,
  );
  while (totalBytes > ROLLOUT_TRACE_MAX_EVENT_BYTES_GLOBAL) {
    const oldestInactive = oldestInactiveRolloutTraceReadState();
    if (!oldestInactive) {
      break;
    }
    totalBytes -= retainedRolloutTraceReadStateBytes(oldestInactive[1]);
    rolloutTraceReadStates.delete(oldestInactive[0]);
  }
}

function isProtectedRolloutTraceReadState(stateKey: string): boolean {
  return isActiveRolloutTraceReadState(stateKey) || rolloutTraceReadsInFlight.has(stateKey);
}

function oldestInactiveRolloutTraceReadState(
  excludedStateKey?: string,
): [string, RolloutTraceReadState] | undefined {
  return [...rolloutTraceReadStates.entries()].reduce<[string, RolloutTraceReadState] | undefined>(
    (current, entry) => {
      if (entry[0] === excludedStateKey || isProtectedRolloutTraceReadState(entry[0])) {
        return current;
      }
      return !current || entry[1].updatedAt < current[1].updatedAt ? entry : current;
    },
    undefined,
  );
}

function retainedRolloutTraceReadStateBytes(state: RolloutTraceReadState): number {
  return state.totalEventBytes + state.totalSkippedPayloadRefBytes + state.partialLine.length;
}

function totalRetainedRolloutTraceReadStateBytes(): number {
  return [...rolloutTraceReadStates.values()].reduce(
    (sum, state) => sum + retainedRolloutTraceReadStateBytes(state),
    0,
  );
}

function pruneRolloutTraceReadStatesForEntry(excludedStateKey: string): void {
  while (rolloutTraceReadStates.size >= ROLLOUT_TRACE_READ_STATE_MAX_ENTRIES) {
    const oldestReclaimable =
      oldestInactiveRolloutTraceReadState(excludedStateKey) ??
      oldestReclaimableRolloutTraceReadState(excludedStateKey);
    if (!oldestReclaimable) {
      return;
    }
    rolloutTraceReadStates.delete(oldestReclaimable[0]);
  }
}

function reserveRolloutTraceReadBytes(stateKey: string, desiredBytes: number): number {
  let retainedBytes = totalRetainedRolloutTraceReadStateBytes();
  while (
    retainedBytes + rolloutTraceReservedReadBytes + desiredBytes >
    ROLLOUT_TRACE_MAX_EVENT_BYTES_GLOBAL
  ) {
    const oldestReclaimable =
      oldestInactiveRolloutTraceReadState(stateKey) ??
      oldestReclaimableRolloutTraceReadState(stateKey);
    if (!oldestReclaimable) {
      break;
    }
    retainedBytes -= retainedRolloutTraceReadStateBytes(oldestReclaimable[1]);
    rolloutTraceReadStates.delete(oldestReclaimable[0]);
  }
  const availableBytes = Math.max(
    0,
    ROLLOUT_TRACE_MAX_EVENT_BYTES_GLOBAL - retainedBytes - rolloutTraceReservedReadBytes,
  );
  const reservedBytes = Math.min(desiredBytes, availableBytes);
  rolloutTraceReservedReadBytes += reservedBytes;
  return reservedBytes;
}

function oldestReclaimableRolloutTraceReadState(
  excludedStateKey: string,
): [string, RolloutTraceReadState] | undefined {
  return [...rolloutTraceReadStates.entries()].reduce<[string, RolloutTraceReadState] | undefined>(
    (current, entry) => {
      if (entry[0] === excludedStateKey || rolloutTraceReadsInFlight.has(entry[0])) {
        return current;
      }
      return !current || entry[1].updatedAt < current[1].updatedAt ? entry : current;
    },
    undefined,
  );
}

function buildProviderRequestBaseFields(params: {
  baseFields: RolloutTraceModelBaseFields;
  callId: string;
  started?: InferenceStarted;
  terminal?: InferenceTerminal;
}): ProviderRequestBaseFields {
  const upstreamRequestIdHash = params.terminal?.upstreamRequestId
    ? fingerprintCodexLogValue(
        CODEX_PROVIDER_REQUEST_ID_HASH_NAMESPACE,
        params.terminal.upstreamRequestId,
      )
    : undefined;
  return {
    ...params.baseFields,
    callId: params.callId,
    scope: "provider-request",
    provider: stringValue(params.started?.payload.provider_name) ?? params.baseFields.provider,
    model: stringValue(params.started?.payload.model) ?? params.baseFields.model,
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function rolloutTraceSourceOrder(event: RawTraceEvent): string {
  return String(eventSeq(event)).padStart(16, "0");
}

function buildTraceModelContent(params: {
  capture: RolloutTraceContentCapture | undefined;
  requestPayload?: unknown;
  responsePayload?: unknown;
}): DiagnosticModelCallContent | undefined {
  const request = asObject(params.requestPayload);
  const response = asObject(params.responsePayload);
  const requestFallback = truncatedPayloadCaptureMetadata(request);
  const responseFallback = truncatedPayloadCaptureMetadata(response);
  const content: DiagnosticModelCallContent = {
    ...(params.capture?.inputMessages && request
      ? { inputMessages: request.input ?? requestFallback }
      : {}),
    ...(params.capture?.systemPrompt && typeof request?.instructions === "string"
      ? { systemPrompt: request.instructions }
      : {}),
    ...(params.capture?.toolDefinitions && request
      ? { toolDefinitions: request.tools ?? requestFallback }
      : {}),
    ...(params.capture?.outputMessages && response
      ? { outputMessages: response.output_items ?? responseFallback }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

function providerRequestEvidence(requestPayload: unknown): {
  previousResponseIdHash?: string;
  requestForm: "full" | "ws-delta";
} {
  const previousResponseId = stringValue(asObject(requestPayload)?.previous_response_id);
  return previousResponseId
    ? {
        requestForm: "ws-delta",
        previousResponseIdHash: fingerprintCodexLogValue(
          CODEX_RESPONSE_ID_HASH_NAMESPACE,
          previousResponseId,
        ),
      }
    : { requestForm: "full" };
}

function truncatedPayloadCaptureMetadata(
  payload: Record<string, unknown> | undefined,
): { truncated: true; originalBytes?: number } | undefined {
  const truncated =
    payload?.truncated === true ? payload : asObject(payload?.[TRUNCATED_PAYLOAD_FIELD]);
  if (truncated?.truncated !== true) {
    return undefined;
  }
  const originalBytes = numberValue(truncated.originalBytes);
  return {
    truncated: true,
    ...(originalBytes !== undefined ? { originalBytes } : {}),
  };
}

function modelContentPrivateData(modelContent: DiagnosticModelCallContent | undefined) {
  return modelContent ? { modelContent } : undefined;
}

function privateModelCallData(params: {
  modelContent?: DiagnosticModelCallContent;
  errorMessage?: string;
}): { modelContent?: DiagnosticModelCallContent; errorMessage?: string } | undefined {
  if (!params.modelContent && !params.errorMessage) {
    return undefined;
  }
  return {
    ...(params.modelContent ? { modelContent: params.modelContent } : {}),
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
  };
}

function boundedTraceFailureMessage(value: unknown): string | undefined {
  const message = stringValue(value)?.trim();
  if (!message) {
    return undefined;
  }
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]+/gu, "[REDACTED_KEY]")
    .slice(0, 512);
}

function matchesTraceTurn(
  event: RawTraceEvent,
  payload: RawTracePayload,
  threadId: string,
  turnId: string,
): boolean {
  return (
    (stringValue(payload.thread_id) ?? stringValue(event.thread_id)) === threadId &&
    (stringValue(payload.codex_turn_id) ?? stringValue(event.codex_turn_id)) === turnId
  );
}

function traceDurationMs(started: RawTraceEvent, terminal: RawTraceEvent): number {
  return Math.max(0, eventWallTimeMs(terminal) - eventWallTimeMs(started));
}

function resolveTerminalOnlyStart(
  terminal: RawTraceEvent,
  payload: RawTracePayload,
): {
  startTimeMs: number;
  durationMs: number;
  startTimeSource: "terminal" | "terminal-duration";
} {
  const endTimeMs = eventWallTimeMs(terminal);
  const durationMs = numberValue(payload.duration_ms) ?? numberValue(payload.durationMs);
  if (durationMs === undefined) {
    return { startTimeMs: endTimeMs, durationMs: 0, startTimeSource: "terminal" };
  }
  const boundedDurationMs = Math.max(0, durationMs);
  return {
    startTimeMs: Math.max(0, endTimeMs - boundedDurationMs),
    durationMs: boundedDurationMs,
    startTimeSource: "terminal-duration",
  };
}

function eventSeq(event: RawTraceEvent): number {
  return numberValue(event.seq) ?? 0;
}

function eventWallTimeMs(event: RawTraceEvent): number {
  return numberValue(event.wall_time_unix_ms) ?? 0;
}

async function readPayloadJson(
  bundleDir: string,
  payloadRef: RawPayloadRef | undefined,
): Promise<unknown> {
  const payloadPath = resolveBundlePayloadPath(bundleDir, payloadRef);
  if (!payloadPath) {
    return undefined;
  }
  try {
    const stat = await fs.stat(payloadPath);
    if (stat.size > ROLLOUT_TRACE_MAX_PAYLOAD_BYTES) {
      return await readTruncatedPayloadJson(payloadPath, stat.size);
    }
    return JSON.parse(await fs.readFile(payloadPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const TRUNCATED_PAYLOAD_FIELD = "__openclaw_truncated_payload";

async function readTruncatedPayloadJson(
  payloadPath: string,
  originalBytes: number,
): Promise<Record<string, unknown>> {
  const handle = await fs.open(payloadPath, "r");
  try {
    const headLength = Math.min(ROLLOUT_TRACE_PAYLOAD_EDGE_BYTES, originalBytes);
    const tailLength = Math.min(ROLLOUT_TRACE_PAYLOAD_EDGE_BYTES, originalBytes - headLength);
    const head = Buffer.allocUnsafe(headLength);
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(head, 0, headLength, 0);
    if (tailLength > 0) {
      await handle.read(tail, 0, tailLength, originalBytes - tailLength);
    }
    const headText = head.toString("utf8");
    const tailText = tail.toString("utf8");
    const tokenUsage = extractTopLevelJsonObjectProperty(headText, "token_usage");
    const toolName = extractTopLevelJsonStringProperty(headText, "tool_name");
    const toolNamespace = extractTopLevelJsonStringProperty(headText, "tool_namespace");
    return {
      ...(tokenUsage ? { token_usage: tokenUsage } : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(toolNamespace ? { tool_namespace: toolNamespace } : {}),
      ...(toolName
        ? { payload: { [TRUNCATED_PAYLOAD_FIELD]: truncatedPayloadMetadata(originalBytes) } }
        : {}),
      [TRUNCATED_PAYLOAD_FIELD]: truncatedPayloadMetadata(originalBytes, headText, tailText),
    };
  } finally {
    await handle.close();
  }
}

function truncatedPayloadMetadata(
  originalBytes: number,
  head?: string,
  tail?: string,
): Record<string, unknown> {
  return {
    truncated: true,
    originalBytes,
    ...(head !== undefined ? { head } : {}),
    ...(tail ? { tail } : {}),
  };
}

function extractTopLevelJsonStringProperty(source: string, property: string): string | undefined {
  const propertyLiteral = JSON.stringify(property);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"' && depth === 1 && source.startsWith(propertyLiteral, index)) {
      let valueStart = index + propertyLiteral.length;
      while (/\s/.test(source[valueStart] ?? "")) {
        valueStart += 1;
      }
      if (source[valueStart] !== ":") {
        continue;
      }
      valueStart += 1;
      while (/\s/.test(source[valueStart] ?? "")) {
        valueStart += 1;
      }
      if (source[valueStart] !== '"') {
        return undefined;
      }
      return parseJsonStringAt(source, valueStart);
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }
  }
  return undefined;
}

function parseJsonStringAt(source: string, stringStart: number): string | undefined {
  let escaped = false;
  for (let index = stringStart + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      try {
        return JSON.parse(source.slice(stringStart, index + 1)) as string;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function extractTopLevelJsonObjectProperty(
  source: string,
  property: string,
): Record<string, unknown> | undefined {
  const propertyLiteral = JSON.stringify(property);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"' && depth === 1 && source.startsWith(propertyLiteral, index)) {
      let valueStart = index + propertyLiteral.length;
      while (/\s/.test(source[valueStart] ?? "")) {
        valueStart += 1;
      }
      if (source[valueStart] !== ":") {
        continue;
      }
      valueStart += 1;
      while (/\s/.test(source[valueStart] ?? "")) {
        valueStart += 1;
      }
      if (source[valueStart] !== "{") {
        return undefined;
      }
      return parseJsonObjectAt(source, valueStart);
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }
  }
  return undefined;
}

function parseJsonObjectAt(
  source: string,
  objectStart: number,
): Record<string, unknown> | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return asObject(JSON.parse(source.slice(objectStart, index + 1)) as unknown);
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function resolveBundlePayloadPath(
  bundleDir: string,
  payloadRef: RawPayloadRef | undefined,
): string | undefined {
  const relativePath = stringValue(payloadRef?.path);
  if (!relativePath) {
    return undefined;
  }
  const bundleRoot = path.resolve(bundleDir);
  const payloadPath = path.resolve(bundleRoot, relativePath);
  return payloadPath === bundleRoot || payloadPath.startsWith(`${bundleRoot}${path.sep}`)
    ? payloadPath
    : undefined;
}

function extractTraceTokenUsage(payload: unknown):
  | {
      input?: number;
      output?: number;
      cacheRead?: number;
      reasoningTokens?: number;
      total?: number;
    }
  | undefined {
  const tokenUsage = asObject(payload)?.token_usage;
  const usageObject = asObject(tokenUsage);
  if (!usageObject) {
    return undefined;
  }
  const inputTokens = numberValue(usageObject.input_tokens);
  const cacheReadTokens = numberValue(usageObject.cached_input_tokens);
  const usage = {
    input:
      inputTokens !== undefined ? Math.max(0, inputTokens - (cacheReadTokens ?? 0)) : undefined,
    output: numberValue(usageObject.output_tokens),
    cacheRead: cacheReadTokens,
    reasoningTokens: numberValue(usageObject.reasoning_output_tokens),
    total: numberValue(usageObject.total_tokens),
  };
  const cleaned = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  );
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function asPayloadRef(value: unknown): RawPayloadRef | undefined {
  const object = asObject(value);
  return object ? (object as RawPayloadRef) : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTraceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
