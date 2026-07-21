import { readFileSync } from "node:fs";
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

/**
 * Check all custom providers in openclaw.json for models missing `cost` config.
 * OpenClaw defaults missing prices to zero, so token usage remains available but
 * monetary cost attribution is unavailable until prices are configured.
 */
export function checkModelCostConfig(stateDir?: string): ModelCostIssue[] {
  if (!stateDir) {
    return [];
  }
  const effectiveStateDir = stateDir;
  const configPath = join(effectiveStateDir, "openclaw.json");

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
 * Missing model prices need provider-specific rates. Do not generate a zero-cost
 * repair command because that would hide unresolved monetary attribution.
 */
export function generateFixCommands(issues: ModelCostIssue[]): string[] {
  void issues;
  return [];
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
    `Token usage remains available, but monetary cost attribution is unresolved until ` +
    `real provider prices are configured. Run 'npm run diagnose' in the ` +
    `openclaw-langfuse plugin directory for details.`
  );
}
