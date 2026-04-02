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

  it("orphan sweep removes entries older than TTL", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const oldKey = "old:entry";
    const freshKey = "fresh:entry";

    tcm.create(oldKey, makeEntry({ createdAt: now - 6 * 60 * 1000 })); // 6 min old
    tcm.create(freshKey, makeEntry({ createdAt: now }));

    tcm.startSweep();

    // Advance 61 seconds to trigger one sweep cycle
    vi.advanceTimersByTime(61_000);

    expect(tcm.get(oldKey)).toBeUndefined();
    expect(tcm.get(freshKey)).toBeDefined();
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
