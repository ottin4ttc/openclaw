import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/feishu";
import type { DynamicAgentCreationConfig } from "./types.js";

export type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

// Serialize dynamic agent creation to prevent concurrent read-modify-write races.
// Multiple DM users sending messages simultaneously would otherwise clobber each other's
// config writes, leaving agents with workspace dirs on disk but missing from the config.
let _createLock: Promise<void> = Promise.resolve();

function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = _createLock;
  _createLock = next;
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/**
 * Check if a dynamic agent should be created for a DM user and create it if needed.
 * This creates a unique agent instance with its own workspace for each DM user.
 *
 * Serialized via an in-process lock so concurrent DMs don't clobber each other's config writes.
 */
export function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  senderName?: string;
  dynamicCfg: DynamicAgentCreationConfig;
  accountId?: string;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  return withCreateLock(() => doCreateDynamicAgent(params));
}

async function doCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  senderName?: string;
  dynamicCfg: DynamicAgentCreationConfig;
  accountId?: string;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { runtime, senderOpenId, senderName, dynamicCfg, accountId, log } = params;

  // Re-read config inside the lock to avoid stale-snapshot races.
  // The caller's `cfg` may already be outdated if another agent was created concurrently.
  const cfg = runtime.config.loadConfig();

  // Check if there's already a binding for this user
  const existingBindings = cfg.bindings ?? [];
  const hasBinding = existingBindings.some(
    (b) =>
      b.match?.channel === "feishu" &&
      b.match?.peer?.kind === "direct" &&
      b.match?.peer?.id === senderOpenId,
  );

  if (hasBinding) {
    return { created: false, updatedCfg: cfg };
  }

  // Check maxAgents limit if configured
  if (dynamicCfg.maxAgents !== undefined) {
    const feishuAgentCount = (cfg.agents?.list ?? []).filter((a) =>
      a.id.startsWith("feishu-"),
    ).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(
        `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
      );
      return { created: false, updatedCfg: cfg };
    }
  }

  // Use full OpenID as agent ID suffix (OpenID format: ou_xxx is already filesystem-safe)
  const agentId = `feishu-${senderOpenId}`;

  // Check if agent already exists (but binding was missing)
  const existingAgent = (cfg.agents?.list ?? []).find((a) => a.id === agentId);
  if (existingAgent) {
    // Agent exists but binding doesn't - just add the binding
    log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);

    const updatedCfg: OpenClawConfig = {
      ...cfg,
      bindings: [
        ...existingBindings,
        {
          agentId,
          match: {
            channel: "feishu",
            accountId: "*",
            peer: { kind: "direct", id: senderOpenId },
          },
        },
      ],
    };

    await runtime.config.writeConfigFile(updatedCfg);
    return { created: true, updatedCfg, agentId };
  }

  // Resolve path templates with substitutions
  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";

  const workspace = resolveUserPath(
    workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );
  const agentDir = resolveUserPath(
    agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );

  log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
  log(`  workspace: ${workspace}`);
  log(`  agentDir: ${agentDir}`);

  // Create directories
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(agentDir, { recursive: true });

  // Write agent metadata (open_id + name) for external scripts to consume
  const meta = {
    openId: senderOpenId,
    name: senderName || undefined,
    agentId,
    createdAt: new Date().toISOString(),
  };
  const metaPath = path.join(agentDir, "meta.json");
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  log(`feishu: wrote agent metadata to ${metaPath}`);

  // Re-read config again before the final write — directory creation above may have
  // yielded the event loop, allowing another agent's write to complete in between.
  const freshCfg = runtime.config.loadConfig();
  const freshBindings = freshCfg.bindings ?? [];

  // Update configuration with new agent and binding
  const updatedCfg: OpenClawConfig = {
    ...freshCfg,
    agents: {
      ...freshCfg.agents,
      list: [...(freshCfg.agents?.list ?? []), { id: agentId, workspace, agentDir }],
    },
    bindings: [
      ...freshBindings,
      {
        agentId,
        match: {
          channel: "feishu",
          accountId: "*",
          peer: { kind: "direct", id: senderOpenId },
        },
      },
    ],
  };

  // Write updated config using PluginRuntime API
  await runtime.config.writeConfigFile(updatedCfg);

  return { created: true, updatedCfg, agentId };
}

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
