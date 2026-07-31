/** Verifies source-checkout plugin runtime resolution and dependency diagnostics. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { loadOpenClawPlugins } from "./loader.js";

const langfusePluginId = "openclaw-langfuse";

function createLangfuseConfig(overrides?: {
  loadPaths?: string[];
  allowConversationAccess?: boolean;
}) {
  return {
    plugins: {
      ...(overrides?.loadPaths ? { load: { paths: overrides.loadPaths } } : {}),
      entries: {
        [langfusePluginId]: {
          enabled: true,
          ...(overrides?.allowConversationAccess
            ? { hooks: { allowConversationAccess: true } }
            : {}),
          config: {
            baseUrl: "https://langfuse.example.test",
            publicKey: "pk-test",
            secretKey: "sk-test",
          },
        },
      },
    },
  };
}

describe("source checkout bundled plugin runtime", () => {
  it("loads enabled bundled plugins from source checkout", () => {
    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: ["tokenjuice"],
      config: {
        plugins: {
          entries: {
            tokenjuice: { enabled: true },
          },
        },
      },
    });

    const tokenjuice = registry.plugins.find((plugin) => plugin.id === "tokenjuice");
    expect(tokenjuice?.status).toBe("loaded");
    expect(tokenjuice?.origin).toBe("bundled");

    const expectedRuntime = `${path.sep}extensions${path.sep}tokenjuice${path.sep}index.ts`;
    const expectedRoot = `${path.sep}extensions${path.sep}tokenjuice`;

    expect(tokenjuice?.source).toContain(expectedRuntime);
    expect(tokenjuice?.rootDir).toContain(expectedRoot);
  });

  it("selects the bundled Langfuse plugin without duplicate diagnostics", () => {
    const sourceExtensionsDir = path.resolve("extensions");
    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: [langfusePluginId],
      config: createLangfuseConfig(),
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: sourceExtensionsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "1",
      },
    });

    const plugin = registry.plugins.find((entry) => entry.id === langfusePluginId);
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.origin).toBe("bundled");
    expect(plugin?.source).toBe(path.join(sourceExtensionsDir, langfusePluginId, "index.ts"));
    expect(
      registry.diagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === langfusePluginId &&
          diagnostic.message.includes("duplicate plugin id"),
      ),
    ).toEqual([]);
  });

  it("loads the bundled Langfuse plugin from built distribution artifacts", () => {
    const distExtensionsDir = path.resolve("dist", "extensions");
    const registry = loadOpenClawPlugins({
      cache: false,
      onlyPluginIds: [langfusePluginId],
      config: createLangfuseConfig(),
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: distExtensionsDir,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "1",
      },
      preferBuiltPluginArtifacts: true,
    });

    const plugin = registry.plugins.find((entry) => entry.id === langfusePluginId);
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.origin).toBe("bundled");
    expect(plugin?.source).toBe(path.join(distExtensionsDir, langfusePluginId, "index.js"));
    expect(
      registry.diagnostics.filter(
        (diagnostic) =>
          diagnostic.pluginId === langfusePluginId &&
          diagnostic.message.includes("duplicate plugin id"),
      ),
    ).toEqual([]);

    const rootManifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(rootManifest.dependencies?.langfuse).toBe("3.38.6");
    expect(fs.existsSync(path.resolve("node_modules", "langfuse", "package.json"))).toBe(true);
  });

  it("keeps an explicit external Langfuse override live through public plugin contracts", async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-external-"));
    const pluginRoot = path.join(externalRoot, "plugin");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `
import Langfuse from "langfuse";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openclaw-langfuse",
  name: "External Langfuse",
  register(api) {
    const client = new Langfuse(api.pluginConfig);
    api.on("before_agent_run", (event) => {
      client.trace({ input: event.prompt });
      return { outcome: "pass" };
    });
  },
});
`,
      "utf8",
    );
    fs.copyFileSync(
      path.resolve("extensions", langfusePluginId, "openclaw.plugin.json"),
      path.join(pluginRoot, "openclaw.plugin.json"),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@test/openclaw-langfuse-external",
        version: "1.0.0",
        type: "module",
        dependencies: { langfuse: "3.38.6" },
        openclaw: { extensions: ["./index.js"] },
      }),
      "utf8",
    );
    const externalNodeModules = path.join(pluginRoot, "node_modules");
    const langfuseStubRoot = path.join(externalNodeModules, "langfuse");
    fs.mkdirSync(langfuseStubRoot, { recursive: true });
    fs.writeFileSync(
      path.join(langfuseStubRoot, "package.json"),
      JSON.stringify({ name: "langfuse", version: "3.38.6", type: "module", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(langfuseStubRoot, "index.js"),
      `
const proofKey = "__openclawLangfuseExternalProof";
export default class Langfuse {
  constructor() {
    globalThis[proofKey] = [];
  }
  trace(body = {}) {
    globalThis[proofKey].push({ type: "trace-create", body });
  }
}
`,
      "utf8",
    );

    const config = createLangfuseConfig({
      loadPaths: [pluginRoot],
      allowConversationAccess: true,
    });
    const proofKey = "__openclawLangfuseExternalProof";
    try {
      const registry = loadOpenClawPlugins({
        activate: false,
        cache: false,
        onlyPluginIds: [langfusePluginId],
        config,
      });
      const plugin = registry.plugins.find((entry) => entry.id === langfusePluginId);
      expect(plugin?.status, plugin?.error).toBe("loaded");
      expect(plugin?.origin).toBe("config");
      expect(plugin?.source).toBe(fs.realpathSync.native(path.join(pluginRoot, "index.js")));

      const runner = createHookRunner(registry);
      await expect(
        runner.runBeforeAgentRun(
          { prompt: "external tracing proof", messages: [] },
          {
            agentId: "external-agent",
            runId: "external-run",
            sessionId: "external-session-id",
            sessionKey: "agent:external-agent:external-session",
            workspaceDir: externalRoot,
          },
        ),
      ).resolves.toMatchObject({ decision: { outcome: "pass" } });
      const proof = (globalThis as Record<string, unknown>)[proofKey] as Array<{
        type: string;
        body: Record<string, unknown>;
      }>;
      expect(proof.some((event) => event.type === "trace-create")).toBe(true);
      expect(proof.some((event) => event.body.input === "external tracing proof")).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>)[proofKey];
      fs.rmSync(externalRoot, { force: true, recursive: true });
    }
  });
});
