#!/usr/bin/env node
/**
 * Diagnose openclaw model configuration issues that affect usage tracking.
 *
 * Checks all custom providers for:
 * 1. Missing `cost` field — causes pi-ai calculateCost() to crash
 * 2. Missing `compat.supportsUsageInStreaming: true` — prevents streaming
 *    usage data (token counts) from being returned by the provider
 *
 * Usage: npm run diagnose
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const configPath = join(homedir(), ".openclaw", "openclaw.json");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch (err) {
  console.error(`Failed to read ${configPath}: ${err.message}`);
  process.exit(1);
}

const providers = config?.models?.providers;

if (!providers) {
  console.log("✅ No custom providers found. Nothing to check.");
  process.exit(0);
}

const costIssues = [];
const usageIssues = [];

for (const [providerName, providerConfig] of Object.entries(providers)) {
  if (!providerConfig?.models || !Array.isArray(providerConfig.models)) {
    continue;
  }
  // Only openai-completions providers need supportsUsageInStreaming
  const isOpenAICompat = providerConfig.api === "openai-completions";

  for (let idx = 0; idx < providerConfig.models.length; idx++) {
    const model = providerConfig.models[idx];
    if (!model.id) {
      continue;
    }
    if (!model.cost) {
      costIssues.push({ provider: providerName, modelId: model.id, modelName: model.name, idx });
    }
    if (isOpenAICompat && model.compat?.supportsUsageInStreaming !== true) {
      usageIssues.push({ provider: providerName, modelId: model.id, modelName: model.name, idx });
    }
  }
}

if (costIssues.length === 0 && usageIssues.length === 0) {
  console.log("✅ All custom models have cost and usage streaming configuration. No issues found.");
  process.exit(0);
}

if (costIssues.length > 0) {
  console.log(`⚠️  Found ${costIssues.length} model(s) missing cost configuration.`);
  console.log(`Missing cost causes pi-ai calculateCost() to crash, resulting in zero cost data.\n`);
  console.log(`Run the following commands to fix:\n`);
  const costJson = JSON.stringify(DEFAULT_COST);
  for (const issue of costIssues) {
    const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
    console.log(`# ${issue.provider}: ${label}`);
    console.log(
      `openclaw config set models.providers.${issue.provider}.models.${issue.idx}.cost '${costJson}'\n`,
    );
  }
}

if (usageIssues.length > 0) {
  console.log(`⚠️  Found ${usageIssues.length} model(s) missing compat.supportsUsageInStreaming.`);
  console.log(
    `Without this setting, OpenAI-compatible providers will not return token usage data in streaming responses.`,
  );
  console.log(
    `Most OpenAI-compatible APIs (moonshot, deepseek, dmxapi, etc.) support this feature.\n`,
  );
  console.log(`Run the following commands to enable usage tracking:\n`);
  for (const issue of usageIssues) {
    const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
    console.log(`# ${issue.provider}: ${label}`);
    console.log(
      `openclaw config set models.providers.${issue.provider}.models.${issue.idx}.compat '{"supportsUsageInStreaming":true}'\n`,
    );
  }
}

console.log(`After fixing, restart the gateway for changes to take effect.`);
