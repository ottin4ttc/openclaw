## Why

With `homeScope = "agent"`, Codex app-server clients are keyed by Agent and can remain resident after a turn releases its lease. In a large multi-Agent run this accumulates native app-server and code-mode-host processes until the service cgroup approaches `TasksMax`, even though no turns are active.

## What Changes

- Add an optional Codex app-server shared-client idle timeout that retires only clients with no active lease, pending acquire, or unfinished native child.
- Make idle cleanup configurable under the Codex plugin `appServer` configuration, with a default of `0` that preserves current warm-client behavior. The setting applies to all shared Codex app-server clients in the plugin process; deployments choose their own value.
- Install the policy once from the Codex plugin registration/startup hook before any shared-client acquisition; configuration changes require a Gateway restart and do not reconfigure running clients.
- Keep the policy independent of OpenClaw `agents.defaults.maxConcurrent` and `agents.defaults.subagents.maxConcurrent`; no environment-specific business behavior belongs in this generic runtime change.
- Reuse the existing race-safe shared-client retirement and `closeAndWait` lifecycle, including deferred cleanup while native children are still active.
- This change does not add a global active-thread admission cap.

## Capabilities

### New Capabilities

- `codex-shared-client-lifecycle`: Configurable idle detection and safe retirement of cached Codex app-server clients while preserving active sessions and existing one-shot cleanup behavior.

### Modified Capabilities

- None.

## Impact

- Codex plugin shared-client state, configuration parsing, plugin manifest schema/help, and lifecycle tests.
- Codex app-server startup latency may increase after an idle client is reclaimed; active turns and persisted session state remain unaffected.
- Each deployment can select its own timeout or leave the default disabled; no environment-specific behavior is encoded in the generic runtime.
- No changes to OpenClaw scheduler concurrency, caller-owned Codex profile values, Codex wire protocol, or external dependencies.
