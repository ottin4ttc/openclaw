import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  NativeChildLineageState,
  NativeChildObservation,
  TraceContextEntry,
} from "./trace-context.js";
import { generateTraceId } from "./utils.js";

export type CodexNativeChildLifecycleDiagnostic = Extract<
  DiagnosticEventPayload,
  { type: "codex.native_child.lifecycle" }
>;
export type CodexNativeChildStatusDiagnostic = Extract<
  DiagnosticEventPayload,
  { type: "codex.native_child.status" }
>;

export const NATIVE_CHILD_MAX_ACTIVE = 64;
export const NATIVE_CHILD_MAX_MUTATIONS = 4_096;
export const NATIVE_CHILD_MAX_PENDING_JOINS = 512;
export const NATIVE_CHILD_MAX_PENDING_DIAGNOSTICS = 512;
export const NATIVE_CHILD_FINAL_DRAIN_MS = 500;
const NATIVE_CHILD_MAX_ROLE_CHARS = 256;

export function isSupportedNativeChildDiagnosticVersion(event: { version: unknown }): boolean {
  return event.version === 1;
}

export function nativeChildTurnKey(childThreadId: string, childTurnId: string): string {
  return `${childThreadId}\u0000${childTurnId}`;
}

export function nativeChildTraceId(
  parentTraceId: string,
  childThreadId: string,
  childTurnId: string,
): string {
  return generateTraceId(
    ["native-child", parentTraceId, childThreadId, childTurnId].join("\u0000"),
    0,
  );
}

export function nativeChildTraceName(agentId?: string, role?: string): string {
  return [agentId, "native-child", role].filter(Boolean).join(":");
}

export function nativeChildLineage(entry: TraceContextEntry): NativeChildLineageState {
  return (entry.nativeChildLineage ??= {
    producerHealthy: true,
    support: "unknown",
    status: "unsupported",
    observations: new Map(),
    currentChildTurnIds: new Map(),
    pendingChildThreads: new Set(),
    childTriggeringToolCallIds: new Map(),
    spawnAgentRoles: new Map(),
    pendingLifecycleEvents: new Map(),
    sourceEventIds: new Set(),
    providerCallOwners: new Map(),
    mutations: 0,
    pendingJoins: 0,
    admittedEvents: 0,
    duplicateEvents: 0,
    droppedEvents: 0,
    activeChildrenAtRootFinalization: 0,
    partialReasons: new Set(),
    drain: "pending",
    finalized: false,
  });
}

export function markNativeChildPending(entry: TraceContextEntry, childThreadId: string): void {
  nativeChildLineage(entry).pendingChildThreads.add(childThreadId);
}

export function clearNativeChildPending(entry: TraceContextEntry, childThreadId: string): void {
  const state = nativeChildLineage(entry);
  state.pendingChildThreads.delete(childThreadId);
  if (
    state.pendingChildThreads.size === 0 &&
    state.pendingLifecycleEvents.size === 0 &&
    (entry.pendingNativeChildDiagnostics?.length ?? 0) === 0
  ) {
    state.partialReasons.delete("child_observation_pending_spawn_ownership");
    state.partialReasons.delete("child_observation_pending_spawn_tool");
    state.partialReasons.delete("child_observation_unavailable");
  }
}

export function rememberNativeChildTriggeringTool(
  entry: TraceContextEntry,
  childThreadId: string,
  toolCallId: string,
): void {
  nativeChildLineage(entry).childTriggeringToolCallIds.set(childThreadId, toolCallId);
}

export function rememberNativeChildSpawnRole(
  entry: TraceContextEntry,
  toolCallId: string,
  role: string,
): boolean {
  const state = nativeChildLineage(entry);
  const normalizedRole = role.trim();
  const boundedRole =
    normalizedRole.length <= NATIVE_CHILD_MAX_ROLE_CHARS
      ? normalizedRole
      : `${normalizedRole.slice(0, 128)}:${generateTraceId(normalizedRole, 0)}`;
  const existing = state.spawnAgentRoles.get(toolCallId);
  if (existing === boundedRole) {
    return true;
  }
  if (existing) {
    state.partialReasons.add("spawn_role_conflict");
    return false;
  }
  if (!admitNativeChildMutation(entry, "spawn_agent_role")) {
    return false;
  }
  state.spawnAgentRoles.set(toolCallId, boundedRole);
  return true;
}

export function noteNativeChildProducerUnhealthy(entry: TraceContextEntry): void {
  nativeChildLineage(entry).producerHealthy = false;
}

export function admitNativeChildMutation(entry: TraceContextEntry, source: string): boolean {
  const state = nativeChildLineage(entry);
  if (state.mutations >= NATIVE_CHILD_MAX_MUTATIONS) {
    state.droppedEvents += 1;
    state.partialReasons.add("mutation_limit");
    state.partialReasons.add(source);
    return false;
  }
  state.mutations += 1;
  return true;
}

