// Covers diagnostic event emission and metadata handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginInternalDiagnosticDeliveryIdentity,
  captureInternalDiagnosticDeliveryCursor,
  completeInternalDiagnosticDeliveryIdentity,
  failInternalDiagnosticDeliveryIdentity,
  waitForInternalDiagnosticDeliveryCursor,
} from "./diagnostic-delivery.js";
import {
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  emitTrustedSkillUsedDiagnosticEvent,
  emitTrustedSecurityEvent,
  formatDiagnosticTraceparentForPropagation,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  resolveTrustedDiagnosticModelContentCapturePolicy,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  function expectConsoleErrorPrefix(errorSpy: { mock: { calls: unknown[][] } }, prefix: string) {
    expect(errorSpy.mock.calls).toHaveLength(1);
    const [call] = errorSpy.mock.calls;
    if (!call) {
      throw new Error("expected console error call");
    }
    const [message] = call;
    expect(typeof message).toBe("string");
    expect((message as string).startsWith(prefix)).toBe(true);
  }

  it("emits monotonic seq and timestamps to subscribers", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(111).mockReturnValueOnce(222);
    const events: Array<{ seq: number; ts: number; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ seq: event.seq, ts: event.ts, type: event.type });
    });

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
    });
    emitDiagnosticEvent({
      type: "session.state",
      state: "processing",
    });
    stop();

    expect(events).toEqual([
      { seq: 1, ts: 111, type: "model.usage" },
      { seq: 2, ts: 222, type: "session.state" },
    ]);
  });

  it("isolates listener failures and logs them", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onDiagnosticEvent(() => {
      throw new Error("boom");
    });
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
    });

    expect(seen).toEqual(["message.queued"]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: Error: boom",
    );
  });

  it("isolates async listener failures and still drains the queue", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onInternalDiagnosticEvent(async () => {
      throw new Error("async boom");
    });
    onInternalDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-async-error",
      callId: "call-async-error",
      provider: "openai",
      model: "gpt-5.5",
    });
    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual(["model.call.started"]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.started seq=1: Error: async boom",
    );
  });

  it("supports unsubscribe and full reset", () => {
    const seen: string[] = [];
    const stop = onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    stop();
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
    });

    expect(seen).toEqual(["webhook.received"]);

    resetDiagnosticEventsForTest();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      error: "failed",
    });
    expect(seen).toEqual(["webhook.received"]);
  });

  it("carries explicit trace context without creating retained trace state", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });
    stop();
    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });

    expect(events).toEqual([{ trace, type: "message.queued" }]);
  });

  it("uses active request trace context when events omit explicit trace", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const explicitTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    runWithDiagnosticTraceContext(trace, () => {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
      });
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
        trace: explicitTrace,
      });
    });
    stop();

    expect(events).toEqual([
      { trace, type: "message.queued" },
      { trace: explicitTrace, type: "message.queued" },
    ]);
  });

  it("marks dispatcher provenance separately from trust", async () => {
    const events: Array<{
      internal: boolean;
      metadataTrusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        internal: isInternalDiagnosticEventMetadata(metadata),
        metadataTrusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });
    emitInternalDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual([
      { internal: false, metadataTrusted: false, type: "message.queued" },
      { internal: true, metadataTrusted: false, type: "webhook.received" },
      { internal: false, metadataTrusted: true, type: "model.call.started" },
    ]);
    expect(isInternalDiagnosticEventMetadata({ trusted: false })).toBe(false);
  });

  it("formats traceparent for propagation only from dispatcher-trusted metadata", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const traceparents: Array<string | undefined> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      traceparents.push(formatDiagnosticTraceparentForPropagation(event, metadata));
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
      trace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
      trace,
    });

    expect(traceparents).toEqual([undefined, `00-${trace.traceId}-${trace.spanId}-01`]);
    expect(formatDiagnosticTraceparentForPropagation({ trace }, { trusted: true })).toBeUndefined();
    expect(
      formatDiagnosticTraceparentForPropagation(
        { trace },
        { trusted: false, trustedTraceContext: true },
      ),
    ).toBeUndefined();
  });

  it("shares diagnostic state across duplicate module instances", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    vi.resetModules();
    const duplicateModule = (await import(
      /* @vite-ignore */ new URL("./diagnostic-events.ts?duplicate", import.meta.url).href
    )) as typeof import("./diagnostic-events.js");
    duplicateModule.emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(events).toEqual(["message.queued"]);
  });

  it("does not expose mutable diagnostic state on the obsolete global symbol", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const events: boolean[] = [];
    globalStore[Symbol.for("openclaw.diagnosticEventsState")] = {
      listeners: new Set([() => events.push(true)]),
    };
    onInternalDiagnosticEvent((eventValue, metadata) => {
      events.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual([false]);
    delete globalStore[Symbol.for("openclaw.diagnosticEventsState")];
  });

  it("keeps trusted internal events off the public diagnostic stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: Array<{ trusted: boolean; type: string }> = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({ trusted: metadata.trusted, type: event.type });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([{ trusted: true, type: "model.call.started" }]);
  });

  it.each([true, false])(
    "keeps skill file identity trusted-only when diagnostics enabled=%s",
    async (enabled) => {
      const skillFile = "/workspace/skills/daily-brief/SKILL.md";
      const publicEvents: DiagnosticEventPayload[] = [];
      const sharedEvents: DiagnosticEventPayload[] = [];
      const trustedEvents: Array<{
        event: DiagnosticEventPayload;
        privateData: DiagnosticEventPrivateData;
      }> = [];
      onDiagnosticEvent((event) => publicEvents.push(event));
      onInternalDiagnosticEvent((event) => {
        sharedEvents.push(event);
      });
      onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
        trustedEvents.push({ event, privateData });
      });
      setDiagnosticsEnabledForProcess(enabled);

      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "Daily Brief",
          skillSource: "workspace",
          activation: "read",
        },
        { skillUsage: { skillFile } },
      );
      await waitForDiagnosticEventsDrained();

      expect(JSON.stringify(publicEvents)).not.toContain(skillFile);
      expect(JSON.stringify(sharedEvents)).not.toContain(skillFile);
      expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain(skillFile);
      expect(trustedEvents).toHaveLength(1);
      expect(trustedEvents[0]?.event).not.toHaveProperty("skillFile");
      expect(trustedEvents[0]?.privateData.skillUsage?.skillFile).toBe(skillFile);
    },
  );

  it("emits canonical security events only through the trusted security helper", () => {
    const internalEvents: Array<{
      action?: string;
      eventId?: string;
      trusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({
        action: event.type === "security.event" ? event.action : undefined,
        eventId: event.type === "security.event" ? event.eventId : undefined,
        trusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "security.event",
      eventId: "untrusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitDiagnosticEvent>[0]);
    emitTrustedDiagnosticEvent({
      type: "security.event",
      eventId: "generic-trusted-security-event",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    } as unknown as Parameters<typeof emitTrustedDiagnosticEvent>[0]);
    emitTrustedSecurityEvent({
      eventId: "security-event-1",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
    });

    expect(internalEvents).toEqual([
      {
        action: "tool.execution.blocked",
        eventId: "security-event-1",
        trusted: true,
        type: "security.event",
      },
    ]);
  });

  it("keeps trusted security events off the public diagnostic stream", () => {
    const publicEvents: string[] = [];
    const internalEvents: Array<{ trusted: boolean; type: string }> = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({ trusted: metadata.trusted, type: event.type });
    });

    emitTrustedSecurityEvent({
      eventId: "security-event-public-filter",
      category: "auth",
      action: "gateway.auth.failed",
      outcome: "failure",
      severity: "medium",
    });

    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([{ trusted: true, type: "security.event" }]);
  });

  it("isolates diagnostic metadata from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: boolean[] = [];
    onInternalDiagnosticEvent((eventValue, metadata) => {
      (metadata as { trusted: boolean }).trusted = true;
    });
    onInternalDiagnosticEvent((eventValue, metadata) => {
      seen.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(seen).toEqual([false]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: TypeError",
    );
  });

  it("isolates trusted event trace context from listener mutation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const seen: Array<{ traceId: string | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      (event.trace as { traceId: string }).traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });
    onInternalDiagnosticEvent((event, metadata) => {
      seen.push({ traceId: event.trace?.traceId, trusted: metadata.trusted });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      trace,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual([{ traceId: trace.traceId, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.started seq=1: TypeError",
    );
  });

  it("isolates nested diagnostic payloads from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: Array<{ total: number | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        event.usage.total = 0;
      }
    });
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.usage") {
        seen.push({ total: event.usage.total, trusted: metadata.trusted });
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 42 },
    });

    expect(seen).toEqual([{ total: 42, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.usage seq=1: TypeError",
    );
  });

  it("drops prototype-pollution keys during event enrichment", () => {
    const eventInput = Object.assign(Object.create(null), {
      type: "message.queued",
      source: "plugin",
      constructor: "blocked",
      prototype: "blocked",
    }) as Parameters<typeof emitDiagnosticEvent>[0] & Record<string, unknown>;
    Object.defineProperty(eventInput, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent(eventInput);

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "prototype")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("dispatches high-frequency tool and model lifecycle events asynchronously", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    emitDiagnosticEvent({
      type: "tool.execution.started",
      toolName: "read",
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toEqual(["tool.execution.started", "model.call.started"]);
  });

  it("yields between large high-frequency diagnostic event bursts", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(100);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(200);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(events).toHaveLength(250);
  });

  it("waits for all queued high-frequency diagnostic events to drain", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await waitForDiagnosticEventsDrained();

    expect(events).toHaveLength(250);
  });

  it("reports pending async diagnostic events before they drain", async () => {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-pending",
      toolName: "exec",
      toolCallId: "call-pending",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-pending",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    expect(
      hasPendingInternalDiagnosticEvent((event) => event.type === "tool.execution.error"),
    ).toBe(false);
  });

  it("waits for async trusted listeners before reporting the queue drained", async () => {
    let releaseListener: (() => void) | undefined;
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    let listenerCompleted = false;
    let drainCompleted = false;

    onTrustedInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed") {
        return;
      }
      await listenerGate;
      listenerCompleted = true;
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-async-listener",
      callId: "call-async-listener",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });

    const drainPromise = waitForDiagnosticEventsDrained().then(() => {
      drainCompleted = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    try {
      expect(listenerCompleted).toBe(false);
      expect(drainCompleted).toBe(false);
    } finally {
      releaseListener?.();
      await drainPromise;
    }

    expect(listenerCompleted).toBe(true);
    expect(drainCompleted).toBe(true);
  });

  it("waits only for accepted deliveries matching a trace/run cursor", async () => {
    const trace = createDiagnosticTraceContext({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
    });
    let releaseMatching: (() => void) | undefined;
    const matchingGate = new Promise<void>((resolve) => {
      releaseMatching = resolve;
    });
    let releaseUnrelated: (() => void) | undefined;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    let cursorDrained = false;

    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed") {
        return;
      }
      if (event.runId === "run-current") {
        await matchingGate;
        return;
      }
      if (event.runId === "run-unrelated") {
        await unrelatedGate;
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-current",
      callId: "call-current",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
      trace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-unrelated",
      callId: "call-unrelated",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
      trace: createDiagnosticTraceContext({
        traceId: "3".repeat(32),
        spanId: "4".repeat(16),
      }),
    });

    const cursor = captureInternalDiagnosticDeliveryCursor({
      traceId: trace.traceId,
      runId: "run-current",
    });
    const drainPromise = waitForInternalDiagnosticDeliveryCursor(cursor).then((result) => {
      cursorDrained = result.ok;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(cursorDrained).toBe(false);
    releaseMatching?.();
    await expect(drainPromise).resolves.toMatchObject({ ok: true });
    expect(cursorDrained).toBe(true);

    releaseUnrelated?.();
    await waitForDiagnosticEventsDrained();
  });

  it("serializes and drains run-scoped and runless events for one session", async () => {
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let releaseUnrelated: (() => void) | undefined;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    const delivered: string[] = [];

    onInternalDiagnosticEvent(async (event) => {
      if (!("sessionKey" in event)) {
        return;
      }
      if (event.sessionKey === "session-current") {
        if (event.type === "model.call.started") {
          delivered.push("provider:start");
          await providerGate;
          delivered.push("provider:end");
          return;
        }
        if (event.type === "model.usage") {
          delivered.push("usage");
        }
        return;
      }
      if (event.sessionKey === "session-unrelated") {
        delivered.push("unrelated:start");
        await unrelatedGate;
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-current",
      sessionKey: "session-current",
      callId: "call-current",
      provider: "openai",
      model: "gpt-5.5",
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "session-current",
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 1, output: 1, total: 2 },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-unrelated",
      sessionKey: "session-unrelated",
      callId: "call-unrelated",
      provider: "openai",
      model: "gpt-5.5",
    });

    const cursor = captureInternalDiagnosticDeliveryCursor({
      sessionKey: "session-current",
    });
    let cursorDrained = false;
    const drainPromise = waitForInternalDiagnosticDeliveryCursor(cursor).then((result) => {
      cursorDrained = result.ok;
      return result;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(delivered).toEqual(["provider:start", "unrelated:start"]);
    expect(cursorDrained).toBe(false);

    releaseProvider?.();
    await expect(drainPromise).resolves.toMatchObject({ ok: true, deliveredEvents: 2 });
    expect(delivered).toEqual(["provider:start", "unrelated:start", "provider:end", "usage"]);

    releaseUnrelated?.();
    await waitForDiagnosticEventsDrained();
  });

  it("captures a cursor before dispatch and still waits for matching async queue delivery", async () => {
    const delivered: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.started") {
        delivered.push(event.callId);
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-cursor-before-dispatch",
      callId: "call-cursor-before-dispatch",
      provider: "openai",
      model: "gpt-5.5",
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-cursor-before-dispatch",
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
    expect(delivered).toEqual(["call-cursor-before-dispatch"]);
  });

  it("times out a trace/run cursor without waiting for unrelated backlog", async () => {
    let releaseUnrelated: (() => void) | undefined;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.completed" && event.runId === "run-unrelated-timeout") {
        await unrelatedGate;
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-unrelated-timeout",
      callId: "call-unrelated-timeout",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-no-events" });

    await expect(
      waitForInternalDiagnosticDeliveryCursor(cursor, { timeoutMs: 1 }),
    ).resolves.toEqual({
      ok: true,
      deliveredEvents: 0,
    });

    releaseUnrelated?.();
    await waitForDiagnosticEventsDrained();
  });

  it("rejects listener work before invoke when cursor tracking exceeds the pending cap", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let seen = 0;
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed" || event.runId !== "run-cursor-cap") {
        return;
      }
      seen += 1;
      if (seen === 1) {
        await firstGate;
      }
    });

    for (let index = 0; index < 8_193; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "model.call.completed",
        runId: "run-cursor-cap",
        callId: `call-cursor-cap-${index}`,
        provider: "openai",
        model: "gpt-5.5",
        durationMs: 1,
      });
    }
    const cursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-cursor-cap" });

    await expect(
      waitForInternalDiagnosticDeliveryCursor(cursor, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "cap_exhausted",
    });

    releaseFirst?.();
    await waitForDiagnosticEventsDrained();
    expect(seen).toBe(8_192);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener queue saturated type=model.call.completed seq=8193",
    );
  });

  it("does not fail a current cursor when an unrelated identity exceeds the pending cap", async () => {
    let releaseCurrent: (() => void) | undefined;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    let releaseUnrelated: (() => void) | undefined;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed") {
        return;
      }
      if (event.runId === "run-current-cap-isolation") {
        await currentGate;
        return;
      }
      if (event.runId === "run-unrelated-cap-isolation") {
        await unrelatedGate;
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-current-cap-isolation",
      callId: "call-current-cap-isolation",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    for (let index = 0; index < 8_193; index += 1) {
      emitTrustedDiagnosticEvent({
        type: "model.call.completed",
        runId: "run-unrelated-cap-isolation",
        callId: `call-unrelated-cap-isolation-${index}`,
        provider: "openai",
        model: "gpt-5.5",
        durationMs: 1,
      });
    }
    const cursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-current-cap-isolation",
    });
    const drainPromise = waitForInternalDiagnosticDeliveryCursor(cursor, {
      timeoutMs: 1_000,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    releaseCurrent?.();
    await expect(drainPromise).resolves.toMatchObject({
      ok: true,
    });

    releaseUnrelated?.();
    await waitForDiagnosticEventsDrained();
  });

  it("does not wait for an earlier unrelated listener lane", async () => {
    let releaseUnrelated: (() => void) | undefined;
    const unrelatedGate = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    const delivered: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed") {
        return;
      }
      if (event.runId === "run-earlier-unrelated") {
        await unrelatedGate;
        return;
      }
      if (event.runId === "run-current-independent") {
        delivered.push(event.callId);
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-earlier-unrelated",
      callId: "call-earlier-unrelated",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-current-independent",
      callId: "call-current-independent",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-current-independent",
    });

    await expect(
      waitForInternalDiagnosticDeliveryCursor(cursor, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ ok: true });
    expect(delivered).toEqual(["call-current-independent"]);

    releaseUnrelated?.();
    await waitForDiagnosticEventsDrained();
  });

  it("evicts settled cursor delivery state after scoped drain", async () => {
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      deliveryCursorCapExhaustedRecords: Map<unknown, unknown>;
      deliveryCursorRecords: Map<unknown, unknown>;
    };
    const delivered: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.completed") {
        delivered.push(event.callId);
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-cursor-evict",
      callId: "call-cursor-evict",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-cursor-evict",
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });

    expect(delivered).toEqual(["call-cursor-evict"]);
    expect(state.deliveryCursorRecords.size).toBe(0);
    expect(state.deliveryCursorCapExhaustedRecords.size).toBe(0);
  });

  it("matches a full cursor when an event carries only shared run and session aliases", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.completed" && event.runId === "run-alias-match") {
        await gate;
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-alias-match",
      sessionId: "session-id-alias-match",
      callId: "call-alias-match",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-alias-match",
      sessionKey: "session-key-alias-match",
      sessionId: "session-id-alias-match",
    });
    let settled = false;
    const waiting = waitForInternalDiagnosticDeliveryCursor(cursor).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(waiting).resolves.toMatchObject({ ok: true });
  });

  it("hydrates active delivery identities preserved by a legacy hot reload", () => {
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      activeDeliveryIdentities?: Map<unknown, unknown>;
    };
    state.activeDeliveryIdentities = undefined;

    beginInternalDiagnosticDeliveryIdentity({ runId: "run-hot-reload" });

    const hydratedState = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      activeDeliveryIdentities?: Map<unknown, unknown>;
    };
    expect(hydratedState.activeDeliveryIdentities).toBeInstanceOf(Map);
    expect(hydratedState.activeDeliveryIdentities?.size).toBe(1);
    completeInternalDiagnosticDeliveryIdentity({ runId: "run-hot-reload" });
    expect(hydratedState.activeDeliveryIdentities?.size).toBe(0);
  });

  it("keeps a matching listener failure sticky until the run identity completes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    beginInternalDiagnosticDeliveryIdentity({ runId: "run-listener-failure" });
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.completed" && event.runId === "run-listener-failure") {
        throw new Error("listener failed");
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-listener-failure",
      callId: "call-listener-failure",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-listener-success",
      callId: "call-listener-success",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const successCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-listener-success",
    });
    const failureCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-listener-failure",
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(successCursor)).resolves.toMatchObject({
      ok: true,
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(failureCursor)).resolves.toMatchObject({
      ok: false,
      reason: "listener_failure",
    });
    nowSpy.mockReturnValue(10 * 60 * 1_000);
    await expect(waitForInternalDiagnosticDeliveryCursor(failureCursor)).resolves.toMatchObject({
      ok: false,
      reason: "listener_failure",
    });

    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as { deliveryCursorListenerFailureRecords: Map<unknown, unknown> };
    expect(state.deliveryCursorListenerFailureRecords.size).toBe(1);

    completeInternalDiagnosticDeliveryIdentity({ runId: "run-listener-failure" });
    expect(state.deliveryCursorListenerFailureRecords.size).toBe(0);
    await expect(waitForInternalDiagnosticDeliveryCursor(failureCursor)).resolves.toMatchObject({
      ok: true,
    });
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.completed",
    );
  });

  it("keeps an incomplete producer sticky and scoped until the run identity completes", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const failedCursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-incomplete" });
    const unrelatedCursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-complete" });

    beginInternalDiagnosticDeliveryIdentity({ runId: "run-incomplete" });
    failInternalDiagnosticDeliveryIdentity({ runId: "run-incomplete" });

    nowSpy.mockReturnValue(10 * 60 * 1_000);
    await expect(waitForInternalDiagnosticDeliveryCursor(failedCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(unrelatedCursor)).resolves.toMatchObject({
      ok: true,
    });

    completeInternalDiagnosticDeliveryIdentity({ runId: "run-incomplete" });
    await expect(waitForInternalDiagnosticDeliveryCursor(failedCursor)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("keeps delivery failures until the final reference-counted identity owner completes", async () => {
    const identity = { runId: "run-reference-counted" };
    beginInternalDiagnosticDeliveryIdentity(identity);
    beginInternalDiagnosticDeliveryIdentity(identity);
    failInternalDiagnosticDeliveryIdentity(identity);
    const cursor = captureInternalDiagnosticDeliveryCursor(identity);

    completeInternalDiagnosticDeliveryIdentity(identity);

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    completeInternalDiagnosticDeliveryIdentity(identity);
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("keeps a session failure while another run in that session remains active", async () => {
    const sessionKey = "session-overlapping-runs";
    const firstIdentity = { runId: "run-overlap-first", sessionKey };
    const secondIdentity = { runId: "run-overlap-second", sessionKey };
    beginInternalDiagnosticDeliveryIdentity(firstIdentity);
    beginInternalDiagnosticDeliveryIdentity(secondIdentity);
    failInternalDiagnosticDeliveryIdentity({ sessionKey });
    const cursor = captureInternalDiagnosticDeliveryCursor({ sessionKey });

    completeInternalDiagnosticDeliveryIdentity(firstIdentity);

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    completeInternalDiagnosticDeliveryIdentity(secondIdentity);
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("matches a run-scoped producer failure from a session cursor", async () => {
    const identity = {
      runId: "run-session-incomplete",
      sessionKey: "session-incomplete",
      sessionId: "session-id-incomplete",
    };
    const cursor = captureInternalDiagnosticDeliveryCursor({
      sessionKey: identity.sessionKey,
    });

    failInternalDiagnosticDeliveryIdentity(identity);

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    completeInternalDiagnosticDeliveryIdentity(identity);
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("does not apply an earlier run failure to a later full cursor in the same session", async () => {
    const sharedSession = {
      sessionKey: "session-shared-after-failure",
      sessionId: "session-id-shared-after-failure",
    };
    const failedIdentity = { ...sharedSession, runId: "run-earlier-failure" };
    failInternalDiagnosticDeliveryIdentity(failedIdentity);
    const laterCursor = captureInternalDiagnosticDeliveryCursor({
      ...sharedSession,
      runId: "run-later-success",
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(laterCursor)).resolves.toMatchObject({
      ok: true,
    });

    completeInternalDiagnosticDeliveryIdentity(failedIdentity);
  });

  it("clears a runless session failure from a completed run identity", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const identity = {
      runId: "run-session-listener-failure",
      sessionKey: "session-listener-failure",
      sessionId: "session-id-listener-failure",
    };
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.usage" && event.sessionKey === identity.sessionKey) {
        throw new Error("runless listener failed");
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 1, output: 1, total: 2 },
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({
      sessionKey: identity.sessionKey,
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "listener_failure",
    });

    completeInternalDiagnosticDeliveryIdentity(identity);
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
    expectConsoleErrorPrefix(errorSpy, "[diagnostic-events] listener error type=model.usage");
  });

  it("clears a full identity failure from a partial completion identity", async () => {
    const identity = {
      traceId: "5".repeat(32),
      runId: "run-partial-completion",
      sessionKey: "session-partial-completion",
      sessionId: "session-id-partial-completion",
    };
    const cursor = captureInternalDiagnosticDeliveryCursor({ runId: identity.runId });

    failInternalDiagnosticDeliveryIdentity(identity);
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    completeInternalDiagnosticDeliveryIdentity({ runId: identity.runId });
    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("drains accepted listener work before returning a producer failure", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.completed" || event.runId !== "run-failed-drain") {
        return;
      }
      await gate;
      delivered.push(event.callId);
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-failed-drain",
      callId: "call-failed-drain",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    failInternalDiagnosticDeliveryIdentity({ runId: "run-failed-drain" });
    const cursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-failed-drain" });
    let settled = false;
    const drain = waitForInternalDiagnosticDeliveryCursor(cursor, { timeoutMs: 1_000 }).finally(
      () => {
        settled = true;
      },
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    release?.();

    await expect(drain).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    expect(delivered).toEqual(["call-failed-drain"]);
  });

  it("waits on matching listener tasks without spinning setImmediate", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.completed" && event.runId === "run-cursor-wait") {
        await gate;
      }
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-cursor-wait",
      callId: "call-cursor-wait",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });
    const cursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-cursor-wait" });
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate");

    const drain = waitForInternalDiagnosticDeliveryCursor(cursor, { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(setImmediateSpy).not.toHaveBeenCalled();
    release?.();

    await expect(drain).resolves.toMatchObject({ ok: true });
    setImmediateSpy.mockRestore();
  });

  it("bounds failure overflow and releases its conservative marker after retention", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const identities = Array.from({ length: 8_193 }, (_, index) => ({
      runId: `run-failure-overflow-${index}`,
    }));
    beginInternalDiagnosticDeliveryIdentity(identities[0]!);
    beginInternalDiagnosticDeliveryIdentity(identities[8_192]!);
    for (const identity of identities) {
      failInternalDiagnosticDeliveryIdentity(identity);
    }
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      deliveryCursorProducerFailureRecords: Map<unknown, unknown>;
      deliveryCursorProducerFailureOverflow?: unknown;
    };
    expect(state.deliveryCursorProducerFailureRecords.size).toBe(8_192);
    expect(state.deliveryCursorProducerFailureOverflow).toBeDefined();
    nowSpy.mockReturnValue(10 * 60 * 1_000);

    const overflowCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-failure-overflow-8192",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(overflowCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    const oldestCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-failure-overflow-0",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(oldestCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    completeInternalDiagnosticDeliveryIdentity({ runId: "run-unrelated-healthy" });
    await expect(waitForInternalDiagnosticDeliveryCursor(overflowCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    const unrelatedCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-unrelated-healthy",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(unrelatedCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });

    for (const identity of identities) {
      completeInternalDiagnosticDeliveryIdentity(identity);
    }

    const freshCursor = captureInternalDiagnosticDeliveryCursor({ runId: "run-after-overflow" });
    await expect(waitForInternalDiagnosticDeliveryCursor(freshCursor)).resolves.toMatchObject({
      ok: true,
    });
    nowSpy.mockRestore();
  });

  it("preserves event order for each async listener without blocking unrelated listeners", async () => {
    let releaseStarted: (() => void) | undefined;
    const startedGate = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const orderedListenerEvents: string[] = [];
    const independentListenerEvents: string[] = [];

    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.started") {
        orderedListenerEvents.push("started:begin");
        await startedGate;
        orderedListenerEvents.push("started:end");
        return;
      }
      if (event.type === "model.call.completed") {
        orderedListenerEvents.push("completed");
      }
    });
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.started" || event.type === "model.call.completed") {
        independentListenerEvents.push(event.type);
      }
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-ordered-listener",
      callId: "call-ordered-listener",
      provider: "openai",
      model: "gpt-5.5",
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-ordered-listener",
      callId: "call-ordered-listener",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(orderedListenerEvents).toEqual(["started:begin"]);
    expect(independentListenerEvents).toEqual(["model.call.started", "model.call.completed"]);

    releaseStarted?.();
    await waitForDiagnosticEventsDrained();

    expect(orderedListenerEvents).toEqual(["started:begin", "started:end", "completed"]);
  });

  it("preserves listener order across shared diagnostic identity aliases", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.started" && event.type !== "model.call.completed") {
        return;
      }
      if (event.runId === "run-shared-alias" && event.type === "model.call.started") {
        seen.push("shared:start");
        await firstGate;
        seen.push("shared:end");
        return;
      }
      if (event.runId === "run-shared-alias") {
        seen.push("shared:completed");
        return;
      }
      if (event.runId === "run-unrelated-alias") {
        seen.push("unrelated");
      }
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-shared-alias",
      callId: "call-shared-alias",
      provider: "openai",
      model: "gpt-5.5",
      trace: createDiagnosticTraceContext({
        traceId: "6".repeat(32),
        spanId: "7".repeat(16),
      }),
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-shared-alias",
      sessionKey: "session-shared-alias",
      sessionId: "session-id-shared-alias",
      callId: "call-shared-alias",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
      trace: createDiagnosticTraceContext({
        traceId: "8".repeat(32),
        spanId: "9".repeat(16),
      }),
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-unrelated-alias",
      sessionKey: "session-unrelated-alias",
      callId: "call-unrelated-alias",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual(["shared:start", "unrelated"]);

    releaseFirst?.();
    await waitForDiagnosticEventsDrained();
    expect(seen).toEqual(["shared:start", "unrelated", "shared:end", "shared:completed"]);
  });

  it("cleans lane counters when a related event adds an earlier alias", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const traceId = "a".repeat(32);
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.started") {
        await firstGate;
      }
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-later-alias",
      callId: "call-later-alias-started",
      provider: "openai",
      model: "gpt-5.5",
      trace: createDiagnosticTraceContext({
        traceId,
        spanId: "b".repeat(16),
      }),
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-earlier-alias",
      callId: "call-later-alias-completed",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
      trace: createDiagnosticTraceContext({
        traceId,
        spanId: "c".repeat(16),
      }),
    });

    releaseFirst?.();
    await waitForDiagnosticEventsDrained();

    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      listenerTaskBytes: Map<unknown, unknown>;
      listenerTaskDepths: Map<unknown, unknown>;
      listenerTasks: Map<unknown, unknown>;
    };
    expect(state.listenerTasks.size).toBe(0);
    expect(state.listenerTaskDepths.size).toBe(0);
    expect(state.listenerTaskBytes.size).toBe(0);
  });

  it("snapshots queued listener payloads before the prior listener task settles", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: Array<{ traceId: string | undefined; inputMessages: unknown }> = [];
    onTrustedInternalDiagnosticEvent(
      async (event, _metadata, privateData) => {
        if (event.type !== "model.call.started") {
          return;
        }
        if (event.callId === "call-first") {
          await firstGate;
          return;
        }
        seen.push({
          traceId: event.trace?.traceId,
          inputMessages: privateData.modelContent?.inputMessages,
        });
      },
      { captureModelContent: { inputMessages: true } },
    );

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-snapshot",
      callId: "call-first",
      provider: "openai",
      model: "gpt-5.5",
    });
    const event = {
      type: "model.call.started" as const,
      runId: "run-snapshot",
      callId: "call-second",
      provider: "openai",
      model: "gpt-5.5",
      trace: { traceId: "1".repeat(32), spanId: "2".repeat(16) },
    };
    const privateData: DiagnosticEventPrivateData = {
      modelContent: { inputMessages: [{ role: "user", content: "before" }] },
    };
    emitTrustedDiagnosticEventWithPrivateData(event, privateData);

    event.trace.traceId = "3".repeat(32);
    const inputMessages = privateData.modelContent?.inputMessages as Array<{
      content: string;
    }>;
    inputMessages[0]!.content = "after";

    releaseFirst?.();
    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual([
      {
        traceId: "1".repeat(32),
        inputMessages: [{ role: "user", content: "before" }],
      },
    ]);
  });

  it("bounds the pending task chain for a stalled async listener", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let seen = 0;
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.usage") {
        return;
      }
      seen += 1;
      if (seen === 1) {
        await firstGate;
      }
    });

    for (let index = 0; index <= 10_000; index += 1) {
      emitDiagnosticEvent({
        type: "model.usage",
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: index + 1 },
      });
    }

    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener queue saturated type=model.usage seq=8193",
    );
    releaseFirst?.();
    await waitForDiagnosticEventsDrained();
    expect(seen).toBe(8_192);
  });

  it("bounds retained bytes for a stalled async listener queue", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: number[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.usage") {
        return;
      }
      seen.push(event.usage.input ?? 0);
      if (event.usage.input === 1) {
        await firstGate;
      }
    });

    const largeModelName = "x".repeat(9 * 1024 * 1024);
    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: "small",
      usage: { input: 1 },
    });
    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: largeModelName,
      usage: { input: 2 },
    });
    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: largeModelName,
      usage: { input: 3 },
    });
    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: "small-after-drop",
      usage: { input: 4 },
    });

    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener queue saturated type=model.usage seq=3",
    );
    releaseFirst?.();
    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual([1, 2, 4]);
  });

  it("enforces one retained-byte budget across independent listener lanes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.started") {
        return;
      }
      seen.push(event.runId ?? "missing");
      await gate;
    });

    for (const [runId, size] of [
      ["run-budget-a", 7 * 1024 * 1024],
      ["run-budget-b", 7 * 1024 * 1024],
      ["run-budget-c", 3 * 1024 * 1024],
    ] as const) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId,
        callId: `call-${runId}`,
        provider: "openai",
        model: "x".repeat(size),
      });
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener queue saturated type=model.call.started seq=3",
    );
    release?.();
    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual(["run-budget-a", "run-budget-b"]);
  });

  it("drops an oversized first event before invoking an async listener", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = vi.fn(async () => undefined);
    onInternalDiagnosticEvent(listener);

    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: "x".repeat(17 * 1024 * 1024),
      usage: { input: 1 },
    });

    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener queue saturated type=model.usage seq=1",
    );
    expect(listener).not.toHaveBeenCalled();
    await waitForDiagnosticEventsDrained();
  });

  it("bounds trusted listener queues after private-data capture filtering", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const inputOnlySeen: string[] = [];
    const outputOnlySeen: string[] = [];

    onTrustedInternalDiagnosticEvent(
      async (event) => {
        if (event.type !== "model.call.started") {
          return;
        }
        if (event.callId === "call-first") {
          await firstGate;
          return;
        }
        inputOnlySeen.push(event.callId);
      },
      { captureModelContent: { inputMessages: true } },
    );
    onTrustedInternalDiagnosticEvent(
      async (event) => {
        if (event.type !== "model.call.started") {
          return;
        }
        if (event.callId === "call-first") {
          await firstGate;
          return;
        }
        outputOnlySeen.push(event.callId);
      },
      { captureModelContent: { outputMessages: true } },
    );

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-byte-policy",
      callId: "call-first",
      provider: "openai",
      model: "gpt-5.5",
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-byte-policy",
        callId: "call-large",
        provider: "openai",
        model: "gpt-5.5",
      },
      {
        modelContent: {
          inputMessages: ["allowed input"],
          outputMessages: ["x".repeat(17 * 1024 * 1024)],
        },
      },
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-byte-policy",
        callId: "call-small",
        provider: "openai",
        model: "gpt-5.5",
      },
      {
        modelContent: {
          outputMessages: ["small output"],
        },
      },
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] trusted listener queue saturated type=model.call.started seq=2",
    );
    releaseFirst?.();
    await waitForDiagnosticEventsDrained();

    expect(inputOnlySeen).toEqual(["call-large", "call-small"]);
    expect(outputOnlySeen).toEqual(["call-small"]);
  });

  it("keeps later events behind the full async listener queue", async () => {
    const releases = new Map<string, () => void>();
    const gates = new Map(
      ["call-1", "call-2", "call-3"].map((callId) => [
        callId,
        new Promise<void>((resolve) => {
          releases.set(callId, resolve);
        }),
      ]),
    );
    const seen: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type !== "model.call.started" || !event.callId) {
        return;
      }
      seen.push(`${event.callId}:begin`);
      await gates.get(event.callId);
      seen.push(`${event.callId}:end`);
    });

    for (const callId of ["call-1", "call-2", "call-3"]) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: "run-queued-listener",
        callId,
        provider: "openai",
        model: "gpt-5.5",
      });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual(["call-1:begin"]);

    releases.get("call-1")?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual(["call-1:begin", "call-1:end", "call-2:begin"]);

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-queued-listener",
      callId: "call-4",
      provider: "openai",
      model: "gpt-5.5",
    });
    releases.get("call-2")?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(seen).toEqual([
      "call-1:begin",
      "call-1:end",
      "call-2:begin",
      "call-2:end",
      "call-3:begin",
    ]);

    releases.get("call-3")?.();
    await waitForDiagnosticEventsDrained();
    expect(seen).toEqual([
      "call-1:begin",
      "call-1:end",
      "call-2:begin",
      "call-2:end",
      "call-3:begin",
      "call-3:end",
      "call-4:begin",
      "call-4:end",
    ]);
  });

  it("does not let async listener rejection poison later delivery", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onInternalDiagnosticEvent(async (event) => {
      if (event.type === "model.call.started") {
        seen.push("started");
        throw new Error("ordered async boom");
      }
      if (event.type === "model.call.completed") {
        seen.push("completed");
      }
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-reject-ordered-listener",
      callId: "call-reject-ordered-listener",
      provider: "openai",
      model: "gpt-5.5",
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-reject-ordered-listener",
      callId: "call-reject-ordered-listener",
      provider: "openai",
      model: "gpt-5.5",
      durationMs: 1,
    });

    await waitForDiagnosticEventsDrained();

    expect(seen).toEqual(["started", "completed"]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.started seq=1: Error: ordered async boom",
    );
  });

  it("passes immutable pending diagnostic copies to queue inspectors", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-immutable",
      toolName: "exec",
      toolCallId: "call-immutable",
      durationMs: 1,
      errorCategory: "test",
    });

    let mutationErrors = 0;
    expect(
      hasPendingInternalDiagnosticEvent((event, metadata) => {
        try {
          (event as { type: string }).type = "model.usage";
        } catch {
          mutationErrors += 1;
        }
        try {
          (metadata as { trusted: boolean }).trusted = false;
        } catch {
          mutationErrors += 1;
        }
        return (
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-immutable"
        );
      }),
    ).toBe(true);
    expect(mutationErrors).toBe(2);

    await waitForDiagnosticEventsDrained();

    expect(events).toMatchObject([
      {
        type: "tool.execution.error",
        toolCallId: "call-immutable",
      },
    ]);
  });

  it("skips uncloneable pending diagnostics during queue inspection", async () => {
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-uncloneable",
      callId: "call-uncloneable",
      provider: "openai",
      model: "gpt-5.4",
      badValue: () => undefined,
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-cloneable",
      toolName: "exec",
      toolCallId: "call-cloneable",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-cloneable",
      ),
    ).toBe(true);
  });

  it("preserves trusted terminal tool diagnostics when the async queue is full", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-saturation-first",
      toolName: "exec",
      toolCallId: "call-saturation-first",
      durationMs: 1,
    });

    for (let index = 0; index < 9_999; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `saturation-run-${index}`,
        callId: `saturation-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-saturation-second",
      toolName: "exec",
      toolCallId: "call-saturation-second",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-saturation-second",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    expect(
      events
        .filter(
          (
            event,
          ): event is Extract<
            DiagnosticEventPayload,
            { type: "tool.execution.completed" | "tool.execution.error" }
          > => event.type === "tool.execution.completed" || event.type === "tool.execution.error",
        )
        .map((event) => ({
          type: event.type,
          toolCallId: event.toolCallId,
        })),
    ).toEqual([
      {
        type: "tool.execution.completed",
        toolCallId: "call-saturation-first",
      },
      {
        type: "tool.execution.error",
        toolCallId: "call-saturation-second",
      },
    ]);
    expect(events.filter((event) => event.type === "model.call.started")).toHaveLength(9_998);
  });

  it("emits a bounded summary when async diagnostics are dropped at saturation", async () => {
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      events.push(event);
    });

    for (let index = 0; index < 10_001; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `drop-run-${index}`,
        callId: `drop-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await waitForDiagnosticEventsDrained();

    const dropSummary = events.find(
      (
        event,
      ): event is Extract<DiagnosticEventPayload, { type: "diagnostic.async_queue.dropped" }> =>
        event.type === "diagnostic.async_queue.dropped",
    );
    expect(dropSummary).toMatchObject({
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 1,
      droppedUntrustedEvents: 1,
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });
    expect(events.filter((event) => event.type === "model.call.started")).toHaveLength(10_000);
  });

  it("bounds the global async queue by retained payload bytes", async () => {
    const events: DiagnosticEventPayload[] = [];
    onTrustedInternalDiagnosticEvent(
      (event) => {
        events.push(event);
      },
      { captureModelContent: { inputMessages: true } },
    );
    const largeValue = "x".repeat(17 * 1024 * 1024);

    for (const callId of ["call-large-first", "call-large-second"]) {
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          runId: "run-large-queue",
          callId,
          provider: "openai",
          model: "gpt-5.4",
        },
        { modelContent: { outputMessages: [largeValue] } },
      );
    }

    await waitForDiagnosticEventsDrained();

    expect(events.filter((event) => event.type === "model.call.started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.async_queue.dropped",
        droppedEvents: 1,
        droppedTrustedEvents: 1,
      }),
    );
  });

  it("keeps log records off the public diagnostic event stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: string[] = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event.type);
    });

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "private log",
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual(["log.record"]);
  });

  it("emits exec approval followup suppression events on the public stream", async () => {
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent({
      type: "exec.approval.followup_suppressed",
      approvalId: "approval-123",
      reason: "session_rebound",
      phase: "gateway_preflight",
    });

    await waitForDiagnosticEventsDrained();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "approval-123",
        reason: "session_rebound",
        phase: "gateway_preflight",
        ts: expect.any(Number),
      }),
    );
  });

  it("keeps trusted private data off shared internal diagnostic listeners", async () => {
    const internalEvents: DiagnosticEventPayload[] = [];
    const trustedEvents: Array<{
      event: DiagnosticEventPayload;
      privateData: unknown;
    }> = [];
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event);
    });
    onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      trustedEvents.push({ event, privateData });
    });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
      },
      {
        modelContent: {
          inputMessages: ["secret prompt"],
          systemPrompt: "secret system",
        },
      },
    );

    await waitForDiagnosticEventsDrained();

    expect(JSON.stringify(internalEvents)).not.toContain("secret");
    expect(JSON.stringify(trustedEvents[0]?.event)).not.toContain("secret");
    expect(trustedEvents[0]?.privateData).toEqual({
      modelContent: {
        inputMessages: ["secret prompt"],
        systemPrompt: "secret system",
      },
    });
  });

  it("filters trusted private model content to an explicit listener capture policy", async () => {
    const selected: DiagnosticEventPrivateData[] = [];
    const outputOnly: DiagnosticEventPrivateData[] = [];
    onTrustedInternalDiagnosticEvent(
      (_event, _metadata, privateData) => {
        selected.push(privateData);
      },
      {
        captureModelContent: {
          inputMessages: true,
          systemPrompt: true,
        },
      },
    );
    onTrustedInternalDiagnosticEvent(
      (_event, _metadata, privateData) => {
        outputOnly.push(privateData);
      },
      {
        captureModelContent: {
          outputMessages: true,
        },
      },
    );

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.started",
        runId: "run-filtered",
        callId: "call-filtered",
        provider: "openai",
        model: "gpt-5.4",
      },
      {
        modelContent: {
          inputMessages: ["secret prompt"],
          systemPrompt: "secret system",
        },
      },
    );

    await waitForDiagnosticEventsDrained();

    expect(selected).toEqual([
      {
        modelContent: {
          inputMessages: ["secret prompt"],
          systemPrompt: "secret system",
        },
      },
    ]);
    expect(outputOnly).toEqual([{}]);
  });

  it("treats omitted trusted listener options as full content capture", () => {
    const stop = onTrustedInternalDiagnosticEvent(() => {});

    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: true,
      toolDefinitions: true,
      anyModelContent: true,
    });

    stop();
    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: false,
      outputMessages: false,
      toolInputs: false,
      toolOutputs: false,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: false,
    });
  });

  it("preserves full capture for trusted listeners registered by an older module instance", () => {
    const stop = onTrustedInternalDiagnosticEvent(() => {});
    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as { trustedListenerOptions: Map<unknown, unknown> };
    state.trustedListenerOptions.clear();

    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: true,
      toolDefinitions: true,
      anyModelContent: true,
    });

    stop();
  });

  it("aggregates trusted listener content capture only while subscribed", () => {
    const stopInput = onTrustedInternalDiagnosticEvent(() => {}, {
      captureModelContent: {
        inputMessages: true,
        toolInputs: true,
      },
    });
    const stopOutput = onTrustedInternalDiagnosticEvent(() => {}, {
      captureModelContent: {
        outputMessages: true,
        toolOutputs: true,
      },
    });

    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: true,
    });

    stopInput();
    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: false,
      outputMessages: true,
      toolInputs: false,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: true,
    });

    stopOutput();
    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: false,
      outputMessages: false,
      toolInputs: false,
      toolOutputs: false,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: false,
    });
  });

  it("captures model content for a tool-only trusted listener", () => {
    const stop = onTrustedInternalDiagnosticEvent(() => {}, {
      captureModelContent: {
        toolInputs: true,
        toolOutputs: true,
      },
    });

    expect(resolveTrustedDiagnosticModelContentCapturePolicy()).toEqual({
      inputMessages: false,
      outputMessages: false,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
      toolDefinitions: false,
      anyModelContent: true,
    });

    stop();
  });

  it("skips event enrichment and subscribers when diagnostics are disabled", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const seen: string[] = [];
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });
    setDiagnosticsEnabledForProcess(false);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });

    expect(seen).toStrictEqual([]);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onDiagnosticEvent(() => {
      calls += 1;
      emitDiagnosticEvent({
        type: "queue.lane.enqueue",
        lane: "main",
        queueSize: calls,
      });
    });

    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "main",
      queueSize: 0,
    });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[diagnostic-events] recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
    );
  });

  it("enables diagnostics unless explicitly disabled", () => {
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(isDiagnosticsEnabled({} as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: {} } as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
});
