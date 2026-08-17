## Context

OpenClaw 2026.7.1's bundled native Codex app-server runtime already launches each configured Agent with `CODEX_HOME = <agentDir>/codex-home`. OpenMAI role routing uses this native runtime boundary. ACP/ACPX are outside this capability and are not modified by it.

The target Codex home contains real authentication, configuration, SQLite state, sessions, logs, skills, caches, and rollout traces. Profile lifecycle code must treat it as an existing external-tool home, not as a replaceable generated directory.

## Goals / Non-Goals

**Goals:**

- Use OpenClaw 2026.7.1's existing per-Agent Codex home at native process launch.
- Install the four OpenMAI roles without destroying or hiding existing Codex configuration or role files.
- Make ownership, reconcile, rollback, crash recovery, and deletion safe and testable.
- Preserve config mode `0600` and leave Codex authentication/runtime databases untouched.
- Keep role selection and sensitive-tool policy in the Agent workspace.
- Make optional OpenMAI delegation credentials transactional with Agent creation/deletion.

**Non-Goals:**

- Adding `runtime.acp.backendOptions` or an OpenMAI-specific OpenClaw config key.
- Forcing `runtime.type = "acp"` or choosing an ACP backend for an OpenMAI Agent.
- Reading or changing global `~/.codex`, ACPX state, or another Agent's native home.
- Creating, copying, deleting, or rotating Codex `auth.json` or OAuth state.
- Giving children OpenMAI dynamic tools or Lark write authority.
- Implementing Langfuse native-child lineage in this change.

## Decisions

### 1. Use the native Agent-local Codex home

