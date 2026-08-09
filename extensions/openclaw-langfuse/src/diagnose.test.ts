import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkModelCostConfig, formatCostWarning, generateFixCommands } from "./diagnose.js";

describe("Langfuse model config diagnose", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-langfuse-diagnose-"));
    configPath = path.join(tmpDir, "openclaw.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports missing model prices without generating zero-cost repair commands", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            custom: {
              models: [{ id: "model-a", name: "Model A" }],
            },
          },
        },
      }),
    );

    const issues = checkModelCostConfig(tmpDir);

    expect(issues).toEqual([
      expect.objectContaining({
        provider: "custom",
        modelId: "model-a",
        modelName: "Model A",
      }),
    ]);
    expect(generateFixCommands(issues)).toEqual([]);
    expect(formatCostWarning(issues)).toContain("monetary cost attribution is unresolved");
  });

  it("prints usage repair commands for only compat.supportsUsageInStreaming", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              models: [
                {
                  id: "model-a",
                  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                  compat: { supportsTools: false, maxTokensField: "max_tokens" },
                },
              ],
            },
          },
        },
      }),
    );

    const output = execFileSync(
      process.execPath,
      [path.join("openclaw-langfuse", "scripts", "diagnose-model-config.mjs"), configPath],
      { cwd: path.resolve(import.meta.dirname, "..", ".."), encoding: "utf-8" },
    );

    expect(output).toContain(
      "openclaw config set models.providers.custom.models.0.compat.supportsUsageInStreaming true",
    );
    expect(output).not.toContain("models.providers.custom.models.0.compat '{");
    expect(output).not.toContain('"supportsTools"');
  });

  it("prints unresolved pricing guidance without zero-cost repair commands", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            custom: {
              models: [{ id: "model-a" }],
            },
          },
        },
      }),
    );

    const output = execFileSync(
      process.execPath,
      [path.join("openclaw-langfuse", "scripts", "diagnose-model-config.mjs"), configPath],
      { cwd: path.resolve(import.meta.dirname, "..", ".."), encoding: "utf-8" },
    );

    expect(output).toContain("monetary cost attribution is unresolved");
    expect(output).toContain("will not write zero-cost defaults");
    expect(output).toContain("models.providers.custom.models.0.cost");
    expect(output).not.toContain("openclaw config set models.providers.custom.models.0.cost");
    expect(output).not.toContain('{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}');
  });
});
