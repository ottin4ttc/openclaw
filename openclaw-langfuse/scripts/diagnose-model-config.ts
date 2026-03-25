#!/usr/bin/env bun
/**
 * Diagnose openclaw model configuration issues that affect usage tracking.
 *
 * Checks all custom providers for missing `cost` field which causes
 * pi-ai's calculateCost() to crash, resulting in zero usage/token data.
 *
 * Usage: npm run diagnose
 */

import { checkModelCostConfig, generateFixCommands } from "../src/diagnose.js";

const issues = checkModelCostConfig();

if (issues.length === 0) {
  console.log("✅ All custom models have cost configuration. No issues found.");
  process.exit(0);
}

console.log(`⚠️  Found ${issues.length} model(s) missing cost configuration.`);
console.log(
  `Missing cost causes pi-ai calculateCost() to crash, resulting in zero usage/token data.\n`,
);

const commands = generateFixCommands(issues);

console.log(`Run the following commands to fix:\n`);

for (let i = 0; i < issues.length; i++) {
  const issue = issues[i];
  const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
  console.log(`# ${issue.provider}: ${label}`);
  console.log(`${commands[i]}\n`);
}

console.log(`After fixing, restart the gateway for changes to take effect.`);
