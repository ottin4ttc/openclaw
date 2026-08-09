import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../../skills/loading/skill-contract.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveAgentHarnessSkillsPromptForRun } from "./skills-prompt.js";

const hostSkillPath = "/Users/example/.openclaw/plugin-skills/demo/SKILL.md";
const hostSkillBaseDir = "/Users/example/.openclaw/plugin-skills/demo";

const snapshot: SkillSnapshot = {
  prompt:
    "<available_skills><skill><location>~/.openclaw/plugin-skills/demo/SKILL.md</location></skill></available_skills>",
  skills: [{ name: "demo" }],
  resolvedSkills: [
    {
      name: "demo",
      description: "Demo skill",
      filePath: hostSkillPath,
      baseDir: hostSkillBaseDir,
      source: "plugin",
      sourceInfo: createSyntheticSourceInfo(hostSkillPath, {
        source: "plugin",
        baseDir: hostSkillBaseDir,
      }),
      disableModelInvocation: false,
    },
  ],
};

function attemptWithSkillsSnapshot(): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/workspace",
    runId: "run-1",
    provider: "codex",
    modelId: "qwen3.7-plus",
    model: {} as EmbeddedRunAttemptParams["model"],
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    thinkLevel: "off",
    timeoutMs: 30_000,
    skillsSnapshot: snapshot,
  };
}

describe("resolveAgentHarnessSkillsPromptForRun", () => {
  it("preserves the existing snapshot prompt outside a sandbox", () => {
    expect(
      resolveAgentHarnessSkillsPromptForRun({
        attempt: attemptWithSkillsSnapshot(),
        effectiveWorkspace: "/workspace",
      }),
    ).toBe(snapshot.prompt);
  });

  it("rebuilds sandbox skill prompts with container-readable locations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-skills-"));
    try {
      const materializedWorkspace = path.join(root, "state", "sandbox-skills");
      const skillDir = path.join(materializedWorkspace, "skills", "demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: demo", "description: Demo skill", "---", "# Demo", ""].join("\n"),
      );

      const prompt = resolveAgentHarnessSkillsPromptForRun({
        attempt: attemptWithSkillsSnapshot(),
        effectiveWorkspace: "/workspace",
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: materializedWorkspace,
          workspaceAccess: "rw",
        },
      });

      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md");
      expect(prompt).not.toContain("~/.openclaw/plugin-skills");
      expect(prompt.replaceAll("\\", "/")).not.toContain(
        materializedWorkspace.replaceAll("\\", "/"),
      );
      expect(prompt).not.toContain(hostSkillPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits unavailable sandbox skills instead of restoring the host snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-skills-missing-"));
    try {
      const prompt = resolveAgentHarnessSkillsPromptForRun({
        attempt: attemptWithSkillsSnapshot(),
        effectiveWorkspace: "/workspace",
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: path.join(root, "sandbox-skills"),
          workspaceAccess: "rw",
        },
      });

      expect(prompt).toBe("");
      expect(prompt).not.toContain("plugin-skills");
      expect(prompt).not.toContain(hostSkillPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
