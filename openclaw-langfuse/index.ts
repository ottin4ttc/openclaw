import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LangfusePluginConfig } from "./src/config.js";
import { createLangfuseService } from "./src/service.js";

const plugin = {
  id: "openclaw-langfuse",
  name: "Langfuse",
  description: "Langfuse tracing and prompt management for OpenClaw",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as LangfusePluginConfig;
    // Skip registration if no valid config (happens during CLI snapshot passes)
    if (
      !config.baseUrl &&
      !config.publicKey &&
      !config.secretKey &&
      !config.tracing &&
      !config.prompts
    ) {
      return;
    }

    const service = createLangfuseService(config, api.logger);
    api.registerService(service);

    const h = service.getHookHandlers();

    // Register all hooks unconditionally - the handlers check disabled/langfuse state internally
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("before_prompt_build", h.beforePromptBuild);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("before_agent_start", h.beforeAgentStart);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("llm_input", h.llmInput);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("llm_output", h.llmOutput);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("before_tool_call", h.beforeToolCall);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("after_tool_call", h.afterToolCall);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("agent_end", h.agentEnd);
    // @ts-expect-error -- local handler types are structurally compatible at runtime
    api.on("session_end", h.sessionEnd);

    api.logger.info(`Langfuse: hooks registered (config keys: ${Object.keys(config).join(",")})`);
  },
};

export default plugin;
