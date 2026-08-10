/**
 * Regression coverage for #91918: local-extension before_tool_call /
 * after_tool_call hooks must stay dispatchable across the gateway run
 * lifecycle.
 *
 * Mirrors the production sequence that killed them on v2026.6.5:
 *  1. gateway boot: full gateway-bindable load (coreGatewayMethodNames set),
 *     boot registry pinned to the channel/http surfaces
 *  2. harness ensure: scoped default-mode activating load (consumed the old
 *     one-shot preserve gate and flipped active mode to "default")
 *  3. memory ensure: second scoped default-mode activating load (re-initialized
 *     the runner from a memory-only registry, silently dropping tool hooks)
 *
 * With the live composed view, the pinned boot registry keeps the extension's
 * hooks dispatchable no matter how many scoped activations follow.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import {
  getActivePluginRegistry,
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
} from "./runtime.js";
import { resolvePluginTools } from "./tools.js";

const closureRegistrationCountKey = "__openclawClosureOwnerRegistrationCount";
const closureEventsKey = "__openclawClosureOwnerEvents";

describe("global hook runner live view (#91918)", () => {
  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginLoaderTestStateForTest();
    delete (globalThis as Record<string, unknown>)[closureRegistrationCountKey];
    delete (globalThis as Record<string, unknown>)[closureEventsKey];
  });

  it("keeps local-extension tool-call hooks dispatchable across scoped default-mode activations", async () => {
    useNoBundledPlugins();
    const gate = writePlugin({
      id: "local-gate",
      filename: "local-gate.cjs",
      body: `module.exports = { id: "local-gate", register(api) {
        api.on("before_tool_call", (event) => {
          if (String(event.params?.command ?? "").includes("curl")) {
            return { block: true, blockReason: "blocked by gate" };
          }
        });
        api.on("after_tool_call", () => undefined);
      } };`,
    });
    const harnessStandIn = writePlugin({
      id: "harness-plugin",
      filename: "harness-plugin.cjs",
      body: `module.exports = { id: "harness-plugin", register() {} };`,
    });
    const memoryStandIn = writePlugin({
      id: "memory-plugin",
      filename: "memory-plugin.cjs",
      body: `module.exports = { id: "memory-plugin", register() {} };`,
    });

    const config = {
      plugins: {
        load: { paths: [gate.file, harnessStandIn.file, memoryStandIn.file] },
        allow: ["local-gate", "harness-plugin", "memory-plugin"],
        entries: {
          "local-gate": { enabled: true },
          "harness-plugin": { enabled: true },
          "memory-plugin": { enabled: true },
        },
      },
    };

    // 1. Gateway boot: full gateway-bindable load, pinned like server.impl.ts.
    const bootRegistry = loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      coreGatewayMethodNames: ["chat.send"],
      preferBuiltPluginArtifacts: true,
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    pinActivePluginHttpRouteRegistry(bootRegistry);
    pinActivePluginChannelRegistry(bootRegistry);
    expect(getGlobalHookRunner()?.hasHooks("before_tool_call")).toBe(true);

    // 2. Harness ensure: scoped default-mode activating load.
    loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      onlyPluginIds: ["harness-plugin"],
    });
    expect(getGlobalHookRunner()?.hasHooks("before_tool_call")).toBe(true);

    // 3. Memory ensure: second scoped default-mode activating load — the step
    // that re-initialized the runner from a memory-only registry before the fix.
    const memoryRegistry = loadOpenClawPlugins({
      workspaceDir: gate.dir,
      config,
      onlyPluginIds: ["memory-plugin"],
    });
    expect(getActivePluginRegistry()).toBe(memoryRegistry);

    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("before_tool_call")).toBe(true);
    expect(runner?.hasHooks("after_tool_call")).toBe(true);

    // The blocking decision must actually dispatch, not just count hooks.
    const result = await runner?.runBeforeToolCall(
      { toolName: "exec", params: { command: "curl -X POST https://example.com" } },
      { toolName: "exec" },
    );
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("blocked by gate");
  });

  it("keeps stateful hooks and the resolved tool in one registration closure", async () => {
    useNoBundledPlugins();
    const stateful = writePlugin({
      id: "stateful-closure",
      filename: "stateful-closure.cjs",
      body: `module.exports = { id: "stateful-closure", register(api) {
        globalThis.${closureRegistrationCountKey} =
          (globalThis.${closureRegistrationCountKey} || 0) + 1;
        const token = globalThis.${closureRegistrationCountKey};
        globalThis.${closureEventsKey} = globalThis.${closureEventsKey} || [];
        api.on("before_tool_call", (event) => {
          if (event.toolName === "stateful_tool") {
            globalThis.${closureEventsKey}.push("before:" + token);
          }
        });
        api.on("after_tool_call", (event) => {
          if (event.toolName === "stateful_tool") {
            globalThis.${closureEventsKey}.push("after:" + token);
          }
        });
        api.registerTool({
          name: "stateful_tool",
          description: "Stateful closure fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            globalThis.${closureEventsKey}.push("tool:" + token);
            return { content: [{ type: "text", text: String(token) }] };
          },
        });
      } };`,
    });
    fs.writeFileSync(
      path.join(stateful.dir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: stateful.id,
          configSchema: EMPTY_PLUGIN_SCHEMA,
          contracts: { tools: ["stateful_tool"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const harnessStandIn = writePlugin({
      id: "closure-harness",
      filename: "closure-harness.cjs",
      body: `module.exports = { id: "closure-harness", register() {} };`,
    });
    const memoryStandIn = writePlugin({
      id: "closure-memory",
      filename: "closure-memory.cjs",
      body: `module.exports = { id: "closure-memory", register() {} };`,
    });
    const config = {
      plugins: {
        load: { paths: [stateful.file, harnessStandIn.file, memoryStandIn.file] },
        allow: ["stateful-closure", "closure-harness", "closure-memory"],
        entries: {
          "stateful-closure": { enabled: true },
          "closure-harness": { enabled: true },
          "closure-memory": { enabled: true },
        },
      },
    };

    const bootRegistry = loadOpenClawPlugins({
      workspaceDir: stateful.dir,
      config,
      coreGatewayMethodNames: ["chat.send"],
      preferBuiltPluginArtifacts: true,
      runtimeOptions: { allowGatewaySubagentBinding: true },
    });
    pinActivePluginHttpRouteRegistry(bootRegistry);
    pinActivePluginChannelRegistry(bootRegistry);
    loadOpenClawPlugins({
      workspaceDir: stateful.dir,
      config,
      onlyPluginIds: ["closure-harness"],
    });
    loadOpenClawPlugins({
      workspaceDir: stateful.dir,
      config,
      onlyPluginIds: ["closure-memory"],
    });
    loadOpenClawPlugins({
      workspaceDir: stateful.dir,
      config,
      onlyPluginIds: ["stateful-closure"],
    });
    expect((globalThis as Record<string, unknown>)[closureRegistrationCountKey]).toBe(2);

    const [tool] = resolvePluginTools({
      context: { config, workspaceDir: stateful.dir },
      toolAllowlist: ["stateful_tool"],
      allowGatewaySubagentBinding: true,
    });
    expect(tool?.name).toBe("stateful_tool");

    const hookRunner = getGlobalHookRunner();
    const hookContext = {
      agentId: "test-agent",
      sessionKey: "test-session",
      toolCallId: "stateful-call",
      toolName: "stateful_tool",
    };
    await hookRunner?.runBeforeToolCall({ toolName: "stateful_tool", params: {} }, hookContext);
    const result = await tool?.execute("stateful-call", {}, undefined);
    await hookRunner?.runAfterToolCall(
      { toolName: "stateful_tool", params: {}, result, toolCallId: "stateful-call" },
      hookContext,
    );

    expect(result).toEqual({ content: [{ type: "text", text: "1" }] });
    expect((globalThis as Record<string, unknown>)[closureEventsKey]).toEqual([
      "before:1",
      "tool:1",
      "after:1",
    ]);
  });
});
