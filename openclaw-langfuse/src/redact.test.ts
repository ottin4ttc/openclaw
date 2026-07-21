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
