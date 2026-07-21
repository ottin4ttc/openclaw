import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { onTrustedInternalDiagnosticEvent } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainCodexRolloutTraceProviderRequestDiagnostics,
  emitCodexRolloutTraceProviderRequestDiagnostics,
  prepareCodexRolloutTraceRoot,
  pruneCodexRolloutTraceBundles,
  registerCodexRolloutTraceClient,
  waitForCodexAttemptDiagnosticEventsDrained,
} from "./rollout-trace-diagnostics.js";

type ModelCallEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.started" | "model.call.completed" | "model.call.error" }
>;

afterEach(() => {
  resetDiagnosticEventsForTest();
});

describe("emitCodexRolloutTraceProviderRequestDiagnostics", () => {
  it("replays Codex rollout inference attempts as provider-request model calls", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-"));
    const bundleDir = path.join(traceRoot, "attempt-one", "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        trace_id: "trace-1",
        rollout_id: "rollout-1",
        root_thread_id: "thread-1",
        started_at_unix_ms: 1000,
        raw_event_log: "trace.jsonl",
        payloads_dir: "payloads",
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({
        model: "aliyun/qwen3.7-plus",
        instructions: "system",
        input: [{ role: "user", content: "first" }],
        tools: [{ type: "function", name: "lookup" }],
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        response_id: "resp-1",
        upstream_request_id: "upstream-secret",
        token_usage: {
          input_tokens: 10,
          output_tokens: 4,
          cached_input_tokens: 2,
          reasoning_output_tokens: 1,
          total_tokens: 14,
        },
        output_items: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "3.json"),
      `${JSON.stringify({ model: "aliyun/qwen3.7-plus", input: "second" })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "4.json"),
      `${JSON.stringify({
        response_id: "resp-2",
        token_usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
        },
        output_items: [],
      })}\n`,
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "call-1",
          model: "aliyun/qwen3.7-plus",
          provider_name: "codex",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1075, "inference_completed", {
          inference_call_id: "call-1",
          upstream_request_id: "upstream-secret",
          response_payload: payloadRef("2"),
        }),
        traceEvent(3, 1100, "inference_started", {
          inference_call_id: "call-2",
          model: "aliyun/qwen3.7-plus",
          provider_name: "codex",
          request_payload: payloadRef("3"),
        }),
        traceEvent(4, 1140, "inference_completed", {
          inference_call_id: "call-2",
          response_payload: payloadRef("4"),
        }),
      ].join(""),
    );
    const events: DiagnosticEventPayload[] = [];
    const privateDataByCall = new Map<string, DiagnosticEventPrivateData | undefined>();
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });
    onTrustedInternalDiagnosticEvent(
      (event, _metadata, privateData) => {
        if (
          (event.type === "model.call.started" || event.type === "model.call.completed") &&
          event.callId
        ) {
          privateDataByCall.set(`${event.type}:${event.callId}`, privateData);
        }
      },
      {
        captureModelContent: {
          inputMessages: true,
          outputMessages: true,
          systemPrompt: true,
          toolDefinitions: true,
        },
      },
    );

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: {
          runId: "run-1",
          callId: "turn-call",
          scope: "turn-aggregate",
          sessionId: "session-1",
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
          api: "responses",
          transport: "stdio",
        },
        capture: {
          inputMessages: true,
          outputMessages: true,
          systemPrompt: true,
          toolDefinitions: true,
        },
      }),
    ).resolves.toBe(4);
    await waitForDiagnosticEventsDrained();

    const modelCallEvents = events.filter(isModelCallEvent);
    expect(modelCallEvents.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
      "model.call.started",
      "model.call.completed",
    ]);
    expect(modelCallEvents.map((event) => event.callId)).toEqual([
      "call-1",
      "call-1",
      "call-2",
      "call-2",
    ]);
    expect(modelCallEvents.every((event) => event.scope === "provider-request")).toBe(true);
    expect(modelCallEvents.every((event) => event.provider === "codex")).toBe(true);
    expect(modelCallEvents.every((event) => event.model === "aliyun/qwen3.7-plus")).toBe(true);
    expect(modelCallEvents.map((event) => event.startTimeMs)).toEqual([1000, 1000, 1100, 1100]);
    expect(modelCallEvents[1]).toMatchObject({
      endTimeMs: 1075,
      durationMs: 75,
      usageSource: "provider",
      usage: {
        input: 8,
        output: 4,
        cacheRead: 2,
        reasoningTokens: 1,
        total: 14,
      },
    });
    expect(modelCallEvents[1]).not.toHaveProperty("requestPayloadBytes");
    expect(modelCallEvents[1]).not.toHaveProperty("responseStreamBytes");
    expect(privateDataByCall.get("model.call.started:call-1")?.modelContent).toMatchObject({
      inputMessages: [{ role: "user", content: "first" }],
      systemPrompt: "system",
      toolDefinitions: [{ type: "function", name: "lookup" }],
    });
    expect(privateDataByCall.get("model.call.completed:call-1")?.modelContent).toMatchObject({
      outputMessages: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
    });
    expect(modelCallEvents[3]).toMatchObject({
      endTimeMs: 1140,
      durationMs: 40,
      usageSource: "provider",
    });
    expect(modelCallEvents[1]?.upstreamRequestIdHash).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(JSON.stringify(modelCallEvents)).not.toContain("upstream-secret");

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: {
          runId: "run-1",
          callId: "turn-call",
          provider: "codex",
          model: "aliyun/qwen3.7-plus",
        },
      }),
    ).resolves.toBe(0);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("retains bounded payload evidence and provider usage for oversized payloads", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-huge-payload-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const padding = "x".repeat(4 * 1024 * 1024);
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      JSON.stringify({
        model: "baidu/deepseek-v4-pro",
        instructions: "private-system-instruction",
        input: "hello",
        tools: [{ type: "function", name: "private-tool-definition" }],
        padding,
      }),
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      JSON.stringify({
        token_usage: {
          input_tokens: 100,
          output_tokens: 7,
          cached_input_tokens: 25,
          total_tokens: 107,
        },
        private_metadata: "private-response-metadata",
        padding,
        output_items: [
          {
            type: "message",
            content: "done",
            token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "huge-call",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1050, "inference_completed", {
          inference_call_id: "huge-call",
          response_payload: payloadRef("2"),
        }),
      ].join(""),
    );
    const events: DiagnosticEventPayload[] = [];
    let completedPrivateData: DiagnosticEventPrivateData | undefined;
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });
    onTrustedInternalDiagnosticEvent(
      (event, _metadata, privateData) => {
        if (event.type === "model.call.completed") {
          completedPrivateData = privateData;
        }
      },
      {
        captureModelContent: {
          inputMessages: true,
          outputMessages: true,
        },
      },
    );

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "baidu/deepseek-v4-pro" },
        capture: { inputMessages: true, outputMessages: true },
      }),
    ).resolves.toBe(2);
    await waitForDiagnosticEventsDrained();

    expect(events.filter(isModelCallEvent).at(-1)).toMatchObject({
      type: "model.call.completed",
      usageSource: "provider",
      usage: { input: 75, output: 7, cacheRead: 25, total: 107 },
    });
    expect(completedPrivateData?.modelContent).toMatchObject({
      inputMessages: { truncated: true, originalBytes: expect.any(Number) },
      outputMessages: { truncated: true, originalBytes: expect.any(Number) },
    });
    const serializedPrivateData = JSON.stringify(completedPrivateData);
    expect(serializedPrivateData).not.toContain(padding);
    expect(serializedPrivateData).not.toContain("private-system-instruction");
    expect(serializedPrivateData).not.toContain("private-tool-definition");
    expect(serializedPrivateData).not.toContain("private-response-metadata");

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("retains an inference start until a later read observes its terminal event", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-pair-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({ model: "aliyun/qwen3.7-plus", input: "hello" })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        output_items: [],
      })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEvent(1, 1000, "inference_started", {
        inference_call_id: "call-late",
        model: "aliyun/qwen3.7-plus",
        provider_name: "codex",
        request_payload: payloadRef("1"),
      }),
    );
    const baseFields = { runId: "run-1", provider: "codex", model: "aliyun/qwen3.7-plus" };

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields,
      }),
    ).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      traceEvent(2, 1040, "inference_completed", {
        inference_call_id: "call-late",
        response_payload: payloadRef("2"),
      }),
    );

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields,
      }),
    ).resolves.toBe(2);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("continues later bundles when a concurrent cleanup removes one trace file", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-missing-trace-"));
    const missingDir = path.join(traceRoot, "trace-a-missing");
    const bundleDir = path.join(traceRoot, "trace-b-valid");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(missingDir, { recursive: true });
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(missingDir, "manifest.json"), "{}\n");
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({ model: "aliyun/qwen3.7-plus", input: "hello" })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        output_items: [],
      })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEvent(1, 1000, "inference_started", {
        inference_call_id: "call-after-missing",
        model: "aliyun/qwen3.7-plus",
        provider_name: "codex",
        request_payload: payloadRef("1"),
      }),
    );
    const events: ModelCallEvent[] = [];
    onInternalDiagnosticEvent((event) => {
      if (isModelCallEvent(event)) {
        events.push(event);
      }
    });
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "aliyun/qwen3.7-plus" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(2, 1040, "inference_completed", {
          inference_call_id: "call-after-missing",
          response_payload: payloadRef("2"),
        }),
        traceEvent(3, 1050, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(2);
    await waitForDiagnosticEventsDrained();

    expect(events.map((event) => `${event.type}:${event.callId}`)).toEqual([
      "model.call.started:call-after-missing",
      "model.call.completed:call-after-missing",
    ]);
    for (const name of ["1.json", "2.json"]) {
      await expect(fs.access(path.join(payloadsDir, name))).rejects.toThrow();
    }

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("waits for a trace file that appears after its manifest", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-race-"));
    const bundleDir = path.join(traceRoot, "trace-pending");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const traceFile = path.join(bundleDir, "trace.jsonl");
    const writeTrace = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void fs
          .writeFile(
            traceFile,
            [
              traceEvent(1, 1000, "inference_started", { inference_call_id: "late-call" }),
              traceEvent(2, 1040, "inference_completed", { inference_call_id: "late-call" }),
              traceEvent(3, 1050, "codex_turn_ended", { status: "completed" }),
            ].join(""),
          )
          .then(resolve, reject);
      }, 50);
    });

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
      }),
    ).resolves.toBe(2);
    await writeTrace;

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("continues draining a trace after the foreground settle window", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-late-trace-"));
    const bundleDir = path.join(traceRoot, "trace-late");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const traceFile = path.join(bundleDir, "trace.jsonl");
    const events: ModelCallEvent[] = [];
    onInternalDiagnosticEvent((event) => {
      if (isModelCallEvent(event)) {
        events.push(event);
      }
    });

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-late",
        baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
      }),
    ).resolves.toBe(0);
    await fs.writeFile(
      traceFile,
      [
        traceEventForTurn(
          1,
          1000,
          "inference_started",
          { inference_call_id: "late-background-call" },
          "thread-1",
          "turn-late",
        ),
        traceEventForTurn(
          2,
          1040,
          "inference_completed",
          { inference_call_id: "late-background-call" },
          "thread-1",
          "turn-late",
        ),
        traceEventForTurn(3, 1050, "codex_turn_ended", {}, "thread-1", "turn-late"),
      ].join(""),
    );

    await vi.waitFor(
      async () => {
        await waitForDiagnosticEventsDrained();
        expect(events.map((event) => event.type)).toEqual([
          "model.call.started",
          "model.call.completed",
        ]);
      },
      { timeout: 3_000 },
    );
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("does not emit provider-request diagnostics after the attempt disables background draining", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-no-bg-trace-"));
    const bundleDir = path.join(traceRoot, "trace-no-background");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const traceFile = path.join(bundleDir, "trace.jsonl");
    const events: ModelCallEvent[] = [];
    onInternalDiagnosticEvent((event) => {
      if (isModelCallEvent(event)) {
        events.push(event);
      }
    });

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics(
        {
          traceRoot,
          threadId: "thread-1",
          turnId: "turn-no-background",
          baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
        },
        { allowBackgroundDrain: false },
      ),
    ).resolves.toBe(0);
    await fs.writeFile(
      traceFile,
      [
        traceEventForTurn(
          1,
          1000,
          "inference_started",
          { inference_call_id: "post-attempt-call" },
          "thread-1",
          "turn-no-background",
        ),
        traceEventForTurn(
          2,
          1040,
          "inference_completed",
          { inference_call_id: "post-attempt-call" },
          "thread-1",
          "turn-no-background",
        ),
        traceEventForTurn(3, 1050, "codex_turn_ended", {}, "thread-1", "turn-no-background"),
      ].join(""),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([]);
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("cancels an existing background drain after the attempt disables background draining", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-cancel-bg-trace-"));
    const bundleDir = path.join(traceRoot, "trace-cancel-background");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const traceFile = path.join(bundleDir, "trace.jsonl");
    const events: ModelCallEvent[] = [];
    onInternalDiagnosticEvent((event) => {
      if (isModelCallEvent(event)) {
        events.push(event);
      }
    });
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-cancel-background",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
    };

    await expect(drainCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics(params, { allowBackgroundDrain: false }),
    ).resolves.toBe(0);
    await fs.writeFile(
      traceFile,
      [
        traceEventForTurn(
          1,
          1000,
          "inference_started",
          { inference_call_id: "cancelled-background-call" },
          "thread-1",
          "turn-cancel-background",
        ),
        traceEventForTurn(
          2,
          1040,
          "inference_completed",
          { inference_call_id: "cancelled-background-call" },
          "thread-1",
          "turn-cancel-background",
        ),
        traceEventForTurn(3, 1050, "codex_turn_ended", {}, "thread-1", "turn-cancel-background"),
      ].join(""),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([]);
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("drains a terminal event recorded asynchronously after turn cleanup", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-drain-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({ model: "aliyun/qwen3.7-plus", input: "hello" })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        output_items: [],
      })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEvent(1, 1000, "inference_started", {
        inference_call_id: "call-late",
        request_payload: payloadRef("1"),
      }),
    );
    const terminalAppended = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        fs.appendFile(
          traceFile,
          [
            traceEvent(2, 1040, "inference_cancelled", {
              inference_call_id: "call-late",
              partial_response_payload: payloadRef("2"),
            }),
            traceEvent(3, 1050, "codex_turn_ended", { status: "cancelled" }),
          ].join(""),
        ).then(resolve, reject);
      }, 20);
    });

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "aliyun/qwen3.7-plus" },
      }),
    ).resolves.toBe(2);
    await terminalAppended;

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("removes raw payload files after a complete turn is drained", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-scrub-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    for (const [name, payload] of [
      ["1.json", { input: "private prompt" }],
      ["2.json", { token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }],
      ["3.json", { tool_name: "lookup", payload: { type: "function", arguments: "{}" } }],
      ["4.json", { type: "direct_response", response_item: { output: "private result" } }],
    ] as const) {
      await fs.writeFile(path.join(payloadsDir, name), JSON.stringify(payload));
    }
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "call-1",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1010, "inference_completed", {
          inference_call_id: "call-1",
          response_payload: payloadRef("2"),
        }),
        traceEvent(3, 1020, "tool_call_started", {
          tool_call_id: "tool-1",
          invocation_payload: payloadRef("3"),
        }),
        traceEvent(4, 1030, "tool_call_ended", {
          tool_call_id: "tool-1",
          result_payload: payloadRef("4"),
          status: "completed",
        }),
        traceEvent(5, 1040, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "baidu/deepseek-v4-pro" },
        capture: {
          inputMessages: true,
          outputMessages: true,
          toolInputs: true,
          toolOutputs: true,
        },
      }),
    ).resolves.toBe(3);

    for (const name of ["1.json", "2.json", "3.json", "4.json"]) {
      await expect(fs.access(path.join(payloadsDir, name))).rejects.toThrow();
    }
    await expect(fs.access(path.join(bundleDir, "trace.jsonl"))).resolves.toBeUndefined();

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("defers later tool diagnostics until an earlier inference terminal arrives", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-order-trace-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      JSON.stringify({
        tool_name: "exec_command",
        payload: { type: "function", arguments: JSON.stringify({ cmd: "printf ordered" }) },
      }),
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      JSON.stringify({
        type: "direct_response",
        response_item: { output: JSON.stringify("ordered") },
      }),
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      [
        traceEvent(1, 1000, "inference_started", { inference_call_id: "late-call" }),
        traceEvent(2, 1010, "tool_call_started", {
          tool_call_id: "tool-call",
          invocation_payload: payloadRef("1"),
        }),
        traceEvent(3, 1020, "tool_call_ended", {
          tool_call_id: "tool-call",
          result_payload: payloadRef("2"),
          status: "completed",
        }),
      ].join(""),
    );
    const eventTypes: string[] = [];
    onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.") || event.type.startsWith("tool.execution.")) {
        eventTypes.push(event.type);
      }
    });
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/deepseek-v4-pro" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(4, 1030, "inference_completed", { inference_call_id: "late-call" }),
        traceEvent(5, 1040, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(3);
    await waitForDiagnosticEventsDrained();

    expect(eventTypes).toEqual([
      "model.call.started",
      "tool.execution.completed",
      "model.call.completed",
    ]);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("does not wait for the settle deadline when no matching turn was traced", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-untraced-"));
    const bundleDir = path.join(traceRoot, "trace-unrelated");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      traceEventForTurn(
        1,
        1000,
        "inference_started",
        { inference_call_id: "other-call" },
        "other-thread",
        "other-turn",
      ),
    );
    const startedAt = Date.now();

    await expect(
      drainCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "aliyun/qwen3.7-plus" },
      }),
    ).resolves.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(250);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("replays a pending inference after an earlier lifecycle was already emitted", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-trace-mixed-"));
    const bundleDir = path.join(traceRoot, "trace-one");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    for (const [name, payload] of [
      ["1.json", { model: "aliyun/qwen3.7-plus", input: "first" }],
      [
        "2.json",
        {
          token_usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          output_items: [],
        },
      ],
      ["3.json", { model: "aliyun/qwen3.7-plus", input: "second" }],
      [
        "4.json",
        {
          token_usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
          output_items: [],
        },
      ],
    ] as const) {
      await fs.writeFile(path.join(payloadsDir, name), `${JSON.stringify(payload)}\n`);
    }
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "call-1",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1040, "inference_completed", {
          inference_call_id: "call-1",
          response_payload: payloadRef("2"),
        }),
      ].join(""),
    );
    const events: ModelCallEvent[] = [];
    onInternalDiagnosticEvent((event) => {
      if (isModelCallEvent(event)) {
        events.push(event);
      }
    });
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "aliyun/qwen3.7-plus" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(2);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(3, 1050, "inference_started", {
          inference_call_id: "call-2",
          request_payload: payloadRef("3"),
        }),
        traceEvent(4, 1090, "inference_completed", {
          inference_call_id: "call-2",
          response_payload: payloadRef("4"),
        }),
        traceEvent(5, 1100, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(2);
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await waitForDiagnosticEventsDrained();

    expect(events.map((event) => `${event.type}:${event.callId}`)).toEqual([
      "model.call.started:call-1",
      "model.call.completed:call-1",
      "model.call.started:call-2",
      "model.call.completed:call-2",
    ]);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("replays Codex namespace tool calls with private input and output content", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tool-trace-"));
    const bundleDir = path.join(traceRoot, "trace-tools");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({
        tool_name: "list",
        tool_namespace: "skills",
        payload: {
          type: "function",
          arguments: JSON.stringify({ authority: { kind: "orchestrator" } }),
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        type: "direct_response",
        response_item: {
          type: "function_call_output",
          call_id: "tool-call-1",
          output: JSON.stringify({ skills: ["example-search"], warnings: [] }),
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "3.json"),
      `${JSON.stringify({
        tool_name: "search",
        tool_namespace: "skills",
        payload: { type: "tool_search", arguments: { query: "talent" } },
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "4.json"),
      `${JSON.stringify({
        type: "direct_response",
        response_item: {
          type: "tool_search_output",
          call_id: "tool-call-2",
          status: "completed",
          execution: "server",
          tools: [{ name: "example_api_call" }],
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 2000, "tool_call_started", {
          tool_call_id: "tool-call-1",
          invocation_payload: payloadRef("1"),
        }),
        traceEvent(2, 2075, "tool_call_ended", {
          tool_call_id: "tool-call-1",
          status: "completed",
          result_payload: payloadRef("2"),
        }),
        traceEvent(3, 2100, "tool_call_started", {
          tool_call_id: "tool-call-2",
          invocation_payload: payloadRef("3"),
        }),
        traceEvent(4, 2175, "tool_call_ended", {
          tool_call_id: "tool-call-2",
          status: "completed",
          result_payload: payloadRef("4"),
        }),
      ].join(""),
    );
    const toolEvents: Array<{
      event: DiagnosticEventPayload;
      privateData: DiagnosticEventPrivateData | undefined;
    }> = [];
    onTrustedInternalDiagnosticEvent(
      (event, _metadata, privateData) => {
        if (event.type.startsWith("tool.execution.")) {
          toolEvents.push({ event, privateData });
        }
      },
      { captureModelContent: { toolInputs: true, toolOutputs: true } },
    );

    await emitCodexRolloutTraceProviderRequestDiagnostics({
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: {
        runId: "run-1",
        sessionKey: "agent:openmai-u1:openresponses:s1",
        sessionId: "session-1",
      },
      capture: {
        toolInputs: true,
        toolOutputs: true,
      },
    });
    await waitForDiagnosticEventsDrained();

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]?.event).toMatchObject({
      type: "tool.execution.completed",
      runId: "run-1",
      sessionKey: "agent:openmai-u1:openresponses:s1",
      sessionId: "session-1",
      toolName: "skills.list",
      toolSource: "core",
      toolOwner: "codex-rollout-trace",
      toolCallId: "tool-call-1",
      startTimeMs: 2000,
      endTimeMs: 2075,
      durationMs: 75,
    });
    expect(toolEvents[0]?.privateData).toEqual({
      toolContent: {
        toolInput: { authority: { kind: "orchestrator" } },
        toolOutput: { skills: ["example-search"], warnings: [] },
      },
    });
    expect(toolEvents[1]?.privateData).toEqual({
      toolContent: {
        toolInput: { query: "talent" },
        toolOutput: {
          type: "tool_search_output",
          call_id: "tool-call-2",
          status: "completed",
          execution: "server",
          tools: [{ name: "example_api_call" }],
        },
      },
    });

    await emitCodexRolloutTraceProviderRequestDiagnostics({
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1" },
      capture: { toolInputs: true, toolOutputs: true },
    });
    await waitForDiagnosticEventsDrained();
    expect(toolEvents).toHaveLength(2);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("emits oversized tool invocations with identity and truncated input summary", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tool-huge-"));
    const bundleDir = path.join(traceRoot, "trace-tool-huge");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      JSON.stringify({
        tool_name: "large",
        tool_namespace: "skills",
        payload: {
          type: "function",
          arguments: JSON.stringify({ privateInput: "x".repeat(5 * 1024 * 1024) }),
        },
      }),
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        type: "direct_response",
        response_item: {
          output: JSON.stringify({ privateOutput: "y".repeat(5 * 1024 * 1024) }),
        },
      })}\n`,
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 2000, "tool_call_started", {
          tool_call_id: "tool-call-huge",
          invocation_payload: payloadRef("1"),
        }),
        traceEvent(2, 2075, "tool_call_ended", {
          tool_call_id: "tool-call-huge",
          status: "completed",
          result_payload: payloadRef("2"),
        }),
      ].join(""),
    );
    const toolEvents: Array<{
      event: DiagnosticEventPayload;
      privateData: DiagnosticEventPrivateData | undefined;
    }> = [];
    onTrustedInternalDiagnosticEvent(
      (event, _metadata, privateData) => {
        if (event.type.startsWith("tool.execution.")) {
          toolEvents.push({ event, privateData });
        }
      },
      { captureModelContent: { toolInputs: true, toolOutputs: true } },
    );

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1" },
        capture: { toolInputs: true, toolOutputs: true },
      }),
    ).resolves.toBe(1);
    await waitForDiagnosticEventsDrained();

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.event).toMatchObject({
      type: "tool.execution.completed",
      toolName: "skills.large",
      toolCallId: "tool-call-huge",
      paramsSummary: { kind: "truncated", originalBytes: expect.any(Number) },
    });
    expect(toolEvents[0]?.privateData).toEqual({
      toolContent: {
        toolInput: { truncated: true, originalBytes: expect.any(Number) },
        toolOutput: { truncated: true, originalBytes: expect.any(Number) },
      },
    });
    expect(JSON.stringify(toolEvents)).not.toContain("privateInput");
    expect(JSON.stringify(toolEvents)).not.toContain("privateOutput");

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("preserves raw inference and tool event order while keeping the configured model identity", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-ordered-trace-"));
    const bundleDir = path.join(traceRoot, "trace-ordered");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(payloadsDir, "1.json"),
      `${JSON.stringify({ model: "glm-5.2", input: [{ role: "user", content: "hello" }] })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      `${JSON.stringify({
        tool_name: "list",
        tool_namespace: "skills",
        payload: { type: "function", arguments: "{}" },
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "3.json"),
      `${JSON.stringify({
        type: "direct_response",
        response_item: { output: JSON.stringify({ skills: ["example-search"] }) },
      })}\n`,
    );
    await fs.writeFile(
      path.join(payloadsDir, "4.json"),
      `${JSON.stringify({
        token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        output_items: [{ type: "function_call", name: "skills.list" }],
      })}\n`,
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "call-1",
          model: "glm-5.2",
          provider_name: "Baidu",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1200, "tool_call_started", {
          tool_call_id: "tool-call-1",
          invocation_payload: payloadRef("2"),
        }),
        traceEvent(3, 1225, "tool_call_ended", {
          tool_call_id: "tool-call-1",
          status: "completed",
          result_payload: payloadRef("3"),
        }),
        traceEvent(4, 1250, "inference_completed", {
          inference_call_id: "call-1",
          response_payload: payloadRef("4"),
        }),
      ].join(""),
    );
    const orderedEvents: Array<{
      type: DiagnosticEventPayload["type"];
      provider?: string;
      model?: string;
    }> = [];
    onTrustedInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.") || event.type.startsWith("tool.execution.")) {
        orderedEvents.push({
          type: event.type,
          ...(event.type.startsWith("model.call.")
            ? { provider: event.provider, model: event.model }
            : {}),
        });
      }
    });

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: {
          runId: "run-1",
          sessionKey: "agent:openmai-u1:openresponses:s1",
          sessionId: "session-1",
          provider: "codex",
          model: "baidu/glm-5.2",
        },
        capture: {
          inputMessages: true,
          outputMessages: true,
          toolInputs: true,
          toolOutputs: true,
        },
      }),
    ).resolves.toBe(3);
    await waitForDiagnosticEventsDrained();

    expect(orderedEvents).toEqual([
      { type: "model.call.started", provider: "Baidu", model: "glm-5.2" },
      { type: "tool.execution.completed" },
      { type: "model.call.completed", provider: "Baidu", model: "glm-5.2" },
    ]);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("keeps later turns buffered when one rollout contains multiple completed turns", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-turns-trace-"));
    const bundleDir = path.join(traceRoot, "trace-turns");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    for (const ordinal of ["1", "2", "3", "4"]) {
      await fs.writeFile(
        path.join(payloadsDir, `${ordinal}.json`),
        `${JSON.stringify(
          Number(ordinal) % 2 === 1
            ? { model: "glm-5.2", input: `request-${ordinal}` }
            : {
                token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                output_items: [{ type: "message", content: `response-${ordinal}` }],
              },
        )}\n`,
      );
    }
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      [
        traceEventForTurn(
          1,
          1000,
          "inference_started",
          {
            inference_call_id: "call-2",
            model: "glm-5.2",
            request_payload: payloadRef("1"),
          },
          "thread-1",
          "turn-2",
        ),
        traceEventForTurn(
          2,
          1010,
          "inference_completed",
          {
            inference_call_id: "call-2",
            response_payload: payloadRef("2"),
          },
          "thread-1",
          "turn-2",
        ),
        traceEventForTurn(
          3,
          1020,
          "inference_started",
          {
            inference_call_id: "call-3",
            model: "glm-5.2",
            request_payload: payloadRef("3"),
          },
          "thread-1",
          "turn-3",
        ),
        traceEventForTurn(
          4,
          1030,
          "inference_completed",
          {
            inference_call_id: "call-3",
            response_payload: payloadRef("4"),
          },
          "thread-1",
          "turn-3",
        ),
      ].join(""),
    );
    const callIds: string[] = [];
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.completed" && event.callId) {
        callIds.push(event.callId);
      }
    });
    const baseFields = { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" };

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-2",
        baseFields,
      }),
    ).resolves.toBe(2);
    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-3",
        baseFields,
      }),
    ).resolves.toBe(2);
    await waitForDiagnosticEventsDrained();

    expect(callIds).toEqual(["call-2", "call-3"]);
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("seals a completed turn when unrelated trace bundle reads fail", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-bundles-trace-"));
    const matchingDir = path.join(traceRoot, "trace-matching");
    const unrelatedDir = path.join(traceRoot, "trace-unrelated");
    await fs.mkdir(path.join(matchingDir, "payloads"), { recursive: true });
    await fs.mkdir(unrelatedDir, { recursive: true });
    await fs.writeFile(path.join(matchingDir, "manifest.json"), "{}\n");
    await fs.writeFile(path.join(unrelatedDir, "manifest.json"), "{}\n");
    await fs.writeFile(
      path.join(matchingDir, "payloads", "1.json"),
      `${JSON.stringify({ model: "glm-5.2", input: "request" })}\n`,
    );
    await fs.writeFile(
      path.join(matchingDir, "payloads", "2.json"),
      `${JSON.stringify({
        token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output_items: [],
      })}\n`,
    );
    const matchingTrace = path.join(matchingDir, "trace.jsonl");
    await fs.writeFile(
      matchingTrace,
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "call-complete",
          request_payload: payloadRef("1"),
        }),
        traceEvent(2, 1010, "inference_completed", {
          inference_call_id: "call-complete",
          response_payload: payloadRef("2"),
        }),
        traceEvent(3, 1020, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(2);
    await fs.appendFile(
      matchingTrace,
      [
        traceEvent(4, 1030, "inference_started", { inference_call_id: "post-turn-call" }),
        traceEvent(5, 1040, "inference_completed", { inference_call_id: "post-turn-call" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("cleans every payload ref and settles after an oversized pending turn ends", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-large-trace-"));
    const bundleDir = path.join(traceRoot, "trace-large");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const payloadOrdinals = Array.from({ length: 257 }, (_, index) => String(index + 1));
    for (const ordinal of payloadOrdinals) {
      await fs.writeFile(
        path.join(payloadsDir, `${ordinal}.json`),
        JSON.stringify({ privatePayload: ordinal }),
      );
    }
    const traceFile = path.join(bundleDir, "trace.jsonl");
    const oversizedMalformedLine = `${"x".repeat(2 * 1024 * 1024)}\n`;
    const events = Array.from({ length: 2049 }, (_, index) =>
      traceEvent(index + 1, 1000 + index, "inference_started", {
        inference_call_id: `call-${index}`,
        request_payload: payloadRef(payloadOrdinals[index % payloadOrdinals.length]),
      }),
    );
    await fs.writeFile(traceFile, `${oversizedMalformedLine}${events.join("")}`);
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(2050, 4000, "inference_completed", { inference_call_id: "call-0" }),
        traceEvent(2051, 4010, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    for (const ordinal of payloadOrdinals) {
      await expect(fs.access(path.join(payloadsDir, `${ordinal}.json`))).rejects.toThrow();
    }
    await fs.appendFile(
      traceFile,
      [
        traceEvent(2052, 4020, "inference_started", { inference_call_id: "post-ended-call" }),
        traceEvent(2053, 4030, "inference_completed", { inference_call_id: "post-ended-call" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("evicts oldest pending turns when a bundle exceeds the state byte budget", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-budget-trace-"));
    const bundleDir = path.join(traceRoot, "trace-budget");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    const largeValue = "x".repeat(900 * 1024);
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      [
        traceEvent(1, 1000, "inference_started", { inference_call_id: "target-call" }),
        traceEvent(2, 1010, "inference_completed", { inference_call_id: "target-call" }),
        ...Array.from({ length: 10 }, (_, index) =>
          traceEventForTurn(
            index + 3,
            1100 + index,
            "inference_started",
            { inference_call_id: `other-call-${index}`, largeValue },
            "other-thread",
            `other-turn-${index}`,
          ),
        ),
      ].join(""),
    );

    await expect(
      emitCodexRolloutTraceProviderRequestDiagnostics({
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
      }),
    ).resolves.toBe(0);

    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("cleans payload refs for a pending turn evicted by the state byte budget", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-budget-scrub-"));
    const bundleDir = path.join(traceRoot, "trace-budget-scrub");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(path.join(payloadsDir, "1.json"), JSON.stringify({ input: "secret" }));
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      JSON.stringify({ output_items: [{ type: "message", content: "secret" }] }),
    );
    const largeValue = "x".repeat(900 * 1024);
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "evicted-call",
          request_payload: payloadRef("1"),
        }),
        ...Array.from({ length: 10 }, (_, index) =>
          traceEventForTurn(
            index + 2,
            1100 + index,
            "inference_started",
            { inference_call_id: `other-call-${index}`, largeValue },
            "other-thread",
            `other-turn-${index}`,
          ),
        ),
      ].join(""),
    );
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(12, 2000, "inference_completed", {
          inference_call_id: "evicted-call",
          response_payload: payloadRef("2"),
        }),
        traceEvent(13, 2010, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);

    await expect(fs.access(path.join(payloadsDir, "1.json"))).rejects.toThrow();
    await expect(fs.access(path.join(payloadsDir, "2.json"))).rejects.toThrow();
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("cleans payload refs for a pending turn evicted by the state entry budget", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-entry-scrub-"));
    const bundleDir = path.join(traceRoot, "trace-entry-scrub");
    const payloadsDir = path.join(bundleDir, "payloads");
    await fs.mkdir(payloadsDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
    await fs.writeFile(path.join(payloadsDir, "1.json"), JSON.stringify({ input: "secret" }));
    await fs.writeFile(
      path.join(payloadsDir, "2.json"),
      JSON.stringify({ output_items: [{ type: "message", content: "secret" }] }),
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      [
        traceEvent(1, 1000, "inference_started", {
          inference_call_id: "entry-evicted-call",
          request_payload: payloadRef("1"),
        }),
        ...Array.from({ length: 64 }, (_, index) =>
          traceEventForTurn(
            index + 2,
            1100 + index,
            "inference_started",
            { inference_call_id: `other-call-${index}` },
            "other-thread",
            `other-turn-${index}`,
          ),
        ),
      ].join(""),
    );
    const params = {
      traceRoot,
      threadId: "thread-1",
      turnId: "turn-1",
      baseFields: { runId: "run-1", provider: "codex", model: "baidu/glm-5.2" },
    };

    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
    await fs.appendFile(
      traceFile,
      [
        traceEvent(66, 2000, "inference_completed", {
          inference_call_id: "entry-evicted-call",
          response_payload: payloadRef("2"),
        }),
        traceEvent(67, 2010, "codex_turn_ended", { status: "completed" }),
      ].join(""),
    );
    await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);

    await expect(fs.access(path.join(payloadsDir, "1.json"))).rejects.toThrow();
    await expect(fs.access(path.join(payloadsDir, "2.json"))).rejects.toThrow();
    await fs.rm(traceRoot, { recursive: true, force: true });
  });
});

describe("pruneCodexRolloutTraceBundles", () => {
  it("periodically removes completed bundles without requiring another attempt", async () => {
    let scheduledPrune: (() => Promise<void>) | undefined;
    const timer = { unref() {} } as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void | Promise<void>,
    ) => {
      scheduledPrune = async () => {
        await callback();
      };
      return timer;
    }) as typeof setTimeout);
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-prune-timer-"));
    try {
      await prepareCodexRolloutTraceRoot(traceRoot);
      const firstPrune = scheduledPrune;
      expect(firstPrune).toBeTypeOf("function");
      const bundleDir = path.join(traceRoot, "attempt-completed", "bundle-completed");
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
      const traceFile = path.join(bundleDir, "trace.jsonl");
      await fs.writeFile(
        traceFile,
        traceEventForTurn(1, Date.now(), "rollout_ended", {}, "thread-1", "turn-1"),
      );
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(traceFile, staleTime, staleTime);

      await firstPrune?.();

      await expect(fs.access(path.join(traceRoot, "attempt-completed"))).rejects.toThrow();
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
      const cleanupPrune = scheduledPrune;
      await cleanupPrune?.();
      setTimeoutSpy.mockRestore();
    }
  });

  it("periodically reclaims stale incomplete bundles created after startup", async () => {
    let scheduledPrune: (() => Promise<void>) | undefined;
    const timer = { unref() {} } as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void | Promise<void>,
    ) => {
      scheduledPrune = async () => {
        await callback();
      };
      return timer;
    }) as typeof setTimeout);
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-prune-crash-"));
    try {
      await prepareCodexRolloutTraceRoot(traceRoot);
      const bundleDir = path.join(traceRoot, "bundle-crashed");
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
      const traceFile = path.join(bundleDir, "trace.jsonl");
      await fs.writeFile(
        traceFile,
        traceEventForTurn(1, Date.now(), "inference_started", {}, "thread-1", "turn-1"),
      );
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(traceFile, staleTime, staleTime);

      await scheduledPrune?.();

      await expect(fs.access(bundleDir)).rejects.toThrow();
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
      const cleanupPrune = scheduledPrune;
      await cleanupPrune?.();
      setTimeoutSpy.mockRestore();
    }
  });

  it("prunes nested per-attempt crash remnants and excess completed bundles", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-prune-trace-"));
    const now = Date.now();
    for (const [name, completed, ageMs] of [
      ["active-old", false, 2 * 60 * 60 * 1000],
      ["active-current", false, 1000],
      ["completed-newest", true, 1000],
      ["completed-middle", true, 2000],
      ["completed-oldest", true, 3000],
    ] as const) {
      const bundleDir = path.join(traceRoot, `attempt-${name}`, `bundle-${name}`);
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
      await fs.writeFile(
        path.join(bundleDir, "trace.jsonl"),
        completed
          ? traceEventForTurn(1, now - ageMs, "rollout_ended", {}, "thread-1", "turn-1")
          : traceEventForTurn(
              1,
              now - ageMs,
              "inference_started",
              {
                inference_call_id: "active-call",
              },
              "thread-1",
              "turn-1",
            ),
      );
      const modifiedAt = new Date(now - ageMs);
      await fs.utimes(path.join(bundleDir, "trace.jsonl"), modifiedAt, modifiedAt);
    }

    await pruneCodexRolloutTraceBundles(traceRoot, now);

    await expect(fs.access(path.join(traceRoot, "attempt-active-old"))).rejects.toThrow();
    await expect(
      fs.access(path.join(traceRoot, "attempt-active-current")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(traceRoot, "attempt-completed-newest")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(traceRoot, "attempt-completed-middle")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(traceRoot, "attempt-completed-oldest"))).rejects.toThrow();
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("protects a live client's bundle and reclaims it after the client closes", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-active-trace-"));
    await prepareCodexRolloutTraceRoot(traceRoot);
    const bundleDir = path.join(traceRoot, "bundle-active");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({ root_thread_id: "thread-1" })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEventForTurn(
        1,
        Date.now() - 2 * 60 * 60 * 1000,
        "inference_started",
        { inference_call_id: "active-call" },
        "thread-1",
        "turn-1",
      ),
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(traceFile, staleTime, staleTime);
    let closeHandler: (() => void) | undefined;
    const client = {
      addCloseHandler(handler: () => void) {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      },
    } as never;
    await registerCodexRolloutTraceClient({ traceRoot, threadId: "thread-1", client });

    await prepareCodexRolloutTraceRoot(traceRoot);

    await expect(fs.access(bundleDir)).resolves.toBeUndefined();
    closeHandler?.();
    await vi.waitFor(async () => {
      await expect(fs.access(bundleDir)).rejects.toThrow();
    });
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("protects stale incomplete bundles created after the live client was registered", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-late-active-"));
    await prepareCodexRolloutTraceRoot(traceRoot);
    let closeHandler: (() => void) | undefined;
    const client = {
      addCloseHandler(handler: () => void) {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      },
    } as never;
    await registerCodexRolloutTraceClient({ traceRoot, threadId: "thread-1", client });
    const bundleDir = path.join(traceRoot, "bundle-created-after-client");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({ root_thread_id: "thread-1" })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEventForTurn(
        1,
        Date.now() - 2 * 60 * 60 * 1000,
        "inference_started",
        { inference_call_id: "late-active-call" },
        "thread-1",
        "turn-1",
      ),
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(traceFile, staleTime, staleTime);

    closeHandler?.();
    await vi.waitFor(async () => {
      await expect(fs.access(bundleDir)).rejects.toThrow();
    });
    await fs.rm(traceRoot, { recursive: true, force: true });
  });

  it("removes pruned active bundle paths from long-lived client registrations", async () => {
    const traceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-stale-owner-"));
    await prepareCodexRolloutTraceRoot(traceRoot);
    let closeHandler: ((client?: unknown) => void) | undefined;
    const client = {
      addCloseHandler(handler: (client?: unknown) => void) {
        closeHandler = handler;
        return () => {
          closeHandler = undefined;
        };
      },
    } as never;
    const bundleDir = path.join(traceRoot, "attempt-reused", "bundle-reused");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({ root_thread_id: "thread-1" })}\n`,
    );
    const traceFile = path.join(bundleDir, "trace.jsonl");
    await fs.writeFile(
      traceFile,
      traceEventForTurn(
        1,
        Date.now() - 2 * 60 * 60 * 1000,
        "rollout_ended",
        {},
        "thread-1",
        "turn-1",
      ),
    );
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(traceFile, staleTime, staleTime);
    await registerCodexRolloutTraceClient({ traceRoot, threadId: "thread-1", client });

    await pruneCodexRolloutTraceBundles(traceRoot, Date.now());
    await expect(fs.access(path.join(traceRoot, "attempt-reused"))).rejects.toThrow();

    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, "manifest.json"),
      `${JSON.stringify({ root_thread_id: "thread-2" })}\n`,
    );
    await fs.writeFile(
      path.join(bundleDir, "trace.jsonl"),
      traceEventForTurn(
        1,
        Date.now(),
        "inference_started",
        { inference_call_id: "different-thread-call" },
        "thread-2",
        "turn-1",
      ),
    );

    closeHandler?.(client);

    await expect(fs.access(bundleDir)).resolves.toBeUndefined();
    await fs.rm(traceRoot, { recursive: true, force: true });
  });
});

describe("waitForCodexAttemptDiagnosticEventsDrained", () => {
  it("bounds attempt finalization when the global diagnostic queue does not drain", async () => {
    await expect(
      waitForCodexAttemptDiagnosticEventsDrained(() => new Promise(() => undefined), 10),
    ).resolves.toBe(false);
    await expect(
      waitForCodexAttemptDiagnosticEventsDrained(() => Promise.resolve(), 10),
    ).resolves.toBe(true);
  });
});

function isModelCallEvent(event: DiagnosticEventPayload): event is ModelCallEvent {
  return (
    event.type === "model.call.started" ||
    event.type === "model.call.completed" ||
    event.type === "model.call.error"
  );
}

function payloadRef(ordinal: string) {
  return {
    raw_payload_id: `raw_payload:${ordinal}`,
    kind: { type: "inference_request" },
    path: `payloads/${ordinal}.json`,
  };
}

function traceEvent(
  seq: number,
  wallTimeMs: number,
  type: string,
  payload: Record<string, unknown>,
): string {
  return traceEventForTurn(seq, wallTimeMs, type, payload, "thread-1", "turn-1");
}

function traceEventForTurn(
  seq: number,
  wallTimeMs: number,
  type: string,
  payload: Record<string, unknown>,
  threadId: string,
  turnId: string,
): string {
  return `${JSON.stringify({
    schema_version: 1,
    seq,
    wall_time_unix_ms: wallTimeMs,
    rollout_id: "rollout-1",
    thread_id: threadId,
    codex_turn_id: turnId,
    payload: {
      type,
      ...payload,
      thread_id: threadId,
      codex_turn_id: turnId,
    },
  })}\n`;
}
