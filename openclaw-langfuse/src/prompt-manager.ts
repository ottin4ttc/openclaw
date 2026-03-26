import Langfuse from "langfuse";
import type { PromptRule, LangfusePluginConfig } from "./config.js";
import { findMatchingRule } from "./matcher.js";

type CacheEntry = {
  compiledPrompt: string;
  fetchedAt: number;
  promptName: string;
  version?: number;
  label?: string;
  promptClient: unknown;
};

type AgentContext = {
  agentId?: string;
  channelId?: string;
  sessionKey?: string;
  trigger?: string;
};

type PromptResolveResult = {
  injection: {
    systemPrompt?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  };
  matchInfo: {
    name: string;
    version?: number;
    label?: string;
    inject?: string;
    matchRule: string;
  };
  promptClient: unknown;
};

export class PromptManager {
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private rules: PromptRule[];
  private langfuse: Langfuse;
  private fetchTimeoutMs = 3000;

  constructor(langfuse: Langfuse, config: LangfusePluginConfig) {
    this.langfuse = langfuse;
    this.rules = config.prompts ?? [];
    this.cacheTtlMs = config.promptCacheTtlMs ?? 300000; // 5 minutes default
  }

  /**
   * Pre-fetch all configured prompt rules into the cache.
   * Fire-and-forget — errors are silently ignored per rule.
   */
  async warmCache(): Promise<void> {
    for (const rule of this.rules) {
      try {
        const cacheKey = `${rule.langfusePrompt}:${rule.version ?? "latest"}:${rule.label ?? "default"}`;
        if (this.cache.has(cacheKey)) {
          continue;
        }
        const { promptText, promptClient } = await this.fetchWithTimeout(rule);
        this.cache.set(cacheKey, {
          compiledPrompt: promptText,
          fetchedAt: Date.now(),
          promptName: rule.langfusePrompt,
          version: rule.version,
          label: rule.label,
          promptClient,
        });
      } catch {
        // Silently skip — will retry on next resolve
      }
    }
  }

  /**
   * Find matching prompt rule and fetch/compile the prompt.
   * Returns { injection, matchInfo } or undefined if no match or fetch fails.
   * Degrades gracefully: fetch errors and timeouts return undefined.
   */
  async resolve(agentId: string, ctx: AgentContext): Promise<PromptResolveResult | undefined> {
    // 1. Find matching rule
    const rule = findMatchingRule(agentId, this.rules);
    if (!rule) {
      return undefined;
    }

    // 2. Check cache
    const cacheKey = `${rule.langfusePrompt}:${rule.version ?? "latest"}:${rule.label ?? "default"}`;
    const cached = this.cache.get(cacheKey);
    // If cache expired, still use stale data but trigger background refresh
    if (cached && Date.now() - cached.fetchedAt >= this.cacheTtlMs) {
      this.fetchWithTimeout(rule)
        .then(({ promptText, promptClient }) =>
          this.cache.set(cacheKey, {
            compiledPrompt: promptText,
            fetchedAt: Date.now(),
            promptName: rule.langfusePrompt,
            version: rule.version,
            label: rule.label,
            promptClient,
          }),
        )
        .catch(() => {}); // silently ignore refresh failures
    }
    if (cached) {
      // compile with context vars
      const compiled = this.compileTemplate(cached.compiledPrompt, ctx);
      return {
        injection: this.buildInjection(compiled, rule.inject),
        matchInfo: {
          name: rule.langfusePrompt,
          version: rule.version,
          label: rule.label,
          inject: rule.inject,
          matchRule: rule.match,
        },
        promptClient: cached.promptClient,
      };
    }

    // 3. Fetch from Langfuse with timeout
    try {
      const { promptText, promptClient } = await this.fetchWithTimeout(rule);
      // Cache the raw template (before variable compilation)
      this.cache.set(cacheKey, {
        compiledPrompt: promptText,
        fetchedAt: Date.now(),
        promptName: rule.langfusePrompt,
        version: rule.version,
        label: rule.label,
        promptClient,
      });
      const compiled = this.compileTemplate(promptText, ctx);
      return {
        injection: this.buildInjection(compiled, rule.inject),
        matchInfo: {
          name: rule.langfusePrompt,
          version: rule.version,
          label: rule.label,
          inject: rule.inject,
          matchRule: rule.match,
        },
        promptClient,
      };
    } catch {
      // Graceful degradation - return undefined, don't throw
      return undefined;
    }
  }

  /**
   * Synchronous resolve — returns cached prompt injection if available.
   * Does NOT fetch from Langfuse. Use warmCache() or resolve() to populate cache first.
   * Used by before_prompt_build hook which must return synchronously.
   */
  resolveSync(agentId: string, ctx: AgentContext): PromptResolveResult | undefined {
    const rule = findMatchingRule(agentId, this.rules);
    if (!rule) {
      return undefined;
    }

    const cacheKey = `${rule.langfusePrompt}:${rule.version ?? "latest"}:${rule.label ?? "default"}`;
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return undefined;
    }

    // If cache expired, trigger background refresh but still return stale data
    if (Date.now() - cached.fetchedAt >= this.cacheTtlMs) {
      this.fetchWithTimeout(rule)
        .then(({ promptText, promptClient }) =>
          this.cache.set(cacheKey, {
            compiledPrompt: promptText,
            fetchedAt: Date.now(),
            promptName: rule.langfusePrompt,
            version: rule.version,
            label: rule.label,
            promptClient,
          }),
        )
        .catch(() => {});
    }

    const compiled = this.compileTemplate(cached.compiledPrompt, ctx);
    return {
      injection: this.buildInjection(compiled, rule.inject),
      matchInfo: {
        name: rule.langfusePrompt,
        version: rule.version,
        label: rule.label,
        inject: rule.inject,
        matchRule: rule.match,
      },
      promptClient: cached.promptClient,
    };
  }

  private async fetchWithTimeout(
    rule: PromptRule,
  ): Promise<{ promptText: string; promptClient: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const promptClient = await this.langfuse.getPrompt(rule.langfusePrompt, rule.version, {
        label: rule.label,
        type: "text",
      });
      // .prompt is the raw template string on TextPromptClient
      return { promptText: promptClient.prompt, promptClient };
    } finally {
      clearTimeout(timeout);
    }
  }

  private compileTemplate(template: string, ctx: AgentContext): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      switch (key) {
        case "agent_name":
          return ctx.agentId ?? "";
        case "channel_id":
          return ctx.channelId ?? "";
        case "session_key":
          return ctx.sessionKey ?? "";
        case "trigger":
          return ctx.trigger ?? "";
        default:
          return "";
      }
    });
  }

  private buildInjection(
    prompt: string,
    inject?: string,
  ): {
    systemPrompt?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  } {
    switch (inject) {
      case "replace":
        return { systemPrompt: prompt };
      case "prepend":
        return { prependSystemContext: prompt };
      case "append":
      default:
        return { appendSystemContext: prompt };
    }
  }
}
