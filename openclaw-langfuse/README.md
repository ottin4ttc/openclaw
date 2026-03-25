# openclaw-langfuse

Langfuse tracing and prompt management plugin for [OpenClaw](https://github.com/openclaw/openclaw).

Captures LLM call chains as structured Langfuse traces and optionally injects prompts from Langfuse Prompt Management into your agents.

## Features

- **LLM Tracing** -- Every agent turn becomes a Langfuse trace with nested generations (LLM calls) and spans (tool calls), including token usage, latency, and model info.
- **Prompt Management** -- Fetch prompts from Langfuse and inject them into agent system prompts. Supports prepend, append, or replace modes.
- **Prompt Linking** -- Generations are linked to Langfuse prompts, so prompt usage is tracked in the Langfuse Prompts dashboard (Observations count).
- **Content Redaction** -- Optionally redact prompt/completion content from traces for privacy compliance.
- **Custom Tags** -- Attach custom tags to every trace for easy filtering in Langfuse.
- **Graceful Degradation** -- If Langfuse is unavailable, OpenClaw continues to operate normally.
- **Gateway + CLI Mode** -- Works in both OpenClaw CLI and gateway (menubar app) modes.

## Installation

```bash
openclaw plugins install openclaw-langfuse
```

Or install from a local path:

```bash
openclaw plugins install /path/to/openclaw-langfuse
```

## Configuration

Add the plugin config to your `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-langfuse": {
        "enabled": true,
        "config": {
          // Langfuse credentials (env vars LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY take precedence)
          "baseUrl": "https://cloud.langfuse.com",
          "publicKey": "pk-lf-...",
          "secretKey": "sk-lf-...",

          // LLM tracing
          "tracing": {
            "enabled": true,
            "tags": ["production"],
            "redact": true,
          },

          // Prompt management (optional)
          "prompts": [
            {
              "match": "main",
              "langfusePrompt": "main-agent-prompt",
              "inject": "replace",
            },
            {
              "match": "my-agent-*",
              "langfusePrompt": "my-agent-prompt",
              "label": "production",
              "inject": "prepend",
            },
            {
              "match": "*",
              "langfusePrompt": "fallback-prompt",
              "inject": "append",
            },
          ],

          "promptCacheTtlMs": 60000,
        },
      },
    },
  },
}
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

| Pattern        | Match type      | Example                                     |
| -------------- | --------------- | ------------------------------------------- |
| `"main"`       | Exact match     | Matches agent ID `main` only                |
| `"my-agent-*"` | Wildcard prefix | Matches `my-agent-1`, `my-agent-test`, etc. |
| `"*"`          | Catch-all       | Matches any agent ID                        |

Each rule supports:

- `langfusePrompt` -- Name of the Langfuse prompt to fetch
- `version` -- Specific prompt version (omit for latest)
- `label` -- Prompt label (e.g. `"production"`, `"staging"`)
- `inject` -- How to inject: `"prepend"` (default), `"append"`, or `"replace"`

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

- OpenClaw 2026.3.0+
- A Langfuse account ([cloud.langfuse.com](https://cloud.langfuse.com) or self-hosted)

## License

MIT
