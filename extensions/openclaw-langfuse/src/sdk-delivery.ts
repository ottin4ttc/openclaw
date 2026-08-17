import { AsyncLocalStorage } from "node:async_hooks";
import type Langfuse from "langfuse";
import type { MinimalLogger } from "./types.js";
import { LANGFUSE_SDK_EVENT_LIMIT_BYTES } from "./utils.js";

export const SDK_DELIVERY_TIMEOUT_MS = 5_000;
export const SDK_DELIVERY_BATCH_SIZE = 5;
export const SDK_DELIVERY_MAX_TICKETS_PER_TRACE = 512;
export const SDK_DELIVERY_MAX_ACTIVE_TRACES = 100;
export const SDK_DELIVERY_MAX_EVENT_BYTES = LANGFUSE_SDK_EVENT_LIMIT_BYTES;
const SDK_DELIVERY_RETIRED_TICKET_TTL_MS = SDK_DELIVERY_TIMEOUT_MS;

type DeliveryTicket = {
  seq: number;
  observationId: string;
  eventType: SdkDeliveryEventType;
  settled: boolean;
  failed: boolean;
  flushScopes?: Set<SdkDeliveryFlushScope>;
};

type TraceDeliveryState = {
  nextSeq: number;
  settledThrough: number;
  firstFailedSeq?: number;
  tickets: DeliveryTicket[];
};

type ScopedDeliveryTicket = {
  traceId: string;
  ticket: DeliveryTicket;
};

type ExplicitFlushInvocation = {
  started: boolean;
  completion: Promise<SdkDeliveryResult>;
  complete: (result: SdkDeliveryResult) => void;
};

export type SdkDeliveryEventType =
  | "trace-create"
  | "generation-create"
  | "generation-update"
  | "span-create"
  | "span-update";

export type SdkDeliveryFlushScope = {
  tickets: ScopedDeliveryTicket[];
};

export type SdkDeliveryResult = { ok: true } | { ok: false; reason: string };

export class SdkDeliveryTracker {
  private traces = new Map<string, TraceDeliveryState>();
  private explicitFlushInvocation = new AsyncLocalStorage<ExplicitFlushInvocation>();
  // Keep unresolved tickets after finalization so late SDK callbacks cannot
  // satisfy a later recovery attempt that reuses the same stable IDs.
  private retiredTickets = new Map<string, DeliveryTicket[]>();

  begin(
    traceId: string,
    observationId: string,
    eventType: SdkDeliveryEventType = "generation-create",
  ): boolean {
    const wasTracked = this.hasPendingTrace(traceId);
    if (!wasTracked && this.trackedTraceCount() >= SDK_DELIVERY_MAX_ACTIVE_TRACES) {
      return false;
    }
    let state = this.traces.get(traceId);
    if (!state) {
      state = { nextSeq: 0, settledThrough: 0, tickets: [] };
      this.traces.set(traceId, state);
    }
    const retiredTicketCount = this.retiredTickets.get(traceId)?.length ?? 0;
    if (state.tickets.length + retiredTicketCount >= SDK_DELIVERY_MAX_TICKETS_PER_TRACE) {
      if (state.nextSeq === 0) {
        this.traces.delete(traceId);
      }
      return false;
    }
    state.tickets.push({
      seq: ++state.nextSeq,
      observationId,
      eventType,
      settled: false,
      failed: false,
    });
    return true;
  }

  watermark(traceId: string): number {
    return this.traces.get(traceId)?.nextSeq ?? 0;
  }

  noteError(_payload: unknown): void {
    // Enqueue processing errors have no matching flush event. Leave the ticket
    // pending so finalization times out instead of claiming delivery.
  }

  captureFlushScope(): SdkDeliveryFlushScope {
    const scope: SdkDeliveryFlushScope = { tickets: [] };
    for (const [traceId, state] of this.traces) {
      for (const ticket of state.tickets) {
        if (!ticket.settled) {
          // Scopes are start-time snapshots, not exclusive claims. Overlapping
          // flushAt=1 requests may start before earlier callbacks return.
          (ticket.flushScopes ??= new Set()).add(scope);
          scope.tickets.push({ traceId, ticket });
        }
      }
    }
    return scope;
  }

