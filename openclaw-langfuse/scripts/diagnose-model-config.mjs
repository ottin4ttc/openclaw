#!/usr/bin/env node
/**
 * Diagnose openclaw model configuration issues that affect usage tracking.
 *
 * Checks all custom providers for missing `cost` field which causes
 * pi-ai's calculateCost() to crash, resulting in zero usage/token data.
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

const issues = [];

for (const [providerName, providerConfig] of Object.entries(providers)) {
  if (!providerConfig?.models || !Array.isArray(providerConfig.models)) {
    continue;
  }
  for (let idx = 0; idx < providerConfig.models.length; idx++) {
    const model = providerConfig.models[idx];
    if (!model.id) {
      continue;
    }
    if (!model.cost) {
      issues.push({ provider: providerName, modelId: model.id, modelName: model.name, idx });
    }
  }
}

if (issues.length === 0) {
  console.log("✅ All custom models have cost configuration. No issues found.");
  process.exit(0);
}

console.log(`⚠️  Found ${issues.length} model(s) missing cost configuration.`);
console.log(
  `Missing cost causes pi-ai calculateCost() to crash, resulting in zero usage/token data.\n`,
);

console.log(`Run the following commands to fix:\n`);

const costJson = JSON.stringify(DEFAULT_COST);

for (const issue of issues) {
  const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
  console.log(`# ${issue.provider}: ${label}`);
  console.log(
    `openclaw config set models.providers.${issue.provider}.models.${issue.idx}.cost '${costJson}'\n`,
  );
}

console.log(`After fixing, restart the gateway for changes to take effect.`);
