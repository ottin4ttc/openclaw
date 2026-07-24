import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createSessionHarness() {
  let sessionListener: ((event: AgentEvent) => void) | undefined;
  let agentListener: ((event: AgentEvent) => void) | undefined;
  const unsubscribeSession = vi.fn();
  const unsubscribeAgent = vi.fn();
  const agentState = { messages: [] as AgentMessage[] };
  const sessionRuntime = {
    _agentEventQueue: Promise.resolve() as Promise<unknown>,
    isCompacting: false,
    abortCompaction: vi.fn(),
    subscribe(nextListener: (event: AgentEvent) => void) {
      sessionListener = nextListener;
      return unsubscribeSession;
    },
    agent: {
      state: agentState,
      subscribe(nextListener: (event: AgentEvent) => void) {
        agentListener = nextListener;
        return unsubscribeAgent;
      },
    },
  };
  const session = sessionRuntime as unknown as Parameters<
    typeof subscribeEmbeddedPiSession
  >[0]["session"];

  return {
    session,
    agentState,
    unsubscribeSession,
    unsubscribeAgent,
    emitFromAgent(event: AgentEvent) {
      agentListener?.(event);
    },
    emitFromSession(event: AgentEvent) {
      sessionListener?.(event);
    },
    queueFromSession(event: AgentEvent, afterBroadcast?: () => Promise<void>) {
      sessionRuntime._agentEventQueue = sessionRuntime._agentEventQueue.then(async () => {
        sessionListener?.(event);
        await afterBroadcast?.();
      });
    },
  };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as AgentMessage;
}

describe("subscribeEmbeddedPiSession event drain", () => {
  it("waits for the agent_end containing the final agent-state message", async () => {
    const harness = createSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session: harness.session,
      runId: "run-event-drain",
    });
    const retryError = assistantMessage("retrying");
    const finalMessage = assistantMessage("done");

    harness.emitFromAgent({ type: "agent_end", messages: [retryError] });
    harness.emitFromAgent({ type: "agent_end", messages: [finalMessage] });
    harness.agentState.messages = [retryError, finalMessage];
    const finalQueueTask = deferred<void>();
    harness.queueFromSession({ type: "agent_end", messages: [retryError] });
    harness.queueFromSession(
      { type: "agent_end", messages: [finalMessage] },
      () => finalQueueTask.promise,
    );

    let drained = false;
    const waitPromise = subscription.waitForEventDrain().then(() => {
      drained = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    finalQueueTask.resolve();
    await waitPromise;
    expect(drained).toBe(true);
  });

  it("waits for compaction work after agent_end broadcasts and replaces agent state", async () => {
    const harness = createSessionHarness();
    const subscription = subscribeEmbeddedPiSession({
      session: harness.session,
      runId: "run-compaction-drain",
    });
    const finalMessage = assistantMessage("done");
    const compaction = deferred<void>();

    harness.emitFromAgent({ type: "agent_end", messages: [finalMessage] });
    harness.queueFromSession({ type: "agent_end", messages: [finalMessage] }, async () => {
      harness.agentState.messages = [assistantMessage("compacted summary")];
      await compaction.promise;
    });

    let drained = false;
    const waitPromise = subscription.waitForEventDrain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);

    compaction.resolve();
    await waitPromise;
    expect(drained).toBe(true);
  });

  it("waits for asynchronous tool event handlers already dispatched before agent_end", async () => {
    const harness = createSessionHarness();
    const blockReplyFlush = deferred<void>();
    const subscription = subscribeEmbeddedPiSession({
      session: harness.session,
      runId: "run-async-event-drain",
      onBlockReplyFlush: () => blockReplyFlush.promise,
    });
    const finalMessage = assistantMessage("done");
    harness.emitFromAgent({ type: "agent_end", messages: [finalMessage] });

    let drained = false;
    const waitPromise = subscription.waitForEventDrain().then(() => {
      drained = true;
    });

    harness.emitFromSession({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "/tmp/example" },
    });
    harness.emitFromSession({ type: "agent_end", messages: [finalMessage] });
    await Promise.resolve();
    expect(drained).toBe(false);

    blockReplyFlush.resolve();
    await waitPromise;
    expect(drained).toBe(true);
  });

  it("serializes start and end handlers for the same tool call", async () => {
    const harness = createSessionHarness();
    const blockReplyFlush = deferred<void>();
    const phases: string[] = [];
    const subscription = subscribeEmbeddedPiSession({
      session: harness.session,
      runId: "run-tool-order",
      onBlockReplyFlush: () => blockReplyFlush.promise,
      onAgentEvent: (event) => {
        if (event.stream === "tool" && typeof event.data.phase === "string") {
          phases.push(event.data.phase);
        }
      },
    });
    const finalMessage = assistantMessage("done");
    harness.emitFromAgent({ type: "agent_end", messages: [finalMessage] });

    const waitPromise = subscription.waitForEventDrain();
    harness.emitFromSession({
      type: "tool_execution_start",
      toolCallId: "tool-ordered",
      toolName: "read",
      args: { path: "/tmp/example" },
    });
    harness.emitFromSession({
      type: "tool_execution_end",
      toolCallId: "tool-ordered",
      toolName: "read",
      result: { content: "ok" },
      isError: false,
    });
    harness.emitFromSession({ type: "agent_end", messages: [finalMessage] });

    blockReplyFlush.resolve();
    await waitPromise;

    expect(phases).toEqual(["start", "result"]);
  });
});