export function activeNativeChildCount(entry: TraceContextEntry): number {
  let active = 0;
  for (const observation of nativeChildLineage(entry).observations.values()) {
    if (!observation.ended) {
      active += 1;
    }
  }
  return active;
}

export function ensureNativeChildObservationState(
  entry: TraceContextEntry,
  childThreadId: string,
  childTurnId: string,
  create: () => NativeChildObservation | undefined,
): NativeChildObservation | undefined {
  const state = nativeChildLineage(entry);
  const key = nativeChildTurnKey(childThreadId, childTurnId);
  const existing = state.observations.get(key);
  if (existing) {
    return existing;
  }
  if (activeNativeChildCount(entry) >= NATIVE_CHILD_MAX_ACTIVE) {
    state.droppedEvents += 1;
    state.partialReasons.add("active_child_limit");
    return undefined;
  }
  if (!admitNativeChildMutation(entry, "child_observation")) {
    return undefined;
  }
  const observation = create();
  if (!observation) {
    return undefined;
  }
  state.currentChildTurnIds.set(childThreadId, childTurnId);
  state.observations.set(key, observation);
  return observation;
}

export function findNativeChildObservation(
  entry: TraceContextEntry,
  childThreadId: string,
  childTurnId?: string,
): NativeChildObservation | undefined {
  const state = nativeChildLineage(entry);
  const resolvedTurnId = childTurnId ?? state.currentChildTurnIds.get(childThreadId);
  return resolvedTurnId
    ? state.observations.get(nativeChildTurnKey(childThreadId, resolvedTurnId))
    : undefined;
}

export function rememberNativeChildProviderOwner(
  entry: TraceContextEntry,
  providerCallId: string,
  childThreadId: string,
  childTurnId: string,
): boolean {
  const state = nativeChildLineage(entry);
  const ownerKey = nativeChildTurnKey(childThreadId, childTurnId);
  const existing = state.providerCallOwners.get(providerCallId);
  if (existing === ownerKey) {
    return true;
  }
  if (existing) {
    state.partialReasons.add("provider_owner_conflict");
    return false;
  }
  if (!admitNativeChildMutation(entry, "provider_call_owner")) {
    return false;
  }
  state.providerCallOwners.set(providerCallId, ownerKey);
  return true;
}

export function noteNativeChildPendingJoin(entry: TraceContextEntry): void {
  const state = nativeChildLineage(entry);
  if (state.pendingJoins >= NATIVE_CHILD_MAX_PENDING_JOINS) {
    state.droppedEvents += 1;
    state.partialReasons.add("pending_join_limit");
    return;
  }
  state.pendingJoins += 1;
  state.partialReasons.add("partial_parenting");
}

export function noteNativeChildPartial(entry: TraceContextEntry, reason: string): void {
  const state = nativeChildLineage(entry);
  state.partialReasons.add(reason);
  if (state.status === "complete") {
    state.status = "partial";
  }
}

export function noteNativeChildPostFinalization(entry: TraceContextEntry): void {
  const state = nativeChildLineage(entry);
  noteNativeChildPartial(entry, "post_finalization_event");
  state.droppedEvents += 1;
}

export function admitNativeChildLifecycle(
  entry: TraceContextEntry,
  event: CodexNativeChildLifecycleDiagnostic,
  options?: { allowAfterRootFinalization?: boolean },
): boolean {
  const state = nativeChildLineage(entry);
  if (state.finalized && !options?.allowAfterRootFinalization) {
    state.droppedEvents += 1;
    state.partialReasons.add("post_finalization_event");
    return false;
  }
  if (state.sourceEventIds.has(event.sourceEventId)) {
    state.duplicateEvents += 1;
    return false;
  }
  if (!admitNativeChildMutation(entry, "lifecycle")) {
    return false;
  }
  state.sourceEventIds.add(event.sourceEventId);
  state.admittedEvents += 1;
  state.support = "supported";
  state.status = "partial";
  return true;
}

