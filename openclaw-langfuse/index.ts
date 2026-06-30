import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { LangfusePluginConfig } from "./src/config.js";
import { createLangfuseService } from "./src/service.js";

export default definePluginEntry({
  id: "openclaw-langfuse",
  name: "Langfuse",
  description: "Langfuse tracing and prompt management for OpenClaw",
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

    const service = createLangfuseService(config, api.logger, api.runtime);
    api.registerService(service);

    const h = service.getHookHandlers();

    // Register all hooks unconditionally - the handlers check disabled/langfuse state internally
    api.on("before_prompt_build", h.beforePromptBuild);
    api.on("before_agent_start", h.beforeAgentStart);
    api.on("llm_input", h.llmInput);
    api.on("llm_output", h.llmOutput);
    api.on("before_tool_call", h.beforeToolCall);
    api.on("after_tool_call", h.afterToolCall);
    api.on("agent_end", h.agentEnd);
    api.on("session_start", h.sessionStart);
    api.on("session_end", h.sessionEnd);
    api.on("before_message_write", h.beforeMessageWrite);

    api.logger.info(`Langfuse: hooks registered (config keys: ${Object.keys(config).join(",")})`);
  },
});
