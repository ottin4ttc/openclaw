# OpenMAI Agent-local Codex role routing

This guide targets OpenClaw `2026.7.1`. OpenMAI Agents use the bundled native Codex app-server runtime, which selects each Agent's existing local Codex home.

## Runtime configuration

Keep or omit the default:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            homeScope: "agent",
            transport: "stdio",
          },
        },
      },
    },
  },
}
```

Do not add an ACP/ACPX runtime override or `runtime.acp.backendOptions.codexHomeScope`. The OpenMAI provisioner does not rewrite the Agent runtime. OpenClaw's native Codex app-server selects `<agentDir>/codex-home`; neither global `~/.codex` nor an ACP/ACPX home participates in OpenMAI role routing.

For the target Agent:

```text
agentDir:   <stateDir>/agents/openmai-u1861319839285792768/agent
workspace:  <stateDir>/workspace-openmai-u1861319839285792768
Codex home: <agentDir>/codex-home
```

Provider authentication is unchanged. Do not copy, replace, delete, or inspect the contents of `auth.json` for this feature.

## Managed profile

The OpenMAI provisioner manages only approved paths inside:

```text
<agentDir>/codex-home/config.toml
<agentDir>/codex-home/.openmai-role-profile.toml
<agentDir>/codex-home/agents/talent_analyst.toml
<agentDir>/codex-home/agents/lark_reader.toml
<agentDir>/codex-home/agents/draft_writer.toml
<agentDir>/codex-home/agents/result_verifier.toml
<workspace>/AGENTS.md marker section
```

Unknown config fields and role files remain unmanaged. Authentication, SQLite, sessions, logs, skills, caches, and rollout traces remain untouched. `config.toml` stays mode `0600`.

The approved config merge is:

```toml
[features.multi_agent_v2]
enabled = true
max_concurrent_threads_per_session = 5

[agents]
max_depth = 1

[agents.talent_analyst]
description = "Analyze bounded candidate/job results supplied by the parent; no live TTC or Lark calls."
config_file = "./agents/talent_analyst.toml"

[agents.lark_reader]
description = "Perform an accepted read-only Lark lookup; never write, send, delete, or mutate."
config_file = "./agents/lark_reader.toml"

[agents.draft_writer]
description = "Draft concise text from supplied facts; no live tools or mutations."
config_file = "./agents/draft_writer.toml"

[agents.result_verifier]
description = "Verify supplied facts, ranking, and output constraints; no external writes."
config_file = "./agents/result_verifier.toml"
```

Every generated role file begins with:

```toml
# managed-by: openmai-codex-role-routing/v1
```

The models are Terra/high, Terra/medium, Luna/low, and Sol/high. Role files omit `model_provider`, `service_tier`, and `developer_instructions`.

## Safe backup

Before reconciling a live Agent, back up only:

- the target `agents.list[]` entry;
- workspace `AGENTS.md`;
- `config.toml`;
- `.openmai-role-profile.toml` if present;
- the four same-named role files if present.

Do not copy or modify `auth.json`, SQLite/WAL/SHM, sessions, logs, or the entire Codex home as part of profile rollback.

If a pre-release target still contains an experimental ACPX runtime override, restore the reviewed native Codex Agent entry before acceptance. The released plugin does not guess that an existing runtime entry is plugin-owned.

## Verification

1. Reconcile the profile and validate the ownership manifest.
2. Confirm `config.toml` is `0600` and unknown config/roles remain present.
3. Restart only the target Codex app-server boundary.
4. Confirm the Gateway child process opens files below the target `<agentDir>/codex-home`.
5. Exercise Sol-to-Terra, Sol-to-Luna, and Sol-to-Sol delegation.
6. Exercise `fork_turns="none"`, a finite fork, sequential follow-up, bounded parallel children, terminal cleanup, and recursive-child rejection.
7. Verify the root owns every OpenMAI dynamic-tool call and every Lark write.
8. Keep `lark_reader` unroutable unless binary, identity, guidance, permission, and one read-only lookup all pass without recording secrets.
9. Verify another Agent and a default OpenClaw instance remain usable and do not discover the OpenMAI roles.
10. Query Langfuse APIs and verify root LLM → spawn tool → child observation → child LLM → child tool, including stable `parentObservationId` values and expected Sol/Terra/Luna models.

## Rollback

Use the OpenMAI profile removal/recovery path. It removes only manifest-owned, marker-bearing, still-matching fields/files and the delimited workspace block. It never removes the entire `config.toml` or `agents/` directory. Contested or unowned values remain for operator review.

After rollback, restart only the target Codex app-server boundary and verify unrelated Codex state and other Agents are unchanged.
