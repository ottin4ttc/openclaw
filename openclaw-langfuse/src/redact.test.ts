import { describe, it, expect } from "vitest";
import { redactText, redactObject } from "./redact.js";

describe("redactText", () => {
  it("redacts API keys with sk- prefix", () => {
    const input = "Use this key: sk-abc123def456789012345";
    const result = redactText(input);
    expect(result).not.toContain("sk-abc123def456789012345");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts API keys with pk- prefix", () => {
    const result = redactText("key=pk-abcdefghij1234567890ab");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("pk-abcdefghij1234567890ab");
  });

  it("redacts API keys with key- prefix", () => {
    const result = redactText("key-abcdefghij1234567890ab is secret");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("key-abcdefghij1234567890ab");
  });

  it("does not redact short key-like strings (under 20 chars)", () => {
    // "sk-short" has only 5 chars after prefix — should not be redacted
    const input = "sk-short";
    const result = redactText(input);
    expect(result).toBe(input);
  });

  it("redacts Bearer tokens", () => {
    const result = redactText("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("redacts JSON api_key field values", () => {
    const result = redactText('{"api_key": "supersecretvalue"}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("supersecretvalue");
  });

  it("redacts JSON password field values", () => {
    const result = redactText('{"password": "hunter2"}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("hunter2");
  });

  it("redacts JSON token field values", () => {
    const result = redactText('{"token": "mytoken123"}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mytoken123");
  });

  it("redacts JSON access_token field values", () => {
    const result = redactText('{"access_token": "at_value"}');
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("at_value");
  });

  it("redacts OpenClaw secret refs like $OPENAI_API_KEY", () => {
    const result = redactText("Using $OPENAI_API_KEY for auth");
    expect(result).toContain("[REDACTED_REF]");
    expect(result).not.toContain("$OPENAI_API_KEY");
  });

  it("redacts multiple secret refs in one string", () => {
    const result = redactText("$OPENAI_API_KEY and $ANTHROPIC_SECRET");
    expect(result).not.toContain("$OPENAI_API_KEY");
    expect(result).not.toContain("$ANTHROPIC_SECRET");
    expect(result.match(/\[REDACTED_REF\]/g)?.length).toBe(2);
  });

  it("does not redact normal text", () => {
    const normal = "Hello, this is a normal sentence with no secrets.";
    expect(redactText(normal)).toBe(normal);
  });

  it("does not redact numbers or non-secret identifiers", () => {
    const input = "user_id=12345, status=active";
    expect(redactText(input)).toBe(input);
  });

  it("disabled redaction returns original text unchanged", () => {
    const input = "Bearer supersecrettoken sk-abc123def456789012345";
    expect(redactText(input, false)).toBe(input);
  });

  it("returns empty string unchanged", () => {
    expect(redactText("")).toBe("");
  });

  it("is idempotent — redacting twice yields the same result as once", () => {
    const input = "sk-abc123def456789012345 and $MY_SECRET";
    expect(redactText(redactText(input))).toBe(redactText(input));
  });
});

describe("redactObject", () => {
  it("redacts string values in a flat object", () => {
    const obj = { key: "sk-abc123def456789012345", normal: "hello" };
    const result = redactObject(obj);
    expect(result.key).toContain("[REDACTED]");
    expect(result.normal).toBe("hello");
  });

  it("redacts string values recursively in nested objects", () => {
    const obj = { outer: { inner: { api_key: "sk-abc123def456789012345" } } };
    // The nested string contains the key pattern, not the JSON key-value pattern
    const result = redactObject(obj);
    expect((result.outer.inner as { api_key: string }).api_key).toContain("[REDACTED]");
  });

  it("redacts strings inside arrays", () => {
    const arr = ["normal", "sk-abc123def456789012345 is secret", "also normal"];
    const result = redactObject(arr);
    expect(result[0]).toBe("normal");
    expect(result[1]).toContain("[REDACTED]");
    expect(result[2]).toBe("also normal");
  });

  it("redacts strings in mixed nested structure", () => {
    const obj = {
      messages: [
        { role: "user", content: "my key is sk-abc123def456789012345" },
        { role: "assistant", content: "understood" },
      ],
    };
    const result = redactObject(obj);
    expect(result.messages[0].content).toContain("[REDACTED]");
    expect(result.messages[1].content).toBe("understood");
  });

  it("disabled redaction returns the original object unchanged", () => {
    const obj = { key: "sk-abc123def456789012345" };
    const result = redactObject(obj, false);
    expect(result).toBe(obj);
  });

  it("handles null without crashing", () => {
    expect(redactObject(null)).toBeNull();
  });

  it("handles undefined without crashing", () => {
    expect(redactObject(undefined)).toBeUndefined();
  });

  it("handles numbers without crashing", () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(3.14)).toBe(3.14);
  });

  it("handles booleans without crashing", () => {
    expect(redactObject(true)).toBe(true);
    expect(redactObject(false)).toBe(false);
  });

  it("processes plain string argument", () => {
    const result = redactObject("Bearer mytoken123abc");
    expect(result).toContain("Bearer [REDACTED]");
  });
});
