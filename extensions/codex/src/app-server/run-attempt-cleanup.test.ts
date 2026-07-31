import { describe, expect, it, vi } from "vitest";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";

describe("cleanupCodexAttempt", () => {
  it("replays suppressed native tool diagnostics when exceptional cleanup cannot drain rollout", async () => {
    const order: string[] = [];
    const stop = vi.fn();
    const finalDrain = vi.fn(async () => {
      order.push("final-drain");
      throw new Error("rollout unavailable");
    });
    const resolveSuppressedNativeToolLifecycleDiagnostics = vi.fn(() => {
      order.push("resolve-suppressed");
    });
    const settlePreToolUseFailureProjections = vi.fn(async () => {
      order.push("native-projection-settle");
    });
    const unregisterNativeHookRelay = vi.fn();
    const failDiagnosticDelivery = vi.fn();
    const abortController = new AbortController();
    const abortListener = vi.fn();
    abortController.signal.addEventListener("abort", abortListener);
    const resources = {
      prompt: {
        context: {
          runtime: {
            connection: {
              params: {
                runId: "run-cleanup",
                sessionId: "session-cleanup",
                sessionKey: "agent:test:cleanup",
                sessionFile: "/tmp/session-cleanup.jsonl",
                isFinalFallbackAttempt: false,
                internalDiagnosticDelivery: { fail: failDiagnosticDelivery },
              },
              options: {},
              rolloutTraceRoot: "/tmp/rollout-cleanup",
              runAbortController: abortController,
            },
          },
          attemptTools: {},
        },
      },
      state: {
        rolloutTraceMonitor: { finalDrain, stop },
        trajectoryEndRecorded: false,
        thread: { threadId: "thread-cleanup" },
        client: { request: vi.fn() },
        turnRoute: {
          drain: vi.fn(async () => {
            order.push("route-drain");
          }),
        },
        nativeHookRelay: {
          settlePreToolUseFailureProjections,
          unregister: unregisterNativeHookRelay,
        },
        nativeFailureProjectionDrainAttempted: false,
      },
      projectorRef: {
        current: { resolveSuppressedNativeToolLifecycleDiagnostics },
      },
      trajectoryRecorder: undefined,
      releaseCurrentRoute: vi.fn(() => {
        order.push("route-release");
      }),
      releaseSharedClientLeaseAndRetireOneShotClient: vi.fn(async () => {
        order.push("client-release");
      }),
      releaseSandboxExecEnvironment: vi.fn(async () => undefined),
    };
    const turnRuntime = {
      state: {
        timedOut: true,
        completed: false,
        clientClosedAbort: false,
        shouldDelayNativeHookRelayUnregister: false,
      },
      steeringQueueRef: { current: { cancel: vi.fn() } },
      userInputBridgeRef: { current: { cancelPending: vi.fn() } },
      turnWatches: { clearAllTimers: vi.fn() },
    };
    const lifecycle = {
      maybeEmitFastModeAutoResetBestEffort: vi.fn(async () => undefined),
      emitLifecycleTerminal: vi.fn(),
      buildLifecycleTerminalMeta: vi.fn(() => ({})),
    };
    const requestRuntime = {
      codexModelCallDiagnostics: { emitError: vi.fn() },
    };
    const activeTurn = {
      activeTurnId: "turn-cleanup",
      abortListener,
      handle: { abort: vi.fn() },
      freezeRunTerminalOutcome: vi.fn(),
    };

    await cleanupCodexAttempt(
      resources as never,
      turnRuntime as never,
      lifecycle as never,
      requestRuntime as never,
      activeTurn as never,
    );

    expect(finalDrain).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(failDiagnosticDelivery).toHaveBeenCalledOnce();
    expect(settlePreToolUseFailureProjections).toHaveBeenCalledOnce();
    expect(unregisterNativeHookRelay).toHaveBeenCalledOnce();
    expect(resolveSuppressedNativeToolLifecycleDiagnostics).toHaveBeenCalledWith(new Set());
    expect(order).toEqual([
      "route-drain",
      "route-release",
      "client-release",
      "final-drain",
      "native-projection-settle",
      "resolve-suppressed",
    ]);
  });
});
