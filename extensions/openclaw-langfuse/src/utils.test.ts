import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LANGFUSE_PLUGIN_EVENT_BODY_LIMIT_BYTES,
  LANGFUSE_SDK_EVENT_ENVELOPE_HEADROOM_BYTES,
  LANGFUSE_SDK_EVENT_LIMIT_BYTES,
  MAX_PAYLOAD_BYTES,
  addUsageToTotals,
  buildApiMessage,
  buildGenerationOutput,
  extractTextContent,
  extractUserMessageText,
  findAggregateOnlyUsageEntry,
  isReasoningOnlyAssistantMessage,
  normalizeModelCallInput,
  truncatePayload,
  usageDetailsFromUsage,
} from "./utils.js";

describe("message content extraction", () => {
  it("extracts nested tool-result content blocks", () => {
    expect(
      extractTextContent([
        { type: "toolResult", content: "first result" },
        { type: "toolResult", content: [{ type: "text", text: "second result" }] },
      ]),
    ).toBe("first result\nsecond result");
  });

  it("stops at recursive content cycles while preserving reachable text", () => {
    const recursiveBlock: { content?: unknown } = {};
    recursiveBlock.content = recursiveBlock;

    expect(
      extractTextContent([
        { type: "text", text: "before" },
        recursiveBlock,
        { type: "toolResult", content: "after" },
      ]),
    ).toBe("before\nafter");
  });

  it("stops before excessive content nesting depth", () => {
    let content: unknown = { type: "text", text: "too deep" };
    for (let i = 0; i < 2000; i++) {
      content = { content };
    }

    expect(extractTextContent(content)).toBe("");
  });

  it("removes only the injected sender metadata fence", () => {
    const content = [
      "Sender (untrusted metadata):",
      "```json",
      '{"label":"control-ui"}',
      "```",
      "",
      "[Sun 2026-07-20 12:00 GMT+8] Keep this example:",
      "```ts",
      'console.log("visible")',
      "```",
    ].join("\n");

    expect(extractUserMessageText(content)).toBe(
      ["Keep this example:", "```ts", 'console.log("visible")', "```"].join("\n"),
    );
  });
});

describe("truncatePayload", () => {
  it("omits encrypted reasoning content before applying the payload limit", () => {
    const truncated = truncatePayload({
      type: "reasoning",
      summary: [],
      encrypted_content: "x".repeat(MAX_PAYLOAD_BYTES * 2),
    });

    expect(truncated).toEqual({
      type: "reasoning",
      summary: [],
    });
  });

  it("does not restore encrypted reasoning content while normalizing circular payloads", () => {
    const payload: Record<string, unknown> = {
      type: "reasoning",
      encrypted_content: "test-encrypted-content",
    };
    payload.self = payload;

    expect(truncatePayload(payload)).toEqual({
      type: "reasoning",
      self: "[unserializable: circular]",
    });
  });

  it("keeps the complete truncated value inside the byte limit", () => {
    const truncated = truncatePayload({ text: "x".repeat(MAX_PAYLOAD_BYTES * 2) });

    expect(typeof truncated).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(String(truncated)).toContain("[truncated: original size");
  });

  it("keeps escape-heavy truncated strings inside the serialized byte limit", () => {
    const truncated = truncatePayload('\\"'.repeat(MAX_PAYLOAD_BYTES));

    expect(typeof truncated).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
    expect(String(truncated)).toContain("[truncated: original size");
  });

  it("does not split a surrogate pair at the boundary", () => {
    const truncated = String(truncatePayload({ text: "😀".repeat(MAX_PAYLOAD_BYTES) }));
    const content = truncated.slice(0, truncated.indexOf("\n[truncated:"));
    const lastCodeUnit = content.charCodeAt(content.length - 1);

    expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
  });

  it("returns a safe representation for circular values", () => {
    const payload: { name: string; self?: unknown } = { name: "root" };
    payload.self = payload;

    const truncated = truncatePayload(payload);

    expect(truncated).toEqual({ name: "root", self: "[unserializable: circular]" });
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
  });

  it("fails closed for payloads with throwing custom serialization", () => {
    const payload = {
      count: 1n,
      value: "kept",
      toJSON() {
        throw new Error("nope");
      },
    };

    const truncated = truncatePayload(payload);

    expect(truncated).toBe("[unserializable: projection]");
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
  });
});

