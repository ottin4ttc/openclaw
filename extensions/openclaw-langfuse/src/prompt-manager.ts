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

export type PromptResolveResult = {
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
    this.cacheTtlMs = config.promptCacheTtlMs ?? 60000; // 1 minute default
  }

  /**
   * Pre-fetch all configured prompt rules into the cache.
   * Fire-and-forget — errors are silently ignored per rule.
   */
  async warmCache(): Promise<void> {
    if (!this.isCacheEnabled()) {
      return;
    }

    for (const rule of this.rules) {
      try {
        const cacheKey = this.cacheKey(rule);
        if (this.cache.has(cacheKey)) {
          continue;
        }
        const { promptText, promptClient } = await this.fetchWithTimeout(rule);
        this.setCacheEntry(rule, promptText, promptClient);
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
    const cached = this.isCacheEnabled() ? this.cache.get(this.cacheKey(rule)) : undefined;
    if (cached && this.isExpired(cached)) {
      // Positive TTLs keep stale-while-refresh behavior: return the cached prompt
      // for this hook while refreshing the cache for the next turn.
      this.refreshCache(rule);
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
      this.setCacheEntry(rule, promptText, promptClient);
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

    if (!this.isCacheEnabled()) {
      return undefined;
    }

    const cacheKey = this.cacheKey(rule);
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      return undefined;
    }

    // If cache expired, trigger background refresh but still return stale data
    if (this.isExpired(cached)) {
      this.refreshCache(rule);
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
    const promptClient = await this.langfuse.getPrompt(rule.langfusePrompt, rule.version, {
      label: rule.label,
      type: "text",
      fetchTimeoutMs: this.fetchTimeoutMs,
    });
    // .prompt is the raw template string on TextPromptClient
    return { promptText: promptClient.prompt, promptClient };
  }

  private isCacheEnabled(): boolean {
    return this.cacheTtlMs > 0;
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt >= this.cacheTtlMs;
  }

  private cacheKey(rule: PromptRule): string {
    return `${rule.langfusePrompt}:${rule.version ?? "latest"}:${rule.label ?? "default"}`;
  }

  private setCacheEntry(rule: PromptRule, promptText: string, promptClient: unknown): void {
    if (!this.isCacheEnabled()) {
      return;
    }

    this.cache.set(this.cacheKey(rule), {
      compiledPrompt: promptText,
      fetchedAt: Date.now(),
      promptName: rule.langfusePrompt,
      version: rule.version,
      label: rule.label,
      promptClient,
    });
  }

  private refreshCache(rule: PromptRule): void {
    this.fetchWithTimeout(rule)
      .then(({ promptText, promptClient }) => this.setCacheEntry(rule, promptText, promptClient))
      .catch(() => {}); // silently ignore refresh failures
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
