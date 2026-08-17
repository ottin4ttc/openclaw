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
- **Codex provider diagnostics** -- When explicitly enabled by the host
  diagnostics content policy, Codex rollout traces can add provider-request
  input/output evidence to the same Langfuse generation.
- **Optional native-child lineage** -- Bundled Codex app-server diagnostics can
  add one correlated trace per native-child turn, with proven model/tool
  ownership, without adding a public plugin hook.

## Installation

The plugin is available in an OpenClaw source checkout and as an independently
installable package. Install it when the target OpenClaw distribution does not
already include it:

```bash
openclaw plugins install @openclaw/openclaw-langfuse
```

Then enable it in the active configuration:

```bash
openclaw config set plugins.entries.openclaw-langfuse.enabled true
```

Restart the Gateway after installing or updating the plugin.

## Development and packaging

From the OpenClaw repository root, install workspace dependencies and run the
plugin tests:

```bash
pnpm install
node scripts/run-vitest.mjs extensions/openclaw-langfuse/
```

Build the package-local JavaScript runtime without rebuilding OpenClaw or any
other plugin:

```bash
node scripts/check-plugin-npm-runtime-builds.mjs \
  --package extensions/openclaw-langfuse
```

Create an installable npm tarball in an isolated output directory:

```bash
mkdir -p /tmp/openclaw-langfuse-package
OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR=/tmp/openclaw-langfuse-package \
  bash scripts/plugin-npm-publish.sh --pack extensions/openclaw-langfuse
```

Install that tarball in another OpenClaw instance:

```bash
openclaw plugins install npm-pack:/tmp/openclaw-langfuse-package/<tarball>.tgz --force
openclaw plugins inspect openclaw-langfuse --runtime --json
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

# Optional: exact Codex provider request/response content. This is sensitive
# local rollout data; enable only the fields you intend to export.
openclaw config set diagnostics.otel.enabled true
openclaw config set diagnostics.otel.traces true
openclaw config set diagnostics.otel.captureContent '{"enabled":true,"inputMessages":true,"outputMessages":true,"systemPrompt":false,"toolDefinitions":false}'
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

One conversation uses one Langfuse session. Root and native-child actor turns
use independent traces:

```
Langfuse session (OpenClaw conversation)
 +-- Root trace (one user-message-to-final-response turn)
 |    +-- Generation (llm-call-1)
 |    +-- Span (tool:collaboration.spawn_agent)
 |         metadata.childTraceId -> child trace
 +-- Child trace A (one child thread + turn)
 |    +-- Generation (llm-call-1)
 |    +-- Span (child tool call)
 +-- Child trace B (one child thread + turn)
      +-- Generation (llm-call-1)
```

The root spawn observation and child trace carry reciprocal `parentTraceId`,
`spawnObservationId`, `childTraceId`, `childThreadId`, and `childTurnId`
metadata. `parentObservationId` is used only within one trace. Reusing a
persistent child thread for a later child turn creates a new child trace.
Joined and detached children use the same topology; a detached child trace may
finalize after its root trace without reopening the root.

### Native-child lineage states

Native-child enrichment requires no plugin config key. OpenClaw 2026.7.1's
bundled Codex app-server monitor emits versioned internal lifecycle/status
diagnostics and drains exact child `threadId + turnId` rollout evidence. No
ACP/ACPX transport or public `native_child_event` hook is involved. If those
internal diagnostics are absent, the plugin keeps parent-only tracing and
records `unsupported`. The plugin never infers a child from event order, role,
model, nickname, prompt, or task text.

Trace metadata reports `nativeChildLineage` with one of these states:

| State         | Meaning                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`    | The producer proved start/terminal and call ownership, the final drain completed, and no admitted event or relationship was dropped or unresolved. |
| `partial`     | Some child evidence is usable, but terminal coverage, ownership, delivery, bounds, drain, or producer health is incomplete.                        |
| `unsupported` | No compatible Codex native-child diagnostics were observed; the parent-only trace remains authoritative.                                           |

