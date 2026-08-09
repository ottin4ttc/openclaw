import Langfuse from "langfuse";
import { describe, expect, it, vi } from "vitest";
import {
  bindSdkDeliveryTracker,
  flushSdkDeliveryForBackpressure,
  flushSdkDeliveryThroughWatermark,
  SDK_DELIVERY_MAX_EVENT_BYTES,
  SDK_DELIVERY_MAX_ACTIVE_TRACES,
  SDK_DELIVERY_MAX_TICKETS_PER_TRACE,
  SDK_DELIVERY_TIMEOUT_MS,
  SdkDeliveryTracker,
} from "./sdk-delivery.js";
import {
  LANGFUSE_PLUGIN_EVENT_BODY_LIMIT_BYTES,
  LANGFUSE_SDK_EVENT_LIMIT_BYTES,
  MAX_PAYLOAD_BYTES,
} from "./utils.js";

function flushItem(
  traceId: string,
  observationId: string,
): { type: "generation-create"; body: { id: string; traceId: string } } {
  return { type: "generation-create", body: { id: observationId, traceId } };
}

describe("SdkDeliveryTracker", () => {
  it("settles every enqueue when one observation id is created and updated", async () => {
    const tracker = new SdkDeliveryTracker();
    expect(tracker.begin("trace-1", "observation-1")).toBe(true);
    expect(tracker.begin("trace-1", "observation-1")).toBe(true);
    const watermark = tracker.watermark("trace-1");

    tracker.noteFlush([flushItem("trace-1", "observation-1")]);
    tracker.noteFlush([flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({ ok: true });
  });

  it("retains successful delivery proof until a late trace waiter consumes its watermark", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    const deliveredWatermark = tracker.watermark("trace-1");

    tracker.noteFlush([flushItem("trace-1", "observation-1")]);
    tracker.begin("trace-1", "observation-2");

    await expect(tracker.awaitTrace("trace-1", deliveredWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    await expect(tracker.awaitTrace("trace-1", tracker.watermark("trace-1"), 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("does not treat an unknown or empty watermark as delivery proof", async () => {
    const tracker = new SdkDeliveryTracker();

    await expect(tracker.awaitTrace("unknown-trace", 1, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    await expect(tracker.awaitTrace("unknown-trace", 0, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("preserves a failed ticket when a later ticket on the same trace succeeds", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    const failedWatermark = tracker.watermark("trace-1");
    tracker.noteFlush([flushItem("trace-1", "observation-1")], new Error("ingestion failed"));

    await expect(tracker.awaitTrace("trace-1", failedWatermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });

    tracker.begin("trace-1", "observation-2");
    const watermark = tracker.watermark("trace-1");
    tracker.noteFlush([flushItem("trace-1", "observation-2")]);

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
  });

  it("keeps a failed SDK batch scoped to the observations in that batch", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    tracker.begin("trace-2", "observation-2");
    const firstWatermark = tracker.watermark("trace-1");
    const secondWatermark = tracker.watermark("trace-2");

    tracker.noteFlush([flushItem("trace-1", "observation-1")], new Error("ingestion failed"));
    tracker.noteFlush([flushItem("trace-2", "observation-2")]);

    await expect(tracker.awaitTrace("trace-1", firstWatermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
    await expect(tracker.awaitTrace("trace-2", secondWatermark, 20)).resolves.toEqual({ ok: true });
  });

  it("times out when enqueue processing emits an error without a flush", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    const watermark = tracker.watermark("trace-1");

    tracker.noteError("not serializable");

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("fails a ticket when the SDK flush event contains an item above its ingestion cap", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    const watermark = tracker.watermark("trace-1");

    tracker.noteFlush([
      {
        type: "generation-create",
        body: {
          id: "observation-1",
          traceId: "trace-1",
          payload: "x".repeat(SDK_DELIVERY_MAX_EVENT_BYTES),
        },
      },
    ]);

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
  });

  it("does not wait for unrelated trace delivery", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-a", "observation-a");
    tracker.begin("trace-b", "observation-b");
    const watermark = tracker.watermark("trace-a");
    tracker.noteFlush([flushItem("trace-a", "observation-a")]);

    await expect(tracker.awaitTrace("trace-a", watermark, 20)).resolves.toEqual({ ok: true });
    await expect(tracker.awaitTrace("trace-b", tracker.watermark("trace-b"), 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("finalizes 99 of 100 tool-heavy traces while one trace remains stalled", async () => {
    const tracker = new SdkDeliveryTracker();
    const traces = Array.from({ length: SDK_DELIVERY_MAX_ACTIVE_TRACES }, (_, traceIndex) => {
      const traceId = `stress-trace-${traceIndex}`;
      const items = [
        { type: "trace-create", body: { id: traceId, traceId } },
        {
          type: "generation-create",
          body: { id: `${traceId}-generation-1`, traceId },
        },
        {
          type: "generation-update",
          body: { id: `${traceId}-generation-1`, traceId },
        },
        {
          type: "span-create",
          body: { id: `${traceId}-tool-1`, traceId },
        },
        {
          type: "span-update",
          body: { id: `${traceId}-tool-1`, traceId },
        },
        {
          type: "generation-create",
          body: { id: `${traceId}-generation-2`, traceId },
        },
        {
          type: "generation-update",
          body: { id: `${traceId}-generation-2`, traceId },
        },
        {
          type: "span-create",
          body: { id: `${traceId}-tool-2`, traceId },
        },
        {
          type: "span-update",
          body: { id: `${traceId}-tool-2`, traceId },
        },
        { type: "trace-update", body: { id: traceId, traceId } },
      ];
      for (const item of items) {
        expect(tracker.begin(traceId, item.body.id, item.type)).toBe(true);
      }
      return { traceId, items, watermark: tracker.watermark(traceId) };
    });

    const stalled = traces[0];
    expect(stalled).toBeDefined();
    for (const trace of traces.slice(1)) {
      for (const item of trace.items) {
        tracker.noteFlush([item]);
      }
    }

    await expect(
      Promise.all(
        traces.slice(1).map((trace) => tracker.awaitTrace(trace.traceId, trace.watermark, 50)),
      ),
    ).resolves.toEqual(Array.from({ length: traces.length - 1 }, () => ({ ok: true })));
    await expect(tracker.awaitTrace(stalled!.traceId, stalled!.watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    expect(tracker.begin("stress-trace-after-99", "root", "trace-create")).toBe(true);

    for (const item of stalled!.items) {
      tracker.noteFlush([item]);
    }
    await expect(tracker.awaitTrace(stalled!.traceId, stalled!.watermark, 20)).resolves.toEqual({
      ok: true,
    });
  });

  it("uses the SDK flush callback as batch-correlated delivery proof", async () => {
    const tracker = new SdkDeliveryTracker();
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      callback?.(undefined, [flushItem("trace-1", "observation-1")]);
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);
    tracker.begin("trace-1", "observation-1");
    const watermark = tracker.watermark("trace-1");

    langfuse.flush();

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({ ok: true });
    expect(originalFlush).toHaveBeenCalledOnce();
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect(langfuse.flush).toBe(originalFlush);
  });

  it("requires trace, observation, and SDK event type to correlate", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1", "generation-update");
    const watermark = tracker.watermark("trace-1");

    tracker.noteFlush([flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    tracker.noteFlush([
      {
        type: "generation-update",
        body: { id: "observation-1", traceId: "trace-1" },
      },
    ]);
    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({ ok: true });
  });

  it("does not infer the private processed subset from a multi-item callback", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    tracker.begin("trace-1", "observation-2");
    const watermark = tracker.watermark("trace-1");

    tracker.noteFlush([
      flushItem("trace-1", "observation-1"),
      flushItem("trace-1", "observation-2"),
    ]);

    await expect(tracker.awaitTrace("trace-1", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("leaves undocumented SDK queue methods untouched", () => {
    const tracker = new SdkDeliveryTracker();
    const processQueueItems = vi.fn();
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      callback?.();
    });
    const langfuse = {
      flush: originalFlush,
      processQueueItems,
    } as unknown as Langfuse;

    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    expect((langfuse as unknown as { processQueueItems: unknown }).processQueueItems).toBe(
      processQueueItems,
    );
    for (const cleanup of cleanups) {
      cleanup();
    }
    expect((langfuse as unknown as { processQueueItems: unknown }).processQueueItems).toBe(
      processQueueItems,
    );
  });

  it("requires the explicit flushAsync call to reach the public flush callback", async () => {
    const tracker = new SdkDeliveryTracker();
    const langfuse = {
      flush: vi.fn((_callback?: (error?: unknown, items?: unknown) => void) => undefined),
      flushAsync: vi.fn(async () => undefined),
    };
    const cleanups = bindSdkDeliveryTracker(langfuse as unknown as Langfuse, tracker);

    await expect(flushSdkDeliveryForBackpressure(langfuse, tracker, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("lets an empty callback settle only the explicit flush invocation", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "observation-1");
    const watermark = tracker.watermark("trace-1");
    const langfuse = {
      flush: vi.fn((callback?: (error?: unknown, items?: unknown) => void) => callback?.()),
      flushAsync: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          langfuse.flush(() => resolve());
        });
      }),
    };
    const cleanups = bindSdkDeliveryTracker(langfuse as unknown as Langfuse, tracker);

    await expect(
      flushSdkDeliveryThroughWatermark(langfuse, tracker, "trace-1", watermark, 20),
    ).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("keeps each pre-bounded production event below the SDK limit with envelope headroom", async () => {
    const langfuse = new Langfuse({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "http://langfuse.invalid",
      fetchRetryCount: 0,
      flushAt: 1,
      flushInterval: 0,
    });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    (langfuse as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const tracker = new SdkDeliveryTracker();
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);
    for (let index = 0; index < 3; index += 1) {
      const observationId = `observation-${index}`;
      expect(tracker.begin("trace-byte-batch", observationId)).toBe(true);
      langfuse.generation({
        id: observationId,
        traceId: "trace-byte-batch",
        name: `llm-call-${index + 1}`,
        input: "i".repeat(MAX_PAYLOAD_BYTES),
        output: "o".repeat(MAX_PAYLOAD_BYTES),
        metadata: { payload: "m".repeat(MAX_PAYLOAD_BYTES) },
      });
    }
    const watermark = tracker.watermark("trace-byte-batch");

    await langfuse.flushAsync();

    await expect(tracker.awaitTrace("trace-byte-batch", watermark, 20)).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const requestBody = (call[1] as { body?: string } | undefined)?.body ?? "";
      const payload = JSON.parse(requestBody) as {
        batch?: Array<{ body?: unknown }>;
      };
      const queuedItem = payload.batch?.[0];
      expect(Buffer.byteLength(JSON.stringify(queuedItem?.body), "utf8")).toBeLessThanOrEqual(
        LANGFUSE_PLUGIN_EVENT_BODY_LIMIT_BYTES,
      );
      expect(Buffer.byteLength(requestBody, "utf8")).toBeLessThan(LANGFUSE_SDK_EVENT_LIMIT_BYTES);
    }
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("waits for every one-event automatic flush plus the explicit final flush", async () => {
    const langfuse = new Langfuse({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "http://langfuse.invalid",
      fetchRetryCount: 0,
      flushAt: 1,
      flushInterval: 0,
    });
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    (langfuse as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const tracker = new SdkDeliveryTracker();
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);
    for (let index = 0; index < 5; index += 1) {
      const observationId = `observation-${index}`;
      expect(tracker.begin("trace-count-batch", observationId)).toBe(true);
      langfuse.generation({
        id: observationId,
        traceId: "trace-count-batch",
        name: `llm-call-${index + 1}`,
      });
    }
    const watermark = tracker.watermark("trace-count-batch");

    await expect(
      flushSdkDeliveryThroughWatermark(langfuse, tracker, "trace-count-batch", watermark, 500),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("bounds a stalled SDK flush by the delivery deadline", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-stalled-flush", "observation-1");
    const watermark = tracker.watermark("trace-stalled-flush");
    const langfuse = {
      flushAsync: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const startedAt = Date.now();

    await expect(
      flushSdkDeliveryThroughWatermark(langfuse, tracker, "trace-stalled-flush", watermark, 20),
    ).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(langfuse.flushAsync).toHaveBeenCalledOnce();
  });

  it("matches identical observation ids to the trace carried by the SDK envelope", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-a", "shared-observation");
    tracker.begin("trace-b", "shared-observation");
    const firstWatermark = tracker.watermark("trace-a");
    const secondWatermark = tracker.watermark("trace-b");

    tracker.noteFlush([flushItem("trace-b", "shared-observation")]);

    await expect(tracker.awaitTrace("trace-b", secondWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    await expect(tracker.awaitTrace("trace-a", firstWatermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("does not guess a trace for a legacy flush item when the observation id is ambiguous", async () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-a", "shared-observation");
    tracker.begin("trace-b", "shared-observation");

    tracker.noteFlush([{ body: { id: "shared-observation" } }]);

    await expect(tracker.awaitTrace("trace-a", tracker.watermark("trace-a"), 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
    await expect(tracker.awaitTrace("trace-b", tracker.watermark("trace-b"), 20)).resolves.toEqual({
      ok: false,
      reason: "delivery timeout",
    });
  });

  it("keeps a retry failed when its failed callback arrives before the old success", async () => {
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    tracker.begin("trace-1", "observation-1");
    langfuse.flush();
    tracker.completeTrace("trace-1", { preservePending: true });

    expect(tracker.begin("trace-1", "observation-1")).toBe(true);
    const retryWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    expect(callbacks).toHaveLength(2);

    callbacks[1]?.(new Error("retry failed"), [flushItem("trace-1", "observation-1")]);
    callbacks[0]?.(undefined, [flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", retryWatermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("keeps a retry successful when its success callback arrives before the old failure", async () => {
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    tracker.begin("trace-1", "observation-1");
    langfuse.flush();
    tracker.completeTrace("trace-1", { preservePending: true });

    expect(tracker.begin("trace-1", "observation-1")).toBe(true);
    const retryWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    expect(callbacks).toHaveLength(2);

    callbacks[1]?.(undefined, [flushItem("trace-1", "observation-1")]);
    callbacks[0]?.(new Error("old request failed"), [flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", retryWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("drops an unmatched retired ticket after its callback and releases its capacity", async () => {
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    tracker.begin("trace-1", "observation-1");
    langfuse.flush();
    tracker.completeTrace("trace-1", { preservePending: true });

    expect(tracker.begin("trace-1", "observation-1")).toBe(true);
    const retryWatermark = tracker.watermark("trace-1");
    callbacks[0]?.(undefined, []);
    langfuse.flush();
    expect(callbacks).toHaveLength(2);
    callbacks[1]?.(undefined, [flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", retryWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    for (let index = 0; index < SDK_DELIVERY_MAX_TICKETS_PER_TRACE; index += 1) {
      expect(tracker.begin("trace-1", `capacity-observation-${index}`)).toBe(true);
    }
    expect(tracker.begin("trace-1", "capacity-over-limit")).toBe(false);
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("releases full trace capacity as production one-event callbacks settle", async () => {
    const tracker = new SdkDeliveryTracker();
    const items = Array.from({ length: SDK_DELIVERY_MAX_TICKETS_PER_TRACE }, (_, index) =>
      flushItem("trace-1", `capacity-observation-${index}`),
    );
    for (const item of items) {
      expect(tracker.begin(item.body.traceId, item.body.id)).toBe(true);
    }
    expect(tracker.begin("trace-1", "terminal-retry")).toBe(false);

    for (const item of items) {
      tracker.noteFlush([item]);
    }

    expect(tracker.begin("trace-1", "terminal-retry")).toBe(true);
  });

  it("expires retired in-flight tickets and releases per-trace capacity", () => {
    vi.useFakeTimers();
    try {
      const tracker = new SdkDeliveryTracker();
      tracker.begin("trace-1", "retired-observation");
      tracker.captureFlushScope();
      tracker.completeTrace("trace-1", { preservePending: true });

      for (let index = 0; index < SDK_DELIVERY_MAX_TICKETS_PER_TRACE - 1; index += 1) {
        expect(tracker.begin("trace-1", `observation-${index}`)).toBe(true);
      }
      expect(tracker.begin("trace-1", "observation-before-expiry")).toBe(false);

      vi.advanceTimersByTime(SDK_DELIVERY_TIMEOUT_MS);

      expect(tracker.begin("trace-1", "observation-after-expiry")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires retired in-flight tickets and releases active-trace capacity", () => {
    vi.useFakeTimers();
    try {
      const tracker = new SdkDeliveryTracker();
      for (let index = 0; index < SDK_DELIVERY_MAX_ACTIVE_TRACES; index += 1) {
        const traceId = `retired-trace-${index}`;
        tracker.begin(traceId, `observation-${index}`);
        tracker.captureFlushScope();
        tracker.completeTrace(traceId, { preservePending: true });
      }
      expect(tracker.begin("trace-before-expiry", "observation-before-expiry")).toBe(false);

      vi.advanceTimersByTime(SDK_DELIVERY_TIMEOUT_MS);

      expect(tracker.begin("trace-after-expiry", "observation-after-expiry")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an expired flush callback after the same IDs are retried", async () => {
    vi.useFakeTimers();
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    try {
      tracker.begin("trace-1", "observation-1");
      langfuse.flush();
      tracker.completeTrace("trace-1", { preservePending: true });
      vi.advanceTimersByTime(SDK_DELIVERY_TIMEOUT_MS);

      expect(tracker.begin("trace-1", "observation-1")).toBe(true);
      const retryWatermark = tracker.watermark("trace-1");
      langfuse.flush();
      expect(callbacks).toHaveLength(2);

      callbacks[0]?.(undefined, [flushItem("trace-1", "observation-1")]);
      vi.useRealTimers();
      await expect(tracker.awaitTrace("trace-1", retryWatermark, 20)).resolves.toEqual({
        ok: false,
        reason: "delivery timeout",
      });

      callbacks[1]?.(undefined, [flushItem("trace-1", "observation-1")]);
      await expect(tracker.awaitTrace("trace-1", retryWatermark, 20)).resolves.toEqual({
        ok: true,
      });
    } finally {
      vi.useRealTimers();
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });

  it("does not retain an ownerless pending ticket against the per-trace limit", () => {
    const tracker = new SdkDeliveryTracker();
    tracker.begin("trace-1", "abandoned-observation");
    tracker.completeTrace("trace-1", { preservePending: true });

    for (let index = 0; index < SDK_DELIVERY_MAX_TICKETS_PER_TRACE; index += 1) {
      expect(tracker.begin("trace-1", `observation-${index}`)).toBe(true);
    }
    expect(tracker.begin("trace-1", "observation-over-limit")).toBe(false);
  });

  it("does not retain ownerless pending tickets against the active-trace limit", () => {
    const tracker = new SdkDeliveryTracker();
    for (let index = 0; index < SDK_DELIVERY_MAX_ACTIVE_TRACES; index += 1) {
      const traceId = `retired-trace-${index}`;
      tracker.begin(traceId, `observation-${index}`);
      tracker.completeTrace(traceId, { preservePending: true });
    }

    expect(tracker.begin("trace-after-retirements", "observation-after-retirements")).toBe(true);
  });

  it("flushes existing traces when a new trace has no delivery watermark yet", async () => {
    const tracker = new SdkDeliveryTracker();
    const queuedItems = Array.from({ length: SDK_DELIVERY_MAX_ACTIVE_TRACES }, (_, index) => {
      const traceId = `trace-${index}`;
      const observationId = `observation-${index}`;
      expect(tracker.begin(traceId, observationId)).toBe(true);
      return flushItem(traceId, observationId);
    });
    expect(tracker.begin("trace-over-cap", "observation-over-cap")).toBe(false);
    const firstQueuedItem = queuedItems[0];
    const langfuse = {
      flush: vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
        callback?.(undefined, firstQueuedItem ? [firstQueuedItem] : []);
      }),
      flushAsync: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          langfuse.flush(() => resolve());
        });
      }),
    };
    const cleanups = bindSdkDeliveryTracker(langfuse as unknown as Langfuse, tracker);

    await expect(flushSdkDeliveryForBackpressure(langfuse, tracker, 100)).resolves.toEqual({
      ok: true,
    });
    expect(langfuse.flushAsync).toHaveBeenCalledOnce();
    expect(tracker.begin("trace-after-flush", "observation-after-flush")).toBe(true);
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("settles overlapping flushes for one observation when the second callback wins the race", async () => {
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    tracker.begin("trace-1", "observation-1");
    const firstWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    tracker.begin("trace-1", "observation-1");
    const secondWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    expect(callbacks).toHaveLength(2);

    callbacks[1]?.(undefined, [flushItem("trace-1", "observation-1")]);
    callbacks[0]?.(undefined, [flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", firstWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    await expect(tracker.awaitTrace("trace-1", secondWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("keeps overlapping flush failure assigned to the second ticket", async () => {
    const tracker = new SdkDeliveryTracker();
    const callbacks: Array<(error?: unknown, items?: unknown) => void> = [];
    const originalFlush = vi.fn((callback?: (error?: unknown, items?: unknown) => void) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const langfuse = { flush: originalFlush } as unknown as Langfuse;
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);

    tracker.begin("trace-1", "observation-1");
    const firstWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    tracker.begin("trace-1", "observation-1");
    const secondWatermark = tracker.watermark("trace-1");
    langfuse.flush();
    expect(callbacks).toHaveLength(2);

    callbacks[1]?.(new Error("second flush failed"), [flushItem("trace-1", "observation-1")]);
    callbacks[0]?.(undefined, [flushItem("trace-1", "observation-1")]);

    await expect(tracker.awaitTrace("trace-1", firstWatermark, 20)).resolves.toEqual({
      ok: true,
    });
    await expect(tracker.awaitTrace("trace-1", secondWatermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("treats HTTP 207 item errors from the installed SDK as delivery failure", async () => {
    const langfuse = new Langfuse({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "http://langfuse.invalid",
      fetchRetryCount: 0,
      flushAt: 100,
      flushInterval: 0,
    });
    const fetchMock = vi.fn(async () => ({
      status: 207,
      json: async () => ({ errors: [{ id: "event-1", message: "rejected" }] }),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    (langfuse as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    const tracker = new SdkDeliveryTracker();
    const cleanups = bindSdkDeliveryTracker(langfuse, tracker);
    tracker.begin("trace-207", "observation-207");
    langfuse.generation({
      id: "observation-207",
      traceId: "trace-207",
      name: "llm-call-1",
      model: "test-model",
    });
    const watermark = tracker.watermark("trace-207");

    await langfuse.flushAsync();

    await expect(tracker.awaitTrace("trace-207", watermark, 20)).resolves.toEqual({
      ok: false,
      reason: "delivery failed",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    for (const cleanup of cleanups) {
      cleanup();
    }
  });

  it("bounds active trace and per-trace ticket state", () => {
    const tracker = new SdkDeliveryTracker();
    for (let index = 0; index < SDK_DELIVERY_MAX_ACTIVE_TRACES; index += 1) {
      expect(tracker.begin(`trace-${index}`, `observation-${index}`)).toBe(true);
    }
    expect(tracker.begin("trace-over-cap", "observation-over-cap")).toBe(false);

    tracker.completeTrace("trace-0");
    expect(tracker.begin("trace-after-completion", "observation-after-completion")).toBe(true);

    const perTraceTracker = new SdkDeliveryTracker();
    for (let index = 0; index < SDK_DELIVERY_MAX_TICKETS_PER_TRACE; index += 1) {
      expect(perTraceTracker.begin("trace-1", `observation-${index}`)).toBe(true);
    }
    expect(perTraceTracker.begin("trace-1", "observation-over-cap")).toBe(false);
  });

  it("does not consume active-trace slots after successful flushes without finalization", () => {
    const tracker = new SdkDeliveryTracker();
    for (let index = 0; index < SDK_DELIVERY_MAX_ACTIVE_TRACES; index += 1) {
      const traceId = `trace-${index}`;
      const observationId = `observation-${index}`;
      expect(tracker.begin(traceId, observationId)).toBe(true);
      tracker.noteFlush([flushItem(traceId, observationId)]);
    }

    expect(tracker.begin("trace-after-successes", "observation-after-successes")).toBe(true);
  });
});
