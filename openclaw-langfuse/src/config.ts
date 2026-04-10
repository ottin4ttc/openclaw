export type PromptRule = {
  match: string;
  langfusePrompt: string;
  version?: number;
  label?: string;
  inject?: "prepend" | "append" | "replace";
};

export type TracingConfig = {
  /** Enable LLM tracing. Default: true */
  enabled?: boolean;
  tags?: string[];
  /** Redact prompt/completion content from traces. Default: true */
  redact?: boolean;
};

export type LangfusePluginConfig = {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  prompts?: PromptRule[];
  /** How long to cache fetched prompts in milliseconds. Default: 60000 */
  promptCacheTtlMs?: number;
  /** How long to wait for prompt fetches before skipping injection. Default: 2000 */
  promptFetchTimeoutMs?: number;
  tracing?: TracingConfig;
};

export type ResolvedCredentials = {
  publicKey: string | undefined;
  secretKey: string | undefined;
  baseUrl: string;
};

/**
 * Resolve Langfuse credentials: env vars take precedence over plugin config.
 * - LANGFUSE_PUBLIC_KEY / config.publicKey
 * - LANGFUSE_SECRET_KEY / config.secretKey
 * - LANGFUSE_BASE_URL / config.baseUrl (default: https://cloud.langfuse.com)
 */
export function resolveCredentials(config: LangfusePluginConfig): ResolvedCredentials {
  return {
    publicKey: process.env["LANGFUSE_PUBLIC_KEY"] ?? config.publicKey,
    secretKey: process.env["LANGFUSE_SECRET_KEY"] ?? config.secretKey,
    baseUrl: process.env["LANGFUSE_BASE_URL"] ?? config.baseUrl ?? "https://cloud.langfuse.com",
  };
}
