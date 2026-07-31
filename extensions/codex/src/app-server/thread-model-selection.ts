import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveCodexAppServerReasoningEffort,
  type CodexReasoningEffort,
} from "./reasoning-effort.js";
import {
  isCodexAppServerNativeAuthProfile,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";

export const CODEX_NATIVE_PERSONALITY_NONE = "none";

export function resolveCodexBindingModelProviderFallback(params: {
  provider?: string;
  currentModel: string | undefined;
  bindingModel: string | undefined;
  bindingModelProvider: string | undefined;
}): string | undefined {
  const provider = params.provider?.trim().toLowerCase();
  if (provider && provider !== "codex") {
    return undefined;
  }
  const currentModel = params.currentModel?.trim();
  const bindingModel = params.bindingModel?.trim();
  if (
    currentModel &&
    bindingModel &&
    currentModel === bindingModel &&
    params.bindingModelProvider
  ) {
    return params.bindingModelProvider;
  }
  return hasProviderQualifiedModelRef(currentModel) ? undefined : params.bindingModelProvider;
}

export function resolveCodexAppServerThreadModelSelection(params: {
  provider: string;
  model: string;
  binding?: Pick<
    CodexAppServerThreadBinding,
    "threadId" | "authProfileId" | "model" | "modelProvider"
  >;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): { model: string; modelProvider?: string } {
  const authProfileId = params.authProfileId ?? params.binding?.authProfileId;
  const explicitModelProvider = resolveCodexAppServerModelProvider({
    provider: params.provider,
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  const bindingModelProvider = params.binding?.threadId
    ? resolveCodexBindingModelProviderFallback({
        provider: params.provider,
        currentModel: params.model,
        bindingModel: params.binding.model,
        bindingModelProvider: params.binding.modelProvider,
      })
    : undefined;
  return resolveCodexAppServerRequestModelSelection({
    model: params.model,
    modelProvider: explicitModelProvider ?? bindingModelProvider,
    authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
}

export function resolveCodexAppServerRequestModelSelection(params: {
  model: string;
  modelProvider?: string | null;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): { model: string; modelProvider?: string } {
  const model = params.model.trim();
  const modelProvider = params.modelProvider?.trim();
  const configuredNestedProvider = resolveConfiguredNestedModelProvider({
    model,
    modelProvider,
    config: params.config,
  });
  if (modelProvider && !configuredNestedProvider) {
    return { model, modelProvider };
  }
  // Codex app-server expects provider-qualified refs as separate fields. Keep
  // explicit providers intact so provider-owned slashy model ids are not split.
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return { model };
  }
  const inferredProvider = configuredNestedProvider ?? model.slice(0, slashIndex);
  const inferredModelProvider = resolveCodexAppServerModelProvider({
    provider: inferredProvider,
    authProfileId: params.authProfileId,
    authProfileStore: params.authProfileStore,
    agentDir: params.agentDir,
    config: params.config,
  });
  return {
    model: model.slice(slashIndex + 1).trim(),
    ...(inferredModelProvider ? { modelProvider: inferredModelProvider } : {}),
  };
}

function resolveConfiguredNestedModelProvider(params: {
  model: string;
  modelProvider?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  if (params.modelProvider?.trim().toLowerCase() !== "openai") {
    return undefined;
  }
  const slashIndex = params.model.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= params.model.length - 1) {
    return undefined;
  }
  const candidate = params.model.slice(0, slashIndex).trim().toLowerCase();
  if (!candidate || candidate === "openai" || candidate === "codex") {
    return undefined;
  }
  return Object.keys(params.config?.models?.providers ?? {}).find(
    (providerId) => providerId.trim().toLowerCase() === candidate,
  );
}

function hasProviderQualifiedModelRef(model: string | undefined): boolean {
  const trimmed = model?.trim();
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && slashIndex < (trimmed?.length ?? 0) - 1;
}

export function resolveCodexAppServerModelProvider(params: {
  provider: string;
  authProfileId?: string;
  authProfileStore?: CodexAppServerAuthProfileLookup["authProfileStore"];
  agentDir?: string;
  config?: CodexAppServerAuthProfileLookup["config"];
}): string | undefined {
  const normalized = params.provider.trim();
  const normalizedLower = normalized.toLowerCase();
  if (!normalized || normalizedLower === "codex") {
    // `codex` is OpenClaw's virtual provider; let Codex app-server keep its
    // native provider/auth selection instead of forcing the legacy OpenAI path.
    return undefined;
  }
  if (isCodexAppServerNativeAuthProfile(params) && normalizedLower === "openai") {
    // When OpenClaw is forwarding ChatGPT/Codex OAuth, `openai` is Codex's
    // native provider id, not a public OpenAI API-key choice. Omit the override
    // so app-server keeps its configured provider/auth pair for this session.
    return undefined;
  }
  return normalizedLower === "openai" ? "openai" : normalized;
}

// Modern Codex models reject the legacy CLI `minimal` default. Prefer
// app-server metadata, then use the app-server-owned fallback effort contract
// for Pro models whose minimum supported effort is `medium`.
// Other modern models translate `minimal` to `low`. (#71946)
// Exported for unit-test coverage of the model-aware translation path.
export function resolveReasoningEffort(
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"] | "ultra",
  modelId: string,
  supportedReasoningEfforts?: readonly string[],
): CodexReasoningEffort | null {
  return resolveCodexAppServerReasoningEffort({
    thinkLevel,
    modelId,
    supportedReasoningEfforts,
  });
}
