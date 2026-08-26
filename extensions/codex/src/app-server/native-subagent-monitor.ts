/**
 * Monitors Codex native subagent threads and mirrors their lifecycle/completion
 * into OpenClaw task runtime records for parent sessions.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  extractCodexNativeSubagentCompletions,
  type CodexNativeSubagentCompletion,
  type CodexNativeSubagentNotificationCompletion,
} from "./native-subagent-notification.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
} from "./native-subagent-task-mirror.js";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import {
  startCodexRolloutTraceMonitor,
  type CodexRolloutTraceFinalDrainResult,
  type CodexRolloutTraceMonitor,
  type RolloutTraceContentCapture,
  type RolloutTraceModelBaseFields,
} from "./rollout-trace-diagnostics.js";
import { retainSharedCodexAppServerClientActivityHoldIfCurrent } from "./shared-client.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEvent>[0];

type NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
  emitTrustedDiagnosticEvent?: typeof emitTrustedDiagnosticEvent;
  startCodexRolloutTraceMonitor?: typeof startCodexRolloutTraceMonitor;
};

type ParentTurnDiagnostics = {
  runId: string;
  parentTurnId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  traceRoot?: string;
  baseFields: RolloutTraceModelBaseFields;
  capture?: RolloutTraceContentCapture;
  sourceEventIds: Set<string>;
  observedChildThreadIds: Set<string>;
  startFactChildThreadIds: Set<string>;
  endedChildThreadIds: Set<string>;
  activeChildThreadIds: Set<string>;
  partialReasons: Set<string>;
  admitted: number;
  duplicates: number;
  dropped: number;
  rolloutTurnsStarted: number;
  rolloutTurnsCompleted: number;
  drainTimedOut: boolean;
  lateEventReported: boolean;
  finalizing: boolean;
  finalized: boolean;
};

type ChildTurnDiagnostics = {
  parentTurnId: string;
  childTurnId: string;
  diagnostics: ParentTurnDiagnostics;
  monitor?: CodexRolloutTraceMonitor;
  finalization?: Promise<CodexRolloutTraceFinalDrainResult | undefined>;
  completed?: boolean;
};

type ParentState = {
  parentThreadId: string;
  transcriptPath?: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
  deferredSettlement?: () => Promise<void> | void;
  deliveredCompletionKeys: Set<string>;
  diagnostics?: ParentTurnDiagnostics;
};

type ChildState = {
  childThreadId: string;
  parentThreadId: string;
  agentPath?: string;
  agentRole?: string;
  triggeringToolCallId?: string;
  assistantMessagesByTurn: Map<string, ChildAssistantMessages>;
  transcriptPath?: string;
  transcriptPollAttempt: number;
  transcriptPollTimer?: ReturnType<typeof setTimeout>;
  transcriptTerminal: boolean;
  pendingCompletion?: CodexNativeSubagentCompletion;
  pendingCompletionEventAt?: number;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletionKey?: string;
  noFinalCompletionFallbackTimer?: ReturnType<typeof setTimeout>;
  settledWithoutCompletion: boolean;
  completionObservedInParentMailbox: boolean;
  diagnostics?: ParentTurnDiagnostics;
  diagnosticTurns: Map<string, ChildTurnDiagnostics>;
  activityHold?: () => void;
};

type ChildAssistantMessages = {
  texts: Map<string, string>;
  order: string[];
  commentaryIds: Set<string>;
  finalMessageIds: Set<string>;
};

type TranscriptCompletion = CodexNativeSubagentCompletion & {
  parentThreadId?: string;
  completedAt?: number;
};

type MonitorOptions = {
  codexHome?: string;
  transcriptPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  taskRowReconcileIntervalMs?: number;
};

const DEFAULT_TRANSCRIPT_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS = 10_000;
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;
const MAX_NATIVE_CHILDREN_PER_TURN = 64;
const MAX_NATIVE_CHILD_EVENTS_PER_TURN = 4_096;
const MAX_NATIVE_CHILD_FINAL_DRAIN_WAIT_MS = 500;
// At most nine identity fields can coexist in one lifecycle event. Keeping each
// to 256 UTF-16 code units leaves ample room below the 16 KiB UTF-8 event limit.
const MAX_NATIVE_CHILD_ID_CHARS = 256;
const MAX_NATIVE_CHILD_PARTIAL_REASONS = 16;
// Codex's recorder uses this filename contract; non-canonical names keep the
// legacy substring fallback for older or test-created transcript files.
const CODEX_ROLLOUT_FILENAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/u;
const PARENT_TRANSCRIPT_TAIL_MAX_BYTES = 512 * 1024;

const defaultRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  emitTrustedDiagnosticEvent,
  startCodexRolloutTraceMonitor,
};

const monitors = new WeakMap<CodexAppServerClient, CodexNativeSubagentMonitor>();

/** Registers or updates the monitor bound to a Codex app-server client. */
export function registerCodexNativeSubagentMonitor(params: {
  client: CodexAppServerClient;
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  codexHome?: string;
  runtime?: NativeSubagentMonitorRuntime;
}): CodexNativeSubagentMonitor {
  let monitor = monitors.get(params.client);
  if (!monitor) {
    monitor = new CodexNativeSubagentMonitor(params.client, params.runtime ?? defaultRuntime, {
      codexHome: params.codexHome,
    });
    monitors.set(params.client, monitor);
  } else {
    monitor.configure({ codexHome: params.codexHome });
  }
  monitor.registerParent({
    parentThreadId: params.parentThreadId,
    requesterSessionKey: params.requesterSessionKey,
    taskRuntimeScope: params.taskRuntimeScope,
    agentId: params.agentId,
  });
  return monitor;
}

