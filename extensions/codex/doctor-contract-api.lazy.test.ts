import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("empty Codex doctor detection loaded agent runtime");
});
vi.mock("openclaw/plugin-sdk/file-lock", () => {
  throw new Error("empty Codex doctor detection loaded file-lock runtime");
});
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => {
  throw new Error("empty Codex doctor detection loaded session-store runtime");
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("Codex doctor contract lazy runtime", () => {
  it("does not load session runtime helpers when default state has no legacy sidecars", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-empty-"));
    tempDirs.push(stateDir);
    const { stateMigrations } = await import("./doctor-contract-api.js");
    const migration = stateMigrations[0];

    await expect(
      migration?.detectLegacyState({
        config: {},
        env: {},
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: {
          openPluginStateKeyedStore() {
            throw new Error("empty detection must not open plugin state");
          },
        },
      }),
    ).resolves.toBeNull();
  });
});
