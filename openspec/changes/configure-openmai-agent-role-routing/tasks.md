## 1. Runtime Contract Evidence and Scope Correction

- [x] 1.1 Verify OpenClaw 2026.7.1 Codex app-server defaults `homeScope` to `agent`, resolves `<agentDir>/codex-home`, and sets `CODEX_HOME` for local stdio launches.
- [x] 1.2 Verify the 2026.7.1 strict ACP Agent schema accepts only `agent`, `backend`, `mode`, and `cwd`, so `runtime.acp.backendOptions.codexHomeScope` is not a supported config surface.
- [x] 1.3 Verify the live target Codex app-server is a Gateway child and has the target Agent's `codex-home` SQLite runtime open without reading credential contents.
- [x] 1.4 Remove the experimental ACP `agentDir`, ACPX selector/env mapping, session-key ownership, and shared-home fallback changes.
- [x] 1.5 Update this proposal, design, spec, tasks, evidence, and operator guide to use only the native Agent-local Codex home.

## 2. OpenMAI Non-Destructive Profile Tests

- [x] 2.1 Add tests proving install preserves provider/model config, unknown features, unknown Agent declarations, unknown role files, `auth.json`, SQLite/WAL/SHM, sessions, logs, skills, caches, and rollout traces.
- [x] 2.2 Add tests for absent approved values, exact pre-existing unowned values, conflicting values, same-named unowned role files, ownership manifest validation, and `config.toml` mode `0600`.
- [x] 2.3 Add tests proving rollback and crash recovery touch only promoted artifacts and do not overwrite a concurrently edited config or role file.
- [x] 2.4 Add tests proving deletion removes only still-matching owned fields/files, retains contested or unowned content, never deletes the complete `config.toml`/`agents/`, and returns a visible repair-required error for an invalid ownership manifest without deleting managed profile data.
- [x] 2.5 Add tests proving two Agent homes remain isolated and independently reconcilable.

## 3. OpenMAI Profile Implementation

- [x] 3.1 Replace whole-file/whole-directory promotion with a bounded semantic merge, four named role-file writes, an ownership manifest, atomic config writes, and mode `0600`.
- [x] 3.2 Scope the recovery journal and backups to touched artifacts; restore only promoted bytes that still match the journal.
- [x] 3.3 Make validation accept preserved unknown config and role files while strictly validating the approved OpenMAI paths and marked role templates.
- [x] 3.4 Make removal delete only manifest-owned, marker-bearing, still-matching fields/files and the delimited workspace guidance.
- [x] 3.5 Remove `withAgentScopedCodexRuntime()`, every `backendOptions.codexHomeScope` reference, and the unsupported field from the OpenMAI SDK type shim; preserve existing runtime entries during reconcile/update.

## 4. Agent and Delegation-Credential Transactions

- [x] 4.1 Add route-level tests proving a delegation-token write failure rolls back a newly created Agent/profile and partial credential.
- [x] 4.2 Add route-level tests proving lifecycle serialization prevents credential writes after deletion, delegation cleanup failure retains the Agent entry, and credential/JWT cleanup still runs while a failed profile deletion, including an invalid ownership manifest, retains the Agent entry and exact paths for retry.
- [x] 4.3 Implement create rollback, delegation-cleanup-first and profile-first retryable deletion, and credential/JWT cleanup without changing Codex authentication behavior.

## 5. Routing Policy and Static Verification

- [x] 5.1 Verify the four role mappings are Terra/high, Terra/medium, Luna/low, and Sol/high and omit `model_provider`, `service_tier`, and `developer_instructions`.
- [x] 5.2 Verify workspace guidance retains root-only routing authority, bounded OpenMAI facts, parent-owned Lark writes, finite forks, depth one, child cleanup, and visible specialist failure.
- [x] 5.3 Compare the OpenMAI plugin and skill roots for tool names, required binaries, identity rules, response contracts, and relevant schemas; align them or record compatibility evidence.
- [x] 5.4 Build and run focused OpenMAI tests, formatting/static checks, and a fresh review with no accepted actionable findings.
- [x] 5.5 Record the natural candidate-match trace where the route and business APIs succeeded but Codex never called `spawn_agent`; distinguish a routing-policy gap from a Langfuse projection gap.
- [ ] 5.6 Record the natural candidate-match trace where automatic Terra/Sol children
      succeeded but a duplicate internal completion overwrote the full root final; require
      exactly one visible final and root/child independent-trace API evidence on rerun.
- [x] 5.7 Add the minimal conditional route instruction and regression test: two or more comparison jobs require `talent_analyst`, a multi-job ranking requires `result_verifier`, and simple requests do not spawn for form's sake.

## 6. Target Deployment Acceptance and Rollback

- [ ] 6.1 Back up the target Agent entry, workspace guidance, `config.toml`, ownership manifest if present, and the four same-named role files without copying or changing Codex auth/runtime databases.
- [ ] 6.2 Restore the pre-release target Agent away from the forced ACPX runtime through the reviewed backup, then reconcile the OpenMAI profile.
- [ ] 6.3 Restart the target native Codex app-server boundary and prove it uses `<agentDir>/codex-home` while another Agent/default instance remains usable.
- [ ] 6.4 Run Sol-to-Terra, Sol-to-Luna, and Sol-to-Sol; exercise no-history and finite forks, sequential follow-up, bounded parallel children, terminal cleanup, and recursive-child rejection.
- [ ] 6.5 Run a parent-mediated OpenMAI read scenario and the no-secret `lark_reader` readiness probe; retain `lark_reader` only if every identity/permission/read gate passes.
- [ ] 6.6 Prove missing Terra/Luna fails visibly while the Sol parent remains usable.
- [ ] 6.7 Exercise ownership-based rollback and reapply; prove unknown Codex state, another Agent, and the default OpenClaw instance are unchanged.

## 7. Observability Handoff

- [ ] 7.1 Accept model routing only after a natural business prompt that does not name
      subagents, delegation, roles, or models returns one complete result after joining
      the required analysis and verification children. Langfuse APIs must show one root
      trace plus linked child-turn traces under the same session, reciprocal spawn/trace
      ids, expected role models, trace-local `llm-call-N` numbering, and no cross-trace
      `parentObservationId`. Explicitly detached children may settle later without changing
      actor-turn trace topology or reopening the completed root trace.