  noteFlush(payload: unknown, error?: unknown, scope = this.captureFlushScope()): void {
    const flushedObservations = observationsFromSdkFlushPayload(payload);
    const observations: Array<{
      traceId?: string;
      id: string;
      eventType: string;
      oversized: boolean;
      failed: boolean;
    }> = [];
    for (const observation of flushedObservations) {
      observations.push({
        ...observation,
        failed: error != null || observation.oversized,
      });
    }
    for (const observation of observations) {
      const traceId =
        observation.traceId ??
        this.resolveUniqueTraceIdForObservation(scope, observation.id, observation.eventType);
      if (!traceId) {
        continue;
      }
      let scopedTicketIndex = -1;
      let fewestScopeReferences = Number.POSITIVE_INFINITY;
      for (let index = 0; index < scope.tickets.length; index += 1) {
        const candidate = scope.tickets[index];
        if (
          !candidate ||
          candidate.traceId !== traceId ||
          candidate.ticket.observationId !== observation.id ||
          candidate.ticket.eventType !== observation.eventType ||
          !this.isTicketPending(candidate, scope)
        ) {
          continue;
        }
        const scopeReferences = candidate.ticket.flushScopes?.size ?? 0;
        if (scopeReferences < fewestScopeReferences) {
          scopedTicketIndex = index;
          fewestScopeReferences = scopeReferences;
        }
      }
      if (scopedTicketIndex < 0) {
        continue;
      }
      const scopedTicket = scope.tickets.splice(scopedTicketIndex, 1)[0];
      if (!scopedTicket) {
        continue;
      }
      this.settleScopedTicket(scopedTicket, scope, observation.failed);
    }
    for (const unmatchedTicket of scope.tickets) {
      this.releaseScopedTicket(unmatchedTicket, scope);
    }
    scope.tickets.length = 0;
    for (const state of this.traces.values()) {
      this.advanceSettledWatermark(state);
    }
  }

  async runExplicitFlush(invoke: () => Promise<unknown>): Promise<SdkDeliveryResult> {
    let complete: ((result: SdkDeliveryResult) => void) | undefined;
    const completion = new Promise<SdkDeliveryResult>((resolve) => {
      complete = resolve;
    });
    const invocation: ExplicitFlushInvocation = {
      started: false,
      completion,
      complete: (result) => complete?.(result),
    };
    try {
      await this.explicitFlushInvocation.run(invocation, invoke);
    } catch {
      return { ok: false, reason: "delivery failed" };
    }
    if (!invocation.started) {
      return { ok: false, reason: "delivery failed" };
    }
    return await invocation.completion;
  }

  beginFlushInvocation(): ExplicitFlushInvocation | undefined {
    const invocation = this.explicitFlushInvocation.getStore();
    if (!invocation || invocation.started) {
      return undefined;
    }
    invocation.started = true;
    return invocation;
  }

  completeFlushInvocation(invocation: ExplicitFlushInvocation | undefined, error?: unknown): void {
    if (!invocation) {
      return;
    }
    invocation.complete(error != null ? { ok: false, reason: "delivery failed" } : { ok: true });
  }

