import type { LangfuseTraceClient, LangfuseGenerationClient, LangfuseSpanClient } from "langfuse";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TraceContextMap, type TraceContextEntry } from "./trace-context.js";

// Minimal stub factories
const stubTrace = () => ({}) as unknown as LangfuseTraceClient;
const stubGeneration = () => ({}) as unknown as LangfuseGenerationClient;
const stubSpan = () => ({}) as unknown as LangfuseSpanClient;

function makeEntry(overrides?: Partial<TraceContextEntry>): TraceContextEntry {
  return {
    trace: stubTrace(),
    traceId: "trace-test",
    llmCallCount: 0,
    toolCallCount: 0,
    pendingGenerations: new Map<string, LangfuseGenerationClient>(),
    pendingGenIds: new Map<string, string>(),
    completedGenerations: new Map(),
    pendingSpans: new Map<string, LangfuseSpanClient>(),
    completedSpanToolCallIds: new Set<string>(),
    createdAt: Date.now(),
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("TraceContextMap", () => {
  let tcm: TraceContextMap;

  beforeEach(() => {
    tcm = new TraceContextMap();
  });

  afterEach(() => {
    tcm.stopSweep();
    vi.useRealTimers();
  });

  it("creates and retrieves an entry by key", () => {
    const key = TraceContextMap.key("agent1", "session1");
    const entry = makeEntry();
    tcm.create(key, entry);
    expect(tcm.get(key)).toBe(entry);
  });

  it("returns undefined for unknown key", () => {
    expect(tcm.get("nonexistent:key")).toBeUndefined();
  });

  it("reports whether any trace is still active", () => {
    const active = makeEntry({ traceId: "trace-active" });
    const finalized = makeEntry({ traceId: "trace-finalized", finalized: true });

    expect(tcm.hasActiveEntries()).toBe(false);
    tcm.create(TraceContextMap.key("agent1", "session1"), finalized);
    expect(tcm.hasActiveEntries()).toBe(false);
    tcm.create(TraceContextMap.key("agent2", "session2"), active);
    expect(tcm.hasActiveEntries()).toBe(true);
    active.finalized = true;
    expect(tcm.hasActiveEntries()).toBe(false);
  });

  it("deletes an entry", () => {
    const key = TraceContextMap.key("agent1", "session1");
    tcm.create(key, makeEntry());
    tcm.delete(key);
    expect(tcm.get(key)).toBeUndefined();
    expect(tcm.size).toBe(0);
  });

  it("concurrent entries with different keys are isolated", () => {
    const key1 = TraceContextMap.key("agent1", "s1");
    const key2 = TraceContextMap.key("agent2", "s2");
    const entry1 = makeEntry({ llmCallCount: 1 });
    const entry2 = makeEntry({ llmCallCount: 2 });
    tcm.create(key1, entry1);
    tcm.create(key2, entry2);
    expect(tcm.get(key1)).toBe(entry1);
    expect(tcm.get(key2)).toBe(entry2);
    expect(tcm.get(key1)?.llmCallCount).toBe(1);
    expect(tcm.get(key2)?.llmCallCount).toBe(2);
  });

  it("keeps finalized previous turns addressable after a new turn starts in the same session", () => {
    const key = TraceContextMap.key("agent1", "session1");
    const previous = makeEntry({ traceId: "trace-previous", finalized: true });
    const current = makeEntry({ traceId: "trace-current" });

    tcm.create(key, previous);
    tcm.create(key, current);

    expect(tcm.get(key)).toBe(current);
    expect(tcm.findByTraceId("trace-previous")).toBe(previous);
    expect(tcm.findRecent("session1", { traceId: "trace-previous" })).toBe(previous);
    expect(tcm.findActive("session1")).toBe(current);
  });

  it("resolves late run events to their original turn instead of the active session turn", () => {
    const key = TraceContextMap.key("agent1", "session1");
    const previous = makeEntry({ traceId: "trace-previous", finalized: true });
    previous.pendingGenIds.set("run-late", "trace-previous-gen-1");
    previous.completedGenerations.set(1, stubGeneration());
    const current = makeEntry({ traceId: "trace-current" });
    current.pendingGenIds.set("run-current", "trace-current-gen-1");

    tcm.create(key, previous);
    tcm.create(key, current);

    expect(tcm.findRecent("session1", { runId: "run-late" })).toBe(previous);
    expect(tcm.findActive("session1", { runId: "run-current" })).toBe(current);
  });

  it("does not let lookup touch move an older trace ahead of the current turn", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const key = TraceContextMap.key("agent1", "session1");
    const previous = makeEntry({
      traceId: "trace-previous",
      createdAt: 1_000,
      timestamp: 1_000,
      finalized: true,
    });

    vi.setSystemTime(2_000);
    const current = makeEntry({
      traceId: "trace-current",
      createdAt: 2_000,
      timestamp: 2_000,
    });
    tcm.create(key, previous);
    tcm.create(key, current);

    vi.setSystemTime(3_000);
    expect(tcm.findRecent("session1", { traceId: "trace-previous" })).toBe(previous);
    expect(tcm.findRecent("session1")).toBe(current);
    expect(tcm.get(key)).toBe(current);
  });

  it("evicts the oldest entry when map reaches MAX_ENTRIES", () => {
    // Access private map to override limit via many inserts
    // Insert 1000 entries then one more; the first should be evicted
    const keys: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const k = `agent${i}:session${i}`;
      keys.push(k);
      tcm.create(k, makeEntry());
    }
    expect(tcm.size).toBe(1000);
    // Insert the 1001st entry
    const newKey = "agent-new:session-new";
    tcm.create(newKey, makeEntry());
    // Size stays at 1000
    expect(tcm.size).toBe(1000);
    // The first key should have been evicted
    expect(tcm.get(keys[0])).toBeUndefined();
    // The new key should be present
    expect(tcm.get(newKey)).toBeDefined();
  });

  it("replacing an existing trace refreshes insertion order without evicting unrelated entries", () => {
    const firstKey = "agent0:session0";
    const replacement = makeEntry({ traceId: "trace-0" });
    tcm.create(firstKey, makeEntry({ traceId: "trace-0" }));
    for (let i = 1; i < 1000; i++) {
      tcm.create(`agent${i}:session${i}`, makeEntry({ traceId: `trace-${i}` }));
    }

    tcm.create(firstKey, replacement);
    tcm.create("agent-new:session-new", makeEntry({ traceId: "trace-new" }));

    expect(tcm.size).toBe(1000);
    expect(tcm.get(firstKey)).toBe(replacement);
    expect(tcm.get("agent1:session1")).toBeUndefined();
    expect(tcm.get("agent-new:session-new")).toBeDefined();
  });

  it("orphan sweep removes only finalized entries older than TTL", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const activeOldKey = "active-old:entry";
    const finalizedOldKey = "finalized-old:entry";
    const freshKey = "fresh:entry";

    tcm.create(activeOldKey, makeEntry({ createdAt: now - 6 * 60 * 1000 }));
    tcm.create(
      finalizedOldKey,
      makeEntry({
        createdAt: now - 6 * 60 * 1000,
        lastUpdatedAt: now - 6 * 60 * 1000,
        finalized: true,
      }),
    );
    tcm.create(freshKey, makeEntry({ createdAt: now }));

    tcm.startSweep();

    // Advance 61 seconds to trigger one sweep cycle
    vi.advanceTimersByTime(61_000);

    expect(tcm.get(activeOldKey)).toBeDefined();
    expect(tcm.get(finalizedOldKey)).toBeUndefined();
    expect(tcm.get(freshKey)).toBeDefined();
  });

  it("orphan sweep eventually removes abandoned active entries", () => {
    vi.useFakeTimers();
    const key = "abandoned:entry";
    tcm.create(key, makeEntry({ createdAt: Date.now() - 25 * 60 * 60 * 1000 }));

    tcm.startSweep();
    vi.advanceTimersByTime(61_000);

    expect(tcm.get(key)).toBeUndefined();
  });

  it("notifies the owner when an abandoned trace is swept", () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    const ownedMap = new TraceContextMap(onDelete);
    const entry = makeEntry({ createdAt: Date.now() - 25 * 60 * 60 * 1000 });
    ownedMap.create("abandoned:owned", entry);

    ownedMap.startSweep();
    vi.advanceTimersByTime(61_000);

    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(entry);
    ownedMap.stopSweep();
  });

  it("notifies the owner only after the final alias is removed", () => {
    const onDelete = vi.fn();
    const ownedMap = new TraceContextMap(onDelete);
    const entry = makeEntry({ traceId: "trace-shared-alias" });
    ownedMap.create("agent-a:session-a", entry);
    ownedMap.create("agent-b:session-b", entry);

    ownedMap.delete("agent-a:session-a");
    expect(onDelete).not.toHaveBeenCalled();
    expect(ownedMap.get("agent-b:session-b")).toBe(entry);

    ownedMap.delete("agent-b:session-b");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(entry);
  });

  it("starts finalized entry TTL from finalization instead of creation", () => {
    vi.useFakeTimers();
    const key = "recently-finalized:entry";
    const entry = makeEntry({ createdAt: Date.now() - 25 * 60 * 60 * 1000 });
    tcm.create(key, entry);
    entry.finalized = true;

    tcm.startSweep();
    vi.advanceTimersByTime(61_000);

    expect(tcm.get(key)).toBe(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);

    expect(tcm.get(key)).toBeUndefined();
  });

  it("llmCallCount and toolCallCount can be incremented on the stored entry", () => {
    const key = TraceContextMap.key("agent1", "session1");
    const entry = makeEntry();
    tcm.create(key, entry);

    const stored = tcm.get(key)!;
    stored.llmCallCount += 1;
    stored.toolCallCount += 3;

    expect(tcm.get(key)?.llmCallCount).toBe(1);
    expect(tcm.get(key)?.toolCallCount).toBe(3);
  });

  it("clear() empties the map", () => {
    tcm.create(TraceContextMap.key("a", "1"), makeEntry());
    tcm.create(TraceContextMap.key("b", "2"), makeEntry());
    expect(tcm.size).toBe(2);
    tcm.clear();
    expect(tcm.size).toBe(0);
  });

  it("static key() builds composite key from agentId and sessionKey", () => {
    expect(TraceContextMap.key("myAgent", "mySession")).toBe("myAgent:mySession");
  });

  it("static key() uses 'unknown' for undefined agentId and sessionKey", () => {
    expect(TraceContextMap.key(undefined, undefined)).toBe("unknown:unknown");
    expect(TraceContextMap.key("a", undefined)).toBe("a:unknown");
    expect(TraceContextMap.key(undefined, "s")).toBe("unknown:s");
  });

  it("pendingGenerations and pendingSpans store and retrieve by id", () => {
    const key = TraceContextMap.key("agent1", "session1");
    const entry = makeEntry();
    const gen = stubGeneration();
    const span = stubSpan();
    entry.pendingGenerations.set("run-1", gen);
    entry.pendingSpans.set("tool-1", span);
    tcm.create(key, entry);

    const stored = tcm.get(key)!;
    expect(stored.pendingGenerations.get("run-1")).toBe(gen);
    expect(stored.pendingSpans.get("tool-1")).toBe(span);
  });
});