The supported OpenClaw runtime shape is:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: { homeScope: "agent" },
        },
      },
    },
  },
}
```

`homeScope = "agent"` is the native app-server default. OpenClaw resolves the configured Agent directory and launches its bundled Codex app-server with `<agentDir>/codex-home`. OpenMAI installs the same approved four-role catalog into each OpenMAI Agent's existing home. It does not add another home selector, wrapper, fallback, or ACP session field. ACPX is not an alternate provisioning path for this capability.

OpenMAI controls one shared role catalog: every OpenMAI Agent receives the same four declarations and role-file contents in its own Codex home. The Agent directory, not the role policy, is the isolation boundary.

Alternative considered: route the native OpenMAI path through ACPX and add an ACPX Codex-home selector. Rejected because OpenClaw 2026.7.1 already owns the required Agent-scoped home in its native Codex runtime and the extra path duplicates that behavior. Existing explicitly configured ACPX sessions are preserved as-is rather than migrated by this change.

### 2. Merge a bounded profile and preserve unmanaged content

The desired profile adds only:

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

The merge contract is conservative:

- absent approved fields are created and recorded as OpenMAI-owned;
- an existing field with the exact approved value is accepted but remains unowned;
- an existing conflicting value causes preparation to fail before promotion;
- unknown top-level fields, provider tables, feature fields, Agent declarations, and role files are preserved;
- `agents.max_threads` remains unsupported and is never introduced;
- writes use an atomic sibling temporary file and finish with `config.toml` mode `0600`.

The role files contain only model and reasoning settings plus an OpenMAI ownership comment:

```toml
# managed-by: openmai-codex-role-routing/v1
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
```

Equivalent files are created for Terra/medium, Luna/low, and Sol/high. They omit `model_provider`, `service_tier`, and `developer_instructions`.

### 3. Persist narrow ownership metadata

`<agentDir>/codex-home/.openmai-role-profile.toml` is a non-secret configuration ownership manifest. It records only:

- profile version;
- config paths created by OpenMAI;
- role filenames created by OpenMAI;
- hashes of the approved values written by that profile.

It never records credentials, provider tokens, arbitrary TOML, absolute paths, prompts, or user data. If a required approved value already existed, it is validated but not listed as owned.

Deletion removes a config field only when the manifest owns it and its current value still matches the approved value. It removes a role file only when the manifest owns it, the file contains the ownership marker, and its content still matches the approved template. A changed or unowned value is retained and reported for reconcile instead of being deleted.

If the manifest is absent, cleanup may remove the separately delimited OpenMAI block from workspace `AGENTS.md`, but it does not delete `config.toml`, `agents/`, or any role file. If the manifest is invalid or uses an unknown version, cleanup removes only that delimited workspace block, clears transient transaction artifacts, and then returns a visible repair-required error. Agent deletion retains the Agent entry and exact paths for retry; the route layer still removes the separate OpenMAI delegation credential and invalidates JWT state.

Alternative considered: infer ownership from filenames. Rejected because a user may already own a same-named role.

### 4. Scope staging, rollback, and crash recovery to touched artifacts

Preparation stages the target config, four role files, manifest, and workspace guidance. Before promotion it records a journal with original bytes and modes for only those artifacts. Promotion replaces only `config.toml`, the four named role files, the ownership manifest, and the delimited workspace block.

Rollback restores only artifacts whose promoted bytes still match the journal. Concurrent or later user changes are never overwritten. A recovery journal is finalized when the promoted profile validates; otherwise it restores the last valid touched artifacts. Unknown files created during the transaction are never removed.

After successful finalization, the transient journal/backup is removed and the permanent ownership manifest remains.

### 5. Keep the workspace as routing authority

The workspace block remains delimited by:

```text
<!-- OPENMAI:CODEX-ROUTING:START -->
<!-- OPENMAI:CODEX-ROUTING:END -->
```

It states that the root owns final integration, every `openmai_internal_api_call`, all Lark writes, high-risk confirmation, bounded child inputs, finite forks, depth-one delegation, child cleanup, and visible specialist failure. Removal edits only this delimited block.

### 6. Require delegation only after a real multi-job comparison exists

Codex ordinary reasoning defaults to explicit-request-only native delegation. Merely declaring role descriptions does not require the root to use them. The OpenMAI candidate-match hook therefore explicitly authorizes native delegation for the one business boundary that benefits from independent work:

- the root performs candidate, job search, Pipeline, and detail API calls;
- when at least two distinct jobs enter fit comparison, the root delegates one bounded comparison to `talent_analyst`;
- when the final response ranks or recommends at least two jobs, the root delegates one independent check to `result_verifier` before answering;
- both children use `fork_turns = "none"` and receive bounded redacted facts plus stable ids;
- single-job lookup, fewer than two comparison jobs, career-direction-only analysis, and no-ranking answers do not spawn for form's sake.

These required analysis and verification children are joined dependencies: the root
waits for their mailbox results before its single final recommendation. Other explicitly
non-blocking native children may be detached. Both modes keep independent child-turn
traces and never change topology based on completion timing.

This policy lives in the OpenMAI plugin's candidate-match prompt hook. It does not add an OpenClaw core policy, a Langfuse-triggered runtime decision, a new config surface, or a telemetry state machine.

Alternative considered: spawn for every candidate-related request. Rejected because it adds latency and cost to simple reads without improving the answer.

### 7. Make OpenMAI delegation credentials transactional

Codex authentication is out of scope. The OpenMAI delegation token stored by `CredentialManager` is a separate plugin credential.

- Lifecycle operations for one normalized Agent id are serialized across Agent/profile creation, delegation-token persistence or rollback, profile deletion, and credential/JWT cleanup.
- Create: if a newly created Agent succeeds but delegation-token persistence fails, delete the new Agent/profile and remove any partial credential before returning failure.
- Delete: remove delegation credentials and invalidate JWT state before asking `AgentManager` to remove the owned profile and Agent entry. A delegation-cleanup failure therefore retains the complete Agent/profile retry anchor. `AgentManager` removes the owned profile before deleting the Agent entry, so a profile failure, including an invalid ownership manifest, also retains the entry and exact paths; a later delete retries through the same lifecycle boundary.
- Existing Agent conflicts do not replace credentials.

## Risks / Trade-offs

- [TOML serialization can change formatting] → Preserve all parsed unknown values, constrain the changed semantic paths, use atomic replacement, and prove rollback from original bytes. A future comment-preserving editor may improve formatting without changing this ownership contract.
- [A user edits an OpenMAI-owned field] → Treat the mismatch as relinquished/contested ownership and retain it during deletion.
- [A same-named role already exists] → Accept only the exact approved declaration/file as unowned; otherwise fail before promotion.
- [A pre-release target still has a forced ACP runtime] → Restore that specific Agent entry from an operator-reviewed backup; do not add a heuristic runtime migration to plugin code.
- [Terra or Luna is unavailable] → Fail the specialist lane visibly while keeping the Sol parent usable; never silently relabel a model.
- [The read-only Lark lane has unexpected identity or permissions] → Keep it unroutable until a no-secret live read probe succeeds.

## Migration Plan

1. Back up the target Agent entry, workspace `AGENTS.md`, `config.toml`, ownership manifest if present, and only the four same-named role files. Do not copy `auth.json`, SQLite, sessions, logs, or the entire Codex home.
2. Remove the experimental ACP `agentDir`, ACPX selector/env mapping, session-key ownership, and shared-home fallback changes; retain native Codex home selection.
3. Update OpenMAI profile tests to prove unknown config, unknown roles, auth, SQLite, sessions, permissions, and concurrent changes survive install, rollback, reconcile, and deletion.
4. Implement the bounded merge, ownership manifest, atomic writes, targeted journal recovery, and safe deletion.
5. Remove `withAgentScopedCodexRuntime()` and preserve existing runtime entries on reconcile/update.
6. Add Agent/credential transaction tests and implement rollback/finally cleanup.
7. Restore the target test Agent from the backed-up pre-release ACPX override so it selects the native Codex harness.
8. Reconcile the target profile, restart only its native Codex app-server boundary, and verify the process opens `<agentDir>/codex-home`.
9. Exercise Sol-to-Terra, Sol-to-Luna, Sol-to-Sol, bounded parallelism, sequential follow-up, recursive-child rejection, parent-owned OpenMAI data, Lark-read gating, and one natural multi-job match that does not mention delegation but triggers `talent_analyst` and `result_verifier`.
10. Roll back through the ownership manifest and verify unrelated files, another Agent, and the default OpenClaw instance remain usable.
