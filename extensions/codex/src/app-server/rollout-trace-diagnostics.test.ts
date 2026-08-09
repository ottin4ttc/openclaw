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
import { afterEach, describe, expect, it } from "vitest";
import {
  emitCodexRolloutTraceProviderRequestDiagnostics,
  finalizeCodexRolloutTraceProviderRequestDiagnostics,
  prepareCodexRolloutTraceRoot,
  registerCodexRolloutTraceClient,
} from "./rollout-trace-diagnostics.js";

type DiagnosticRecord = DiagnosticEventPayload & Record<string, unknown>;

afterEach(() => {
  resetDiagnosticEventsForTest();
});

describe("finalizeCodexRolloutTraceProviderRequestDiagnostics", () => {
  it("emits provider requests with rollout-owned tool lifecycle coverage", async () => {
    const traceRoot = await createTraceRoot("provider-success");
    try {
      const bundleDir = path.join(traceRoot, "attempt-one", "trace-one");
      await writePayload(bundleDir, "request", {
        model: "openai/gpt-5.5",
        instructions: "system",
        input: [{ role: "user", content: "hello" }],
      });
      await writePayload(bundleDir, "response", {
        response_id: "resp-secret",
        upstream_request_id: "request-secret",
        token_usage: {
          input_tokens: 10,
          output_tokens: 4,
          cached_input_tokens: 2,
          total_tokens: 14,
        },
        output_items: [{ type: "message", content: "done" }],
      });
      await writePayload(bundleDir, "tool-input", { command: "pwd" });
      await writePayload(bundleDir, "tool-output", { output: "/tmp" });
      await writeTrace(bundleDir, [
        traceEvent(1, 1_000, "inference_started", {
          inference_call_id: "provider-call",
          model: "openai/gpt-5.5",
          provider_name: "openai",
          request_payload: payloadRef("request"),
        }),
        traceEvent(2, 1_010, "tool_call_started", {
          tool_call_id: "tool-call",
          invocation_payload: payloadRef("tool-input"),
        }),
        traceEvent(3, 1_020, "tool_call_ended", {
          tool_call_id: "tool-call",
          status: "completed",
          result_payload: payloadRef("tool-output"),
        }),
        traceEvent(4, 1_075, "inference_completed", {
          inference_call_id: "provider-call",
          response_id: "resp-secret",
          upstream_request_id: "request-secret",
          response_payload: payloadRef("response"),
        }),
        traceEvent(5, 1_080, "codex_turn_ended", { status: "completed" }),
      ]);

      const events: DiagnosticRecord[] = [];
      const privateData = new Map<string, DiagnosticEventPrivateData | undefined>();
      onInternalDiagnosticEvent((event) => events.push(event as DiagnosticRecord));
      onTrustedInternalDiagnosticEvent(
        (event, _metadata, data) => {
          if (event.type.startsWith("model.call.") && event.callId) {
            privateData.set(`${event.type}:${event.callId}`, data);
          }
        },
        {
          captureModelContent: {
            inputMessages: true,
            outputMessages: true,
            systemPrompt: true,
          },
        },
      );

      await expect(
        finalizeCodexRolloutTraceProviderRequestDiagnostics({
          traceRoot,
          threadId: "thread-1",
          turnId: "turn-1",
          baseFields: {
            runId: "run-1",
            callId: "turn-call",
            sessionId: "session-1",
            provider: "codex",
            model: "openai/gpt-5.5",
            runtime: "codex",
            runtimeEngine: "codex-app-server",
            transport: "stdio",
          },
          capture: { inputMessages: true, outputMessages: true, systemPrompt: true },
        }),
      ).resolves.toMatchObject({
        emitted: 4,
        complete: true,
        emittedToolLifecycleKeys: ["started:tool-call", "terminal:tool-call"],
      });
      await waitForDiagnosticEventsDrained();

      const modelEvents = events.filter((event) => event.type.startsWith("model.call."));
      expect(modelEvents.map((event) => event.type)).toEqual([
        "model.call.started",
        "model.call.completed",
      ]);
      expect(modelEvents.every((event) => event.scope === "provider-request")).toBe(true);
      expect(modelEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runtime: "codex",
            runtimeEngine: "codex-app-server",
            transport: "stdio",
          }),
        ]),
      );
      expect(modelEvents[1]).toMatchObject({
        callId: "provider-call",
        durationMs: 75,
        usageSource: "provider",
        usage: { input: 8, output: 4, cacheRead: 2, total: 14 },
      });
      expect(
        events
          .filter((event) => event.type.startsWith("tool.execution."))
          .map((event) => ({
            type: event.type,
            toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
            toolOwner: "toolOwner" in event ? event.toolOwner : undefined,
          })),
      ).toEqual([
        {
          type: "tool.execution.started",
          toolCallId: "tool-call",
          toolOwner: "codex-rollout-trace",
        },
        {
          type: "tool.execution.completed",
          toolCallId: "tool-call",
          toolOwner: "codex-rollout-trace",
        },
      ]);
      expect(privateData.get("model.call.started:provider-call")?.modelContent).toMatchObject({
        inputMessages: [{ role: "user", content: "hello" }],
        systemPrompt: "system",
      });
      expect(privateData.get("model.call.completed:provider-call")?.modelContent).toMatchObject({
        outputMessages: [{ type: "message", content: "done" }],
      });
      expect(JSON.stringify(events)).not.toContain("request-secret");
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("emits a failed provider request with partial output", async () => {
    const traceRoot = await createTraceRoot("provider-failure");
    try {
      const bundleDir = path.join(traceRoot, "trace-one");
      await writePayload(bundleDir, "request", {
        model: "openai/gpt-5.5",
        input: [{ role: "user", content: "hello" }],
      });
      await writePayload(bundleDir, "partial", {
        output_items: [{ type: "message", content: "partial" }],
      });
      await writeTrace(bundleDir, [
        traceEvent(1, 2_000, "inference_started", {
          inference_call_id: "failed-call",
          request_payload: payloadRef("request"),
        }),
        traceEvent(2, 2_050, "inference_failed", {
          inference_call_id: "failed-call",
          error: "provider unavailable",
          partial_response_payload: payloadRef("partial"),
        }),
        traceEvent(3, 2_060, "codex_turn_ended", { status: "failed" }),
      ]);
      const events: DiagnosticRecord[] = [];
      const privateData = new Map<string, DiagnosticEventPrivateData | undefined>();
      onInternalDiagnosticEvent((event) => events.push(event as DiagnosticRecord));
      onTrustedInternalDiagnosticEvent((event, _metadata, data) => {
        if (event.type === "model.call.error") {
          privateData.set(event.callId, data);
        }
      });

      await expect(
        finalizeCodexRolloutTraceProviderRequestDiagnostics({
          traceRoot,
          threadId: "thread-1",
          turnId: "turn-1",
          baseFields: {
            runId: "run-2",
            callId: "turn-call",
            provider: "codex",
            model: "gpt-5.5",
            runtime: "codex",
            runtimeEngine: "codex-app-server",
            transport: "stdio",
          },
          emitToolDiagnostics: false,
        }),
      ).resolves.toMatchObject({ emitted: 2, complete: true });
      await waitForDiagnosticEventsDrained();

      expect(events.filter((event) => event.type.startsWith("model.call."))).toEqual([
        expect.objectContaining({ type: "model.call.started", callId: "failed-call" }),
        expect.objectContaining({
          type: "model.call.error",
          callId: "failed-call",
          scope: "provider-request",
          errorCategory: "error",
          usageSource: "unknown",
          runtime: "codex",
          runtimeEngine: "codex-app-server",
          transport: "stdio",
        }),
      ]);
      expect(privateData.get("failed-call")?.errorMessage).toBe("provider unavailable");
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("orders three provider requests by rollout source and de-duplicates repeated final drains", async () => {
    const traceRoot = await createTraceRoot("provider-order");
    try {
      const bundleDir = path.join(traceRoot, "trace-one");
      await writeTrace(bundleDir, [
        traceEvent(1, 1_000, "inference_started", { inference_call_id: "call-1" }),
        traceEvent(2, 1_010, "inference_completed", { inference_call_id: "call-1" }),
        traceEvent(3, 1_020, "inference_started", { inference_call_id: "call-2" }),
        traceEvent(4, 1_030, "inference_failed", {
          inference_call_id: "call-2",
          error: "retryable",
        }),
        traceEvent(5, 1_040, "inference_started", { inference_call_id: "call-3" }),
        traceEvent(6, 1_050, "inference_completed", { inference_call_id: "call-3" }),
        traceEvent(7, 1_060, "codex_turn_ended", { status: "completed" }),
      ]);
      const events: DiagnosticRecord[] = [];
      onInternalDiagnosticEvent((event) => {
        if (event.type.startsWith("model.call.")) {
          events.push(event as DiagnosticRecord);
        }
      });
      const params = {
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-order", provider: "codex", model: "gpt-5.5" },
      };

      await expect(
        finalizeCodexRolloutTraceProviderRequestDiagnostics(params),
      ).resolves.toMatchObject({ emitted: 6, complete: true });
      await expect(
        finalizeCodexRolloutTraceProviderRequestDiagnostics(params),
      ).resolves.toMatchObject({ emitted: 0, complete: true });
      await waitForDiagnosticEventsDrained();

      expect(
        events.map((event) => ({
          type: event.type,
          callId: event.callId,
          providerRequestIndex: event.providerRequestIndex,
        })),
      ).toEqual([
        { type: "model.call.started", callId: "call-1", providerRequestIndex: 1 },
        { type: "model.call.completed", callId: "call-1", providerRequestIndex: 1 },
        { type: "model.call.started", callId: "call-2", providerRequestIndex: 2 },
        { type: "model.call.error", callId: "call-2", providerRequestIndex: 2 },
        { type: "model.call.started", callId: "call-3", providerRequestIndex: 3 },
        { type: "model.call.completed", callId: "call-3", providerRequestIndex: 3 },
      ]);
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("synthesizes a stable start for a terminal-only provider request", async () => {
    const traceRoot = await createTraceRoot("provider-terminal-only");
    try {
      const bundleDir = path.join(traceRoot, "trace-one");
      await writeTrace(bundleDir, [
        traceEvent(7, 1_040, "inference_completed", {
          inference_call_id: "terminal-only",
          duration_ms: 40,
        }),
        traceEvent(8, 1_050, "codex_turn_ended", { status: "completed" }),
      ]);
      const events: DiagnosticRecord[] = [];
      onInternalDiagnosticEvent((event) => {
        if (event.type.startsWith("model.call.")) {
          events.push(event as DiagnosticRecord);
        }
      });
      const params = {
        traceRoot,
        threadId: "thread-1",
        turnId: "turn-1",
        baseFields: { runId: "run-terminal-only", provider: "codex", model: "gpt-5.5" },
      };

      await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(2);
      await expect(emitCodexRolloutTraceProviderRequestDiagnostics(params)).resolves.toBe(0);
      await waitForDiagnosticEventsDrained();

      expect(events).toMatchObject([
        {
          type: "model.call.started",
          callId: "terminal-only",
          providerRequestIndex: 1,
          syntheticStart: true,
          startTimeMs: 1_000,
        },
        {
          type: "model.call.completed",
          callId: "terminal-only",
          providerRequestIndex: 1,
          startTimeMs: 1_000,
          endTimeMs: 1_040,
          durationMs: 40,
        },
      ]);
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("keeps an incomplete bundle after client close for the terminal drain", async () => {
    const traceRoot = await createTraceRoot("close-race");
    try {
      const bundleDir = path.join(traceRoot, "attempt-one", "trace-one");
      await fs.mkdir(bundleDir, { recursive: true });
      await fs.writeFile(
        path.join(bundleDir, "manifest.json"),
        `${JSON.stringify({ root_thread_id: "thread-1" })}\n`,
      );
      await fs.writeFile(
        path.join(bundleDir, "trace.jsonl"),
        traceEvent(1, 3_000, "inference_failed", {
          inference_call_id: "failed-call",
          error: "provider unavailable",
        }),
      );
      let closeHandler: (() => void) | undefined;
      const client = {
        addCloseHandler(handler: () => void) {
          closeHandler = handler;
        },
      };
      await registerCodexRolloutTraceClient({
        traceRoot,
        threadId: "thread-1",
        client: client as never,
      });
      closeHandler?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(fs.access(bundleDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });

  it("does not prune the trace root on every traced turn", async () => {
    const traceRoot = await createTraceRoot("prune-once");
    try {
      for (const name of ["bundle-one", "bundle-two"]) {
        await writeTrace(path.join(traceRoot, name), [
          traceEvent(1, 4_000, "codex_turn_ended", { status: "completed" }),
        ]);
      }
      await prepareCodexRolloutTraceRoot(traceRoot);
      await writeTrace(path.join(traceRoot, "bundle-three"), [
        traceEvent(1, 4_000, "codex_turn_ended", { status: "completed" }),
      ]);
      await prepareCodexRolloutTraceRoot(traceRoot);
      const entries = await fs.readdir(traceRoot, { withFileTypes: true });
      expect(entries.filter((entry) => entry.isDirectory())).toHaveLength(3);
    } finally {
      await fs.rm(traceRoot, { recursive: true, force: true });
    }
  });
});

async function createTraceRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-codex-${label}-`));
}

async function writePayload(bundleDir: string, id: string, payload: unknown): Promise<void> {
  const payloadsDir = path.join(bundleDir, "payloads");
  await fs.mkdir(payloadsDir, { recursive: true });
  await fs.writeFile(path.join(payloadsDir, `${id}.json`), `${JSON.stringify(payload)}\n`);
}

async function writeTrace(bundleDir: string, events: string[]): Promise<void> {
  await fs.mkdir(bundleDir, { recursive: true });
  await fs.writeFile(path.join(bundleDir, "manifest.json"), "{}\n");
  await fs.writeFile(path.join(bundleDir, "trace.jsonl"), events.join(""));
}

function payloadRef(id: string) {
  return {
    raw_payload_id: `raw_payload:${id}`,
    kind: { type: "inference_request" },
    path: `payloads/${id}.json`,
  };
}

function traceEvent(
  seq: number,
  wallTimeMs: number,
  type: string,
  payload: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    schema_version: 1,
    seq,
    wall_time_unix_ms: wallTimeMs,
    rollout_id: "rollout-1",
    thread_id: "thread-1",
    codex_turn_id: "turn-1",
    payload: { type, ...payload, thread_id: "thread-1", codex_turn_id: "turn-1" },
  })}\n`;
}
