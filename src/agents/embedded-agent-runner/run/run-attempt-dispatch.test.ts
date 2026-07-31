import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginInternalDiagnosticDeliveryIdentity,
  captureInternalDiagnosticDeliveryCursor,
  completeInternalDiagnosticDeliveryIdentity,
  failInternalDiagnosticDeliveryIdentity,
  waitForInternalDiagnosticDeliveryCursor,
} from "../../../infra/diagnostic-delivery.js";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";

const mocks = vi.hoisted(() => ({
  applyAuthHeaderOverride: vi.fn((model: unknown) => model),
  runEmbeddedAttemptWithBackend: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  runEmbeddedAttemptWithBackend: mocks.runEmbeddedAttemptWithBackend,
}));

vi.mock("../../tool-terminal-outcome.js", () => ({
  createToolTerminalObserver: vi.fn(() => vi.fn()),
}));

vi.mock("../../delegation-capability.js", () => ({
  resolveDelegationCapability: vi.fn(() => undefined),
}));

vi.mock("../../model-auth.js", () => ({
  applyAuthHeaderOverride: mocks.applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
}));

import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";

describe("dispatchEmbeddedRunAttempt", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    mocks.applyAuthHeaderOverride.mockReset().mockImplementation((model: unknown) => model);
    mocks.runEmbeddedAttemptWithBackend.mockReset();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
  });

  it("releases Codex diagnostic identity when attempt parameter construction throws", async () => {
    const constructionError = new Error("attempt parameter construction failed");
    mocks.applyAuthHeaderOverride.mockImplementation(() => {
      throw constructionError;
    });
    const clearPostCompactionAbortController = vi.fn();
    const control = {
      lifecycleGeneration: "generation-1",
      pluginHarnessOwnsTransport: false,
      laneTaskAbortController: new AbortController(),
      laneTaskReleaseController: new AbortController(),
      noteLaneTaskProgress: vi.fn(),
      onToolOutcome: vi.fn(),
      allocateToolOutcomeOrdinal: vi.fn(() => 1),
      onToolStreamBoundary: vi.fn(),
      onRunProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAgentEvent: vi.fn(),
      onUserMessagePersisted: vi.fn(),
      onUserMessagePersistenceInvalidated: vi.fn(),
      getPostCompactionAbortError: vi.fn(() => undefined),
      setPostCompactionAbortController: vi.fn(),
      clearPostCompactionAbortController,
    };

    await expect(
      dispatchEmbeddedRunAttempt({
        params: {
          runId: "run-sync-construction-error",
          config: {},
        } as never,
        runtime: {
          sessionId: "session-id",
          sessionFile: "session.jsonl",
          trajectorySessionFile: "trajectory.jsonl",
          workspaceDir: "/workspace",
          isCanonicalWorkspace: true,
          agentDir: "/agent",
          prompt: "prompt",
          provider: "openai",
          modelId: "gpt-5.5",
          requestedModelId: "gpt-5.5",
          fallbackActive: false,
          fallbackReason: null,
          agentHarnessId: "codex",
          runtimePlan: {},
          model: {},
          authProfileIdSource: "auto",
          initialReplayState: {},
          agentId: "agent-1",
          skipPreparedUserTurnMessage: false,
          runtimeAuthActive: false,
          captureRuntimeArtifact: false,
        } as never,
        control: control as never,
        bootstrapPromptWarningSignaturesSeen: [],
        suppressNextUserMessagePersistence: false,
        beforeAgentFinalizeRevisionAttempts: 0,
        maxBeforeAgentFinalizeRevisions: 0,
      }),
    ).rejects.toBe(constructionError);

    const state = (globalThis as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.diagnosticEvents.state.v1")
    ] as {
      activeDeliveryIdentities: Map<unknown, unknown>;
    };
    expect(state.activeDeliveryIdentities.size).toBe(0);
    expect(mocks.runEmbeddedAttemptWithBackend).not.toHaveBeenCalled();
    expect(clearPostCompactionAbortController).toHaveBeenCalledOnce();
    const failureCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-sync-construction-error",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(failureCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    completeInternalDiagnosticDeliveryIdentity({ runId: "run-sync-construction-error" });
  });

  it("keeps an explicit Codex producer failure after releasing the attempt owner", async () => {
    mocks.runEmbeddedAttemptWithBackend.mockImplementation((params) => {
      params.internalDiagnosticDelivery?.fail();
      return Promise.resolve({});
    });
    const control = {
      lifecycleGeneration: "generation-1",
      pluginHarnessOwnsTransport: false,
      laneTaskAbortController: new AbortController(),
      laneTaskReleaseController: new AbortController(),
      noteLaneTaskProgress: vi.fn(),
      onToolOutcome: vi.fn(),
      allocateToolOutcomeOrdinal: vi.fn(() => 1),
      onToolStreamBoundary: vi.fn(),
      onRunProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAgentEvent: vi.fn(),
      onUserMessagePersisted: vi.fn(),
      onUserMessagePersistenceInvalidated: vi.fn(),
      getPostCompactionAbortError: vi.fn(() => undefined),
      setPostCompactionAbortController: vi.fn(),
      clearPostCompactionAbortController: vi.fn(),
    };

    await dispatchEmbeddedRunAttempt({
      params: {
        runId: "run-explicit-diagnostic-failure",
        config: {},
      } as never,
      runtime: {
        sessionId: "session-id",
        sessionFile: "session.jsonl",
        trajectorySessionFile: "trajectory.jsonl",
        workspaceDir: "/workspace",
        isCanonicalWorkspace: true,
        agentDir: "/agent",
        prompt: "prompt",
        provider: "openai",
        modelId: "gpt-5.5",
        requestedModelId: "gpt-5.5",
        fallbackActive: false,
        fallbackReason: null,
        agentHarnessId: "codex",
        runtimePlan: {},
        model: {},
        authProfileIdSource: "auto",
        initialReplayState: {},
        agentId: "agent-1",
        skipPreparedUserTurnMessage: false,
        runtimeAuthActive: false,
        captureRuntimeArtifact: false,
      } as never,
      control: control as never,
      bootstrapPromptWarningSignaturesSeen: [],
      suppressNextUserMessagePersistence: false,
      beforeAgentFinalizeRevisionAttempts: 0,
      maxBeforeAgentFinalizeRevisions: 0,
    });

    const failureCursor = captureInternalDiagnosticDeliveryCursor({
      runId: "run-explicit-diagnostic-failure",
    });
    await expect(waitForInternalDiagnosticDeliveryCursor(failureCursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    completeInternalDiagnosticDeliveryIdentity({ runId: "run-explicit-diagnostic-failure" });
  });

  it("does not release a diagnostic identity owned by a different harness attempt", async () => {
    const identity = {
      runId: "run-shared-with-codex",
      sessionId: "session-id",
    };
    beginInternalDiagnosticDeliveryIdentity(identity);
    failInternalDiagnosticDeliveryIdentity(identity);
    const cursor = captureInternalDiagnosticDeliveryCursor(identity);
    mocks.runEmbeddedAttemptWithBackend.mockResolvedValue({});

    const control = {
      lifecycleGeneration: "generation-1",
      pluginHarnessOwnsTransport: false,
      laneTaskAbortController: new AbortController(),
      laneTaskReleaseController: new AbortController(),
      noteLaneTaskProgress: vi.fn(),
      onToolOutcome: vi.fn(),
      allocateToolOutcomeOrdinal: vi.fn(() => 1),
      onToolStreamBoundary: vi.fn(),
      onRunProgress: vi.fn(),
      onToolResult: vi.fn(),
      onAgentEvent: vi.fn(),
      onUserMessagePersisted: vi.fn(),
      onUserMessagePersistenceInvalidated: vi.fn(),
      getPostCompactionAbortError: vi.fn(() => undefined),
      setPostCompactionAbortController: vi.fn(),
      clearPostCompactionAbortController: vi.fn(),
    };

    await dispatchEmbeddedRunAttempt({
      params: {
        runId: identity.runId,
        config: {},
      } as never,
      runtime: {
        sessionId: identity.sessionId,
        sessionFile: "session.jsonl",
        trajectorySessionFile: "trajectory.jsonl",
        workspaceDir: "/workspace",
        isCanonicalWorkspace: true,
        agentDir: "/agent",
        prompt: "prompt",
        provider: "openai",
        modelId: "gpt-5.5",
        requestedModelId: "gpt-5.5",
        fallbackActive: false,
        fallbackReason: null,
        agentHarnessId: "pi",
        runtimePlan: {},
        model: {},
        authProfileIdSource: "auto",
        initialReplayState: {},
        agentId: "agent-1",
        skipPreparedUserTurnMessage: false,
        runtimeAuthActive: false,
        captureRuntimeArtifact: false,
      } as never,
      control: control as never,
      bootstrapPromptWarningSignaturesSeen: [],
      suppressNextUserMessagePersistence: false,
      beforeAgentFinalizeRevisionAttempts: 0,
      maxBeforeAgentFinalizeRevisions: 0,
    });

    await expect(waitForInternalDiagnosticDeliveryCursor(cursor)).resolves.toMatchObject({
      ok: false,
      reason: "producer_incomplete",
    });
    completeInternalDiagnosticDeliveryIdentity(identity);
  });
});