  async awaitTrace(
    traceId: string,
    watermark: number,
    timeoutMs = SDK_DELIVERY_TIMEOUT_MS,
  ): Promise<SdkDeliveryResult> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = this.traceStatus(traceId, watermark);
      if (result.done) {
        return result.failed ? { ok: false, reason: "delivery failed" } : { ok: true };
      }
      if (Date.now() >= deadline) {
        return { ok: false, reason: "delivery timeout" };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

  completeTrace(traceId: string, options?: { preservePending?: boolean }): void {
    const state = this.traces.get(traceId);
    if (!state) {
      return;
    }
    if (!options?.preservePending) {
      this.traces.delete(traceId);
      return;
    }
    this.advanceSettledWatermark(state);
    const pendingTickets = state.tickets.filter(
      (ticket) => !ticket.settled && (ticket.flushScopes?.size ?? 0) > 0,
    );
    if (pendingTickets.length > 0) {
      const retired = this.retiredTickets.get(traceId) ?? [];
      retired.push(...pendingTickets);
      this.retiredTickets.set(traceId, retired);
      const expiry = setTimeout(() => {
        this.releaseRetiredTickets(traceId, pendingTickets);
      }, SDK_DELIVERY_RETIRED_TICKET_TTL_MS);
      // Retired tickets protect retry isolation only for a bounded late-callback
      // window; the timer must not keep an otherwise idle process alive.
      expiry.unref();
    }
    this.traces.delete(traceId);
  }

  clear(): void {
    this.traces.clear();
    this.retiredTickets.clear();
  }

  private traceStatus(traceId: string, watermark: number): { done: boolean; failed: boolean } {
    const state = this.traces.get(traceId);
    if (!state || watermark <= 0 || watermark > state.nextSeq) {
      return { done: false, failed: false };
    }
    return {
      done: state.settledThrough >= watermark,
      failed: state.firstFailedSeq !== undefined && state.firstFailedSeq <= watermark,
    };
  }

  private advanceSettledWatermark(state: TraceDeliveryState): void {
    while (true) {
      const nextSeq = state.settledThrough + 1;
      const ticketIndex = state.tickets.findIndex((ticket) => ticket.seq === nextSeq);
      const ticket = ticketIndex >= 0 ? state.tickets[ticketIndex] : undefined;
      if (!ticket?.settled) {
        return;
      }
      if (ticket.failed && state.firstFailedSeq === undefined) {
        state.firstFailedSeq = ticket.seq;
      }
      state.settledThrough = ticket.seq;
      state.tickets.splice(ticketIndex, 1);
    }
  }

  private hasPendingTrace(traceId: string): boolean {
    return (
      (this.traces.get(traceId)?.tickets.length ?? 0) > 0 ||
      (this.retiredTickets.get(traceId)?.length ?? 0) > 0
    );
  }

  private trackedTraceCount(): number {
    const traceIds = new Set<string>();
    for (const [traceId, state] of this.traces) {
      if (state.tickets.length > 0) {
        traceIds.add(traceId);
      }
    }
    for (const [traceId, tickets] of this.retiredTickets) {
      if (tickets.length > 0) {
        traceIds.add(traceId);
      }
    }
    return traceIds.size;
  }

  private resolveUniqueTraceIdForObservation(
    scope: SdkDeliveryFlushScope,
    observationId: string,
    eventType: string,
  ): string | undefined {
    const traceIds = new Set<string>();
    for (const candidate of scope.tickets) {
      if (
        candidate.ticket.observationId === observationId &&
        candidate.ticket.eventType === eventType &&
        this.isTicketPending(candidate, scope)
      ) {
        traceIds.add(candidate.traceId);
      }
    }
    return traceIds.size === 1 ? traceIds.values().next().value : undefined;
  }

  private isTicketPending(candidate: ScopedDeliveryTicket, scope: SdkDeliveryFlushScope): boolean {
    if (!candidate.ticket.flushScopes?.has(scope)) {
      return false;
    }
    const activeTicket = this.traces
      .get(candidate.traceId)
      ?.tickets.find((ticket) => ticket === candidate.ticket);
    if (activeTicket) {
      return !activeTicket.settled;
    }
    return (
      this.retiredTickets.get(candidate.traceId)?.some((ticket) => ticket === candidate.ticket) ===
      true
    );
  }

  private settleScopedTicket(
    candidate: ScopedDeliveryTicket,
    scope: SdkDeliveryFlushScope,
    failed: boolean,
  ): void {
    if (!candidate.ticket.flushScopes?.has(scope)) {
      return;
    }
    candidate.ticket.flushScopes.delete(scope);
    const retiredTickets = this.retiredTickets.get(candidate.traceId);
    const retiredTicketIndex = retiredTickets?.findIndex((ticket) => ticket === candidate.ticket);
    if (retiredTicketIndex !== undefined && retiredTicketIndex >= 0) {
      this.releaseRetiredTickets(candidate.traceId, [candidate.ticket]);
      return;
    }
    const activeTicket = this.traces
      .get(candidate.traceId)
      ?.tickets.find((ticket) => ticket === candidate.ticket);
    if (!activeTicket || activeTicket.settled) {
      return;
    }
    activeTicket.settled = true;
    // Langfuse fetchWithRetry converts HTTP 207 item errors into this callback error.
    // A null error therefore means the whole SDK batch was accepted.
    activeTicket.failed = failed;
  }

  private releaseScopedTicket(candidate: ScopedDeliveryTicket, scope: SdkDeliveryFlushScope): void {
    const activeTicket = this.traces
      .get(candidate.traceId)
      ?.tickets.find((ticket) => ticket === candidate.ticket);
    if (activeTicket && !activeTicket.settled) {
      activeTicket.flushScopes?.delete(scope);
      return;
    }
    const retiredTickets = this.retiredTickets.get(candidate.traceId);
    const retiredTicketIndex = retiredTickets?.findIndex(
      (ticket) => ticket === candidate.ticket && ticket.flushScopes?.has(scope),
    );
    if (retiredTicketIndex !== undefined && retiredTicketIndex >= 0) {
      candidate.ticket.flushScopes?.delete(scope);
      if ((candidate.ticket.flushScopes?.size ?? 0) === 0) {
        this.releaseRetiredTickets(candidate.traceId, [candidate.ticket]);
      }
    }
    // This callback is the retired ticket's final delivery boundary. If the
    // SDK omitted it, no later callback can settle it, so release its capacity.
  }

  private releaseRetiredTickets(traceId: string, tickets: DeliveryTicket[]): void {
    const retiredTickets = this.retiredTickets.get(traceId);
    if (!retiredTickets) {
      return;
    }
    const releasedTickets = new Set(tickets);
    const retainedTickets = retiredTickets.filter((ticket) => !releasedTickets.has(ticket));
    if (retainedTickets.length === 0) {
      this.retiredTickets.delete(traceId);
      return;
    }
    this.retiredTickets.set(traceId, retainedTickets);
  }
}

export function bindSdkDeliveryTracker(
  langfuse: Langfuse,
  tracker: SdkDeliveryTracker,
  logger?: MinimalLogger | null,
  batchSize = SDK_DELIVERY_BATCH_SIZE,
): Array<() => void> {
  const cleanups: Array<() => void> = [];
  if (typeof langfuse.flush === "function") {
    // Preserve the exact SDK method for cleanup; every invocation below supplies
    // the Langfuse receiver explicitly, so the unbound reference never escapes.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalFlush = langfuse.flush;
    type PendingFlush = {
      automatic: boolean;
      callback?: Parameters<Langfuse["flush"]>[0];
      invocation?: ExplicitFlushInvocation;
    };
    const pendingFlushes: PendingFlush[] = [];
    let automaticFlushQueued = false;
    let flushActive = false;
    let disposed = false;

    const queueAutomaticFlush = (): void => {
      if (automaticFlushQueued || disposed) {
        return;
      }
      automaticFlushQueued = true;
      pendingFlushes.push({ automatic: true });
    };

    const drainFlushQueue = (): void => {
      if (flushActive || disposed) {
        return;
      }
      const pending = pendingFlushes.shift();
      if (!pending) {
        return;
      }
      if (pending.automatic) {
        automaticFlushQueued = false;
      }
      flushActive = true;
      const scope = tracker.captureFlushScope();
      let completed = false;
      const complete = (error?: unknown, items?: unknown): void => {
        if (completed) {
          return;
        }
        completed = true;
        tracker.noteFlush(items, error, scope);
        tracker.completeFlushInvocation(pending.invocation, error);
        pending.callback?.(error, items);
        const flushedItemCount = Array.isArray(items) ? items.length : 0;
        flushActive = false;
        if (flushedItemCount >= batchSize) {
          queueAutomaticFlush();
        }
        drainFlushQueue();
      };
      try {
        originalFlush.call(langfuse, complete);
      } catch (error) {
        complete(error, []);
      }
    };

    const trackedFlush: Langfuse["flush"] = function (callback) {
      const invocation = tracker.beginFlushInvocation();
      if (callback || invocation) {
        pendingFlushes.push({ automatic: false, callback, invocation });
      } else {
        queueAutomaticFlush();
      }
      drainFlushQueue();
    };
    langfuse.flush = trackedFlush;
    cleanups.push(() => {
      disposed = true;
      pendingFlushes.length = 0;
      if (langfuse.flush === trackedFlush) {
        langfuse.flush = originalFlush;
      }
    });
  }
  if (typeof langfuse.on === "function") {
    cleanups.push(
      langfuse.on("warning", (message: unknown) => {
        logger?.warn?.(`Langfuse: [SDK-warn] ${String(message)}`);
      }),
      langfuse.on("error", (message: unknown) => {
        tracker.noteError(message);
        logger?.error?.(`Langfuse: [SDK-error] ${String(message)}`);
      }),
    );
  }
  return cleanups;
}

export async function flushSdkDeliveryThroughWatermark(
  langfuse: Pick<Langfuse, "flushAsync">,
  tracker: SdkDeliveryTracker,
  traceId: string,
  watermark: number,
  timeoutMs = SDK_DELIVERY_TIMEOUT_MS,
): Promise<SdkDeliveryResult> {
  if (watermark <= 0) {
    return { ok: false, reason: "delivery timeout" };
  }
  const deadline = Date.now() + timeoutMs;
  const flushResult = await flushSdkBeforeDeadline(langfuse, tracker, deadline);
  if (!flushResult.ok) {
    return flushResult;
  }
  return await tracker.awaitTrace(traceId, watermark, Math.max(0, deadline - Date.now()));
}

export async function flushSdkDeliveryForBackpressure(
  langfuse: Pick<Langfuse, "flushAsync">,
  tracker: SdkDeliveryTracker,
  timeoutMs = SDK_DELIVERY_TIMEOUT_MS,
): Promise<SdkDeliveryResult> {
  return await flushSdkBeforeDeadline(langfuse, tracker, Date.now() + timeoutMs);
}

async function flushSdkBeforeDeadline(
  langfuse: Pick<Langfuse, "flushAsync">,
  tracker: SdkDeliveryTracker,
  deadline: number,
): Promise<SdkDeliveryResult> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return { ok: false, reason: "delivery timeout" };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      tracker.runExplicitFlush(() => langfuse.flushAsync()),
      new Promise<SdkDeliveryResult>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false, reason: "delivery timeout" }), remainingMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function observationsFromSdkFlushPayload(
  payload: unknown,
): Array<{ traceId?: string; id: string; eventType: string; oversized: boolean }> {
  if (!Array.isArray(payload)) {
    return [];
  }
  const observations: Array<{
    traceId?: string;
    id: string;
    eventType: string;
    oversized: boolean;
  }> = [];
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const body = objectRecord(record.body);
    const candidate = [record.observationId, body.id, body.observationId].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const type = typeof record.type === "string" ? record.type : "";
    const traceId =
      typeof body.traceId === "string" && body.traceId.length > 0
        ? body.traceId
        : type.startsWith("trace-") && typeof body.id === "string" && body.id.length > 0
          ? body.id
          : undefined;
    if (candidate && type) {
      // Preserve multiplicity: create and update operations for one observation
      // use the same id but each operation owns a distinct delivery ticket.
      observations.push({
        traceId,
        id: candidate,
        eventType: type,
        oversized: serializedByteLength(item) > SDK_DELIVERY_MAX_EVENT_BYTES,
      });
    }
  }
  return observations;
}

function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