describe("model-call input normalization", () => {
  it("omits encrypted reasoning content from the Langfuse generation projection", () => {
    const normalized = normalizeModelCallInput({
      model: "gpt-5.6-sol",
      messages: [
        {
          type: "reasoning",
          id: "rs-1",
          summary: [],
          encrypted_content: "test-encrypted-content",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible" }],
        },
      ],
      redactEnabled: false,
    });

    expect(normalized.generationInput).toEqual({
      model: "gpt-5.6-sol",
      messages: [
        {
          type: "reasoning",
          id: "rs-1",
          summary: [],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible" }],
        },
      ],
    });
  });

  it("omits OpenClaw thinking signatures from the Langfuse generation projection", () => {
    const normalized = normalizeModelCallInput({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Checking the request",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                encrypted_content: "test-encrypted-content",
              }),
            },
          ],
        },
      ],
      redactEnabled: false,
    });

    expect(normalized.generationInput).toEqual({
      model: "gpt-5.6-sol",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Checking the request",
            },
          ],
        },
      ],
    });
  });

  it("keeps current-call messages structured when the old combined Codex payload truncates", () => {
    const currentUser = { role: "user", content: "current request" };
    const combined = truncatePayload({
      systemPrompt: "s".repeat(MAX_PAYLOAD_BYTES),
      messages: [{ role: "user", content: "old request" }, currentUser],
      tools: [{ type: "function", name: "search", description: "d".repeat(4096) }],
    });

    const normalized = normalizeModelCallInput({
      model: "qwen3.7-plus",
      systemPrompt: "s".repeat(MAX_PAYLOAD_BYTES),
      messages: [{ role: "user", content: "old request" }, currentUser],
      firstGenerationInput: "current request",
      priorMessages: [{ role: "user", content: "old request" }],
      tools: [{ type: "function", name: "search", description: "d".repeat(4096) }],
      redactEnabled: false,
    });

    expect(typeof combined).toBe("string");
    expect(normalized.generationInput).toEqual({
      model: "qwen3.7-plus",
      messages: [{ role: "user", content: "current request" }],
    });
    expect(normalized.traceMetadata.system_prompt_truncated).toBe(true);
    expect(normalized.traceMetadata.prior_conversation).toEqual([
      { role: "user", content: "old request" },
    ]);
  });

  it("calculates subsequent call deltas from the prior provider input", () => {
    const firstMessages = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
    ];
    const first = normalizeModelCallInput({
      model: "model",
      systemPrompt: "system",
      messages: firstMessages,
      firstGenerationInput: "current request",
      priorMessages: firstMessages.slice(0, 2),
      redactEnabled: false,
    });
    const assistantToolCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"query":"go"}' },
        },
      ],
    };
    const toolResult = {
      role: "tool",
      tool_call_id: "call-1",
      content: '{"total":1}',
    };
    const second = normalizeModelCallInput({
      model: "model",
      systemPrompt: "system",
      messages: [...firstMessages, assistantToolCall, toolResult],
      previousMessages: first.nextMessages,
      redactEnabled: false,
    });

    expect(first.generationInput).toEqual({
      model: "model",
      messages: [{ role: "user", content: "current request" }],
    });
    expect(second.generationInput).toMatchObject({
      messages: [assistantToolCall, toolResult],
    });
    expect(second.traceMetadata.prior_conversation).toBeUndefined();
  });

  it("does not infer prior conversation from a complete provider request", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      systemPrompt: "system",
      messages: [
        { role: "developer", content: "runtime bootstrap" },
        { role: "user", content: "current request" },
      ],
      firstGenerationInput: "current request",
      redactEnabled: false,
    });

    expect(normalized.generationInput).toEqual({
      model: "model",
      messages: [{ role: "user", content: "current request" }],
    });
    expect(normalized.traceMetadata.prior_conversation).toBeUndefined();
  });

  it("projects prior history to value-bearing API messages", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [{ role: "user", content: "current request" }],
      firstGenerationInput: "current request",
      priorMessages: [
        {
          role: "user",
          content: "old request",
          timestamp: 123,
          sourceChannel: "webchat",
          __openclaw: { mirrorIdentity: "internal" },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          provider: "openai",
          model: "gpt-5.6-sol",
          usage: { input: 100, output: 20, totalTokens: 120 },
          stopReason: "stop",
          timestamp: 456,
          __openclaw: { mirrorIdentity: "internal" },
        },
      ],
      redactEnabled: false,
    });

    expect(normalized.traceMetadata.prior_conversation).toEqual([
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
    ]);
    expect(normalized.traceMetadata.prior_conversation_projection).toBe("value");
    expect(JSON.stringify(normalized.traceMetadata.prior_conversation)).not.toContain(
      "gpt-5.6-sol",
    );
    expect(JSON.stringify(normalized.traceMetadata.prior_conversation)).not.toContain(
      "mirrorIdentity",
    );
  });

  it("omits Codex reasoning-only mirror rows from prior history", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [{ role: "user", content: "current request" }],
      firstGenerationInput: "current request",
      priorMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "internal reasoning" }],
          __openclaw: { mirrorIdentity: "turn-1:reasoning" },
        },
        { role: "user", content: "old request" },
      ],
      redactEnabled: false,
    });

    expect(normalized.traceMetadata.prior_conversation).toEqual([
      { role: "user", content: "old request" },
    ]);
    expect(normalized.traceMetadata.prior_conversation_message_count).toBe(2);
    expect(normalized.traceMetadata.prior_conversation_retained_message_count).toBe(1);
  });

  it("keeps tool-call identity and result content in the prior projection", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [{ role: "user", content: "current request" }],
      firstGenerationInput: "current request",
      priorMessages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "lookup", input: { q: "old" } }],
          usage: { input: 10, output: 2 },
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "lookup",
          content: "candidate result",
          timestamp: 789,
        },
      ],
      redactEnabled: false,
    });

    expect(normalized.traceMetadata.prior_conversation).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"old"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "candidate result" },
    ]);
  });

  it("accounts for UTF-8 bytes and hashes redacted logical content before truncation", () => {
    const priorMessages = [{ role: "user", content: "密钥-secret" }];
    const normalized = normalizeModelCallInput({
      model: "model",
      systemPrompt: "密钥-secret",
      messages: [
        { role: "user", content: "历史消息" },
        { role: "assistant", content: "历史回复" },
        { role: "user", content: "当前消息" },
      ],
      firstGenerationInput: "当前消息",
      priorMessages,
      redactEnabled: true,
    });
    const redacted = "[REDACTED]";
    const expectedBytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
    const expectedHash = createHash("sha256").update(JSON.stringify(redacted)).digest("hex");
    const redactedPriorMessages: unknown[] = [];
    const expectedPriorHash = createHash("sha256")
      .update(JSON.stringify(redactedPriorMessages))
      .digest("hex");

    expect(normalized.traceMetadata.system_prompt).toBe(redacted);
    expect(normalized.traceMetadata.system_prompt_bytes).toBe(expectedBytes);
    expect(normalized.traceMetadata.system_prompt_sha256).toBe(expectedHash);
    expect(normalized.traceMetadata.prior_conversation).toEqual(redactedPriorMessages);
    expect(normalized.traceMetadata.prior_conversation_sha256).toBe(expectedPriorHash);
    expect(JSON.stringify(normalized.traceMetadata)).not.toContain("secret");
    expect(JSON.stringify(normalized.traceMetadata)).not.toContain("历史消息");
  });

  it("preserves current messages and replaces oversized tool definitions with size metadata", () => {
    const currentMessage = { role: "user", content: "keep this message intact" };
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [currentMessage],
      tools: Array.from({ length: 20 }, (_, index) => ({
        type: "function",
        name: `tool-${index}`,
        description: "x".repeat(10_000),
      })),
      redactEnabled: false,
    });
    const input = normalized.generationInput as {
      messages: unknown[];
      tools: {
        truncated: boolean;
        original_bytes: number;
        sha256: string;
        tool_count: number;
      };
    };

    expect(input.messages).toEqual([currentMessage]);
    expect(input.tools.truncated).toBe(true);
    expect(input.tools.original_bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(input.tools.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.tools.tool_count).toBe(20);
    expect(
      Buffer.byteLength(JSON.stringify(normalized.generationInput), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("keeps oversized current-call messages structurally inspectable", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [
        {
          role: "assistant",
          content: "x".repeat(MAX_PAYLOAD_BYTES * 2),
          tool_calls: [
            {
              id: "call-oversized",
              type: "function",
              function: {
                name: "lookup",
                arguments: "y".repeat(MAX_PAYLOAD_BYTES * 2),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-oversized",
          content: "z".repeat(MAX_PAYLOAD_BYTES * 2),
        },
      ],
      redactEnabled: false,
    });
    const input = normalized.generationInput as {
      messages: Array<Record<string, unknown>>;
      messages_truncation: { truncated: boolean; original_count: number; retained_count: number };
    };

    expect(input.messages).toHaveLength(2);
    expect(input.messages[0]).toMatchObject({
      role: "assistant",
      content: { truncated: true, original_bytes: expect.any(Number) },
      tool_calls: [
        {
          id: "call-oversized",
          type: "function",
          function: {
            name: "lookup",
            arguments: { truncated: true, original_bytes: expect.any(Number) },
          },
        },
      ],
    });
    expect(input.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call-oversized",
      content: { truncated: true, original_bytes: expect.any(Number) },
    });
    expect(input.messages_truncation).toMatchObject({
      truncated: true,
      original_count: 2,
      retained_count: 2,
    });
    expect(
      Buffer.byteLength(JSON.stringify(normalized.generationInput), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("keeps size-bounded model-call messages as a contiguous suffix", () => {
    const toolResult = {
      role: "tool",
      tool_call_id: "call-oversized",
      content: '{"total":1}',
    };
    const normalized = normalizeModelCallInput({
      model: "model",
      messages: [
        { role: "user", content: "older request" },
        {
          role: "assistant",
          content: null,
          tool_calls: Array.from({ length: 32 }, (_, index) => ({
            id: `call-${index}-${"i".repeat(1900)}`,
            type: `function-${"t".repeat(1900)}`,
            function: {
              name: `lookup-${"n".repeat(1900)}`,
              arguments: "a".repeat(1900),
            },
          })),
        },
        toolResult,
      ],
      redactEnabled: false,
    });
    const input = normalized.generationInput as {
      messages: unknown[];
      messages_truncation: { retained_count: number };
    };

    expect(input.messages).toEqual([]);
    expect(input.messages_truncation.retained_count).toBe(0);
    expect(
      Buffer.byteLength(JSON.stringify(normalized.generationInput), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("bounds an oversized model identifier in compact generation input", () => {
    const normalized = normalizeModelCallInput({
      model: `model-${"x".repeat(MAX_PAYLOAD_BYTES * 2)}`,
      messages: [{ role: "user", content: "y".repeat(MAX_PAYLOAD_BYTES * 2) }],
      redactEnabled: false,
    });
    const input = normalized.generationInput as {
      model: { truncated: boolean; original_bytes: number; sha256: string };
      messages: unknown[];
    };

    expect(input.model).toMatchObject({
      truncated: true,
      original_bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(input.messages).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(normalized.generationInput), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("keeps independently bounded context plus generation input below the SDK event cap", () => {
    const normalized = normalizeModelCallInput({
      model: "model",
      systemPrompt: "系".repeat(MAX_PAYLOAD_BYTES),
      messages: [
        { role: "user", content: "历".repeat(MAX_PAYLOAD_BYTES) },
        { role: "user", content: "current" },
      ],
      firstGenerationInput: "current",
      priorMessages: [{ role: "user", content: "历".repeat(MAX_PAYLOAD_BYTES) }],
      tools: [{ type: "function", name: "tool", description: "d".repeat(MAX_PAYLOAD_BYTES) }],
      redactEnabled: false,
    });
    const event = {
      input: normalized.generationInput,
      metadata: normalized.traceMetadata,
      output: "ok",
    };

    expect(
      Buffer.byteLength(JSON.stringify(normalized.traceMetadata.system_prompt), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify(normalized.traceMetadata.prior_conversation), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify(normalized.generationInput), "utf8"),
    ).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    expect(eventBytes).toBeLessThanOrEqual(LANGFUSE_PLUGIN_EVENT_BODY_LIMIT_BYTES);
    expect(LANGFUSE_SDK_EVENT_LIMIT_BYTES - LANGFUSE_PLUGIN_EVENT_BODY_LIMIT_BYTES).toBe(
      LANGFUSE_SDK_EVENT_ENVELOPE_HEADROOM_BYTES,
    );
  });
});

describe("buildApiMessage", () => {
  it("preserves assistant tool calls and maps tool results to OpenAI roles", () => {
    expect(
      buildApiMessage({
        role: "assistant",
        content: [
          { type: "text", text: "searching" },
          { type: "toolCall", id: "call-1", name: "search", input: { query: "go" } },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: "searching",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"query":"go"}' },
        },
      ],
    });
    expect(
      buildApiMessage({
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: '{"total":1}' }],
      }),
    ).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: '{"total":1}',
    });
  });
});

describe("usage aggregation", () => {
  it("derives aggregate total from input and output when explicit totals are missing", () => {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    addUsageToTotals(totals, { input: 7, output: 11, cacheRead: 3 });

    expect(totals).toEqual({ input: 7, output: 11, cacheRead: 3, cacheWrite: 0, total: 18 });
    expect(usageDetailsFromUsage({ input: 7, output: 11, cacheRead: 3 })).toEqual({
      input: 7,
      output: 11,
      total: 18,
      cache_read_input_tokens: 3,
    });

    expect(usageDetailsFromUsage({ input: 7 })).toEqual({ input: 7, total: 7 });
    expect(
      usageDetailsFromUsage({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 0,
      }),
    ).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  it("recognizes an explicitly reported all-zero aggregate usage entry", () => {
    const firstAssistant = {
      timestamp: 1,
      message: { role: "assistant", content: "tool call" },
    };
    const toolResult = {
      timestamp: 2,
      message: { role: "toolResult", content: "done" },
    };
    const aggregateAssistant = {
      timestamp: 3,
      message: {
        role: "assistant",
        content: "final",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };

    expect(
      findAggregateOnlyUsageEntry(
        [firstAssistant, aggregateAssistant],
        [firstAssistant, toolResult, aggregateAssistant],
      ),
    ).toBe(aggregateAssistant);
  });
});

describe("buildGenerationOutput", () => {
  it("removes the complete tool-call payload when redaction is enabled", () => {
    const output = buildGenerationOutput(
      [
        { type: "text", text: "calling tool" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "fetch_secret",
          input: {
            query: "normal",
            accessToken: "plain-access-token",
            nested: { apiKey: "plain-api-key" },
          },
        },
      ],
      true,
    ) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };

    const args = output.tool_calls[0]?.function.arguments ?? "";
    expect(args).toBe('"[REDACTED]"');
    expect(args).not.toContain("accessToken");
    expect(args).not.toContain("apiKey");
    expect(args).not.toContain("plain-access-token");
    expect(args).not.toContain("plain-api-key");
  });

  it("preserves tool-call arguments when redaction is disabled", () => {
    const output = buildGenerationOutput(
      [
        {
          type: "toolCall",
          id: "tool-1",
          name: "fetch_secret",
          input: { accessToken: "plain-access-token" },
        },
      ],
      false,
    ) as {
      tool_calls: Array<{ function: { arguments: string } }>;
    };

    expect(output.tool_calls[0]?.function.arguments).toContain("plain-access-token");
  });
});

describe("isReasoningOnlyAssistantMessage", () => {
  it("keeps the canonical Codex reasoning mirror marker", () => {
    expect(
      isReasoningOnlyAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text: "anything" }],
        __openclaw: { mirrorIdentity: "turn-1:reasoning" },
      }),
    ).toBe(true);
  });

  it("does not suppress visible assistant text from a Codex provider by prefix alone", () => {
    expect(
      isReasoningOnlyAssistantMessage({
        role: "assistant",
        provider: "codex",
        content: [{ type: "text", text: "Codex reasoning:\nthis is normal user-visible text" }],
        usage: { input: 0, output: 0, totalTokens: 0 },
      }),
    ).toBe(false);

    expect(
      isReasoningOnlyAssistantMessage({
        role: "assistant",
        metadata: { provider: "codex" },
        content: [{ type: "text", text: "Codex reasoning:\nmetadata is not authoritative" }],
      }),
    ).toBe(false);
  });
});