export function applyNativeChildTurnStatus(
  entry: TraceContextEntry,
  event: CodexNativeChildStatusDiagnostic,
  producerHealthy: boolean,
): void {
  const state = nativeChildLineage(entry);
  state.support = event.support;
  state.capability = {
    eventVersions: [event.version],
    authoritativeStart: event.authoritativeStart,
    authoritativeTerminal: event.authoritativeTerminal,
    providerCallOwnership: event.providerCallOwnership,
    toolCallOwnership: event.toolCallOwnership,
  };
  state.drain = event.drain;
  state.admittedEvents = Math.max(state.admittedEvents, event.counts.admitted);
  state.duplicateEvents = Math.max(state.duplicateEvents, event.counts.duplicates);
  state.droppedEvents = Math.max(state.droppedEvents, event.counts.dropped);
  state.activeChildrenAtRootFinalization = event.counts.activeChildren;
  for (const reason of event.partialReasons ?? []) {
    state.partialReasons.add(reason);
  }
  if (!producerHealthy || !state.producerHealthy) {
    state.partialReasons.add("producer_unhealthy");
  }
  if ((entry.pendingObservationDeliveryFailures?.size ?? 0) > 0) {
    state.partialReasons.add("observation_delivery_incomplete");
  }
  if (event.support === "unsupported") {
    if (state.observations.size > 0 || state.providerCallOwners.size > 0) {
      state.support = "supported";
      state.status = "partial";
      state.partialReasons.add("lifecycle_capability_absent");
    } else {
      state.status = "unsupported";
    }
    return;
  }
  const capability = state.capability;
  const terminalCoverage = capability?.authoritativeTerminal || event.counts.activeChildren > 0;
  const authoritativeCoverage =
    capability?.authoritativeStart &&
    terminalCoverage &&
    capability.providerCallOwnership &&
    capability.toolCallOwnership;
  state.status =
    authoritativeCoverage &&
    event.drain === "completed" &&
    event.counts.dropped === 0 &&
    state.partialReasons.size === 0
      ? "complete"
      : "partial";
}

export function finalizeNativeChildLineage(
  entry: TraceContextEntry,
  producerHealthy: boolean,
): void {
  const state = nativeChildLineage(entry);
  state.finalized = true;
  if (
    state.support === "supported" &&
    [...state.pendingLifecycleEvents.keys()].some(
      (childThreadId) => !state.currentChildTurnIds.has(childThreadId),
    )
  ) {
    noteNativeChildPartial(entry, "child_turn_identity_unavailable");
  }
  if (
    state.support === "supported" &&
    [...state.observations.values()].some(
      (observation) => observation.ended && (observation.executionContextCallIds?.size ?? 0) === 0,
    )
  ) {
    noteNativeChildPartial(entry, "child_context_unavailable");
  }
  if ((entry.pendingObservationDeliveryFailures?.size ?? 0) > 0) {
    noteNativeChildPartial(entry, "observation_delivery_incomplete");
  }
  if (state.support === "supported" && state.drain === "pending") {
    state.partialReasons.add("missing_turn_status");
    state.status = "partial";
  }
  if ((!producerHealthy || !state.producerHealthy) && state.support === "supported") {
    state.partialReasons.add("producer_unhealthy");
    state.status = "partial";
  }
}

export function nativeChildLifecycleMetadata(
  event: CodexNativeChildLifecycleDiagnostic,
): Record<string, unknown> {
  return {
    sourceEventId: event.sourceEventId,
    childThreadId: event.childThreadId,
    ...(event.triggeringToolCallId ? { triggeringToolCallId: event.triggeringToolCallId } : {}),
    lifecycle: event.lifecycle,
    parentThreadId: event.parentThreadId,
    parentTurnId: event.parentTurnId,
    ...(event.childTurnId ? { childTurnId: event.childTurnId } : {}),
    ...(event.role ? { role: event.role } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}),
    ...(event.depth !== undefined ? { depth: event.depth } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
  };
}

export function nativeChildLineageMetadata(entry: TraceContextEntry): Record<string, unknown> {
  const state = nativeChildLineage(entry);
  const observations = [...state.observations.values()];
  const roles = [
    ...new Set(
      observations
        .map((observation) => observation.role)
        .filter((role): role is string => typeof role === "string"),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  const models = [
    ...new Set(
      observations
        .map((observation) => observation.model)
        .filter((model): model is string => typeof model === "string"),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  const childrenWithContext = observations.filter(
    (observation) => (observation.executionContextCallIds?.size ?? 0) > 0,
  ).length;
  const contextRequestCount = observations.reduce(
    (total, observation) => total + (observation.executionContextCallIds?.size ?? 0),
    0,
  );
  return {
    status: state.status,
    support: state.support,
    drain: state.drain,
    childCount: state.observations.size,
    admittedEvents: state.admittedEvents,
    duplicateEvents: state.duplicateEvents,
    droppedEvents: state.droppedEvents,
    activeChildrenAtRootFinalization: state.activeChildrenAtRootFinalization,
    observationMutations: state.mutations,
    pendingOwnershipJoins: state.pendingJoins,
    partialReasons: [...state.partialReasons].toSorted().slice(0, 16),
    ...(observations.length > 0
      ? {
          childTraceLinks: observations.map((observation) => ({
            childTraceId: observation.id,
            spawnObservationId: observation.spawnObservationId,
            childThreadId: observation.childThreadId,
            childTurnId: observation.childTurnId,
          })),
          childContext: {
            availableChildren: childrenWithContext,
            unavailableChildren: observations.length - childrenWithContext,
            requestCount: contextRequestCount,
            ...(roles.length > 0 ? { roles } : {}),
            ...(models.length > 0 ? { models } : {}),
          },
        }
      : {}),
    ...(state.capability ? { capability: state.capability } : {}),
  };
}