Root metadata also includes child, admitted, duplicate, dropped, observation
mutation, and pending-ownership counters plus bounded partial reasons. A tool
with a proven triggering provider call is parented beneath that generation. If
only the child owner is proven, the tool is attached directly to the child
trace and marked `partial_parenting = true`. No cross-trace parent or
event-order parent is invented.

Each materialized child trace summarizes its exact provider requests as
`requestCount`, `firstRequest`, and `latestRequest`. Prompt statistics identify
whether the effective child system instructions came from top-level Responses
`instructions` or Responses Lite `system`/`developer` input messages, and expose
only `systemPromptSource`, character count, and a namespaced hash. Raw child
system prompts and conversation history are not copied into observation
metadata.

Child history follows Codex `spawn_agent` semantics. `fork_turns = "none"`
creates a fresh child with its task and role instructions, omitted or `"all"`
inherits the full parent history, and a positive integer string inherits the
most recent parent turns. Langfuse records the spawn arguments and exact child
request summaries; it does not infer inherited history from prompt size or
message order.

Native-child telemetry is bounded per turn to 64 active children, 4,096
lifecycle/call mutations, 16,384 UTF-8 metadata bytes per event, and 512
pending ownership joins. The runtime performs one final drain of at most 500
milliseconds. Excess or incomplete evidence degrades lineage to `partial`
without changing the OpenClaw reply, Codex result, child result, or tool
outcome.

A child fact received after that child trace finalizes does not reopen the
trace or create a replacement trace. A detached-child fact received after only
the root finalized remains admissible to the still-active child trace.
Langfuse delivery failures, missing credentials, shutdown, and plugin unload
remain fail-open for Agent execution.

To roll back enrichment, disable its internal diagnostic consumption or disable
the Langfuse plugin. Existing parent traces, generations, and tool spans
continue to work in parent-only mode.

## Acceptance testing

Treat the Langfuse trace and observations APIs as the acceptance source of
truth. A JSON file downloaded from the Langfuse UI may contain the correct
trace and observation indexes while omitting observation `input` or `output`;
do not classify those fields as lost until the API records are checked for the
same trace ID.

For every live acceptance run:

1. Fetch `/api/public/traces/<root-trace-id>` and its linked child trace IDs;
   verify all traces use the same session identity and reciprocal correlation
   metadata.
2. Fetch `/api/public/observations?traceId=<trace-id>&limit=100` for the root
   and every child trace; verify trace-local `llm-call-N` and tool counts.
3. Require every completed observation to have `input`, `output` or a
   classified terminal error, and `endTime`. Require generations to retain the
   available model and usage fields.
4. Require every `parentObservationId` to resolve inside the same trace. A
   child tool without proven provider ownership must have no parent and must
   carry `partial_parenting = true`.
5. For real-time behavior, query the observations API while the turn is still
   running and confirm started generations appear before `agent_end`.

Use UI downloads for convenient inspection only. When a UI download and the
public API differ, the public API response is authoritative for plugin
acceptance.

## Environment Variables

| Variable              | Description                                        |
| --------------------- | -------------------------------------------------- |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key (takes precedence over config) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key (takes precedence over config) |
| `LANGFUSE_BASE_URL`   | Langfuse base URL (takes precedence over config)   |

Exact Codex provider-request tracing is opt-in through the host's
`diagnostics.otel.captureContent` policy. It starts Codex's local rollout trace
bundle and exports only the selected fields after bounded redaction. Rollout
bundles can contain prompts, responses, tool I/O, and local paths; they are
temporary local input and are pruned after processing. With content capture
disabled, the plugin still records aggregate model-call and turn telemetry.

## Requirements

- OpenClaw 2026.7.1+
- A Langfuse account ([cloud.langfuse.com](https://cloud.langfuse.com) or self-hosted)

## License

MIT
