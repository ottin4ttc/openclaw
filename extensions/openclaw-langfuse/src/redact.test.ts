import { describe, it, expect } from "vitest";
import { redactText, redactObject } from "./redact.js";

describe("redactText", () => {
  it("redacts all non-empty content", () => {
    expect(redactText("ordinary prompt content")).toBe("[REDACTED]");
  });

  it("disabled redaction returns original text unchanged", () => {
    const input = "Bearer supersecrettoken sk-abc123def456789012345";
    expect(redactText(input, false)).toBe(input);
  });

  it("returns empty string unchanged", () => {
    expect(redactText("")).toBe("");
  });

  it("is idempotent — redacting twice yields the same result as once", () => {
    const input = "ordinary prompt content";
    expect(redactText(redactText(input))).toBe(redactText(input));
  });
});

describe("redactObject", () => {
  it("suppresses object keys and values completely", () => {
    const obj = {
      role: "assistant",
      type: "function",
      id: "call-1",
      name: "lookup",
      content: "private completion",
      arguments: "private arguments",
      retryCount: 3,
      cached: false,
    };

    const result = redactObject(obj);

    expect(result).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("assistant");
    expect(JSON.stringify(result)).not.toContain("retryCount");
    expect(JSON.stringify(result)).not.toContain("false");
  });

  it("suppresses nested object shape instead of preserving keys", () => {
    const result = redactObject({
      user: "alice",
      password: "plain-password",
      nested: { token: "plain-token", note: "private note" },
    });

    expect(result).toBe("[REDACTED]");
  });

  it("suppresses arrays without preserving length or element values", () => {
    const result = redactObject(["first", "second", 3, true]);

    expect(result).toBe("[REDACTED]");
  });

  it("disabled redaction preserves payloads without projected fields", () => {
    const obj = { key: "sk-abc123def456789012345" };
    const result = redactObject(obj, false);
    expect(result).toEqual(obj);
    expect(result).not.toBe(obj);
  });

  it("omits encrypted reasoning content when redaction is disabled", () => {
    const obj = {
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
          content: [{ type: "output_text", text: "visible" }],
        },
      ],
      nested: {
        encrypted_content: "test-nested-encrypted-content",
        retained: true,
      },
    };

    const result = redactObject(obj, false);

    expect(result).toEqual({
      model: "gpt-5.6-sol",
      messages: [
        {
          type: "reasoning",
          id: "rs-1",
          summary: [],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "visible" }],
        },
      ],
      nested: {
        retained: true,
      },
    });
    expect(obj.messages[0]?.encrypted_content).toBe("test-encrypted-content");
    expect(obj.nested.encrypted_content).toBe("test-nested-encrypted-content");
  });

  it("omits OpenClaw thinking signatures while preserving visible thinking summaries", () => {
    const thinkingSignature = JSON.stringify({
      id: "rs-1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Checking the request" }],
      encrypted_content: "test-encrypted-content",
    });
    const obj = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Checking the request",
              thinkingSignature,
              openclawReasoningReplay: {
                v: 1,
                source: "openai-responses",
              },
            },
          ],
        },
      ],
    };

    expect(redactObject(obj, false)).toEqual({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Checking the request",
              openclawReasoningReplay: {
                v: 1,
                source: "openai-responses",
              },
            },
          ],
        },
      ],
    });
    expect(obj.messages[0]?.content[0]?.thinkingSignature).toBe(thinkingSignature);
  });

  it("suppresses payloads that throw during projection", () => {
    const obj = {
      encrypted_content: "test-encrypted-content",
      get broken() {
        throw new Error("projection failed");
      },
    };

    expect(redactObject(obj, false)).toBe("[unserializable: projection]");
  });

  it("preserves own __proto__ fields without changing the projected object prototype", () => {
    const obj = JSON.parse(
      '{"encrypted_content":"test-encrypted-content","__proto__":{"polluted":true},"kept":1}',
    ) as Record<string, unknown>;

    const result = redactObject(obj, false) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(result.kept).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("omits encrypted reasoning content from class instances", () => {
    class ReasoningItem {
      type = "reasoning";
      summary: unknown[] = [];
      encrypted_content = "test-encrypted-content";
    }

    expect(redactObject({ item: new ReasoningItem() }, false)).toEqual({
      item: {
        type: "reasoning",
        summary: [],
      },
    });
  });

  it("omits encrypted reasoning content exposed by custom JSON serialization", () => {
    class ReasoningItem {
      #encryptedContent = "test-encrypted-content";

      toJSON() {
        return {
          type: "reasoning",
          summary: [],
          encrypted_content: this.#encryptedContent,
        };
      }
    }

    expect(redactObject({ item: new ReasoningItem() }, false)).toEqual({
      item: {
        type: "reasoning",
        summary: [],
      },
    });
  });

  it("returns the inspected snapshot for stateful custom JSON serialization", () => {
    let serializationCount = 0;
    const item = {
      toJSON() {
        serializationCount += 1;
        return serializationCount === 1
          ? { type: "reasoning", summary: [] }
          : { encrypted_content: "test-encrypted-content" };
      },
    };

    const result = redactObject({ item }, false);

    expect(JSON.stringify(result)).toBe('{"item":{"type":"reasoning","summary":[]}}');
    expect(serializationCount).toBe(1);
  });

  it("fails closed when an object serializer returns undefined", () => {
    let serializationCount = 0;
    const item = {
      toJSON() {
        serializationCount += 1;
        return serializationCount === 1
          ? undefined
          : { encrypted_content: "test-encrypted-content" };
      },
    };

    expect(redactObject(item, false)).toBe("[unserializable: projection]");
    expect(serializationCount).toBe(1);
  });

  it("fails closed when custom serialization throws after exposing encrypted content", () => {
    const payload = {
      first: {
        toJSON() {
          return { encrypted_content: "test-encrypted-content" };
        },
      },
      second: {
        toJSON() {
          throw new Error("serialization failed");
        },
      },
    };

    expect(redactObject(payload, false)).toBe("[unserializable: projection]");
  });

  it("preserves the JSON representation of unrelated non-plain values", () => {
    const createdAt = new Date("2026-07-31T06:00:00.000Z");

    expect(
      redactObject(
        {
          encrypted_content: "test-encrypted-content",
          createdAt,
        },
        false,
      ),
    ).toEqual({
      createdAt: createdAt.toISOString(),
    });
  });

  it("handles null without crashing", () => {
    expect(redactObject(null)).toBeNull();
  });

  it("handles undefined without crashing", () => {
    expect(redactObject(undefined)).toBeUndefined();
  });

  it("handles numbers without crashing", () => {
    expect(redactObject(42)).toBe("[REDACTED]");
    expect(redactObject(3.14)).toBe("[REDACTED]");
  });

  it("handles booleans without crashing", () => {
    expect(redactObject(true)).toBe("[REDACTED]");
    expect(redactObject(false)).toBe("[REDACTED]");
  });

  it("processes plain string argument", () => {
    expect(redactObject("ordinary content")).toBe("[REDACTED]");
  });
});