/** Tracks native subagent thread notifications, transcript completions, and task delivery. */
export class CodexNativeSubagentMonitor {
  private readonly startedAt = Date.now();
  private readonly parentStates = new Map<string, ParentState>();
  private readonly childThreadParents = new Map<string, string>();
  private readonly childStates = new Map<string, ChildState>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly transcriptPathsByChildThreadId = new Map<string, string>();
  private codexHome?: string;
  private transcriptPollDelaysMs: readonly number[];
  private completionDeliveryRetryDelaysMs: readonly number[];
  private taskRowReconcileTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: Pick<
      CodexAppServerClient,
      "addNotificationHandler" | "addCloseHandler"
    >,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultRuntime,
    options: MonitorOptions = {},
  ) {
    this.codexHome = normalizeOptionalString(options.codexHome);
    this.transcriptPollDelaysMs =
      options.transcriptPollDelaysMs ?? DEFAULT_TRANSCRIPT_POLL_DELAYS_MS;
    this.completionDeliveryRetryDelaysMs =
      options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.startTaskRowReconciler(
      options.taskRowReconcileIntervalMs ?? DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS,
    );
    client.addNotificationHandler((notification) => this.handleNotification(notification));
    client.addCloseHandler?.(() => this.dispose());
  }

  dispose(): void {
    this.clearTimers();
    for (const childState of this.childStates.values()) {
      this.releaseChildActivityHold(childState);
    }
    this.parentStates.clear();
    this.childThreadParents.clear();
    this.childStates.clear();
    this.childThreadIdsByAgentPath.clear();
    this.transcriptPathsByChildThreadId.clear();
  }

  deferUntilParentSettles(parentThreadId: string, callback: () => Promise<void> | void): boolean {
    const normalizedParentThreadId = parentThreadId.trim();
    const state = this.parentStates.get(normalizedParentThreadId);
    if (!state || !this.hasUnsettledChildren(normalizedParentThreadId)) {
      return false;
    }
    // A yielded one-shot turn must keep this monitor alive until its child
    // result reaches the parent; cleanup ownership transfers back afterward.
    state.deferredSettlement = callback;
    return true;
  }

  configure(options: MonitorOptions): void {
    const codexHome = normalizeOptionalString(options.codexHome);
    if (codexHome) {
      this.codexHome = codexHome;
    }
  }

  registerParent(params: {
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
    agentId?: string;
  }): void {
    const parentThreadId = params.parentThreadId.trim();
    if (!parentThreadId) {
      return;
    }
    const existing = this.parentStates.get(parentThreadId);
    if (existing) {
      existing.requesterSessionKey = params.requesterSessionKey ?? existing.requesterSessionKey;
      existing.taskRuntimeScope = params.taskRuntimeScope ?? existing.taskRuntimeScope;
      existing.agentId = params.agentId ?? existing.agentId;
      this.ensureParentTaskRuntime(existing);
    } else {
      const state: ParentState = {
        parentThreadId,
        requesterSessionKey: params.requesterSessionKey,
        taskRuntimeScope: params.taskRuntimeScope,
        agentId: params.agentId,
        deliveredCompletionKeys: new Set<string>(),
      };
      this.ensureParentTaskRuntime(state);
      this.parentStates.set(parentThreadId, {
        ...state,
      });
    }
    const state = this.parentStates.get(parentThreadId);
    if (state) {
      void this.reconcileExistingRunningTasksForParent(state);
    }
  }

  beginParentTurnDiagnostics(params: {
    parentThreadId: string;
    runId: string;
    parentTurnId: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    traceRoot?: string;
    baseFields: RolloutTraceModelBaseFields;
    capture?: RolloutTraceContentCapture;
  }): void {
    const state = this.parentStates.get(params.parentThreadId.trim());
    if (!state) {
      return;
    }
    const runId = boundedDiagnosticId(params.runId);
    const parentTurnId = boundedDiagnosticId(params.parentTurnId);
    if (!runId || !parentTurnId) {
      return;
    }
    const sessionKey = boundedOptionalDiagnosticId(params.sessionKey);
    const sessionId = boundedOptionalDiagnosticId(params.sessionId);
    const agentId = boundedOptionalDiagnosticId(params.agentId);
    const previous = state.diagnostics;
    if (previous && !previous.finalized && previous.parentTurnId !== parentTurnId) {
      previous.partialReasons.add("parent_turn_replaced_before_finalization");
      this.stopDiagnosticTurnsForParent(previous.parentTurnId);
    }
    state.diagnostics = {
      runId,
      parentTurnId,
      sessionKey,
      sessionId,
      agentId,
      traceRoot: params.traceRoot,
      baseFields: {
        ...params.baseFields,
        runId,
        sessionKey,
        sessionId,
        agentId,
      },
      capture: params.capture,
      sourceEventIds: new Set<string>(),
      observedChildThreadIds: new Set<string>(),
      startFactChildThreadIds: new Set<string>(),
      endedChildThreadIds: new Set<string>(),
      activeChildThreadIds: new Set<string>(),
      partialReasons: new Set<string>(),
      admitted: 0,
      duplicates: 0,
      dropped: 0,
      rolloutTurnsStarted: 0,
      rolloutTurnsCompleted: 0,
      drainTimedOut: false,
      lateEventReported: false,
      finalizing: false,
      finalized: false,
    };
  }

  async finalizeParentTurnDiagnostics(parentThreadId: string): Promise<void> {
    const state = this.parentStates.get(parentThreadId.trim());
    const diagnostics = state?.diagnostics;
    if (!state || !diagnostics || diagnostics.finalized || diagnostics.finalizing) {
      return;
    }
    diagnostics.finalizing = true;
    const finalizations: Promise<CodexRolloutTraceFinalDrainResult | undefined>[] = [];
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId !== state.parentThreadId) {
        continue;
      }
      for (const turn of childState.diagnosticTurns.values()) {
        if (turn.parentTurnId !== diagnostics.parentTurnId) {
          continue;
        }
        if (turn.finalization) {
          finalizations.push(turn.finalization);
        }
      }
    }
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    const drainResult = await Promise.race([
      Promise.all(finalizations).then((drains) => ({ drains, timedOut: false as const })),
      new Promise<{ drains: []; timedOut: true }>((resolve) => {
        drainDeadline = setTimeout(
          () => resolve({ drains: [], timedOut: true }),
          MAX_NATIVE_CHILD_FINAL_DRAIN_WAIT_MS,
        );
        unrefTimer(drainDeadline);
      }),
    ]).finally(() => {
      if (drainDeadline) {
        clearTimeout(drainDeadline);
      }
    });
    if (drainResult.timedOut) {
      diagnostics.drainTimedOut = true;
      diagnostics.partialReasons.add("child_rollout_parent_drain_timeout");
      // The parent stops waiting after one shared deadline. Terminal drains and
      // active detached child monitors retain their own lifecycle in background.
    }
    diagnostics.finalizing = false;
    diagnostics.finalized = true;
    this.deleteCompletedDiagnosticTurnsForParent(diagnostics.parentTurnId);
    if (drainResult.drains.some((drain) => drain && !drain.complete)) {
      diagnostics.drainTimedOut = true;
      diagnostics.partialReasons.add("child_rollout_drain_incomplete");
    }
    this.emitParentTurnDiagnosticStatus(state, diagnostics);
    this.deliverPendingCompletionsForParent(state);
  }

  private emitParentTurnDiagnosticStatus(
    state: ParentState,
    diagnostics: ParentTurnDiagnostics,
  ): void {
    const support = diagnostics.admitted > 0 ? "supported" : "unsupported";
    const activeChildren = diagnostics.activeChildThreadIds.size;
    const authoritativeStart =
      diagnostics.observedChildThreadIds.size > 0 &&
      diagnostics.startFactChildThreadIds.size >= diagnostics.observedChildThreadIds.size;
    const authoritativeTerminal =
      diagnostics.observedChildThreadIds.size > 0 &&
      diagnostics.endedChildThreadIds.size >= diagnostics.observedChildThreadIds.size &&
      activeChildren === 0;
    this.emitDiagnostic({
      type: "codex.native_child.status",
      version: 1,
      runId: diagnostics.runId,
      ...(diagnostics.sessionKey ? { sessionKey: diagnostics.sessionKey } : {}),
      ...(diagnostics.sessionId ? { sessionId: diagnostics.sessionId } : {}),
      ...(diagnostics.agentId ? { agentId: diagnostics.agentId } : {}),
      parentTurnId: diagnostics.parentTurnId,
      parentThreadId: boundedDiagnosticId(state.parentThreadId),
      support,
      drain:
        support === "unsupported" || diagnostics.rolloutTurnsStarted === 0
          ? "not_applicable"
          : diagnostics.drainTimedOut
            ? "timed_out"
            : "completed",
      authoritativeStart,
      authoritativeTerminal,
      providerCallOwnership: diagnostics.rolloutTurnsStarted > 0,
      toolCallOwnership: diagnostics.rolloutTurnsStarted > 0,
      counts: {
        admitted: diagnostics.admitted,
        duplicates: diagnostics.duplicates,
        dropped: diagnostics.dropped,
        activeChildren,
      },
      ...(diagnostics.partialReasons.size > 0
        ? {
            partialReasons: [...diagnostics.partialReasons]
              .toSorted()
              .slice(0, MAX_NATIVE_CHILD_PARTIAL_REASONS),
          }
        : {}),
    });
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const state = this.resolveMirrorState(notification);
    if (state?.mirror) {
      try {
        state.mirror.handleNotification(notification);
      } catch (error) {
        embeddedAgentLog.warn("Failed to mirror Codex native subagent lifecycle event", {
          method: notification.method,
          error: formatErrorMessage(error),
        });
      }
    }
    this.markChildTurnStarted(notification);
    await this.handleChildSystemError(notification);
    this.captureChildAssistantMessage(notification);
    await this.handleChildTurnCompletion(notification);
    await this.handleCompletionNotification(notification);
  }

  private emitDiagnostic(event: TrustedDiagnosticEventInput): void {
    try {
      (this.runtime.emitTrustedDiagnosticEvent ?? emitTrustedDiagnosticEvent)(event);
    } catch (error) {
      embeddedAgentLog.debug("Codex native-child diagnostic emission failed open", {
        type: event.type,
        error: formatErrorMessage(error),
      });
    }
  }

  private recordChildLifecycle(params: {
    state: ParentState;
    childThreadId: string;
    sourceEventId: string;
    lifecycle: "started" | "activity" | "turn_started" | "turn_completed" | "ended";
    sourceTimestampMs?: number;
    childTurnId?: string;
    triggeringToolCallId?: string;
    outcome?: "completed" | "failed" | "cancelled" | "interrupted" | "timed_out";
    preferCurrentTurn?: boolean;
  }): void {
    const rawChildThreadId = params.childThreadId.trim();
    const childThreadId = boundedDiagnosticId(rawChildThreadId);
    const childState = this.childStates.get(rawChildThreadId);
    const activatesChild =
      params.lifecycle === "started" ||
      params.lifecycle === "activity" ||
      params.lifecycle === "turn_started";
    const terminalLifecycle = params.lifecycle === "turn_completed" || params.lifecycle === "ended";
    if (terminalLifecycle) {
      this.releaseChildActivityHold(childState);
    }
    const turnDiagnostics = params.childTurnId
      ? [...(childState?.diagnosticTurns.values() ?? [])].find(
          (turn) => turn.childTurnId === params.childTurnId,
        )?.diagnostics
      : undefined;
    const retainedDiagnostics = childState?.diagnostics;
    const retainedOwner =
      retainedDiagnostics &&
      (params.lifecycle === "ended" ||
        (childThreadId !== undefined &&
          retainedDiagnostics.activeChildThreadIds.has(childThreadId)));
    const currentOwner =
      params.preferCurrentTurn &&
      params.state.diagnostics &&
      !params.state.diagnostics.finalizing &&
      !params.state.diagnostics.finalized
        ? params.state.diagnostics
        : undefined;
    // Parent-scoped collaboration activity is the ownership handoff for a reused child.
    // Child-thread notifications alone may still belong to a detached prior parent turn.
    const diagnostics =
      turnDiagnostics ??
      currentOwner ??
      (retainedOwner ? retainedDiagnostics : params.state.diagnostics);
    if (!diagnostics) {
      return;
    }
    const sourceEventId = boundedDiagnosticId(params.sourceEventId);
    if (!childThreadId || !sourceEventId) {
      diagnostics.dropped += 1;
      diagnostics.partialReasons.add("invalid_identity");
      return;
    }
    if (params.lifecycle === "ended" && diagnostics.endedChildThreadIds.has(childThreadId)) {
      diagnostics.duplicates += 1;
      return;
    }
    const detachedContinuation =
      diagnostics.finalized &&
      (turnDiagnostics !== undefined || diagnostics.activeChildThreadIds.has(childThreadId));
    if (diagnostics.finalized && !detachedContinuation) {
      diagnostics.dropped += 1;
      diagnostics.partialReasons.add("post_finalization_event");
      if (!diagnostics.lateEventReported) {
        diagnostics.lateEventReported = true;
        this.emitParentTurnDiagnosticStatus(params.state, diagnostics);
      }
      return;
    }
    if (diagnostics.sourceEventIds.has(sourceEventId)) {
      diagnostics.duplicates += 1;
      return;
    }
    if (diagnostics.admitted >= MAX_NATIVE_CHILD_EVENTS_PER_TURN) {
      diagnostics.dropped += 1;
      diagnostics.partialReasons.add("event_limit");
      return;
    }
    const alreadyActive = diagnostics.activeChildThreadIds.has(childThreadId);
    if (!alreadyActive && activatesChild) {
      if (diagnostics.activeChildThreadIds.size >= MAX_NATIVE_CHILDREN_PER_TURN) {
        diagnostics.dropped += 1;
        diagnostics.partialReasons.add("active_child_limit");
        return;
      }
    }
    if (activatesChild && childState && !childState.activityHold) {
      childState.activityHold = retainSharedCodexAppServerClientActivityHoldIfCurrent(
        this.clientForActivityHold(),
      );
    }
    if (!alreadyActive && activatesChild) {
      diagnostics.activeChildThreadIds.add(childThreadId);
      diagnostics.observedChildThreadIds.add(childThreadId);
    }
    if (childState && !diagnostics.finalized) {
      childState.diagnostics = diagnostics;
    }
    if (params.lifecycle === "started") {
      diagnostics.startFactChildThreadIds.add(childThreadId);
    }
    if (terminalLifecycle) {
      if (alreadyActive) {
        diagnostics.activeChildThreadIds.delete(childThreadId);
        diagnostics.endedChildThreadIds.add(childThreadId);
      } else if (!diagnostics.observedChildThreadIds.has(childThreadId)) {
        diagnostics.partialReasons.add("terminal_without_active_child");
      }
    }
    diagnostics.sourceEventIds.add(sourceEventId);
    diagnostics.admitted += 1;
    const triggeringToolCallId = boundedOptionalDiagnosticId(childState?.triggeringToolCallId);
    const role = boundedOptionalDiagnosticId(childState?.agentRole);
    this.emitDiagnostic({
      type: "codex.native_child.lifecycle",
      version: 1,
      runId: diagnostics.runId,
      ...(diagnostics.sessionKey ? { sessionKey: diagnostics.sessionKey } : {}),
      ...(diagnostics.sessionId ? { sessionId: diagnostics.sessionId } : {}),
      ...(diagnostics.agentId ? { agentId: diagnostics.agentId } : {}),
      parentTurnId: diagnostics.parentTurnId,
      parentThreadId: boundedDiagnosticId(params.state.parentThreadId),
      sourceEventId,
      childThreadId,
      ...(triggeringToolCallId ? { triggeringToolCallId } : {}),
      ...(params.childTurnId ? { childTurnId: boundedDiagnosticId(params.childTurnId) } : {}),
      ...(role ? { role } : {}),
      lifecycle: params.lifecycle,
      sourceTimestampMs: params.sourceTimestampMs ?? Date.now(),
      ...(params.outcome ? { outcome: params.outcome } : {}),
    });
    if (childState && params.lifecycle === "ended") {
      childState.diagnostics = undefined;
    }
  }

  private startChildTurnDiagnostics(childState: ChildState, childTurnId: string): void {
    const state = this.parentStates.get(childState.parentThreadId);
    const currentDiagnostics = state?.diagnostics;
    const retainedDiagnostics = childState.diagnostics;
    const diagnostics = retainedDiagnostics?.activeChildThreadIds.has(childState.childThreadId)
      ? retainedDiagnostics
      : currentDiagnostics;
    if (
      !state ||
      !diagnostics ||
      (diagnostics.finalized && !diagnostics.activeChildThreadIds.has(childState.childThreadId))
    ) {
      return;
    }
    childState.diagnostics = diagnostics;
    const key = diagnosticTurnKey(diagnostics.parentTurnId, childTurnId);
    if (childState.diagnosticTurns.has(key)) {
      return;
    }
    const startMonitor =
      this.runtime.startCodexRolloutTraceMonitor ?? startCodexRolloutTraceMonitor;
    let monitor: CodexRolloutTraceMonitor | undefined;
    if (diagnostics.traceRoot) {
      try {
        monitor = startMonitor({
          traceRoot: diagnostics.traceRoot,
          threadId: childState.childThreadId,
          turnId: childTurnId,
          baseFields: {
            ...diagnostics.baseFields,
            nativeChildThreadId: boundedDiagnosticId(childState.childThreadId),
            nativeChildTurnId: boundedDiagnosticId(childTurnId),
            parentTurnId: diagnostics.parentTurnId,
          },
          capture: diagnostics.capture,
          log: embeddedAgentLog,
        });
      } catch (error) {
        diagnostics.partialReasons.add("child_rollout_monitor_start_error");
        embeddedAgentLog.debug("Codex child rollout monitor start failed open", {
          childThreadId: childState.childThreadId,
          childTurnId,
          error: formatErrorMessage(error),
        });
      }
    }
    if (monitor) {
      diagnostics.rolloutTurnsStarted += 1;
    } else {
      diagnostics.partialReasons.add("child_rollout_trace_unavailable");
    }
    childState.diagnosticTurns.set(key, {
      parentTurnId: diagnostics.parentTurnId,
      childTurnId,
      diagnostics,
      monitor,
    });
  }

  private finalizeChildTurnDiagnostics(
    childState: ChildState,
    turn: ChildTurnDiagnostics,
  ): Promise<CodexRolloutTraceFinalDrainResult | undefined> {
    if (turn.finalization) {
      return turn.finalization;
    }
    const diagnostics = turn.diagnostics;
    turn.finalization = turn.monitor
      ? Promise.resolve()
          .then(() => turn.monitor?.finalDrain())
          .finally(() => this.stopChildTurnDiagnosticMonitor(childState, turn))
          .then((drain) => {
            if (!drain) {
              return undefined;
            }
            if (!turn.completed) {
              turn.completed = true;
              diagnostics.rolloutTurnsCompleted += 1;
              if (!drain.complete) {
                diagnostics.drainTimedOut = true;
                diagnostics.partialReasons.add(`child_rollout_${drain.reason ?? "incomplete"}`);
              }
            }
            return drain;
          })
          .catch((error: unknown) => {
            diagnostics.drainTimedOut = true;
            diagnostics.partialReasons.add("child_rollout_finalization_error");
            embeddedAgentLog.debug("Codex child rollout finalization failed open", {
              childThreadId: childState.childThreadId,
              childTurnId: turn.childTurnId,
              error: formatErrorMessage(error),
            });
            return undefined;
          })
      : Promise.resolve(undefined);
    return turn.finalization;
  }

  private stopChildTurnDiagnosticMonitor(childState: ChildState, turn: ChildTurnDiagnostics): void {
    try {
      turn.monitor?.stop();
    } catch (error) {
      turn.diagnostics.partialReasons.add("child_rollout_monitor_stop_error");
      embeddedAgentLog.debug("Codex child rollout monitor stop failed open", {
        childThreadId: childState.childThreadId,
        childTurnId: turn.childTurnId,
        error: formatErrorMessage(error),
      });
    }
  }

  private stopDiagnosticTurnsForParent(parentTurnId: string): void {
    for (const childState of this.childStates.values()) {
      for (const [key, turn] of childState.diagnosticTurns) {
        if (turn.parentTurnId !== parentTurnId) {
          continue;
        }
        this.stopChildTurnDiagnosticMonitor(childState, turn);
        childState.diagnosticTurns.delete(key);
      }
    }
  }

  private deleteCompletedDiagnosticTurnsForParent(parentTurnId: string): void {
    for (const childState of this.childStates.values()) {
      for (const [key, turn] of childState.diagnosticTurns) {
        if (turn.parentTurnId === parentTurnId && turn.completed) {
          childState.diagnosticTurns.delete(key);
        }
      }
    }
  }

  private markChildTurnStarted(notification: CodexServerNotification): void {
    if (notification.method !== "turn/started") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    if (childState) {
      childState.settledWithoutCompletion = false;
      childState.transcriptTerminal = false;
      childState.completionObservedInParentMailbox = false;
      const turn = isJsonObject(params?.turn) ? params.turn : undefined;
      const childTurnId = readString(turn, "id")?.trim();
      const state = this.parentStates.get(childState.parentThreadId);
      if (state && childTurnId) {
        this.recordChildLifecycle({
          state,
          childThreadId: childState.childThreadId,
          childTurnId,
          sourceEventId: `turn-started:${childState.childThreadId}:${childTurnId}`,
          lifecycle: "turn_started",
          sourceTimestampMs: readEventTimestampMs(params, turn),
        });
        this.startChildTurnDiagnostics(childState, childTurnId);
      }
    }
  }

  private async handleChildSystemError(notification: CodexServerNotification): Promise<void> {
    if (notification.method !== "thread/status/changed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const status = isJsonObject(params?.status) ? params.status : undefined;
    if (readString(status, "type") !== "systemError") {
      return;
    }
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    if (childState) {
      childState.settledWithoutCompletion = true;
      await Promise.all(
        [...childState.diagnosticTurns.values()]
          .filter((turn) => !turn.completed)
          .map((turn) => this.finalizeChildTurnDiagnostics(childState, turn)),
      );
      const state = this.parentStates.get(childState.parentThreadId);
      if (state) {
        this.recordChildLifecycle({
          state,
          childThreadId: childState.childThreadId,
          sourceEventId: `thread-system-error:${childState.childThreadId}:${readEventTimestampMs(params)}`,
          lifecycle: "ended",
          outcome: "failed",
          sourceTimestampMs: readEventTimestampMs(params),
        });
      }
      await this.flushDeferredParentSettlements(childState.parentThreadId);
    }
  }

  private ensureParentTaskRuntime(state: ParentState): void {
    if (state.taskRuntime || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    state.taskRuntime = this.runtime.createAgentHarnessTaskRuntime({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      scope: state.taskRuntimeScope,
      runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    });
    state.mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        agentId: state.agentId,
      },
      state.taskRuntime,
    );
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readSpawnParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readSpawnAgentPath(thread);
      const agentRole = readSpawnAgentRole(thread);
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && childThreadId && parentThreadId) {
        this.registerChildThread(parentThreadId, childThreadId, { agentPath, agentRole });
        this.recordChildLifecycle({
          state,
          childThreadId,
          sourceEventId: `thread-started:${childThreadId}`,
          lifecycle: "started",
          sourceTimestampMs: readEventTimestampMs(params, thread),
        });
      }
      return state;
    }
    if (notification.method === "thread/status/changed") {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId ? this.childThreadParents.get(childThreadId) : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && parentThreadId) {
        // Codex multi-agent V2 exposes the child only through this parent-scoped
        // activity item; its later wait item has no receiver thread ids.
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          readString(item, "type") === "subAgentActivity"
        ) {
          const childThreadId = readString(item, "agentThreadId")?.trim();
          if (childThreadId) {
            // MultiAgentV2 uses the current collaboration call id for each activity.
            // Persistent children must bind a later turn to that turn's send/assign tool.
            const isSpawnActivity = normalizeToolName(readString(item, "kind")) === "started";
            this.registerChildThread(parentThreadId, childThreadId, {
              agentPath: readString(item, "agentPath"),
              triggeringToolCallId: readString(item, "id"),
            });
            this.recordChildLifecycle({
              state,
              childThreadId,
              sourceEventId:
                readString(item, "id") ?? `subagent-activity:${parentThreadId}:${childThreadId}`,
              lifecycle: isSpawnActivity ? "started" : "activity",
              sourceTimestampMs: readEventTimestampMs(params, item),
              preferCurrentTurn: true,
            });
          }
          return state;
        }
        const isSpawnAgentTool = normalizeToolName(readString(item, "tool")) === "spawnagent";
        const childThreadIds = isSpawnAgentTool
          ? new Set([
              ...readStringArray(item?.receiverThreadIds),
              ...readObjectStringKeys(item?.agentsStates),
            ])
          : new Set(readStringArray(item?.receiverThreadIds));
        for (const childThreadId of childThreadIds) {
          this.registerChildThread(
            parentThreadId,
            childThreadId,
            isSpawnAgentTool ? { triggeringToolCallId: readString(item, "id") } : {},
          );
          this.recordChildLifecycle({
            state,
            childThreadId,
            sourceEventId: `${readString(item, "id") ?? "collab-agent"}:${childThreadId}`,
            lifecycle: "activity",
            sourceTimestampMs: readEventTimestampMs(params, item),
            preferCurrentTurn: true,
          });
        }
      }
      return state;
    }
    return undefined;
  }

  private async handleCompletionNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const parentThreadId = params ? readString(params, "threadId")?.trim() : undefined;
    const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    if (!state) {
      return;
    }
    const completions = extractCodexNativeSubagentCompletions(notification);
    for (const nativeCompletion of completions) {
      const childThreadId = this.resolveChildThreadIdForAgentPath(
        state.parentThreadId,
        nativeCompletion.agentPath,
      );
      if (childThreadId) {
        // V2 completion notifications are the last authoritative source for
        // the path. Refresh state before emitting the terminal diagnostic so
        // Langfuse can retain the role even when the activity item was raced.
        this.registerChildThread(state.parentThreadId, childThreadId, {
          agentPath: nativeCompletion.agentPath,
        });
      }
      const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
      if (!childState || childState.parentThreadId !== state.parentThreadId) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion = toThreadCompletion(nativeCompletion, childState.childThreadId);
      // Upstream emits this item only after get_pending_input drains the mailbox into this
      // parent turn, via wait_agent or the next automatic model step. Enqueue alone emits none.
      if (state.diagnostics) {
        // Codex emits this trusted item only after the parent drains the child result from its
        // mailbox. Preserve that fact across the parent final-drain race so OpenClaw does not
        // enqueue a second requester-agent announce for a result the parent already consumed.
        childState.completionObservedInParentMailbox = true;
      }
      await this.processChildCompletion(state, childState, completion);
    }
  }

  private captureChildAssistantMessage(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    if (!childState || childState.transcriptTerminal) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const turnId = readString(params, "turnId");
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");
      if (turnId && itemId && delta) {
        this.recordChildAssistantMessage(childState, turnId, itemId, delta);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const turnId = readString(params, "turnId");
    const item = isJsonObject(params?.item) ? params.item : undefined;
    this.captureChildAssistantMessageItem(childState, turnId, item);
  }

  private captureChildAssistantMessageItem(
    childState: ChildState,
    turnId: string | undefined,
    item: JsonObject | undefined,
  ): void {
    if (readString(item, "type") !== "agentMessage") {
      return;
    }
    const itemId = readString(item, "id");
    if (!turnId || !itemId) {
      return;
    }
    const assistantMessages = this.getChildAssistantMessages(childState, turnId);
    const phase = readString(item, "phase");
    if (phase === "commentary") {
      assistantMessages.commentaryIds.add(itemId);
    } else {
      assistantMessages.finalMessageIds.add(itemId);
    }
    const text = readString(item, "text");
    if (text) {
      this.recordChildAssistantMessage(childState, turnId, itemId, text, { replace: true });
    }
  }

  private captureChildTurnAssistantMessages(childState: ChildState, turn: JsonObject): void {
    const turnId = readString(turn, "id");
    if (!turnId || !Array.isArray(turn.items)) {
      return;
    }
    for (const item of turn.items) {
      this.captureChildAssistantMessageItem(
        childState,
        turnId,
        isJsonObject(item) ? item : undefined,
      );
    }
  }

  private recordChildAssistantMessage(
    childState: ChildState,
    turnId: string,
    itemId: string,
    text: string,
    options: { replace?: boolean } = {},
  ): void {
    const assistantMessages = this.getChildAssistantMessages(childState, turnId);
    if (!assistantMessages.texts.has(itemId)) {
      assistantMessages.order.push(itemId);
    }
    const existing = assistantMessages.texts.get(itemId) ?? "";
    assistantMessages.texts.set(itemId, options.replace ? text : `${existing}${text}`);
  }

  private getChildAssistantMessages(
    childState: ChildState,
    turnId: string,
  ): ChildAssistantMessages {
    const existing = childState.assistantMessagesByTurn.get(turnId);
    if (existing) {
      return existing;
    }
    const assistantMessages: ChildAssistantMessages = {
      texts: new Map<string, string>(),
      order: [],
      commentaryIds: new Set<string>(),
      finalMessageIds: new Set<string>(),
    };
    childState.assistantMessagesByTurn.set(turnId, assistantMessages);
    return assistantMessages;
  }

  private async handleChildTurnCompletion(notification: CodexServerNotification): Promise<void> {
    if (notification.method !== "turn/completed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    const turn = isJsonObject(params?.turn) ? params.turn : undefined;
    const childTurnId = turn ? readString(turn, "id")?.trim() : undefined;
    if (state && childState && turn && childTurnId) {
      const status = readString(turn, "status");
      const recordTurnCompleted = () =>
        this.recordChildLifecycle({
          state,
          childThreadId: childState.childThreadId,
          childTurnId,
          sourceEventId: `turn-completed:${childState.childThreadId}:${childTurnId}:${status ?? "unknown"}`,
          lifecycle: "turn_completed",
          sourceTimestampMs: readEventTimestampMs(params, turn),
          outcome: childTurnOutcome(status),
        });
      this.startChildTurnDiagnostics(childState, childTurnId);
      const diagnosticTurn = [...childState.diagnosticTurns.values()].find(
        (candidate) => candidate.childTurnId === childTurnId,
      );
      if (diagnosticTurn) {
        diagnosticTurn.finalization = this.finalizeChildTurnDiagnostics(
          childState,
          diagnosticTurn,
        ).finally(recordTurnCompleted);
        void diagnosticTurn.finalization.catch((error: unknown) => {
          diagnosticTurn.diagnostics.partialReasons.add("child_rollout_finalization_error");
          embeddedAgentLog.debug("Codex child rollout finalization failed open", {
            childThreadId: childState.childThreadId,
            childTurnId,
            error: formatErrorMessage(error),
          });
        });
      } else {
        recordTurnCompleted();
      }
    }
    if (childState && turn && readString(turn, "status") === "interrupted") {
      const turnId = childTurnId;
      if (turnId) {
        childState.assistantMessagesByTurn.delete(turnId);
      }
      // Codex keeps interrupted agents resumable but intentionally sends no
      // parent completion, so one-shot cleanup may settle until another turn starts.
      childState.settledWithoutCompletion = true;
      await this.flushDeferredParentSettlements(childState.parentThreadId);
      return;
    }
    if (childState && turn) {
      this.captureChildTurnAssistantMessages(childState, turn);
    }
    const completion = childState && turn ? toChildTurnCompletion(childState, turn) : undefined;
    if (!state || !childState || childState.transcriptTerminal || !completion) {
      return;
    }
    await this.processChildCompletion(state, childState, completion);
  }

  private async processChildCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
  ): Promise<void> {
    if (shouldWaitForTranscriptCompletion(completion, this.codexHome)) {
      // Codex can notify `completed: null` before the child transcript exposes
      // its final assistant message; poll briefly before delivering the no-final fallback.
      const eventAt = Date.now();
      const reconciled = await this.reconcileChildTranscript(childState.childThreadId);
      if (!reconciled) {
        this.scheduleTranscriptPoll(childState);
        this.scheduleNoFinalCompletionFallback(state, childState, completion, eventAt);
      }
      return;
    }
    await this.processCompletion(state, completion);
  }

  async reconcileChildTranscript(
    childThreadId: string,
    options: { allowTreeScan?: boolean } = {},
  ): Promise<boolean> {
    const childState = this.childStates.get(childThreadId.trim());
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    if (!childState || !state || childState.transcriptTerminal) {
      return false;
    }
    const codexHome = this.codexHome;
    if (!codexHome) {
      return false;
    }
    const completion = await this.findTranscriptCompletionForChild(childState, options);
    if (!completion) {
      return false;
    }
    const transcriptParentThreadId = completion.completion.parentThreadId;
    if (transcriptParentThreadId && transcriptParentThreadId !== state.parentThreadId) {
      embeddedAgentLog.warn("Codex native subagent transcript parent did not match monitor state", {
        childThreadId: childState.childThreadId,
        expectedParentThreadId: state.parentThreadId,
        transcriptParentThreadId,
      });
      childState.transcriptPath = undefined;
      this.transcriptPathsByChildThreadId.delete(childState.childThreadId);
      return false;
    }
    await this.processCompletion(state, completion.completion, completion.completion.completedAt);
    return true;
  }

  private async processCompletion(
    state: ParentState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = Date.now(),
  ): Promise<void> {
    this.recordChildLifecycle({
      state,
      childThreadId: completion.childThreadId,
      sourceEventId: `child-completion:${createHash("sha256")
        .update(buildCompletionDedupeKey(state.parentThreadId, completion))
        .digest("hex")}`,
      lifecycle: "ended",
      sourceTimestampMs: eventAt,
      outcome:
        completion.status === "succeeded"
          ? "completed"
          : completion.status === "cancelled"
            ? "cancelled"
            : "failed",
    });
    this.finalizeCompletionTask(completion, eventAt);
    const childState = this.childStates.get(completion.childThreadId);
    if (childState) {
      childState.transcriptTerminal = true;
      if (childState.transcriptPollTimer) {
        clearTimeout(childState.transcriptPollTimer);
        childState.transcriptPollTimer = undefined;
      }
      if (childState.noFinalCompletionFallbackTimer) {
        clearTimeout(childState.noFinalCompletionFallbackTimer);
        childState.noFinalCompletionFallbackTimer = undefined;
      }
    }
    if (!state.requesterSessionKey) {
      await this.flushDeferredParentSettlements(state.parentThreadId);
      return;
    }
    const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
    if (state.deliveredCompletionKeys.has(completionKey)) {
      return;
    }
    if (childState?.completionObservedInParentMailbox) {
      this.markMailboxCompletionDelivered(state, childState, completion, completionKey);
      await this.flushDeferredParentSettlements(state.parentThreadId);
      return;
    }
    const deliveryState =
      childState ?? this.ensureChildState(state.parentThreadId, completion.childThreadId);
    deliveryState.pendingCompletion = completion;
    deliveryState.pendingCompletionEventAt = eventAt;
    this.markCompletionDeliveryPending(completion);
    const activeParentTurn = state.diagnostics;
    if (activeParentTurn && !activeParentTurn.finalizing && !activeParentTurn.finalized) {
      // A child terminal event can race the parent's final model step. Hold it until the
      // parent mailbox proves consumption or root finalization starts detached delivery.
      return;
    }
    await this.deliverPendingCompletion(state, deliveryState);
  }

  private deliverPendingCompletionsForParent(state: ParentState): void {
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId !== state.parentThreadId || !childState.pendingCompletion) {
        continue;
      }
      void this.deliverPendingCompletion(state, childState);
    }
  }

  private async deliverPendingCompletion(
    state: ParentState,
    childState: ChildState,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
    if (
      state.deliveredCompletionKeys.has(completionKey) ||
      childState.deliveringCompletionKey === completionKey
    ) {
      return;
    }
    childState.deliveringCompletionKey = completionKey;
    try {
      if (await this.observeMailboxCompletionInParentTranscript(state, childState, completion)) {
        this.markMailboxCompletionDelivered(state, childState, completion, completionKey);
        return;
      }
      const delivery = await this.runtime.deliverAgentHarnessTaskCompletion({
        scope: state.taskRuntimeScope,
        childSessionKey: codexNativeSubagentRunId(completion.childThreadId),
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${state.parentThreadId}:${completion.childThreadId}:${completion.status}`,
        announceType: "Codex native subagent",
        taskLabel: "Codex native subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        state.deliveredCompletionKeys.add(completionKey);
        childState.pendingCompletion = undefined;
        childState.pendingCompletionEventAt = undefined;
        childState.completionDeliveryAttempt = 0;
        if (childState.completionDeliveryTimer) {
          clearTimeout(childState.completionDeliveryTimer);
          childState.completionDeliveryTimer = undefined;
        }
        this.markCompletionDeliveryDelivered(completion);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      this.markCompletionDeliveryPending(completion, error);
      this.scheduleCompletionDeliveryRetry(childState);
    } catch (error) {
      this.markCompletionDeliveryPending(completion, formatErrorMessage(error));
      this.scheduleCompletionDeliveryRetry(childState);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: formatErrorMessage(error),
      });
    } finally {
      childState.deliveringCompletionKey = undefined;
      await this.flushDeferredParentSettlements(state.parentThreadId);
    }
  }

  private markMailboxCompletionDelivered(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    completionKey: string,
  ): void {
    if (childState.pendingCompletion) {
      state.deliveredCompletionKeys.add(
        buildCompletionDedupeKey(state.parentThreadId, childState.pendingCompletion),
      );
    }
    state.deliveredCompletionKeys.add(completionKey);
    childState.pendingCompletion = undefined;
    childState.pendingCompletionEventAt = undefined;
    if (childState.completionDeliveryTimer) {
      clearTimeout(childState.completionDeliveryTimer);
      childState.completionDeliveryTimer = undefined;
    }
    this.markCompletionDeliveryDelivered(completion);
  }

  private async observeMailboxCompletionInParentTranscript(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
  ): Promise<boolean> {
    const codexHome = this.codexHome;
    const agentPath = childState.agentPath;
    if (!codexHome || !agentPath) {
      return false;
    }
    const transcriptPath =
      state.transcriptPath ??
      (await findTranscriptPath({ codexHome, childThreadId: state.parentThreadId }));
    if (!transcriptPath) {
      return false;
    }
    state.transcriptPath = transcriptPath;
    const observed = await transcriptHasMailboxCompletion({
      transcriptPath,
      agentPath,
      completion,
      observedAfter: childState.pendingCompletionEventAt,
    });
    if (observed) {
      childState.completionObservedInParentMailbox = true;
    }
    return observed;
  }

  private markCompletionDeliveryPending(
    completion: CodexNativeSubagentCompletion,
    error?: string,
  ): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    taskRuntime.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "pending",
      ...(error ? { error } : {}),
    });
  }

  private markCompletionDeliveryDelivered(completion: CodexNativeSubagentCompletion): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    taskRuntime.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "delivered",
    });
  }

  private scheduleCompletionDeliveryRetry(childState: ChildState): void {
    if (!childState.pendingCompletion || childState.completionDeliveryTimer) {
      return;
    }
    const attempt = childState.completionDeliveryAttempt;
    const delayMs =
      this.completionDeliveryRetryDelaysMs[
        Math.min(attempt, this.completionDeliveryRetryDelaysMs.length - 1)
      ];
    childState.completionDeliveryAttempt += 1;
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      const state = this.parentStates.get(childState.parentThreadId);
      if (!state) {
        return;
      }
      void this.deliverPendingCompletion(state, childState);
    }, delayMs);
    unrefTimer(childState.completionDeliveryTimer);
  }

  private hasUnsettledChildren(parentThreadId: string): boolean {
    for (const childState of this.childStates.values()) {
      if (
        childState.parentThreadId === parentThreadId &&
        (childState.pendingCompletion !== undefined ||
          childState.deliveringCompletionKey !== undefined ||
          (!childState.transcriptTerminal && !childState.settledWithoutCompletion))
      ) {
        return true;
      }
    }
    return false;
  }

  private async flushDeferredParentSettlements(parentThreadId: string): Promise<void> {
    if (this.hasUnsettledChildren(parentThreadId)) {
      return;
    }
    const state = this.parentStates.get(parentThreadId);
    const callback = state?.deferredSettlement;
    if (!state || !callback) {
      return;
    }
    state.deferredSettlement = undefined;
    await this.runDeferredParentSettlement(parentThreadId, callback);
  }

  private async runDeferredParentSettlement(
    parentThreadId: string,
    callback: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      embeddedAgentLog.warn("Failed to finish deferred Codex app-server cleanup", {
        parentThreadId,
        error: formatErrorMessage(error),
      });
    }
  }

  private finalizeCompletionTask(completion: CodexNativeSubagentCompletion, eventAt: number): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    this.getMirrorForChild(completion.childThreadId)?.markAuthoritativeCompletion(
      completion.childThreadId,
    );
    taskRuntime.finalizeTaskRunByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      status: completion.status,
      endedAt: eventAt,
      lastEventAt: eventAt,
      ...(completion.status === "succeeded" ? {} : { error: completion.result }),
      progressSummary: completion.result,
      terminalSummary: completion.result,
    });
  }

  private getTaskRuntimeForChild(childThreadId: string): AgentHarnessTaskRuntime | undefined {
    const childState = this.childStates.get(childThreadId.trim());
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    return state?.taskRuntime;
  }

  private getMirrorForChild(childThreadId: string): CodexNativeSubagentTaskMirror | undefined {
    const childState = this.childStates.get(childThreadId.trim());
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    return state?.mirror;
  }

  private registerChildThread(
    parentThreadId: string,
    childThreadId: string,
    options: {
      agentPath?: string;
      agentRole?: string;
      scheduleTranscriptPoll?: boolean;
      triggeringToolCallId?: string;
    } = {},
  ): void {
    const normalizedParentThreadId = parentThreadId.trim();
    const normalizedChildThreadId = childThreadId.trim();
    if (!normalizedParentThreadId || !normalizedChildThreadId) {
      return;
    }
    this.childThreadParents.set(normalizedChildThreadId, normalizedParentThreadId);
    this.childThreadIdsByAgentPath.set(
      buildParentAgentPathKey(normalizedParentThreadId, normalizedChildThreadId),
      normalizedChildThreadId,
    );
    const agentPath = normalizeOptionalString(options.agentPath);
    const agentRole = normalizeOptionalString(options.agentRole);
    const state = this.parentStates.get(normalizedParentThreadId);
    if (state?.mirror && (this.codexHome || agentPath)) {
      state.mirror.markAuthoritativeCompletionExpected(normalizedChildThreadId);
    }
    if (agentPath) {
      this.childThreadIdsByAgentPath.set(
        buildParentAgentPathKey(normalizedParentThreadId, agentPath),
        normalizedChildThreadId,
      );
    }
    let childState = this.childStates.get(normalizedChildThreadId);
    if (!childState) {
      childState = {
        childThreadId: normalizedChildThreadId,
        parentThreadId: normalizedParentThreadId,
        ...(agentPath ? { agentPath } : {}),
        ...(agentRole ? { agentRole } : {}),
        ...(options.triggeringToolCallId
          ? { triggeringToolCallId: options.triggeringToolCallId }
          : {}),
        assistantMessagesByTurn: new Map<string, ChildAssistantMessages>(),
        transcriptPollAttempt: 0,
        transcriptTerminal: false,
        completionDeliveryAttempt: 0,
        settledWithoutCompletion: false,
        completionObservedInParentMailbox: false,
        diagnosticTurns: new Map<string, ChildTurnDiagnostics>(),
      };
      this.childStates.set(normalizedChildThreadId, childState);
    } else if (childState.parentThreadId !== normalizedParentThreadId) {
      this.releaseChildActivityHold(childState);
      childState.parentThreadId = normalizedParentThreadId;
    }
    if (agentPath) {
      childState.agentPath = agentPath;
    }
    if (agentRole) {
      childState.agentRole = agentRole;
    }
    if (options.triggeringToolCallId) {
      childState.triggeringToolCallId = options.triggeringToolCallId;
    }
    if (options.scheduleTranscriptPoll !== false) {
      this.scheduleTranscriptPoll(childState);
    }
  }

  private releaseChildActivityHold(childState: ChildState | undefined): void {
    const release = childState?.activityHold;
    if (!release) {
      return;
    }
    childState.activityHold = undefined;
    release();
  }

  private clientForActivityHold(): CodexAppServerClient {
    return this.client as CodexAppServerClient;
  }

  private ensureChildState(parentThreadId: string, childThreadId: string): ChildState {
    this.registerChildThread(parentThreadId, childThreadId);
    return this.childStates.get(childThreadId.trim())!;
  }

  private resolveChildThreadIdForAgentPath(
    parentThreadId: string,
    agentPath: string,
  ): string | undefined {
    const mapped = this.childThreadIdsByAgentPath.get(
      buildParentAgentPathKey(parentThreadId, agentPath),
    );
    if (mapped) {
      return mapped;
    }
    const exactChild = this.childStates.get(agentPath);
    return exactChild?.parentThreadId === parentThreadId ? exactChild.childThreadId : undefined;
  }

  private scheduleTranscriptPoll(childState: ChildState): void {
    if (!this.codexHome || childState.transcriptTerminal || childState.transcriptPollTimer) {
      return;
    }
    const attempt = childState.transcriptPollAttempt;
    const delayMs =
      this.transcriptPollDelaysMs[Math.min(attempt, this.transcriptPollDelaysMs.length - 1)];
    childState.transcriptPollAttempt += 1;
    childState.transcriptPollTimer = setTimeout(() => {
      childState.transcriptPollTimer = undefined;
      void this.reconcileChildTranscript(childState.childThreadId)
        .catch((error: unknown) => {
          embeddedAgentLog.warn("Failed to reconcile Codex native subagent transcript", {
            childThreadId: childState.childThreadId,
            error: formatErrorMessage(error),
          });
          return false;
        })
        .then((reconciled) => {
          if (!reconciled) {
            this.scheduleTranscriptPoll(childState);
          }
        });
    }, delayMs);
    unrefTimer(childState.transcriptPollTimer);
  }

  private scheduleNoFinalCompletionFallback(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): void {
    if (childState.transcriptTerminal || childState.noFinalCompletionFallbackTimer) {
      return;
    }
    const delayMs = noFinalCompletionFallbackDelayMs(this.transcriptPollDelaysMs);
    childState.noFinalCompletionFallbackTimer = setTimeout(() => {
      childState.noFinalCompletionFallbackTimer = undefined;
      void this.deliverNoFinalCompletionFallback(state, childState, completion, eventAt);
    }, delayMs);
    unrefTimer(childState.noFinalCompletionFallbackTimer);
  }

  private async deliverNoFinalCompletionFallback(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): Promise<void> {
    const reconciled = await this.reconcileChildTranscript(childState.childThreadId).catch(
      (error: unknown): false => {
        embeddedAgentLog.warn("Failed to reconcile Codex native subagent transcript", {
          childThreadId: childState.childThreadId,
          error: formatErrorMessage(error),
        });
        return false;
      },
    );
    if (!reconciled && !childState.transcriptTerminal) {
      await this.processCompletion(state, completion, eventAt);
    }
  }

  private clearTimers(): void {
    if (this.taskRowReconcileTimer) {
      clearInterval(this.taskRowReconcileTimer);
      this.taskRowReconcileTimer = undefined;
    }
    for (const childState of this.childStates.values()) {
      for (const turn of childState.diagnosticTurns.values()) {
        this.stopChildTurnDiagnosticMonitor(childState, turn);
      }
      childState.diagnosticTurns.clear();
      if (childState.transcriptPollTimer) {
        clearTimeout(childState.transcriptPollTimer);
        childState.transcriptPollTimer = undefined;
      }
      if (childState.completionDeliveryTimer) {
        clearTimeout(childState.completionDeliveryTimer);
        childState.completionDeliveryTimer = undefined;
      }
      if (childState.noFinalCompletionFallbackTimer) {
        clearTimeout(childState.noFinalCompletionFallbackTimer);
        childState.noFinalCompletionFallbackTimer = undefined;
      }
    }
  }

  private startTaskRowReconciler(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.taskRowReconcileTimer = setInterval(
      () => {
        void this.reconcileKnownTaskRows().catch((error: unknown) => {
          embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
            error: formatErrorMessage(error),
          });
        });
      },
      Math.max(1, Math.floor(intervalMs)),
    );
    unrefTimer(this.taskRowReconcileTimer);
  }

  async reconcileKnownTaskRows(): Promise<void> {
    if (!this.codexHome) {
      return;
    }
    for (const state of this.parentStates.values()) {
      await this.reconcileKnownTaskRowsForParent(state);
    }
  }

  private async reconcileExistingRunningTasksForParent(state: ParentState): Promise<void> {
    if (!this.codexHome || !state.taskRuntime) {
      return;
    }
    const tasks = state.taskRuntime.listTaskRecords();
    const candidates: Array<{ childThreadId: string; childState: ChildState }> = [];
    for (const task of tasks) {
      if (!this.shouldReconcileCodexNativeTask(task)) {
        continue;
      }
      if (state.requesterSessionKey && task.requesterSessionKey !== state.requesterSessionKey) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      if (!childThreadId) {
        continue;
      }
      this.registerChildThread(state.parentThreadId, childThreadId, {
        scheduleTranscriptPoll: false,
      });
      const childState = this.childStates.get(childThreadId);
      if (childState && !childState.transcriptPollTimer) {
        candidates.push({ childThreadId, childState });
      }
    }
    await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
    for (const { childThreadId, childState } of candidates) {
      const reconciled = await this.reconcileChildTranscript(childThreadId, {
        allowTreeScan: false,
      });
      if (!reconciled) {
        this.scheduleTranscriptPoll(childState);
      }
    }
  }

  private async reconcileKnownTaskRowsForParent(state: ParentState): Promise<void> {
    if (!this.codexHome || !state.taskRuntime) {
      return;
    }
    const tasks = state.taskRuntime.listTaskRecords();
    const candidates: Array<{
      task: AgentHarnessTaskRecord;
      childThreadId: string;
      childState: ChildState;
    }> = [];
    for (const task of tasks) {
      if (!this.shouldReconcileCodexNativeTask(task)) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      if (!childThreadId) {
        continue;
      }
      this.registerChildThread(state.parentThreadId, childThreadId, {
        scheduleTranscriptPoll: false,
      });
      const childState = this.childStates.get(childThreadId);
      if (!childState || childState.transcriptPollTimer) {
        continue;
      }
      candidates.push({ task, childThreadId, childState });
    }
    await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
    for (const { task, childThreadId, childState } of candidates) {
      const transcriptCompletion = await this.findTranscriptCompletionForChild(childState, {
        allowTreeScan: false,
      });
      if (!transcriptCompletion) {
        this.scheduleTranscriptPoll(childState);
        continue;
      }
      const parentThreadId =
        transcriptCompletion.completion.parentThreadId ??
        this.childThreadParents.get(childThreadId);
      if (!parentThreadId) {
        embeddedAgentLog.warn("Codex native subagent transcript did not include a parent thread", {
          childThreadId,
          transcriptPath: transcriptCompletion.transcriptPath,
        });
        continue;
      }
      if (parentThreadId !== state.parentThreadId) {
        continue;
      }
      state.agentId = state.agentId ?? task.agentId;
      await this.processCompletion(
        state,
        transcriptCompletion.completion,
        transcriptCompletion.completion.completedAt,
      );
    }
  }

  private shouldReconcileCodexNativeTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.runtime !== "subagent" ||
      task.taskKind !== "codex-native" ||
      !task.runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)
    ) {
      return false;
    }
    if (
      task.status === "running" ||
      task.status === "queued" ||
      task.deliveryStatus === "pending"
    ) {
      return true;
    }
    return task.deliveryStatus === "not_applicable" && this.isRecentTerminalTask(task);
  }

  private isRecentTerminalTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.status !== "succeeded" &&
      task.status !== "failed" &&
      task.status !== "timed_out" &&
      task.status !== "cancelled" &&
      task.status !== "lost"
    ) {
      return false;
    }
    const earliestRelevantAt = this.startedAt - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
    return [task.createdAt, task.startedAt, task.endedAt, task.lastEventAt].some(
      (timestamp) => typeof timestamp === "number" && timestamp >= earliestRelevantAt,
    );
  }

  private async primeTranscriptPathCacheForChildren(
    childStates: readonly ChildState[],
  ): Promise<void> {
    const codexHome = this.codexHome;
    if (!codexHome) {
      return;
    }
    const missingChildThreadIds = new Set(
      childStates
        .filter(
          (childState) =>
            !childState.transcriptPath &&
            !this.transcriptPathsByChildThreadId.has(childState.childThreadId),
        )
        .map((childState) => childState.childThreadId),
    );
    if (missingChildThreadIds.size === 0) {
      return;
    }
    const transcriptPaths = await findTranscriptPaths({
      codexHome,
      childThreadIds: missingChildThreadIds,
    });
    for (const [childThreadId, transcriptPath] of transcriptPaths) {
      this.transcriptPathsByChildThreadId.set(childThreadId, transcriptPath);
      const childState = this.childStates.get(childThreadId);
      if (childState) {
        childState.transcriptPath = transcriptPath;
      }
    }
  }

  private async findTranscriptCompletionForChild(
    childState: ChildState,
    options: { allowTreeScan?: boolean } = {},
  ): Promise<{ transcriptPath: string; completion: TranscriptCompletion } | undefined> {
    const codexHome = this.codexHome;
    if (!codexHome) {
      return undefined;
    }
    const transcriptPath =
      childState.transcriptPath ??
      this.transcriptPathsByChildThreadId.get(childState.childThreadId);
    const completion = await findTranscriptCompletion({
      codexHome,
      childThreadId: childState.childThreadId,
      transcriptPath,
      allowTreeScan: options.allowTreeScan ?? true,
    });
    if (completion) {
      childState.transcriptPath = completion.transcriptPath;
      this.transcriptPathsByChildThreadId.set(childState.childThreadId, completion.transcriptPath);
    }
    return completion;
  }
}

function buildCompletionDedupeKey(
  parentThreadId: string,
  completion: CodexNativeSubagentCompletion,
): string {
  const hash = createHash("sha256").update(completion.result).digest("hex").slice(0, 16);
  return `${parentThreadId}:${completion.childThreadId}:${completion.status}:${hash}`;
}

function toChildTurnCompletion(
  childState: ChildState,
  turn: JsonObject,
): CodexNativeSubagentCompletion | undefined {
  const status = readString(turn, "status");
  if (status === "completed") {
    const turnId = readString(turn, "id");
    const result = turnId ? lastChildAssistantMessage(childState, turnId) : undefined;
    return {
      childThreadId: childState.childThreadId,
      status: "succeeded",
      statusLabel: result ? "turn_completed" : "completed_without_final_message",
      result: result ?? "Codex native subagent completed without a final assistant message.",
    };
  }
  if (status === "failed") {
    return {
      childThreadId: childState.childThreadId,
      status: "failed",
      statusLabel: "turn_failed",
      result: readTurnErrorMessage(turn) ?? "Codex native subagent failed.",
    };
  }
  return undefined;
}

function lastChildAssistantMessage(childState: ChildState, turnId: string): string | undefined {
  const assistantMessages = childState.assistantMessagesByTurn.get(turnId);
  if (!assistantMessages) {
    return undefined;
  }
  for (let index = assistantMessages.order.length - 1; index >= 0; index -= 1) {
    const itemId = assistantMessages.order[index];
    if (
      assistantMessages.finalMessageIds.has(itemId) &&
      !assistantMessages.commentaryIds.has(itemId)
    ) {
      const text = normalizeOptionalString(assistantMessages.texts.get(itemId));
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

function buildParentAgentPathKey(parentThreadId: string, agentPath: string): string {
  return `${parentThreadId}\0${agentPath}`;
}

function toThreadCompletion(
  completion: CodexNativeSubagentNotificationCompletion,
  childThreadId: string,
): CodexNativeSubagentCompletion {
  return {
    childThreadId,
    status: completion.status,
    statusLabel: completion.statusLabel,
    result: completion.result,
  };
}

function shouldWaitForTranscriptCompletion(
  completion: CodexNativeSubagentCompletion,
  codexHome: string | undefined,
): boolean {
  return Boolean(
    codexHome &&
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message",
  );
}

function noFinalCompletionFallbackDelayMs(delays: readonly number[]): number {
  const first = delays[0] ?? 0;
  const second = delays[1] ?? 0;
  return Math.max(1, first + second);
}

function readSpawnParentThreadId(thread: JsonObject | undefined): string | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
  return readString(spawn, "parent_thread_id")?.trim();
}

function readSpawnAgentPath(thread: JsonObject | undefined): string | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
  return readString(spawn, "agent_path")?.trim();
}

function readSpawnAgentRole(thread: JsonObject | undefined): string | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
  return readString(spawn, "agent_role")?.trim() || readString(thread, "agentRole")?.trim();
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readObjectStringKeys(value: JsonValue | undefined): string[] {
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.keys(value).filter((entry) => entry.trim() !== "");
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

async function findTranscriptCompletion(params: {
  codexHome: string;
  childThreadId: string;
  transcriptPath?: string;
  allowTreeScan?: boolean;
}): Promise<
  | {
      transcriptPath: string;
      completion: TranscriptCompletion;
    }
  | undefined
> {
  const transcriptPath =
    params.transcriptPath ??
    (params.allowTreeScan === false
      ? undefined
      : await findTranscriptPath({
          codexHome: params.codexHome,
          childThreadId: params.childThreadId,
        }));
  if (!transcriptPath) {
    return undefined;
  }
  const completion = await readTranscriptCompletion(transcriptPath, params.childThreadId);
  return completion ? { transcriptPath, completion } : undefined;
}

async function findTranscriptPaths(params: {
  codexHome: string;
  childThreadIds: ReadonlySet<string>;
}): Promise<Map<string, string>> {
  const sessionsDir = path.join(params.codexHome, "sessions");
  const found = new Map<string, string>();
  const remaining = new Set(params.childThreadIds);
  const stack = [sessionsDir];
  while (stack.length > 0 && remaining.size > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const rolloutMatch = entry.name.match(CODEX_ROLLOUT_FILENAME_RE);
      if (rolloutMatch) {
        const childThreadId = rolloutMatch[1];
        if (remaining.delete(childThreadId)) {
          found.set(childThreadId, entryPath);
        }
        continue;
      }
      for (const childThreadId of remaining) {
        if (entry.name.includes(childThreadId)) {
          found.set(childThreadId, entryPath);
          remaining.delete(childThreadId);
          break;
        }
      }
    }
  }
  return found;
}

async function findTranscriptPath(params: {
  codexHome: string;
  childThreadId: string;
}): Promise<string | undefined> {
  const sessionsDir = path.join(params.codexHome, "sessions");
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      const rolloutMatch = entry.name.match(CODEX_ROLLOUT_FILENAME_RE);
      if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        (rolloutMatch
          ? rolloutMatch[1] === params.childThreadId
          : entry.name.includes(params.childThreadId))
      ) {
        return entryPath;
      }
    }
  }
  return undefined;
}

async function readTranscriptCompletion(
  transcriptPath: string,
  childThreadId: string,
): Promise<TranscriptCompletion | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }
  let parentThreadId: string | undefined;
  let completion: TranscriptCompletion | undefined;
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: JsonValue;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isJsonObject(entry)) {
      continue;
    }
    const payload = isJsonObject(entry.payload) ? entry.payload : undefined;
    if (!payload) {
      continue;
    }
    if (readString(entry, "type") === "session_meta") {
      parentThreadId = readTranscriptParentThreadId(payload) ?? parentThreadId;
      continue;
    }
    if (readString(entry, "type") !== "event_msg") {
      continue;
    }
    const payloadType = readString(payload, "type");
    if (payloadType === "task_complete") {
      const result =
        readString(payload, "last_agent_message")?.trim() || readString(payload, "message")?.trim();
      completion = {
        childThreadId,
        parentThreadId,
        status: "succeeded",
        statusLabel: result ? "task_complete" : "completed_without_final_message",
        result: result ?? "Codex native subagent completed without a final assistant message.",
        completedAt: secondsToMillis(readNumber(payload, "completed_at")) ?? readTimestamp(entry),
      };
    } else if (payloadType === "task_failed") {
      const result =
        readString(payload, "last_agent_message")?.trim() ||
        readString(payload, "error")?.trim() ||
        readString(payload, "message")?.trim() ||
        "Codex native subagent failed.";
      completion = {
        childThreadId,
        parentThreadId,
        status: "failed",
        statusLabel: "task_failed",
        result,
        completedAt: readTimestamp(entry),
      };
    }
  }
  return completion;
}

async function transcriptHasMailboxCompletion(params: {
  transcriptPath: string;
  agentPath: string;
  completion: CodexNativeSubagentCompletion;
  observedAfter?: number;
}): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let contents: string;
  try {
    handle = await fs.open(params.transcriptPath, "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, PARENT_TRANSCRIPT_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    contents = buffer.toString("utf8");
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: JsonValue;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isJsonObject(entry) || readString(entry, "type") !== "response_item") {
      continue;
    }
    const observedAt = readTimestamp(entry);
    if (params.observedAfter !== undefined && observedAt !== undefined) {
      if (observedAt < params.observedAfter) {
        continue;
      }
    }
    const item = isJsonObject(entry.payload) ? entry.payload : undefined;
    if (!item) {
      continue;
    }
    const completions = extractCodexNativeSubagentCompletions({
      method: "rawResponseItem/completed",
      params: { item },
    });
    if (
      completions.some(
        (candidate) =>
          candidate.agentPath === params.agentPath &&
          candidate.status === params.completion.status &&
          candidate.result === params.completion.result,
      )
    ) {
      return true;
    }
  }
  return false;
}

function readTranscriptParentThreadId(payload: JsonObject): string | undefined {
  const source = isJsonObject(payload.source) ? payload.source : undefined;
  const subagent =
    (isJsonObject(source?.subagent) ? source.subagent : undefined) ??
    (isJsonObject(source?.subAgent) ? source.subAgent : undefined);
  const spawn = isJsonObject(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
  return readString(spawn, "parent_thread_id")?.trim();
}

function readNumber(record: JsonObject, key: string): number | undefined {
  return asFiniteNumber(record[key]);
}

function secondsToMillis(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000);
}

function readTimestamp(entry: JsonObject): number | undefined {
  const timestamp = readString(entry, "timestamp");
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedDiagnosticId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= MAX_NATIVE_CHILD_ID_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, 128)}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function boundedOptionalDiagnosticId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return boundedDiagnosticId(value) || undefined;
}

function diagnosticTurnKey(parentTurnId: string, childTurnId: string): string {
  return `${parentTurnId}\u0000${childTurnId}`;
}

function readEventTimestampMs(...records: Array<JsonObject | undefined>): number {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of ["completedAtMs", "startedAtMs", "occurredAtMs", "createdAtMs"] as const) {
      const value = readNumber(record, key);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return Date.now();
}

function childTurnOutcome(
  status: string | undefined,
): "completed" | "failed" | "cancelled" | "interrupted" | "timed_out" | undefined {
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "interrupted") {
    return "interrupted";
  }
  return status === "timedOut" || status === "timed_out" ? "timed_out" : undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
