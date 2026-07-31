# openclaw-langfuse

Langfuse tracing and prompt management plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Captures LLM call chains as structured Langfuse traces and optionally injects prompts from Langfuse Prompt Management into your agents.

## Features

- **LLM Tracing** -- Every agent turn becomes a Langfuse trace with LLM generations, including tool-call content, token usage, latency, and model info.
- **Prompt Management** -- Fetch prompts from Langfuse and inject them into agent system prompts. Supports prepend, append, or replace modes.
- **Prompt Linking** -- Generations are linked to Langfuse prompts, so prompt usage is tracked in the Langfuse Prompts dashboard (Observations count).
- **Content Redaction** -- Optionally redact prompt/completion content from traces for privacy compliance.
- **Custom Tags** -- Attach custom tags to every trace for easy filtering in Langfuse.
- **Graceful Degradation** -- If Langfuse is unavailable, OpenClaw continues to operate normally.
- **Gateway + CLI Mode** -- Works in both OpenClaw CLI and gateway (menubar app) modes.

## Installation

The plugin is bundled with OpenClaw. Enable it in the active configuration:

```bash
openclaw config set plugins.entries.openclaw-langfuse.enabled true
```

## Configuration

### Quick Setup via CLI

```bash
# Enable plugin
openclaw config set plugins.entries.openclaw-langfuse.enabled true

# Allow conversation hook access for LLM/tool tracing. Keep tracing.redact=true
# unless you need full prompt/completion payloads in Langfuse.
openclaw config set plugins.entries.openclaw-langfuse.hooks.allowConversationAccess true

# Langfuse connection
openclaw config set plugins.entries.openclaw-langfuse.config.baseUrl "https://cloud.langfuse.com"
openclaw config set plugins.entries.openclaw-langfuse.config.publicKey "pk-lf-your-public-key"
openclaw config set plugins.entries.openclaw-langfuse.config.secretKey "sk-lf-your-secret-key"

# Tracing (enabled by default, content redacted for privacy)
openclaw config set plugins.entries.openclaw-langfuse.config.tracing '{"enabled":true,"tags":["production"],"redact":true}'

# Prompt management (optional) -- inject Langfuse prompts into agents
openclaw config set plugins.entries.openclaw-langfuse.config.prompts '[{"match":"main","langfusePrompt":"oh-my-langfuse-prompt","label":"latest","inject":"replace"},{"match":"support-*","langfusePrompt":"oh-my-langfuse-support","label":"production","inject":"append"},{"match":"*","langfusePrompt":"oh-my-langfuse-fallback","label":"latest","inject":"append"}]'

# Prompt cache TTL (default: 60 seconds)
openclaw config set plugins.entries.openclaw-langfuse.config.promptCacheTtlMs 60000
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Configuration Reference

| Field              | Type         | Default                      | Description                                            |
| ------------------ | ------------ | ---------------------------- | ------------------------------------------------------ |
| `baseUrl`          | string       | `https://cloud.langfuse.com` | Langfuse API base URL                                  |
| `publicKey`        | string       | --                           | Langfuse public key (or `LANGFUSE_PUBLIC_KEY` env var) |
| `secretKey`        | string       | --                           | Langfuse secret key (or `LANGFUSE_SECRET_KEY` env var) |
| `tracing.enabled`  | boolean      | `true`                       | Enable/disable LLM tracing                             |
| `tracing.tags`     | string[]     | `[]`                         | Custom tags attached to every trace                    |
| `tracing.redact`   | boolean      | `true`                       | Redact prompt/completion content                       |
| `prompts`          | PromptRule[] | `[]`                         | Prompt injection rules (see below)                     |
| `promptCacheTtlMs` | number       | `60000`                      | Prompt cache TTL in milliseconds                       |

### Prompt Rules

Rules are evaluated in order (first match wins):

| Pattern       | Match type      | Example                                             |
| ------------- | --------------- | --------------------------------------------------- |
| `"main"`      | Exact match     | Matches agent ID `main` only                        |
| `"support-*"` | Wildcard prefix | Matches `support-tier1`, `support-enterprise`, etc. |
| `"*"`         | Catch-all       | Matches any agent ID                                |

Each rule supports:

- `langfusePrompt` -- Name of the Langfuse prompt to fetch
- `version` -- Specific prompt version (omit for latest)
- `label` -- Prompt label (e.g. `"production"`, `"staging"`)
- `inject` -- How to inject: `"append"` (default), `"prepend"`, or `"replace"`

### Template Variables

Prompts fetched from Langfuse can include template variables:

| Variable          | Value              |
| ----------------- | ------------------ |
| `{{agent_name}}`  | Current agent ID   |
| `{{channel_id}}`  | Channel identifier |
| `{{session_key}}` | Session key        |
| `{{trigger}}`     | Trigger source     |

## Trace Structure

Each agent turn produces a trace like:

```
Trace (agent turn)
 +-- Generation (llm-call-1: model, input/output, tokens, prompt link)
 +-- Span (tool:read_file, params, result, duration)
 +-- Generation (llm-call-2: model, input/output, tokens, prompt link)
 +-- Span (tool:web_search, params, result, duration)
 +-- Generation (llm-call-3: final answer)
```

## Environment Variables

| Variable              | Description                                        |
| --------------------- | -------------------------------------------------- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (takes precedence over config) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (takes precedence over config) |
| `LANGFUSE_BASE_URL`   | Langfuse base URL (takes precedence over config)   |

## Requirements

- OpenClaw 2026.7.2+
- A Langfuse account ([cloud.langfuse.com](https://cloud.langfuse.com) or self-hosted)

## License

MIT
