import { describe, it, expect } from "vitest";
import { findMatchingRule, type PromptRule } from "./matcher.js";

const rule = (match: string, langfusePrompt: string): PromptRule => ({ match, langfusePrompt });

describe("findMatchingRule", () => {
  it("returns undefined for empty rules array", () => {
    expect(findMatchingRule("main", [])).toBeUndefined();
  });

  it("returns undefined when no rule matches", () => {
    const rules = [rule("other", "other-prompt"), rule("foo-*", "foo-prompt")];
    expect(findMatchingRule("main", rules)).toBeUndefined();
  });

  it("exact match: returns rule when agentId equals pattern", () => {
    const rules = [rule("main", "main-prompt")];
    expect(findMatchingRule("main", rules)?.langfusePrompt).toBe("main-prompt");
  });

  it("exact match: does not match a different agentId", () => {
    const rules = [rule("main", "main-prompt")];
    expect(findMatchingRule("main-extra", rules)).toBeUndefined();
  });

  it("wildcard prefix: 'openmai-*' matches 'openmai-u1234'", () => {
    const rules = [rule("openmai-*", "openmai-prompt")];
    expect(findMatchingRule("openmai-u1234", rules)?.langfusePrompt).toBe("openmai-prompt");
  });

  it("wildcard prefix: 'openmai-test-*' matches 'openmai-test-claude-001'", () => {
    const rules = [rule("openmai-test-*", "test-prompt")];
    expect(findMatchingRule("openmai-test-claude-001", rules)?.langfusePrompt).toBe("test-prompt");
  });

  it("first-match-wins: 'openmai-test-*' before 'openmai-*' wins for 'openmai-test-claude-001'", () => {
    const rules = [rule("openmai-test-*", "test-prompt"), rule("openmai-*", "openmai-prompt")];
    expect(findMatchingRule("openmai-test-claude-001", rules)?.langfusePrompt).toBe("test-prompt");
  });

  it("first-match-wins: 'openmai-*' before 'openmai-test-*' wins for 'openmai-test-claude-001'", () => {
    const rules = [rule("openmai-*", "openmai-prompt"), rule("openmai-test-*", "test-prompt")];
    expect(findMatchingRule("openmai-test-claude-001", rules)?.langfusePrompt).toBe(
      "openmai-prompt",
    );
  });

  it("catch-all '*' matches any agentId", () => {
    const rules = [rule("*", "catch-all-prompt")];
    expect(findMatchingRule("anything", rules)?.langfusePrompt).toBe("catch-all-prompt");
    expect(findMatchingRule("", rules)?.langfusePrompt).toBe("catch-all-prompt");
  });

  it("catch-all '*' is skipped when an earlier exact rule matches first", () => {
    const rules = [rule("main", "main-prompt"), rule("*", "catch-all-prompt")];
    expect(findMatchingRule("main", rules)?.langfusePrompt).toBe("main-prompt");
  });

  it("catch-all '*' is reached when no earlier rule matches", () => {
    const rules = [rule("main", "main-prompt"), rule("*", "catch-all-prompt")];
    expect(findMatchingRule("other", rules)?.langfusePrompt).toBe("catch-all-prompt");
  });

  it("exact match before wildcard when exact appears first", () => {
    const rules = [rule("openmai-u1234", "exact-prompt"), rule("openmai-*", "wildcard-prompt")];
    expect(findMatchingRule("openmai-u1234", rules)?.langfusePrompt).toBe("exact-prompt");
  });

  it("returned rule carries all fields (version, label, inject)", () => {
    const full: PromptRule = {
      match: "main",
      langfusePrompt: "full-prompt",
      version: 3,
      label: "production",
      inject: "prepend",
    };
    expect(findMatchingRule("main", [full])).toEqual(full);
  });
});
