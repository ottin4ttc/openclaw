import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  addUsageToTotals,
  buildGenerationOutput,
  extractTextContent,
  extractUserMessageText,
  isReasoningOnlyAssistantMessage,
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

  it("returns safe markers for BigInt and throwing toJSON values", () => {
    const payload = {
      count: 1n,
      value: "kept",
      toJSON() {
        throw new Error("nope");
      },
    };

    const truncated = truncatePayload(payload);

    expect(truncated).toEqual({
      count: "[unserializable: bigint]",
      value: "kept",
      toJSON: "[unserializable: function]",
    });
    expect(Buffer.byteLength(JSON.stringify(truncated), "utf8")).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES,
    );
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
