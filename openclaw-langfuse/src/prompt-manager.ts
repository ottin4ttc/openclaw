import Langfuse from "langfuse";
import type { LangfusePromptClient } from "langfuse-core";
import type { PromptRule, LangfusePluginConfig } from "./config.js";
import { findMatchingRule } from "./matcher.js";

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
  private cacheTtlMs: number;
  private rules: PromptRule[];
  private langfuse: Langfuse;
  private fetchTimeoutMs: number;

  constructor(langfuse: Langfuse, config: LangfusePluginConfig) {
    this.langfuse = langfuse;
    this.rules = config.prompts ?? [];
    this.cacheTtlMs = config.promptCacheTtlMs ?? 60000; // 1 minute default
    this.fetchTimeoutMs = config.promptFetchTimeoutMs ?? 2000;
  }

  /**
   * Prime the Langfuse SDK cache for configured prompt rules.
   * Errors are ignored so prompt fetching can retry on demand.
   */
  async warmCache(): Promise<void> {
    for (const rule of this.rules) {
      try {
        await this.fetchWithTimeout(rule);
      } catch {
        // Silently skip — will retry on next resolve
      }
    }
  }

  /**
   * Find matching prompt rule and fetch/compile the prompt.
   * Returns { injection, matchInfo } or undefined if no match or fetch fails.
   * Degrades gracefully: fetch errors and timeouts return undefined.
   * Caching behavior is delegated to the Langfuse SDK.
   */
  async resolve(agentId: string, ctx: AgentContext): Promise<PromptResolveResult | undefined> {
    const rule = findMatchingRule(agentId, this.rules);
    if (!rule) {
      return undefined;
    }

    try {
      const { promptText, promptClient } = await this.fetchWithTimeout(rule);
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
      return undefined;
    }
  }

  /**
   * Synchronous resolve is intentionally unsupported.
   * The plugin now relies on the async Langfuse SDK prompt cache behavior.
   */
  resolveSync(_agentId: string, _ctx: AgentContext): PromptResolveResult | undefined {
    return undefined;
  }

  private async fetchWithTimeout(
    rule: PromptRule,
  ): Promise<{ promptText: string; promptClient: unknown }> {
    const promptClient = (await Promise.race([
      this.langfuse.getPrompt(rule.langfusePrompt, rule.version, {
        label: rule.label,
        cacheTtlSeconds: Math.max(0, Math.ceil(this.cacheTtlMs / 1000)),
        type: "text",
      }),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), this.fetchTimeoutMs);
      }),
    ])) as LangfusePromptClient | undefined;
    if (!promptClient) {
      throw new Error(`Prompt fetch timed out after ${this.fetchTimeoutMs}ms`);
    }
    // .prompt is the raw template string on TextPromptClient
    return { promptText: promptClient.prompt, promptClient };
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
