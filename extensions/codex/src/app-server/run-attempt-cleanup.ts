import {
  clearActiveEmbeddedRun,
  embeddedAgentLog,
  runAgentCleanupStep,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { scheduleCodexNativeHookRelayUnregister } from "./native-hook-relay.js";
import { waitForCodexAttemptDiagnosticEventsDrained } from "./rollout-trace-diagnostics.js";
import type { CodexAttemptActiveTurn } from "./run-attempt-active-turn.js";
import type { CodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import type { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";

export async function cleanupCodexAttempt(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  lifecycle: CodexAttemptLifecycleController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
  activeTurn: CodexAttemptActiveTurn,
) {
  const {
    prompt,
    state: resourceState,
    projectorRef,
    trajectoryRecorder,
    releaseCurrentRoute,
    releaseSharedClientLeaseAndRetireOneShotClient,
    releaseSandboxExecEnvironment,
  } = resources;
  const { connection } = prompt.context.runtime;
  const { params, options, rolloutTraceRoot, runAbortController } = connection;
  const diagnosticDelivery = (
    params as typeof params & { internalDiagnosticDelivery?: { fail: () => void } }
  ).internalDiagnosticDelivery;
  const { state, steeringQueueRef, userInputBridgeRef, turnWatches } = turnRuntime;
  const {
    maybeEmitFastModeAutoResetBestEffort,
    emitLifecycleTerminal,
    buildLifecycleTerminalMeta,
  } = lifecycle;
  const { codexModelCallDiagnostics } = requestRuntime;
  const { activeTurnId, abortListener, handle, freezeRunTerminalOutcome } = activeTurn;
  const rolloutTraceMonitor = resourceState.rolloutTraceMonitor;
  if (rolloutTraceMonitor && !state.completed && !runAbortController.signal.aborted) {
    handle.abort();
  }
  if (params.isFinalFallbackAttempt !== false) {
    await maybeEmitFastModeAutoResetBestEffort();
  }
  codexModelCallDiagnostics.emitError(
    "codex app-server run completed without model-call terminal event",
  );
  emitLifecycleTerminal({
    phase: "error",
    error: "codex app-server run completed without lifecycle terminal event",
    ...buildLifecycleTerminalMeta({
      aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
      timedOut: state.timedOut,
    }),
  });
  if (trajectoryRecorder && !resourceState.trajectoryEndRecorded) {
    trajectoryRecorder.recordEvent("session.ended", {
      status:
        state.timedOut || (runAbortController.signal.aborted && !state.clientClosedAbort)
          ? "interrupted"
          : "cleanup",
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
      timedOut: state.timedOut,
      aborted: runAbortController.signal.aborted && !state.clientClosedAbort,
    });
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-trajectory-flush",
    log: embeddedAgentLog,
    cleanup: async () => trajectoryRecorder?.flush(),
  });
  if (!state.timedOut && !runAbortController.signal.aborted) {
    await steeringQueueRef.current?.flushPending();
  }
  if (!state.timedOut) {
    await unsubscribeCodexThreadBestEffort(resourceState.client, {
      threadId: resourceState.thread.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }
  userInputBridgeRef.current?.cancelPending();
  turnWatches.clearAllTimers();
  await resourceState.turnRoute?.drain();
  releaseCurrentRoute();
  await releaseSharedClientLeaseAndRetireOneShotClient();
  let rolloutTraceDrain:
    | Awaited<ReturnType<NonNullable<typeof rolloutTraceMonitor>["finalDrain"]>>
    | undefined;
  if (rolloutTraceMonitor) {
    try {
      rolloutTraceDrain = await rolloutTraceMonitor.finalDrain();
    } catch (error) {
      embeddedAgentLog.debug("codex rollout trace cleanup drain failed", {
        error: error instanceof Error ? error.message : String(error),
        runId: params.runId,
      });
    } finally {
      rolloutTraceMonitor.stop();
      resourceState.rolloutTraceMonitor = undefined;
    }
    if (!rolloutTraceDrain?.complete) {
      diagnosticDelivery?.fail();
      embeddedAgentLog.warn("codex rollout trace cleanup drain incomplete", {
        reason: rolloutTraceDrain?.reason ?? "incomplete_rollout",
        runId: params.runId,
      });
    }
  }
  const nativeHookRelay = resourceState.nativeHookRelay;
  const nativeHookRelayToSettle = resourceState.nativeFailureProjectionDrainAttempted
    ? undefined
    : nativeHookRelay;
  resourceState.nativeFailureProjectionDrainAttempted = true;
  const nativeFailureProjectionsSettled = nativeHookRelayToSettle
    ? await waitForCodexAttemptDiagnosticEventsDrained(() =>
        nativeHookRelayToSettle.settlePreToolUseFailureProjections(),
      )
    : true;
  if (!nativeFailureProjectionsSettled) {
    diagnosticDelivery?.fail();
    embeddedAgentLog.warn("codex native hook failure projection drain timed out during cleanup", {
      threadId: resourceState.thread.threadId,
      turnId: activeTurnId,
    });
  }
  if (rolloutTraceRoot) {
    projectorRef.current?.resolveSuppressedNativeToolLifecycleDiagnostics(
      new Set(rolloutTraceDrain?.emittedToolLifecycleKeys ?? []),
    );
  }
  if (nativeHookRelay) {
    if (state.shouldDelayNativeHookRelayUnregister) {
      // Native hook subprocesses can finish shortly after turn completion.
      scheduleCodexNativeHookRelayUnregister({
        relay: nativeHookRelay,
        hookTimeoutSec: options.nativeHookRelay?.hookTimeoutSec,
      });
    } else {
      nativeHookRelay.unregister();
    }
  }
  await releaseSandboxExecEnvironment();
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "codex-scoped-mcp-dispose",
    log: embeddedAgentLog,
    cleanup: async () => {
      await prompt.context.attemptTools.scopedMcpTools?.dispose();
    },
  });
  runAbortController.signal.removeEventListener("abort", abortListener);
  steeringQueueRef.current?.cancel();
  freezeRunTerminalOutcome();
  params.replyOperation?.detachBackend(handle);
  clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
}
