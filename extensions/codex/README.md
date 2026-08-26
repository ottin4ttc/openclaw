# OpenClaw Codex

Official OpenClaw provider and harness plugin for OpenAI Codex app-server integration. It exposes the Codex-managed GPT model catalog and the Codex runtime surfaces used by OpenClaw agents.

Install from OpenClaw:

```bash
openclaw plugin add @openclaw/codex
```

Use this plugin when you want OpenClaw to run Codex-backed model turns, media understanding, and prompt overlays through the Codex app-server harness.

## Shared app-server client lifecycle

The plugin keeps shared Codex app-server clients warm by default. To reclaim a
client after it has been idle, set the generic plugin option below in
`openclaw.json`:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            sharedClientIdleTimeoutMs: 300000,
          },
        },
      },
    },
  },
}
```

The value is milliseconds. Omit it or set it to `0` to preserve warm-client
reuse. A positive value applies to every shared Codex app-server client in the
Gateway process and only reclaims clients with no active lease, pending
acquisition, or native-child work. Restart the Gateway after changing it; the
policy is read at startup and is not changed live.
