// Codex tests cover run attempt.hooks plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  abortAgentHarnessRun,
  onAgentEvent,
  resolveActiveEmbeddedRunSessionId,
  type AgentEventPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  onTrustedInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  activeRolloutTraceTurnRegistrationCountForTest,
  CODEX_ROLLOUT_TRACE_ROOT_ENV_VAR,
} from "./rollout-trace-diagnostics.js";
import {
  assistantMessage,
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

type ReplyBackend = Parameters<
  NonNullable<ReturnType<typeof createParams>["replyOperation"]>["attachBackend"]
>[0];

function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt hooks and model diagnostics", () => {
  it("runs before_agent_run with canonical history before model diagnostics and turn start", async () => {
    const order: string[] = [];
    const beforeAgentRun = vi.fn(async () => {
      order.push("before_agent_run:start");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      order.push("before_agent_run:end");
      return { outcome: "pass" as const };
    });
    const llmInput = vi.fn(() => {
      order.push("llm_input");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.started" && event.scope === "turn-aggregate") {
        order.push("model.call.started");
      }
    });
    const sessionFile = path.join(tempDir, "before-agent-run-order.jsonl");
    const workspaceDir = path.join(tempDir, "before-agent-run-order-workspace");
    const priorMessages = [
      userMessage("prior question", 1_783_000_000_000),
      assistantMessage("prior answer", 1_783_000_001_000),
    ];
    const sessionManager = SessionManager.open(sessionFile);
    for (const message of priorMessages) {
      sessionManager.appendMessage(message);
    }
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        order.push("turn/start");
        return turnStartResult("turn-1", "completed");
      }
      return {};
    });
    const params = createParams(sessionFile, workspaceDir);
    params.config = {
      diagnostics: {
        enabled: true,
        otel: { enabled: true, traces: true },
      },
    } as never;

    await runCodexAppServerAttempt(params, {
      nativeHookRelay: { enabled: false },
      turnCompletionIdleTimeoutMs: 5,
    });
    await flushDiagnosticEvents();

    const [beforeRunEvent] = mockCall(beforeAgentRun, "before_agent_run") as [
      {
        messages?: unknown[];
        priorMessages?: unknown[];
        prompt?: string;
        systemPrompt?: string;
      },
    ];
    expect(beforeRunEvent.prompt).toBe("hello");
    expect(beforeRunEvent.systemPrompt).toContain(
      "You are a personal agent running inside OpenClaw.",
    );
    expect(beforeRunEvent.messages).toEqual(priorMessages);
    expect(beforeRunEvent.priorMessages).toEqual(priorMessages);
    expect(order.slice(0, 2)).toEqual(["before_agent_run:start", "before_agent_run:end"]);
    expect(order.indexOf("model.call.started")).toBeGreaterThan(
      order.indexOf("before_agent_run:end"),
    );
    expect(order.indexOf("llm_input")).toBeGreaterThan(order.indexOf("before_agent_run:end"));
    expect(order.indexOf("turn/start")).toBeGreaterThan(order.indexOf("llm_input"));
  });

  it("stops before model diagnostics and turn/start when before_agent_run blocks", async () => {
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "policy denied",
      message: "blocked by policy",
    }));
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun },
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
      ]),
    );
    const modelEvents = vi.fn();
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.started" || event.type === "model.call.error") {
        modelEvents(event);
      }
    });
    const sessionFile = path.join(tempDir, "before-agent-run-block.jsonl");
    const workspaceDir = path.join(tempDir, "before-agent-run-block-workspace");
    const harness = createStartedThreadHarness();

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir)),
    ).resolves.toMatchObject({
      promptError: expect.objectContaining({
        message: expect.stringContaining("blocked by policy"),
      }),
      promptErrorSource: "hook:before_agent_run",
    });
    await flushDiagnosticEvents();

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(llmInput).not.toHaveBeenCalled();
    expect(llmOutput).not.toHaveBeenCalled();
    expect(modelEvents).not.toHaveBeenCalled();
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
  });

  it("enables Codex rollout traces for tool-only content capture", async () => {
    let rolloutTraceRoot: string | undefined;
    const harness = createAppServerHarness(
      async (method) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        return {};
      },
      {
        onStart: (_authProfileId, _agentDir, startOptions) => {
          rolloutTraceRoot = startOptions.env?.[CODEX_ROLLOUT_TRACE_ROOT_ENV_VAR];
        },
      },
    );
    const params = createParams(
      path.join(tempDir, "tool-only-rollout-trace.jsonl"),
      path.join(tempDir, "tool-only-rollout-trace-workspace"),
    );
    params.config = {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          traces: true,
          captureContent: { enabled: true, toolInputs: true },
        },
      },
    } as never;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(rolloutTraceRoot).toBeTypeOf("string");
  });

  it.each([
    { label: "completed", status: "completed" as const, error: undefined, legacy: false },
    { label: "failed", status: "failed" as const, error: "codex exploded", legacy: false },
    {
      label: "completed legacy alias",
      status: "completed" as const,
      error: undefined,
      legacy: true,
    },
  ])("defers $label lifecycle terminal ownership", async ({ status, error, legacy }) => {
    const onRunAgentEvent = vi.fn();
    const sessionFile = path.join(tempDir, `deferred-${status}.jsonl`);
    const workspaceDir = path.join(tempDir, `workspace-${status}`);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    if (legacy) {
      params.deferTerminalLifecycleEnd = true;
    } else {
      params.deferTerminalLifecycle = true;
    }
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (status === "completed") {
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "hello back",
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    } else {
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            error: { message: error },
          },
        },
      });
    }
    await run;

    const lifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents.map((event) => event.data.phase)).toEqual(["start", "finishing"]);
    expect(lifecycleEvents[1]?.data.error).toBe(error);
  });

  it("fires llm_input, llm_output, and agent_end hooks for codex turns", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(llmInput).toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const [llmInputPayload, llmInputContext] = mockCall(llmInput, "llm_input") as [
      {
        historyMessages?: Array<{ role?: string }>;
        imagesCount?: number;
        model?: string;
        prompt?: string;
        provider?: string;
        runtime?: string;
        runtimeEngine?: string;
        transport?: string;
        runId?: string;
        sessionId?: string;
        systemPrompt?: string;
      },
      { runId?: string; sessionId?: string; sessionKey?: string },
    ];
    expect(llmInputPayload.runId).toBe("run-1");
    expect(llmInputPayload.sessionId).toBe("session-1");
    expect(llmInputPayload.provider).toBe("codex");
    expect(llmInputPayload.model).toBe("gpt-5.4-codex");
    expect(llmInputPayload.runtime).toBe("codex");
    expect(llmInputPayload.runtimeEngine).toBe("codex-app-server");
    expect(llmInputPayload.transport).toBe("stdio");
    expect(llmInputPayload.prompt).toBe("hello");
    expect(llmInputPayload.imagesCount).toBe(0);
    expect(llmInputPayload.historyMessages).toEqual([]);
    expect(llmInputPayload.systemPrompt).toContain(
      "You are a personal agent running inside OpenClaw.",
    );
    expect(llmInputPayload.systemPrompt).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    expect(llmInputContext.runId).toBe("run-1");
    expect(llmInputContext.sessionId).toBe("session-1");
    expect(llmInputContext.sessionKey).toBe("agent:main:session-1");

    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello back",
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.assistantTexts).toEqual(["hello back"]);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: {
        endedAt?: number;
        phase?: string;
        startedAt?: number;
        text?: string;
      };
      stream: string;
    }>;
    const lifecycleStart = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof lifecycleStart?.data.startedAt).toBe("number");
    const assistantEvents = agentEvents.filter((event) => event.stream === "assistant");
    expect(assistantEvents).toHaveLength(2);
    expect(assistantEvents[0]?.data).toEqual({
      text: "hello back",
      delta: "hello back",
      replaceable: true,
    });
    expect(assistantEvents[1]?.data).toEqual({ text: "hello back" });
    const lifecycleEnd = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(typeof lifecycleEnd?.data.startedAt).toBe("number");
    expect(typeof lifecycleEnd?.data.endedAt).toBe("number");
    const startIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    const assistantIndex = agentEvents.findIndex((event) => event.stream === "assistant");
    const endIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(startIndex);
    expect(endIndex).toBeGreaterThan(assistantIndex);
    const globalAssistantEvents = globalAgentEvents.filter((event) => event.stream === "assistant");
    expect(globalAssistantEvents).toHaveLength(2);
    expect(globalAssistantEvents[0]?.runId).toBe("run-1");
    expect(globalAssistantEvents[0]?.sessionKey).toBe("agent:main:session-1");
    expect(globalAssistantEvents[0]?.data).toEqual({
      text: "hello back",
      delta: "hello back",
      replaceable: true,
    });
    expect(globalAssistantEvents[1]?.data).toEqual({ text: "hello back" });
    const globalEndEvent = globalAgentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(globalEndEvent?.runId).toBe("run-1");
    expect(globalEndEvent?.sessionKey).toBe("agent:main:session-1");

    const [llmOutputPayload, llmOutputContext] = mockCall(llmOutput, "llm_output") as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        lastAssistant?: { role?: string };
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
        contextTokenBudget?: number;
        contextWindowSource?: string;
        contextWindowReferenceTokens?: number;
      },
      {
        runId?: string;
        sessionId?: string;
        contextTokenBudget?: number;
        contextWindowSource?: string;
        contextWindowReferenceTokens?: number;
      },
    ];
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.contextTokenBudget).toBe(150_000);
    expect(llmOutputPayload.contextWindowSource).toBe("agentContextTokens");
    expect(llmOutputPayload.contextWindowReferenceTokens).toBe(200_000);
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.assistantTexts).toEqual(["hello back"]);
    expect(llmOutputPayload.lastAssistant?.role).toBe("assistant");
    expect(llmOutputContext.runId).toBe("run-1");
    expect(llmOutputContext.sessionId).toBe("session-1");
    expect(llmOutputContext.contextTokenBudget).toBe(150_000);
    expect(llmOutputContext.contextWindowSource).toBe("agentContextTokens");
    expect(llmOutputContext.contextWindowReferenceTokens).toBe(200_000);
    const [agentEndPayload, agentEndContext] = mockCall(agentEnd, "agent_end") as [
      { messages?: Array<{ role?: string }>; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "user")).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
  });

  it("emits gated model-call content diagnostics for codex turns", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const diagnosticContentByType = new Map<string, DiagnosticEventPrivateData>();
    let diagnosticTypesAtLlmOutput: string[] = [];
    let rolloutTraceRoot: string | undefined;
    let startedAgentDir: string | undefined;
    const llmOutput = vi.fn(() => {
      diagnosticTypesAtLlmOutput = diagnosticEvents.map((event) => event.type);
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const stopDiagnostics = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
        diagnosticContentByType.set(event.type, privateData);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createAppServerHarness(
        async (method) => {
          if (method === "thread/start") {
            return threadStartResult();
          }
          if (method === "turn/start") {
            return {
              turn: {
                ...turnStartResult("turn-1", "completed").turn,
                items: [
                  {
                    id: "msg-1",
                    type: "agentMessage",
                    text: "hello back",
                    status: "completed",
                  },
                ],
              },
            };
          }
          return {};
        },
        {
          onStart: (_authProfileId, agentDir, startOptions) => {
            startedAgentDir = agentDir;
            rolloutTraceRoot = startOptions.env?.[CODEX_ROLLOUT_TRACE_ROOT_ENV_VAR];
          },
        },
      );
      const params = createParams(sessionFile, workspaceDir);
      const sessionManager = SessionManager.open(sessionFile);
      sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: {
              enabled: true,
              inputMessages: true,
              outputMessages: true,
              systemPrompt: true,
            },
          },
        },
      } as never;
      params.sessionId = "diagnostic-session-1";
      params.sessionKey = "agent:diagnostic:diagnostic-session-1";
      params.runId = "diagnostic-run-1";
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false },
        turnCompletionIdleTimeoutMs: 5,
      });
      await harness.waitForMethod("turn/start");
      await run;
      await vi.waitFor(
        () =>
          expect(diagnosticEvents.some((event) => event.type === "model.call.completed")).toBe(
            true,
          ),
        fastWait,
      );

      const startedEvent = diagnosticEvents.find((event) => event.type === "model.call.started");
      const completedEvent = diagnosticEvents.find(
        (event) => event.type === "model.call.completed",
      );
      expect(startedEvent?.callId).toBe("diagnostic-run-1:codex-model:1");
      expect(startedEvent).toMatchObject({
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
      });
      expect(
        (startedEvent as (DiagnosticEventPayload & { scope?: string }) | undefined)?.scope,
      ).toBe("turn-aggregate");
      expect(rolloutTraceRoot).toBe(path.join(startedAgentDir!, "codex-home", "rollout-traces"));
      expect(startedEvent?.trace?.traceId).toBeTypeOf("string");
      expect(JSON.stringify(startedEvent)).not.toContain("hello");
      const startedContent = diagnosticContentByType.get("model.call.started")?.modelContent;
      expect(JSON.stringify(startedContent?.inputMessages)).toContain("hello");
      expect(JSON.stringify(startedContent?.inputMessages)).not.toContain("existing context");
      expect(startedContent?.systemPrompt).toContain(
        "You are a personal agent running inside OpenClaw.",
      );
      expect(completedEvent?.callId).toBe("diagnostic-run-1:codex-model:1");
      expect(completedEvent).toMatchObject({
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
      });
      expect(JSON.stringify(completedEvent)).not.toContain("hello back");
      expect(
        JSON.stringify(diagnosticContentByType.get("model.call.completed")?.modelContent),
      ).toContain("hello back");
      expect(completedEvent?.requestPayloadBytes).toBeGreaterThan(0);
      expect(llmOutput).toHaveBeenCalledTimes(1);
      expect(diagnosticTypesAtLlmOutput).toContain("model.call.completed");
      expect(diagnosticTypesAtLlmOutput).not.toContain("model.call.error");
    } finally {
      stopDiagnostics();
    }
  }, 240_000);

  it("drains provider-request diagnostics before llm_output", async () => {
    const diagnosticEvents: Array<DiagnosticEventPayload & Record<string, unknown>> = [];
    let providerRequestsAtLlmOutput = 0;
    let rolloutToolEventsAtLlmOutput = 0;
    const llmOutput = vi.fn(() => {
      providerRequestsAtLlmOutput = diagnosticEvents.filter(
        (event) => event.scope === "provider-request",
      ).length;
      rolloutToolEventsAtLlmOutput = diagnosticEvents.filter(
        (event) => event.toolOwner === "codex-rollout-trace",
      ).length;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.") || event.type.startsWith("tool.execution.")) {
        diagnosticEvents.push(event as DiagnosticEventPayload & Record<string, unknown>);
      }
    });
    let rolloutTraceRoot: string | undefined;
    let rolloutTraceFile: string | undefined;
    try {
      const sessionFile = path.join(tempDir, "provider-request-session.jsonl");
      const workspaceDir = path.join(tempDir, "provider-request-workspace");
      const harness = createAppServerHarness(
        async (method) => {
          if (method === "thread/start") {
            return threadStartResult();
          }
          if (method === "turn/start") {
            if (!rolloutTraceRoot) {
              throw new Error("rollout trace root was not configured before turn/start");
            }
            const bundleDir = path.join(rolloutTraceRoot, "attempt-one", "trace-one");
            const payloadsDir = path.join(bundleDir, "payloads");
            await fs.mkdir(payloadsDir, { recursive: true });
            await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
            await fs.writeFile(
              path.join(payloadsDir, "request.json"),
              `${JSON.stringify({
                model: "openai/gpt-5.4-codex",
                input: [{ role: "user", content: "hello" }],
              })}\n`,
            );
            await fs.writeFile(
              path.join(payloadsDir, "response.json"),
              `${JSON.stringify({
                token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
                output_items: [{ type: "message", content: "hello back" }],
              })}\n`,
            );
            await fs.writeFile(
              path.join(payloadsDir, "tool-input.json"),
              `${JSON.stringify({
                tool_name: "exec_command",
                payload: { type: "function", arguments: JSON.stringify({ cmd: "pwd" }) },
              })}\n`,
            );
            await fs.writeFile(
              path.join(payloadsDir, "tool-output.json"),
              `${JSON.stringify({
                type: "direct_response",
                response_item: { output: JSON.stringify({ exit_code: 0, output: "/workspace" }) },
              })}\n`,
            );
            const traceEvent = (
              seq: number,
              wallTimeMs: number,
              type: string,
              payload: Record<string, unknown>,
            ) =>
              `${JSON.stringify({
                schema_version: 1,
                seq,
                wall_time_unix_ms: wallTimeMs,
                rollout_id: "rollout-1",
                thread_id: "thread-1",
                codex_turn_id: "turn-1",
                payload: {
                  type,
                  ...payload,
                  thread_id: "thread-1",
                  codex_turn_id: "turn-1",
                },
              })}\n`;
            const payloadRef = (id: string) => ({
              raw_payload_id: `raw_payload:${id}`,
              kind: { type: "inference_request" },
              path: `payloads/${id}.json`,
            });
            rolloutTraceFile = path.join(bundleDir, "trace.jsonl");
            await fs.writeFile(
              rolloutTraceFile,
              [
                traceEvent(1, 1_000, "inference_started", {
                  inference_call_id: "provider-call-1",
                  model: "openai/gpt-5.4-codex",
                  provider_name: "openai",
                  request_payload: payloadRef("request"),
                }),
                traceEvent(2, 1_050, "inference_completed", {
                  inference_call_id: "provider-call-1",
                  response_payload: payloadRef("response"),
                }),
                traceEvent(3, 1_055, "tool_call_started", {
                  tool_call_id: "tool-call-1",
                  invocation_payload: payloadRef("tool-input"),
                }),
                traceEvent(4, 1_058, "tool_call_ended", {
                  tool_call_id: "tool-call-1",
                  status: "completed",
                  result_payload: payloadRef("tool-output"),
                }),
              ].join(""),
            );
            return turnStartResult("turn-1", "inProgress");
          }
          return {};
        },
        {
          onStart: (_authProfileId, _agentDir, startOptions) => {
            rolloutTraceRoot = startOptions.env?.[CODEX_ROLLOUT_TRACE_ROOT_ENV_VAR];
          },
        },
      );
      const params = createParams(sessionFile, workspaceDir);
      params.config = {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: { enabled: true, inputMessages: true, outputMessages: true },
          },
        },
      } as never;
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false },
        turnCompletionIdleTimeoutMs: 5,
      });
      await harness.waitForMethod("turn/start");
      await vi.waitFor(
        () => {
          expect(
            diagnosticEvents.filter((event) => event.scope === "provider-request"),
          ).toHaveLength(2);
        },
        { timeout: 3_000 },
      );
      expect(llmOutput).not.toHaveBeenCalled();
      await harness.notify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "tool-call-1",
            command: "pwd",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        },
      });
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "tool-call-1",
            command: "pwd",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "/workspace",
            exitCode: 0,
            durationMs: 3,
          },
        },
      });
      if (!rolloutTraceFile) {
        throw new Error("rollout trace file was not created");
      }
      await fs.appendFile(
        rolloutTraceFile,
        `${JSON.stringify({
          schema_version: 1,
          seq: 5,
          wall_time_unix_ms: 1_060,
          rollout_id: "rollout-1",
          thread_id: "thread-1",
          codex_turn_id: "turn-1",
          payload: {
            type: "codex_turn_ended",
            status: "completed",
            thread_id: "thread-1",
            codex_turn_id: "turn-1",
          },
        })}\n`,
      );
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "hello back",
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      await flushDiagnosticEvents();

      const providerEvents = diagnosticEvents.filter((event) => event.scope === "provider-request");
      expect(providerEvents).toEqual([
        expect.objectContaining({
          type: "model.call.started",
          callId: "provider-call-1",
          provider: "openai",
          model: "openai/gpt-5.4-codex",
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          transport: "stdio",
        }),
        expect.objectContaining({
          type: "model.call.completed",
          callId: "provider-call-1",
          durationMs: 50,
          usageSource: "provider",
          usage: { input: 10, output: 4, total: 14 },
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          transport: "stdio",
        }),
      ]);
      expect(providerRequestsAtLlmOutput).toBe(2);
      const rolloutToolEvents = diagnosticEvents.filter(
        (event) => event.toolOwner === "codex-rollout-trace",
      );
      expect(rolloutToolEvents).toEqual([
        expect.objectContaining({
          type: "tool.execution.started",
          toolCallId: "tool-call-1",
        }),
        expect.objectContaining({
          type: "tool.execution.completed",
          toolCallId: "tool-call-1",
        }),
      ]);
      expect(
        diagnosticEvents.filter((event) => event.toolOwner === "codex-native-tool-lifecycle"),
      ).toEqual([]);
      expect(rolloutToolEventsAtLlmOutput).toBe(2);
      expect(llmOutput).toHaveBeenCalledOnce();
    } finally {
      stopDiagnostics();
    }
  }, 240_000);

  it("finalizes rollout diagnostics and replays native fallback after terminal cleanup errors", async () => {
    const diagnosticEvents: Array<DiagnosticEventPayload & Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("tool.execution.")) {
        diagnosticEvents.push(event as DiagnosticEventPayload & Record<string, unknown>);
      }
    });
    let rolloutTraceRoot: string | undefined;
    try {
      vi.spyOn(CodexAppServerEventProjector.prototype, "getCompletedTurnStatus").mockImplementation(
        () => {
          throw new Error("simulated terminal projection failure");
        },
      );
      const harness = createStartedThreadHarness(undefined, {
        onStart: (_authProfileId, agentDir) => {
          rolloutTraceRoot = agentDir
            ? path.join(agentDir, "codex-home", "rollout-traces")
            : undefined;
        },
      });
      const params = createParams(
        path.join(tempDir, "cleanup-error-session.jsonl"),
        path.join(tempDir, "cleanup-error-workspace"),
      );
      params.config = {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: { enabled: true, inputMessages: true, outputMessages: true },
          },
        },
      } as never;
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false },
      });
      await harness.waitForMethod("turn/start");
      const activeTraceRoot = rolloutTraceRoot;
      if (!activeTraceRoot) {
        throw new Error("rollout trace root was not configured");
      }
      expect(
        activeRolloutTraceTurnRegistrationCountForTest({
          traceRoot: activeTraceRoot,
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      ).toBe(1);
      await harness.notify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "native-fallback-tool",
            command: "pwd",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        },
      });
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "native-fallback-tool",
            command: "pwd",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "/workspace",
            exitCode: 0,
            durationMs: 3,
          },
        },
      });
      expect(diagnosticEvents).toEqual([]);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(run).rejects.toThrow("simulated terminal projection failure");
      await flushDiagnosticEvents();

      expect(
        activeRolloutTraceTurnRegistrationCountForTest({
          traceRoot: activeTraceRoot,
          threadId: "thread-1",
          turnId: "turn-1",
        }),
      ).toBe(0);
      expect(
        diagnosticEvents.map((event) => ({
          type: event.type,
          toolCallId: event.toolCallId,
          toolOwner: event.toolOwner,
        })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolCallId: "native-fallback-tool",
          toolOwner: "codex-native-tool-lifecycle",
        },
        {
          type: "tool.execution.completed",
          toolCallId: "native-fallback-tool",
          toolOwner: "codex-native-tool-lifecycle",
        },
      ]);
    } finally {
      stopDiagnostics();
    }
  }, 240_000);

  it("classifies codex model-call timeout diagnostics", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      } as never;
      params.timeoutMs = 200;

      const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 5 });
      await harness.waitForMethod("turn/start");
      const result = await run;
      await flushDiagnosticEvents();

      const errorEvent = diagnosticEvents.find((event) => event.type === "model.call.error") as
        | ({ failureKind?: string; errorCategory?: string } & DiagnosticEventPayload)
        | undefined;
      expect(result.timedOut).toBe(true);
      expect(errorEvent?.failureKind).toBe("timeout");
      expect(errorEvent?.errorCategory).toBe("timeout");
      expect(errorEvent).toMatchObject({
        runtime: "codex",
        runtimeEngine: "codex-app-server",
        transport: "stdio",
      });
    } finally {
      stopDiagnostics();
    }
  });

  it("waits for agent_end hooks before resolving local codex turns", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);
    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({ promptError: null });
    expect(settled).toBe(true);
  });

  it("freezes recovered timeout success locally before agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onRunAgentEvent = vi.fn();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = onRunAgentEvent;
    params.timeoutMs = 200;
    const attachBackend = vi.fn();
    const detachBackend = vi.fn();
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend,
      detachBackend,
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-final-1",
          type: "agentMessage",
          text: "Done.",
          status: "completed",
        },
      },
    });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    const [replyBackend] = mockCall(attachBackend, "reply backend") as [
      { isAbortable?: () => boolean },
    ];
    expect(replyBackend.isAbortable?.()).toBe(false);
    expect(abortAgentHarnessRun("session-1")).toBe(false);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBe("session-1");
    releaseAgentEnd();

    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(true);
    expect(freezeAbort).not.toHaveBeenCalled();
    const terminalLifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
    expect(terminalLifecycleEvents).toHaveLength(1);
    expect(terminalLifecycleEvents[0]?.data).toMatchObject({ phase: "end" });
    expect(terminalLifecycleEvents[0]?.data.aborted).toBeUndefined();
    expect(detachBackend).toHaveBeenCalledWith(replyBackend);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBeUndefined();
  });

  it("freezes recovered client-close success locally before agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend: Pick<ReplyBackend, "isAbortable"> | undefined;
    const params = createParams(
      path.join(tempDir, "recovered-client-close.jsonl"),
      path.join(tempDir, "recovered-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort: vi.fn(),
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-final-1",
          type: "agentMessage",
          text: "Done before restart.",
          status: "completed",
        },
      },
    });
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(false);
    expect(abortAgentHarnessRun("session-1")).toBe(false);
    expect(onAttemptAbort).not.toHaveBeenCalled();

    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
      assistantTexts: ["Done before restart."],
    });
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(true);
  });

  it("keeps a successful memory preflight cancellable for the main turn", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
    const params = createParams(
      path.join(tempDir, "memory-preflight.jsonl"),
      path.join(tempDir, "memory-preflight-workspace"),
    );
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/notes.md";
    params.onAttemptAbort = onAttemptAbort;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({
      aborted: false,
      promptError: null,
    });
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it("keeps replay-safe client-close recovery cancellable during agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend:
      | {
          isAbortable?: () => boolean;
          cancel: (reason: "restart" | "superseded" | "user_abort") => void;
        }
      | undefined;
    const params = createParams(
      path.join(tempDir, "replay-safe-client-close.jsonl"),
      path.join(tempDir, "replay-safe-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({
      aborted: false,
      promptError: "codex app-server client closed before turn completed",
      codexAppServerFailure: {
        kind: "client_closed_before_turn_completed",
        replaySafe: true,
      },
    });
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "failed",
      status: "failed",
      error: { message: "codex exploded" },
      expectedPromptError: "codex exploded",
      expectedClassification: undefined,
    },
    {
      label: "interrupted",
      status: "interrupted",
      error: undefined,
      expectedPromptError: null,
      expectedClassification: "empty",
    },
    {
      label: "empty completed",
      status: "completed",
      error: undefined,
      expectedPromptError: null,
      expectedClassification: "empty",
    },
  ] as const)(
    "keeps ordinary $label turns cancellable until the orchestrator settles",
    async ({ label, status, error, expectedPromptError, expectedClassification }) => {
      let releaseAgentEnd: () => void = () => undefined;
      const agentEndSettled = new Promise<void>((resolve) => {
        releaseAgentEnd = resolve;
      });
      const agentEnd = vi.fn(() => agentEndSettled);
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
      );
      const onAttemptAbort = vi.fn();
      let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
      const params = createParams(
        path.join(tempDir, `ordinary-${label}-turn.jsonl`),
        path.join(tempDir, `ordinary-${label}-turn-workspace`),
      );
      params.onAttemptAbort = onAttemptAbort;
      const freezeAbort = vi.fn();
      params.replyOperation = {
        attachBackend: (backend: ReplyBackend) => {
          replyBackend = backend;
        },
        detachBackend: vi.fn(),
        freezeAbort,
      } as unknown as NonNullable<typeof params.replyOperation>;
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);

      await harness.waitForMethod("turn/start");
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(error ? { error } : {}),
          },
        },
      });
      await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

      expect(replyBackend?.isAbortable?.()).toBe(true);
      replyBackend?.cancel("user_abort");
      expect(onAttemptAbort).toHaveBeenCalledTimes(1);

      releaseAgentEnd();
      const result = await run;
      expect(result).toMatchObject({
        aborted: false,
        promptError: expectedPromptError,
      });
      expect(result.agentHarnessResultClassification).toBe(expectedClassification);
      expect(freezeAbort).not.toHaveBeenCalled();
    },
  );

  it("keeps websocket client-close failure cancellable until the orchestrator settles", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend:
      | {
          isAbortable?: () => boolean;
          cancel: (reason: "restart" | "superseded" | "user_abort") => void;
        }
      | undefined;
    const params = createParams(
      path.join(tempDir, "websocket-client-close.jsonl"),
      path.join(tempDir, "websocket-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort: vi.fn(),
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      turnTerminalIdleTimeoutMs: 60_000,
    });

    await harness.waitForMethod("turn/start");
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({
      aborted: false,
      promptError: "codex app-server client closed before turn completed",
      codexAppServerFailure: {
        transport: "websocket",
      },
    });
  });

  it("clears a stale binding when completed-turn coverage persistence fails", async () => {
    const sessionFile = path.join(tempDir, "binding-coverage-failure.jsonl");
    const workspaceDir = path.join(tempDir, "binding-coverage-workspace");
    const harness = createStartedThreadHarness();
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        const mutation = args[1];
        if (mutation.kind === "patch" && mutation.patch.historyCoveredThrough) {
          throw new Error("simulated binding coverage write failure");
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), { bindingStore });
    await harness.waitForMethod("turn/start");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await expect(run).resolves.toMatchObject({ promptError: null, aborted: false });
    expect(bindingStore.mutate).toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("does not wait for agent_end hooks before resolving channel-backed codex turns", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.messageChannel = "discord";
    params.messageProvider = "discord";
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.promptError).toBeNull();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    releaseAgentEnd();
  });

  it("waits for agent_end hooks before rejecting local codex turn-start failures", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    let settled = false;
    void run.catch(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);
    releaseAgentEnd();
    await expect(run).rejects.toThrow("turn start exploded");
    expect(settled).toBe(true);
  });

  it("fires agent_end with failure metadata when the codex turn fails", async () => {
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "codex exploded" },
        },
      },
    });

    const result = await run;

    expect(result.promptError).toBe("codex exploded");
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: { endedAt?: number; error?: string; phase?: string; startedAt?: number };
      stream: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof startEvent?.data.startedAt).toBe("number");
    const errorEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "error",
    );
    expect(typeof errorEvent?.data.startedAt).toBe("number");
    expect(typeof errorEvent?.data.endedAt).toBe("number");
    expect(errorEvent?.data.error).toBe("codex exploded");
    expect(agentEvents.some((event) => event.stream === "assistant")).toBe(false);
    const [agentEndPayload, agentEndContext] = mockCall(agentEnd, "agent_end") as [
      { error?: string; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("codex exploded");
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
  });

  it("fires llm_output and agent_end when turn/start fails", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()),
    );
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.messageChannel = "discord";
    params.messageProvider = "discord-voice";
    params.senderId = "user-123";
    params.senderName = "Test User";
    params.senderUsername = "testuser";
    params.inputProvenance = {
      kind: "external_user",
      sourceChannel: "discord",
    };

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn start exploded");

    expect(llmInput).toHaveBeenCalledTimes(1);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [llmOutputPayload] = mockCall(llmOutput, "llm_output") as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
      },
      unknown,
    ];
    expect(llmOutputPayload.assistantTexts).toEqual([]);
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { error?: string; messages?: Array<{ role?: string }>; success?: boolean },
      unknown,
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("turn start exploded");
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    const userMessage = agentEndPayload.messages?.find((message) => message.role === "user") as
      | {
          content?: unknown;
          provenance?: unknown;
          role?: string;
          senderId?: unknown;
          senderLabel?: unknown;
          senderName?: unknown;
          senderUsername?: unknown;
          sourceChannel?: unknown;
        }
      | undefined;
    expect(userMessage).toMatchObject({
      role: "user",
      content: "hello",
      sourceChannel: "discord",
      senderId: "user-123",
      senderName: "Test User",
      senderUsername: "testuser",
      senderLabel: "Test User (user-123)",
      provenance: {
        kind: "external_user",
        sourceChannel: "discord",
      },
    });
  });

  it("fires agent_end with success false when the codex turn is aborted", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const { waitForMethod } = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { pluginConfig: { appServer: { mode: "yolo" } } },
    );

    await waitForMethod("turn/start");
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(false);
  });
});
