/* eslint-disable @typescript-eslint/unbound-method -- vi.fn() mocks are safe to reference unbound */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";
import { PromptManager } from "./prompt-manager.js";

// Minimal Langfuse mock factory — only getPrompt is needed
function makeMockLangfuse(getPromptImpl?: () => Promise<{ prompt: string }>) {
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

  // 4. Prepend injection mode works
  it("prepend injection mode sets prependSystemContext", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "Prepended content" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "prepend-prompt", inject: "prepend" }],
      }),
    );
    const result = await pm.resolve("main", {});
    expect(result!.injection.prependSystemContext).toBe("Prepended content");
    expect(result!.injection.appendSystemContext).toBeUndefined();
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

  // 6. Prompt TTL is forwarded to the Langfuse SDK
  it("forwards promptCacheTtlMs to the Langfuse SDK cacheTtlSeconds option", async () => {
    mockLangfuse = makeMockLangfuse(() => Promise.resolve({ prompt: "Cached prompt text" }));
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "cached-prompt" }],
        promptCacheTtlMs: 60000,
      }),
    );
    await pm.resolve("main", {});
    expect(mockLangfuse.getPrompt).toHaveBeenCalledWith(
      "cached-prompt",
      undefined,
      expect.objectContaining({ cacheTtlSeconds: 60, type: "text" }),
    );
  });

  // 7. Zero TTL is forwarded to the Langfuse SDK
  it("forwards zero TTL to the Langfuse SDK", async () => {
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [{ match: "main", langfusePrompt: "ttl-prompt" }],
        // 0ms TTL = always expired
        promptCacheTtlMs: 0,
      }),
    );
    await pm.resolve("main", {});
    expect(mockLangfuse.getPrompt).toHaveBeenCalledWith(
      "ttl-prompt",
      undefined,
      expect.objectContaining({ cacheTtlSeconds: 0, type: "text" }),
    );
  });

  it("warmCache primes prompts through the Langfuse SDK", async () => {
    const pm = new PromptManager(
      mockLangfuse,
      makeConfig({
        prompts: [
          { match: "main", langfusePrompt: "main-prompt" },
          { match: "*", langfusePrompt: "fallback-prompt", label: "production" },
        ],
      }),
    );

    await pm.warmCache();
    expect(mockLangfuse.getPrompt).toHaveBeenCalledTimes(2);
    expect(mockLangfuse.getPrompt).toHaveBeenNthCalledWith(
      1,
      "main-prompt",
      undefined,
      expect.objectContaining({ cacheTtlSeconds: 60, type: "text" }),
    );
    expect(mockLangfuse.getPrompt).toHaveBeenNthCalledWith(
      2,
      "fallback-prompt",
      undefined,
      expect.objectContaining({ label: "production", cacheTtlSeconds: 60, type: "text" }),
    );
  });

  it("uses a 2 second fetch timeout by default", async () => {
    vi.useFakeTimers();
    try {
      mockLangfuse = makeMockLangfuse(
        () =>
          new Promise<{ prompt: string }>((resolve) =>
            setTimeout(() => resolve({ prompt: "Late" }), 2500),
          ),
      );
      const pm = new PromptManager(
        mockLangfuse,
        makeConfig({
          prompts: [{ match: "main", langfusePrompt: "slow-default-prompt" }],
        }),
      );

      const resultPromise = pm.resolve("main", {});
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      mockLangfuse = makeMockLangfuse(
        () =>
          new Promise<{ prompt: string }>((resolve) =>
            setTimeout(() => resolve({ prompt: "Late" }), 100),
          ),
      );
      const pm = new PromptManager(
        mockLangfuse,
        makeConfig({
          prompts: [{ match: "main", langfusePrompt: "slow-prompt" }],
          promptFetchTimeoutMs: 50,
        }),
      );
      const resultPromise = pm.resolve("main", {});
      await vi.advanceTimersByTimeAsync(50);
      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes through successful fetches within the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      mockLangfuse = makeMockLangfuse(
        () =>
          new Promise<{ prompt: string }>((resolve) =>
            setTimeout(() => resolve({ prompt: "Fetched in time" }), 100),
          ),
      );
      const pm = new PromptManager(
        mockLangfuse,
        makeConfig({
          prompts: [{ match: "main", langfusePrompt: "timely-prompt" }],
          promptFetchTimeoutMs: 200,
        }),
      );
      const resultPromise = pm.resolve("main", {});
      await vi.advanceTimersByTimeAsync(100);
      await expect(resultPromise).resolves.toMatchObject({
        injection: { appendSystemContext: "Fetched in time" },
      });
    } finally {
      vi.useRealTimers();
    }
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
