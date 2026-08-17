import { describe, expect, it } from "vitest";
import {
  admitNativeChildLifecycle,
  applyNativeChildTurnStatus,
  ensureNativeChildObservationState,
  finalizeNativeChildLineage,
  isSupportedNativeChildDiagnosticVersion,
  nativeChildLineage,
  nativeChildLineageMetadata,
  noteNativeChildPartial,
  noteNativeChildPendingJoin,
  rememberNativeChildSpawnRole,
} from "./native-child.js";
import type { TraceContextEntry } from "./trace-context.js";

function entry(): TraceContextEntry {
  return {
    trace: {} as TraceContextEntry["trace"],
    traceId: "trace-1",
    llmCallCount: 0,
    toolCallCount: 0,
    pendingGenerations: new Map(),
    pendingGenIds: new Map(),
    completedGenerations: new Map(),
    pendingSpans: new Map(),
    completedSpanToolCallIds: new Set(),
    createdAt: 1_000,
    timestamp: 1_000,
  };
}

const fullCapability = {
  authoritativeStart: true,
  authoritativeTerminal: true,
  providerCallOwnership: true,
  toolCallOwnership: true,
};

describe("Langfuse native-child lineage state", () => {
  it("bounds configured spawn roles before retaining lineage metadata", () => {
    const traceEntry = entry();
    const oversizedRole = `role-${"界".repeat(20_000)}`;

    expect(rememberNativeChildSpawnRole(traceEntry, "spawn-1", oversizedRole)).toBe(true);
    expect(rememberNativeChildSpawnRole(traceEntry, "spawn-1", oversizedRole)).toBe(true);

    const retainedRole = nativeChildLineage(traceEntry).spawnAgentRoles.get("spawn-1");
    expect(retainedRole).toBeDefined();
    expect(retainedRole).not.toBe(oversizedRole);
    expect(retainedRole?.length).toBeLessThanOrEqual(256);
  });

  it("classifies complete, partial, and unsupported without affecting trace state", () => {
    const completeEntry = entry();
    applyNativeChildTurnStatus(
      completeEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-1",
        parentTurnId: "turn-1",
        parentThreadId: "parent-1",
        support: "supported",
        ...fullCapability,
        drain: "completed",
        counts: { admitted: 2, duplicates: 0, dropped: 0, activeChildren: 0 },
      },
      true,
    );
    finalizeNativeChildLineage(completeEntry, true);
    expect(nativeChildLineageMetadata(completeEntry)).toMatchObject({ status: "complete" });

    const partialEntry = entry();
    applyNativeChildTurnStatus(
      partialEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-2",
        parentTurnId: "turn-2",
        parentThreadId: "parent-2",
        support: "supported",
        ...fullCapability,
        drain: "timed_out",
        counts: { admitted: 1, duplicates: 0, dropped: 1, activeChildren: 1 },
      },
      false,
    );
    finalizeNativeChildLineage(partialEntry, false);
    expect(nativeChildLineageMetadata(partialEntry)).toMatchObject({
      status: "partial",
      drain: "timed_out",
    });

    const unsupportedEntry = entry();
    applyNativeChildTurnStatus(
      unsupportedEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-3",
        parentTurnId: "turn-3",
        parentThreadId: "parent-3",
        support: "unsupported",
        authoritativeStart: false,
        authoritativeTerminal: false,
        providerCallOwnership: false,
        toolCallOwnership: false,
        drain: "not_applicable",
        counts: { admitted: 0, duplicates: 0, dropped: 0, activeChildren: 0 },
      },
      true,
    );
    finalizeNativeChildLineage(unsupportedEntry, true);
    expect(nativeChildLineageMetadata(unsupportedEntry)).toMatchObject({
      status: "unsupported",
      support: "unsupported",
    });
  });

  it("keeps root coverage complete when an independently tracked detached child is active", () => {
    const traceEntry = entry();
    applyNativeChildTurnStatus(
      traceEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-detached",
        parentTurnId: "turn-detached",
        parentThreadId: "parent-detached",
        support: "supported",
        authoritativeStart: true,
        authoritativeTerminal: false,
        providerCallOwnership: true,
        toolCallOwnership: true,
        drain: "completed",
        counts: { admitted: 2, duplicates: 0, dropped: 0, activeChildren: 1 },
      },
      true,
    );
    finalizeNativeChildLineage(traceEntry, true);

    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      status: "complete",
      activeChildrenAtRootFinalization: 1,
      partialReasons: [],
    });
  });

  it("deduplicates lifecycle ids and rejects post-finalization activity", () => {
    const traceEntry = entry();
    const event = {
      type: "codex.native_child.lifecycle" as const,
      version: 1 as const,
      runId: "run-1",
      sourceEventId: "event-1",
      childThreadId: "child-1",
      lifecycle: "started" as const,
      sourceTimestampMs: 1_000,
      parentTurnId: "turn-1",
      parentThreadId: "parent-1",
    };
    expect(admitNativeChildLifecycle(traceEntry, event)).toBe(true);
    expect(admitNativeChildLifecycle(traceEntry, event)).toBe(false);
    finalizeNativeChildLineage(traceEntry, true);
    expect(admitNativeChildLifecycle(traceEntry, { ...event, sourceEventId: "event-2" })).toBe(
      false,
    );
    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      duplicateEvents: 1,
      droppedEvents: 1,
      partialReasons: expect.arrayContaining(["post_finalization_event"]),
    });
  });

  it("downgrades complete lineage when a later proven partial reason arrives", () => {
    const traceEntry = entry();
    applyNativeChildTurnStatus(
      traceEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-late-partial",
        parentTurnId: "turn-late-partial",
        parentThreadId: "parent-late-partial",
        support: "supported",
        ...fullCapability,
        drain: "completed",
        counts: { admitted: 2, duplicates: 0, dropped: 0, activeChildren: 0 },
      },
      true,
    );
    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({ status: "complete" });

    noteNativeChildPartial(traceEntry, "partial_parenting");

    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      status: "partial",
      partialReasons: expect.arrayContaining(["partial_parenting"]),
    });
  });

  it("defers missing child turn identity until unresolved lifecycle finalization", () => {
    const traceEntry = entry();
    const state = nativeChildLineage(traceEntry);
    state.support = "supported";
    state.status = "complete";
    state.pendingLifecycleEvents.set("child-pending-turn", [
      {
        type: "codex.native_child.lifecycle",
        version: 1,
        runId: "run-pending-turn",
        parentTurnId: "turn-pending-turn",
        parentThreadId: "parent-pending-turn",
        sourceEventId: "child-pending-turn-start",
        childThreadId: "child-pending-turn",
        lifecycle: "started",
        sourceTimestampMs: 1_000,
      },
    ]);

    expect(state.partialReasons).not.toContain("child_turn_identity_unavailable");
    finalizeNativeChildLineage(traceEntry, true);

    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      status: "partial",
      partialReasons: expect.arrayContaining(["child_turn_identity_unavailable"]),
    });
  });

  it("does not report complete while observation delivery remains unresolved", () => {
    const traceEntry = entry();
    traceEntry.pendingObservationDeliveryFailures = new Set([
      "sdk:diagnostic provider-request generation:child-gen",
    ]);

    applyNativeChildTurnStatus(
      traceEntry,
      {
        type: "codex.native_child.status",
        version: 1,
        runId: "run-delivery-incomplete",
        parentTurnId: "turn-delivery-incomplete",
        parentThreadId: "parent-delivery-incomplete",
        support: "supported",
        ...fullCapability,
        drain: "completed",
        counts: { admitted: 2, duplicates: 0, dropped: 0, activeChildren: 0 },
      },
      true,
    );
    finalizeNativeChildLineage(traceEntry, true);

    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      status: "partial",
      partialReasons: expect.arrayContaining(["observation_delivery_incomplete"]),
    });
  });

  it("rejects unknown diagnostic versions without treating them as compatible", () => {
    expect(isSupportedNativeChildDiagnosticVersion({ version: 1 })).toBe(true);
    expect(isSupportedNativeChildDiagnosticVersion({ version: 2 })).toBe(false);
    expect(isSupportedNativeChildDiagnosticVersion({ version: "1" })).toBe(false);
  });

  it("bounds active observations and pending ownership joins", () => {
    const traceEntry = entry();
    for (let index = 0; index < 64; index += 1) {
      const childThreadId = `child-${index}`;
      const childTurnId = `turn-${index}`;
      expect(
        ensureNativeChildObservationState(traceEntry, childThreadId, childTurnId, () => ({
          id: `trace-${index}`,
          traceEntry: entry(),
          spawnObservationId: `spawn-${index}`,
          childThreadId,
          childTurnId,
          ended: false,
        })),
      ).toBeDefined();
    }
    expect(
      ensureNativeChildObservationState(traceEntry, "child-overflow", "turn-overflow", () => ({
        id: "trace-overflow",
        traceEntry: entry(),
        spawnObservationId: "spawn-overflow",
        childThreadId: "child-overflow",
        childTurnId: "turn-overflow",
        ended: false,
      })),
    ).toBeUndefined();
    for (let index = 0; index < 513; index += 1) {
      noteNativeChildPendingJoin(traceEntry);
    }
    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      childCount: 64,
      pendingOwnershipJoins: 512,
      status: "unsupported",
    });
    expect(nativeChildLineage(traceEntry).partialReasons.has("active_child_limit")).toBe(true);
    expect(nativeChildLineage(traceEntry).partialReasons.has("pending_join_limit")).toBe(true);
  });

  it("bounds lifecycle and call mutations per turn", () => {
    const traceEntry = entry();
    for (let index = 0; index < 4_096; index += 1) {
      expect(
        admitNativeChildLifecycle(traceEntry, {
          type: "codex.native_child.lifecycle",
          version: 1,
          runId: "run-bounded",
          parentTurnId: "turn-bounded",
          parentThreadId: "parent-bounded",
          sourceEventId: `event-${index}`,
          childThreadId: "child-bounded",
          lifecycle: "activity",
          sourceTimestampMs: index,
        }),
      ).toBe(true);
    }
    expect(
      admitNativeChildLifecycle(traceEntry, {
        type: "codex.native_child.lifecycle",
        version: 1,
        runId: "run-bounded",
        parentTurnId: "turn-bounded",
        parentThreadId: "parent-bounded",
        sourceEventId: "event-overflow",
        childThreadId: "child-bounded",
        lifecycle: "activity",
        sourceTimestampMs: 4_096,
      }),
    ).toBe(false);
    expect(nativeChildLineageMetadata(traceEntry)).toMatchObject({
      observationMutations: 4_096,
      droppedEvents: 1,
      partialReasons: expect.arrayContaining(["mutation_limit"]),
    });
  });
});
