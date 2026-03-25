import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ModelEntry = {
  id: string;
  name?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  [key: string]: unknown;
};

type ProviderConfig = {
  baseUrl?: string;
  api?: string;
  models?: ModelEntry[];
  [key: string]: unknown;
};

export type ModelCostIssue = {
  provider: string;
  modelId: string;
  modelName?: string;
  /** All models in this provider (needed to generate the full config set command) */
  allModels: ModelEntry[];
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Check all custom providers in openclaw.json for models missing `cost` config.
 * Missing cost causes pi-ai's calculateCost() to crash, resulting in zero usage data.
 */
export function checkModelCostConfig(): ModelCostIssue[] {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return [];
  }

  const providers = (config.models as Record<string, unknown>)?.providers as
    | Record<string, ProviderConfig>
    | undefined;

  if (!providers) {
    return [];
  }

  const issues: ModelCostIssue[] = [];

  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerConfig?.models || !Array.isArray(providerConfig.models)) {
      continue;
    }
    for (const model of providerConfig.models) {
      if (!model.id) {
        continue;
      }
      if (!model.cost) {
        issues.push({
          provider: providerName,
          modelId: model.id,
          modelName: model.name,
          allModels: providerConfig.models,
        });
      }
    }
  }

  return issues;
}

/**
 * Generate `openclaw config set` commands that add cost to specific models.
 * Uses array index to target only the cost field, leaving other model config untouched.
 */
export function generateFixCommands(issues: ModelCostIssue[]): string[] {
  const commands: string[] = [];
  for (const issue of issues) {
    const idx = issue.allModels.findIndex((m) => m.id === issue.modelId);
    if (idx === -1) {
      continue;
    }
    const costJson = JSON.stringify(DEFAULT_COST);
    commands.push(
      `openclaw config set models.providers.${issue.provider}.models.${idx}.cost '${costJson}'`,
    );
  }
  return commands;
}

/**
 * Format issues as user-friendly warning message.
 */
export function formatCostWarning(issues: ModelCostIssue[]): string {
  if (issues.length === 0) {
    return "";
  }

  const models = issues.map((i) => `${i.provider}/${i.modelId}`).join(", ");
  return (
    `Langfuse: ${issues.length} custom model(s) missing 'cost' config: ${models}. ` +
    `This causes zero usage/token data in traces. ` +
    `Run 'npm run diagnose' in the openclaw-langfuse plugin directory for fix commands.`
  );
}
