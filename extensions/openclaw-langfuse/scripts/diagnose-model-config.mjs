#!/usr/bin/env node
/**
 * Diagnose openclaw model configuration issues that affect usage tracking.
 *
 * Checks all custom providers for:
 * 1. Missing `cost` field — leaves monetary cost attribution at zero
 * 2. Missing `compat.supportsUsageInStreaming: true` — prevents streaming
 *    usage data (token counts) from being returned by the provider
 *
 * Usage: npm run diagnose [-- /path/to/openclaw.json]
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configPath = process.argv[2] || join(homedir(), ".openclaw", "openclaw.json");

let config;
try {
  const raw = readFileSync(configPath, "utf-8");
  config = JSON.parse(raw);

  // Detect duplicate provider keys (JSON silently drops earlier duplicates)
  const providerMatch = raw.match(/"providers"\s*:\s*\{/);
  if (providerMatch) {
    const providerNames = [];
    const duplicates = new Set();
    // Simple regex scan for top-level provider keys inside "providers": { ... }
    const providerSection = raw.slice(providerMatch.index);
    let depth = 0;
    // Walk through the providers section to find duplicate keys
    for (const line of providerSection.split("\n")) {
      const trimmed = line.trim();
      if (depth === 1) {
        const keyMatch = trimmed.match(/^"(\w[\w-]*)"\s*:/);
        if (keyMatch) {
          const name = keyMatch[1];
          if (providerNames.includes(name)) {
            duplicates.add(name);
          }
          providerNames.push(name);
        }
      }
      for (const ch of trimmed) {
        if (ch === "{") {
          depth++;
        }
        if (ch === "}") {
          depth--;
        }
      }
      if (depth <= 0 && providerNames.length > 0) {
        break;
      }
    }
    if (duplicates.size > 0) {
      console.log(
        `🚨 Duplicate provider key(s) detected: ${[...duplicates].map((d) => `"${String(d)}"`).join(", ")}`,
      );
      console.log(
        `JSON silently discards earlier entries with the same key — only the LAST definition is used.`,
      );
      console.log(
        `Fix: rename duplicates (e.g. "dmxapi" → "dmxapi-anthropic" for the anthropic-messages variant).\n`,
      );
    }
  }
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
const cacheRetentionIssues = [];

const modelOverrides = config?.agents?.defaults?.models ?? {};

for (const [providerName, providerConfig] of Object.entries(providers)) {
  if (!providerConfig?.models || !Array.isArray(providerConfig.models)) {
    continue;
  }
  // Only openai-completions providers need supportsUsageInStreaming
  const isOpenAICompat = providerConfig.api === "openai-completions";
  // Custom anthropic-messages providers need explicit cacheRetention
  const isCustomAnthropic =
    providerConfig.api === "anthropic-messages" && providerName !== "anthropic";

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
    if (isCustomAnthropic) {
      const modelKey = `${providerName}/${model.id}`;
      const params = modelOverrides[modelKey]?.params;
      if (!params?.cacheRetention) {
        cacheRetentionIssues.push({
          provider: providerName,
          modelId: model.id,
          modelName: model.name,
          modelKey,
        });
      }
    }
  }
}

if (costIssues.length === 0 && usageIssues.length === 0 && cacheRetentionIssues.length === 0) {
  console.log(
    "✅ All custom models have cost, usage streaming, and cache retention configuration. No issues found.",
  );
  process.exit(0);
}

if (costIssues.length > 0) {
  console.log(`⚠️  Found ${costIssues.length} model(s) missing cost configuration.`);
  console.log(
    `OpenClaw defaults missing prices to zero. Token usage remains available, but monetary cost attribution is unresolved until real provider prices are configured.\n`,
  );
  console.log(
    `Diagnose will not write zero-cost defaults because that would hide unresolved pricing.`,
  );
  console.log(`Configure explicit per-token prices for these models:\n`);
  for (const issue of costIssues) {
    const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
    console.log(`# ${issue.provider}: ${label}`);
    console.log(`models.providers.${issue.provider}.models.${issue.idx}.cost\n`);
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
      `openclaw config set models.providers.${issue.provider}.models.${issue.idx}.compat.supportsUsageInStreaming true\n`,
    );
  }
}

if (cacheRetentionIssues.length > 0) {
  console.log(
    `⚠️  Found ${cacheRetentionIssues.length} anthropic-messages model(s) missing cacheRetention config.`,
  );
  console.log(
    `Without explicit cacheRetention, prompt cache will only create entries but never read them,`,
  );
  console.log(
    `resulting in wasted tokens on every LLM call (only cache_creation, no cache_read).\n`,
  );
  console.log(`Run the following commands to enable prompt caching:\n`);
  for (const issue of cacheRetentionIssues) {
    const label = issue.modelName ? `${issue.modelId} (${issue.modelName})` : issue.modelId;
    console.log(`# ${issue.provider}: ${label}`);
    console.log(
      `openclaw config set agents.defaults.models.${issue.modelKey}.params.cacheRetention '"short"'\n`,
    );
  }
}

console.log(`After fixing, restart the gateway for changes to take effect.`);
