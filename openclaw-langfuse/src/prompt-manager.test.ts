import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { PromptManager } from "./prompt-manager.js";

// Minimal Langfuse mock factory — only getPrompt is needed
function makeMockLangfuse(getPromptImpl?: (...args: unknown[]) => Promise<{ prompt: string }>) {
  return {
    getPrompt: vi.fn(getPromptImpl ?? (() => Promise.resolve({ prompt: "Hello from Langfuse" }))),
  } as unknown as import("langfuse").default;
}

function makeConfig(overrides?: Partial<LangfusePluginConfig>): LangfusePluginConfig {
  return { ...overrides };
}

describe("PromptManager", () => {
  let mockLangfuse: ReturnType<typeof makeMockLangfuse>;

  beforeEach(() => {
    mockLangfuse = makeMockLangfuse();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Returns undefined when no rules configured
  it("returns undefined when no rules configured", async () => {
    const pm = new PromptManager(mockLangfuse, makeConfig({ prompts: [] }));
    const result = await pm.resolve("main", {});
    expect(result).toBeUndefined();
    expect(mockLangfuse.getPrompt).not.toHaveBeenCalled();
  });

  // 2. Returns undefined when no rule matches agent
  it("returns undefined when no rule matches agent", async () => {
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "other-agent", langfusePrompt: "some-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeUndefined();
    expect(mockLangfuse.getPrompt).not.toHaveBeenCalled();
  });

  // 3. Exact match returns correct prompt with append injection (default)
  it("exact match returns prompt with append injection by default", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "System guidance text" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "main-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeDefined();
    expect(result!.injection.appendSystemContext).toBe("System guidance text");
    expect(result!.injection.systemPrompt).toBeUndefined();
    expect(result!.injection.prependSystemContext).toBeUndefined();
    expect(result!.matchInfo.name).toBe("main-prompt");
    expect(result!.matchInfo.matchRule).toBe("main");
  });

  // 4. Append injection mode works
  it("append injection mode sets appendSystemContext", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "Appended content" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "append-prompt", inject: "append" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result!.injection.appendSystemContext).toBe("Appended content");
    expect(result!.injection.prependSystemContext).toBeUndefined();
    expect(result!.injection.systemPrompt).toBeUndefined();
  });

  // 5. Replace injection mode works
  it("replace injection mode sets systemPrompt", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "Replacement system prompt" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [
          {
            match: "main",
            langfusePrompt: "replace-prompt",
            inject: "replace",
          },
        ],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result!.injection.systemPrompt).toBe("Replacement system prompt");
    expect(result!.injection.prependSystemContext).toBeUndefined();
    expect(result!.injection.appendSystemContext).toBeUndefined();
  });

  // 6. Cache hit within TTL returns cached prompt without fetching again
  it("cache hit within TTL does not re-fetch from Langfuse", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "Cached prompt text" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "cached-prompt" }],
        promptCacheTtlMs: 60000,
      }),
    );
    // First call fetches
    const first = await pm.resolve("main", {});
    expect(first!.injection.appendSystemContext).toBe("Cached prompt text");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(1);

    // Second call uses cache
    const second = await pm.resolve("main", {});
    expect(second!.injection.appendSystemContext).toBe("Cached prompt text");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(1);
  });

  // 7. Zero TTL disables cache and returns the freshly fetched prompt
  it("zero TTL disables cache and returns the freshly fetched prompt", async () => {
    mockLangfuse = makeMockLangfuse(
      vi
        .fn()
        .mockResolvedValueOnce({ prompt: "first prompt" })
        .mockResolvedValueOnce({ prompt: "second prompt" }),
    );
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "ttl-prompt" }],
        // 0ms TTL disables the prompt cache.
        promptCacheTtlMs: 0,
      }),
    );
    const first = await pm.resolve("main", {});
    const second = await pm.resolve("main", {});

    expect(first!.injection.appendSystemContext).toBe("first prompt");
    expect(second!.injection.appendSystemContext).toBe("second prompt");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(2);
    expect(pm.resolveSync("main", {})).toBeUndefined();
  });

  it("positive TTL keeps stale-while-refresh behavior after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mockLangfuse = makeMockLangfuse(
      vi
        .fn()
        .mockResolvedValueOnce({ prompt: "cached prompt" })
        .mockResolvedValueOnce({ prompt: "refreshed prompt" }),
    );
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "ttl-prompt" }],
        promptCacheTtlMs: 100,
      }),
    );

    const first = await pm.resolve("main", {});
    expect(first!.injection.appendSystemContext).toBe("cached prompt");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_101);
    const stale = await pm.resolve("main", {});
    expect(stale!.injection.appendSystemContext).toBe("cached prompt");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(2);

    await Promise.resolve();
    await Promise.resolve();

    const refreshed = await pm.resolve("main", {});
    expect(refreshed!.injection.appendSystemContext).toBe("refreshed prompt");
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(2);
  });

  // 8. Template compilation replaces {{agent_name}}, {{channel_id}}, {{session_key}}, {{trigger}}
  it("compiles template variables into the prompt text", async () => {
    mockLangfuse = makeMockLangfuse(() =>
      Promise.resolve({
        prompt:
          "Agent: {{agent_name}}, Channel: {{channel_id}}, Session: {{session_key}}, Trigger: {{trigger}}",
      }),
    );
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "template-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {
      agentId: "agent-42",
      channelId: "ch-99",
      sessionKey: "sess-abc",
      trigger: "voice",
    });
    expect(result!.injection.appendSystemContext).toBe(
      "Agent: agent-42, Channel: ch-99, Session: sess-abc, Trigger: voice",
    );
  });

  // 9. Template with missing variable uses empty string
  it("template with missing variable uses empty string", async () => {
    mockLangfuse = makeMockLangfuse(() =>
      Promise.resolve({ prompt: "Agent: {{agent_name}}, Unknown: {{unknown_var}}" }),
    );
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "partial-template" }],
      }),
    );
    const result = await pm.resolve("main", { agentId: "bot" });
    expect(result!.injection.appendSystemContext).toBe("Agent: bot, Unknown: ");
  });

  // 10. Fetch timeout returns undefined (graceful degradation)
  it("fetch timeout returns undefined gracefully", async () => {
    mockLangfuse = makeMockLangfuse((_name, _version, options) =>
      Promise.reject(
        new Error(`timeout:${(options as { fetchTimeoutMs?: number }).fetchTimeoutMs}`),
      ),
    );
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "slow-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeUndefined();
    expect(mockLangfuse.getPrompt).toHaveBeenCalledWith(
      "slow-prompt",
      undefined,
      expect.objectContaining({ fetchTimeoutMs: 3000, type: "text" }),
    );
  });

  // 11. Langfuse API error returns undefined (graceful degradation)
  it("Langfuse API error returns undefined gracefully", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.reject(new Error("API error")));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "error-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeUndefined();
  });

  // 12. Prompt not found returns undefined
  it("prompt not found returns undefined gracefully", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.reject(new Error("Prompt not found")));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "nonexistent-prompt" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeUndefined();
  });

  // 13. Version pinning calls getPrompt with version number
  it("version pinning passes version to getPrompt", async () => {
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "versioned-prompt", version: 5 }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeDefined();
    expect(mockLangfuse.getPrompt).toHaveBeenCalledWith(
      "versioned-prompt",
      5,
      expect.objectContaining({ type: "text" }),
    );
    expect(result!.matchInfo.version).toBe(5);
  });

  // 14. Label-based selection passes label to getPrompt
  it("label-based selection passes label to getPrompt", async () => {
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [
          {
            match: "main",
            langfusePrompt: "labeled-prompt",
            label: "production",
          },
        ],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result).toBeDefined();
    expect(mockLangfuse.getPrompt).toHaveBeenCalledWith(
      "labeled-prompt",
      undefined,
      expect.objectContaining({ label: "production", type: "text" }),
    );
    expect(result!.matchInfo.label).toBe("production");
  });
});
