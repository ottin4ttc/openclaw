import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LangfusePluginConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK so importing the plugin doesn't require real creds
// ---------------------------------------------------------------------------

vi.mock("langfuse", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      trace: vi.fn().mockReturnValue({
        generation: vi.fn().mockReturnValue({ update: vi.fn(), end: vi.fn() }),
        span: vi.fn().mockReturnValue({ update: vi.fn(), end: vi.fn() }),
        update: vi.fn(),
      }),
      shutdownAsync: vi.fn().mockResolvedValue(undefined),
      getPrompt: vi.fn(),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockLogger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeApi(config: LangfusePluginConfig) {
  return {
    pluginConfig: config,
    logger: mockLogger,
    registerService: vi.fn(),
    on: vi.fn(),
  };
}

const baseConfig: LangfusePluginConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
  baseUrl: "http://localhost:3000",
  tracing: { enabled: true, tags: ["test"], redact: false },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Langfuse plugin registration (index.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports plugin with correct id and name", async () => {
    const { default: plugin } = await import("../index.js");
    expect(plugin.id).toBe("openclaw-langfuse");
    expect(plugin.name).toBe("Langfuse");
    expect(typeof plugin.description).toBe("string");
    expect(plugin.description.length).toBeGreaterThan(0);
  });

  it("register calls api.registerService", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi(baseConfig);
    await plugin.register(api as never);
    expect(api.registerService).toHaveBeenCalledOnce();
  });

  it("registers tracing hooks when tracing enabled", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi(baseConfig);
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("llm_input");
    expect(registeredEvents).toContain("llm_output");
    expect(registeredEvents).toContain("before_tool_call");
    expect(registeredEvents).toContain("after_tool_call");
    expect(registeredEvents).toContain("agent_end");
    expect(registeredEvents).toContain("session_end");
  });

  it("skips tracing hooks when tracing.enabled is false", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({ ...baseConfig, tracing: { enabled: false } });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).not.toContain("before_agent_start");
    expect(registeredEvents).not.toContain("llm_input");
    expect(registeredEvents).not.toContain("llm_output");
    expect(registeredEvents).not.toContain("before_tool_call");
    expect(registeredEvents).not.toContain("after_tool_call");
    expect(registeredEvents).not.toContain("agent_end");
    expect(registeredEvents).not.toContain("session_end");
  });

  it("registers prompt hook when prompts configured", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({
      ...baseConfig,
      prompts: [{ match: "agent-1", langfusePrompt: "my-prompt" }],
    });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).toContain("before_prompt_build");
  });

  it("skips prompt hook when no prompts configured", async () => {
    const { default: plugin } = await import("../index.js");
    const api = makeApi({ ...baseConfig, prompts: [] });
    await plugin.register(api as never);

    const registeredEvents = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredEvents).not.toContain("before_prompt_build");
  });
});
