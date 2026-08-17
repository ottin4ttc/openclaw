## Why

The `openmai-u1861319839285792768` Agent needs deterministic Sol, Terra, and Luna routing across repeated Codex native subagent calls without reading the operator's global `~/.codex` configuration. OpenClaw 2026.7.1 already provides that isolation through the bundled Codex app-server harness: its default `plugins.entries.codex.config.appServer.homeScope` is `agent`, and local launches set `CODEX_HOME` to `<agentDir>/codex-home`.

The missing work is therefore not a new ACPX home-selection feature. It is safe OpenMAI-owned provisioning inside the existing native Agent home. The current prototype incorrectly forces `runtime.type = "acp"`, writes an unsupported `runtime.acp.backendOptions.codexHomeScope`, replaces the complete `config.toml`/`agents/` catalog, and can delete unrelated Codex state. Those behaviors must be removed before deployment.

## What Changes

- Use OpenClaw 2026.7.1's bundled native Codex app-server runtime and its existing Agent-scoped `CODEX_HOME = <agentDir>/codex-home` behavior. Do not route this feature through ACP/ACPX.
- Stop the OpenMAI plugin from rewriting an Agent's `runtime` entry. Agent creation supplies only the normal OpenClaw Agent identity, workspace, Agent directory, and existing OpenMAI-owned settings.
- Incrementally merge the approved multi-agent settings and four OpenMAI role declarations into the existing `<agentDir>/codex-home/config.toml` while preserving unknown provider, model, feature, and Agent-role settings and mode `0600`.
- Create only the four approved role files. Preserve unknown `agents/*.toml`, `auth.json`, SQLite databases, sessions, logs, skills, caches, rollout traces, and every other unmanaged Codex artifact.
- Persist a bounded non-secret ownership manifest and role-file markers. Reconcile and deletion remove only still-owned, still-matching OpenMAI fields/files; missing or invalid ownership metadata fails safe without deleting unmanaged data.
- Keep staged validation, rollback, and crash recovery, but scope backups and restoration to the files and fields the OpenMAI operation actually changes.
- Serialize Agent creation, delegation-token persistence/rollback, deletion, and credential cleanup by normalized Agent id. On credential failure, remove the newly created Agent/profile. On deletion, retain the Agent entry and its exact paths until delegation credential/JWT cleanup and profile cleanup succeed, so either failure remains safely retryable.
- Keep the parent responsible for `openmai_internal_api_call`, all Lark writes, and final integration. Children receive bounded facts for analysis, drafting, verification, or an accepted read-only Lark lane.
- Keep Codex authentication behavior unchanged. The profile does not create, copy, delete, or rotate Codex `auth.json` or OAuth state.
- Keep Codex native-child/Langfuse lineage in the separate `add-native-subagent-trace-lineage` change.

## Capabilities

### New Capabilities

- `openmai-agent-role-routing`: OpenMAI-owned, non-destructive role provisioning in the native per-Agent Codex home, deterministic model routing, parent-owned tool/side-effect policy, rollback, and live acceptance.

### Modified Capabilities

None.

## Impact

- OpenClaw ACP core and ACPX: unchanged and outside this native OpenMAI role-routing capability.
- Bundled Codex plugin: existing 2026.7.1 `appServer.homeScope = "agent"` behavior is the runtime dependency and remains unchanged.
- OpenMAI plugin: owns incremental role-profile installation, reconcile, rollback, deletion, and delegation-credential transactions.
- Operator configuration: keep `plugins.entries.codex.config.appServer.homeScope = "agent"` or omit it to use the default; do not add `runtime.acp.backendOptions`.
- Existing Codex provider authentication and unrelated Agent homes remain untouched.
