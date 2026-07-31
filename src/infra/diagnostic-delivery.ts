export type InternalDiagnosticDeliveryCursorIdentity = Readonly<{
  traceId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
}>;

export type InternalDiagnosticDeliveryCursor = InternalDiagnosticDeliveryCursorIdentity &
  Readonly<{
    sequence: number;
  }>;

export type InternalDiagnosticDeliveryCursorDrainResult =
  | Readonly<{
      ok: true;
      deliveredEvents: number;
    }>
  | Readonly<{
      ok: false;
      reason: "cap_exhausted" | "listener_failure" | "producer_incomplete" | "timeout";
      deliveredEvents: number;
    }>;

export type InternalDiagnosticDeliveryCursorOptions = Readonly<{
  timeoutMs?: number;
}>;

type InternalDiagnosticDeliveryApi = {
  begin: (identity: InternalDiagnosticDeliveryCursorIdentity) => void;
  capture: (
    identity?: InternalDiagnosticDeliveryCursorIdentity,
  ) => InternalDiagnosticDeliveryCursor;
  waitFor: (
    cursor: InternalDiagnosticDeliveryCursor,
    options?: InternalDiagnosticDeliveryCursorOptions,
  ) => Promise<InternalDiagnosticDeliveryCursorDrainResult>;
  fail: (identity: InternalDiagnosticDeliveryCursorIdentity) => void;
  complete: (identity: InternalDiagnosticDeliveryCursorIdentity) => void;
};

const INTERNAL_DIAGNOSTIC_DELIVERY_REGISTRY_SYMBOL = Symbol.for(
  "openclaw.diagnosticDelivery.internalApi.v1",
);

export function installInternalDiagnosticDeliveryApi(api: InternalDiagnosticDeliveryApi): void {
  Object.defineProperty(globalThis, INTERNAL_DIAGNOSTIC_DELIVERY_REGISTRY_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: api,
    writable: false,
  });
}

function resolveInternalDiagnosticDeliveryApi(): InternalDiagnosticDeliveryApi | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[
    INTERNAL_DIAGNOSTIC_DELIVERY_REGISTRY_SYMBOL
  ] as InternalDiagnosticDeliveryApi | undefined;
}

export function beginInternalDiagnosticDeliveryIdentity(
  identity: InternalDiagnosticDeliveryCursorIdentity,
): void {
  resolveInternalDiagnosticDeliveryApi()?.begin(identity);
}

export function captureInternalDiagnosticDeliveryCursor(
  identity: InternalDiagnosticDeliveryCursorIdentity = {},
): InternalDiagnosticDeliveryCursor {
  return resolveInternalDiagnosticDeliveryApi()?.capture(identity) ?? { ...identity, sequence: 0 };
}

export async function waitForInternalDiagnosticDeliveryCursor(
  cursor: InternalDiagnosticDeliveryCursor,
  options: InternalDiagnosticDeliveryCursorOptions = {},
): Promise<InternalDiagnosticDeliveryCursorDrainResult> {
  return (
    (await resolveInternalDiagnosticDeliveryApi()?.waitFor(cursor, options)) ?? {
      ok: true,
      deliveredEvents: 0,
    }
  );
}

export function completeInternalDiagnosticDeliveryIdentity(
  identity: InternalDiagnosticDeliveryCursorIdentity,
): void {
  resolveInternalDiagnosticDeliveryApi()?.complete(identity);
}

export function failInternalDiagnosticDeliveryIdentity(
  identity: InternalDiagnosticDeliveryCursorIdentity,
): void {
  resolveInternalDiagnosticDeliveryApi()?.fail(identity);
}
