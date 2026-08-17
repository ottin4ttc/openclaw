# Implementation evidence

## Corrected runtime contract

| Surface                  | Evidence                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| OpenClaw build           | `2026.7.1`, `343f31e19cca0704887e434fa31b3dd64c50b037`                                                           |
| Codex app-server default | `extensions/codex/src/app-server/config.ts` resolves omitted `homeScope` to `agent`                              |
| Agent-home resolution    | `extensions/codex/src/app-server/auth-bridge.ts` resolves `<agentDir>/codex-home` and exports it as `CODEX_HOME` |
| ACP Agent schema         | `src/config/zod-schema.agent-runtime.ts` is strict and accepts only `agent`, `backend`, `mode`, and `cwd`        |
| sibling Codex            | `CODEX_HOME` is the configuration root; configured `agents/*.toml` are loaded from its config layer              |

Live redacted evidence on 2026-08-11:

```text
OpenClaw 2026.7.1 (343f31e)
gateway PID 4996 -> codex-0.147.0 app-server --listen stdio:// PID 40017
PID 40017 has <agentDir>/codex-home/logs_2.sqlite, -wal, and -shm open
config.toml mode: 0600
auth.json mode: 0600 (contents not read)
```

## Removed duplicate direction

The experimental ACP `agentDir` ensure context, ACPX selector/env mapping,
session-key ownership change, and shared-home fallback were removed. OpenMAI
routing uses only the existing native Codex app-server `homeScope = "agent"`
path. It adds no ACP backend option, OpenMAI OpenClaw config key, OAuth copying,
or OpenMAI policy to OpenClaw core.

## OpenMAI implementation evidence

This capability intentionally has a cross-repository owner boundary: the
OpenClaw worktree contains the contract, operator guide, and Codex runtime
integration, while OpenMAI-owned provisioning remains in the sibling
`openmai/openclaw-plugin` repository. The implementation under review is the
sibling HEAD `6b808371102625765cd7a8fcb5a5fb64090b13d3` plus its uncommitted
working-tree diff; its owned files are `src/codex-role-profile.ts`, `src/agent-manager.ts`,
`src/model-management.ts`, `index.ts`, and their focused tests/types. This
OpenClaw change is therefore not independently landable as a single-repository
OpenMAI implementation; the sibling review and deployment acceptance are
separate required gates.

The OpenMAI plugin now:

- preserves an existing Agent runtime instead of forcing ACP/ACPX;
- performs a bounded semantic merge into the native per-Agent `codex-home`;
- owns only marked, still-matching config paths and role files;
- preserves `auth.json`, SQLite/WAL/SHM, sessions, logs, skills, caches, rollout traces, unknown config, and unknown roles;
- rolls back only unchanged promoted bytes; a missing manifest deletes no managed profile data, while an invalid manifest returns a visible repair-required error;
- serializes create/delete by normalized Agent id before filesystem provisioning, so a losing duplicate create cannot remove the winning Agent's files;
- serializes the HTTP create/credential/rollback/delete lifecycle by normalized Agent id, so deletion cannot race ahead of credential persistence;
- removes delegation credentials and invalidates JWT state before profile/entry deletion, so delegation cleanup failure retains the complete Agent/profile retry anchor;
- retains the Agent entry and exact custom paths until ownership-managed profile cleanup succeeds, including when an invalid manifest blocks cleanup;
- rolls back a new Agent/profile after delegation-credential failure and removes delegation credentials/JWT state on a failed deletion attempt without changing Codex authentication.

The role contract is locked as:

| Role              | Model           | Effort   |
| ----------------- | --------------- | -------- |
| `talent_analyst`  | `gpt-5.6-terra` | `high`   |
| `lark_reader`     | `gpt-5.6-terra` | `medium` |
| `draft_writer`    | `gpt-5.6-luna`  | `low`    |
| `result_verifier` | `gpt-5.6-sol`   | `high`   |

Role files omit `model_provider`, `service_tier`, and `developer_instructions`. The generated workspace block keeps routing and final integration in the Sol root, permits no more than four active children under the five-thread root-plus-children session cap, enforces depth one and child cleanup, and reports unavailable Terra/Luna lanes visibly.

The `lark_reader` readiness probe is exactly:

```text
lark-cli wiki +space-list --as user --page-size 1 --format json
```

Routing is enabled only for exit code zero with JSON `ok=true`, array `data.spaces`, and numeric `meta.count`; resource fields are discarded. Binary, identity, permission, exit-code, or response-shape failure is fail-closed without bot fallback. `skills/INSTALL.md` records the matching `openmai_internal_api_call` and `lark-cli` tool, identity, response, and Claude-runtime compatibility contracts.

Fresh commands on 2026-08-11:

```text
npm run build
node --test dist/src/codex-role-profile.test.js dist/src/agent-manager.test.js dist/src/index.test.js dist/src/model-management.test.js
git diff --check
```

Result: TypeScript build passed; 58 tests passed, 0 failed; diff whitespace
check passed. The focused suite includes duplicate-create preservation,
create/credential/delete serialization, standalone credential-update/delete
serialization, delegation-cleanup retry before Agent-entry deletion,
invalid-manifest fail-safe behavior, and retry using retained custom Agent paths
after profile-cleanup failure.

## Verification status

Static OpenClaw runtime-contract proof, OpenMAI role/tool contract comparison,
build, and focused tests are complete for the plugin changes described above. Fresh autoreview found and drove fixes
for duplicate-create filesystem rollback, delete retryability, custom-path
retention, credential writes racing deletion, and Agent-entry deletion preceding
a failed delegation-credential cleanup. The final scoped autoreview command was:

```text
.agents/skills/autoreview/scripts/autoreview --mode local --stream-engine-output --prompt <OpenMAI role-routing and lifecycle scope>
```

It completed with `autoreview clean: no accepted/actionable findings reported`
and `patch is correct (0.78)`. A separate review claim that
OpenClaw 2026.7.1 exposes only the deprecated
`loadConfig`/`writeConfigFile` methods was rejected against the exact supported
host source: `src/plugins/runtime/types-core.ts` declares `current` and
`mutateConfigFile`, `src/plugins/runtime/runtime-config.ts` returns both from
`createRuntimeConfig()`, and `src/plugins/registry.ts` forwards both through the
plugin-scoped runtime. Deployment smoke, live model routing, rollback/reapply,
and Langfuse acceptance remain pending and SHALL NOT be claimed until fresh
runtime and API evidence is recorded. The final acceptance now also requires the native Codex/Langfuse hierarchy and ordering proof.

The current target Agent entry has no runtime override and points to its own
workspace and Agent directory. The running OpenClaw 2026.7.1 Gateway has a
bundled Codex app-server child, and the target `<agentDir>/codex-home` contains
the installed four-role catalog. Fresh natural-prompt routing acceptance is
still pending the plugin redeploy and Langfuse API proof below.

## Natural-business delegation gap found on 2026-08-15

Langfuse trace `2a97e6360376f1028e0cf0633878c0b1` is negative evidence from
Agent `openmai-u1861319839285792768`. The natural request supplied one candidate
and asked for recently active jobs with interview progress. The OpenMAI route
was detected, the root loaded candidate data, performed job search, Pipeline
intersection, and job-detail calls, compared four detailed jobs, and returned a
ranked two-job recommendation. The trace nevertheless contained sixteen root
generations and fifteen root tool spans but zero
`tool:collaboration.spawn_agent` spans, zero `native-child:*` observations, and
`nativeChildLineage.status = unsupported` with `childCount = 0`.

This is not a Langfuse child-loss case: Codex never requested a child. Sibling
Codex source shows ordinary non-ultra sessions use explicit-request-only
multi-agent mode, and its `spawn_agent` guidance requires the user or applicable
AGENTS/skill instructions to explicitly authorize spawning. The existing
OpenMAI profile described role capabilities but did not define a complex-match
trigger.

The minimal plugin correction adds a conditional candidate-match instruction:
after root-owned live reads, two or more comparison jobs require one bounded
`talent_analyst` spawn; a final multi-job ranking additionally requires one
`result_verifier` spawn; simple/single-job requests do not spawn for trace shape.
The focused candidate-routing test first failed on the missing instruction and
then passed all 38 cases after the correction. Deployment and a fresh natural
Langfuse API trace remain required before acceptance.

## Automatic delegation succeeded but final delivery duplicated

Fresh trace `87a31c49ccc31a4fed9f8b1de5b1416d` closes the routing gap but is
still negative acceptance evidence. The natural request did not mention delegation,
roles, models, or child agents. The root automatically spawned `talent_analyst` on
Terra and `result_verifier` on Sol with `fork_turns = "none"`; both child results were
consumed through native `wait_agent`, and root `llm-call-23` produced the full business
report.

OpenClaw then injected the already-consumed verifier result again as an internal task
completion. `llm-call-24` emitted only a one-line supplement and replaced the caller and
trace output. This is a duplicate native-child delivery defect, not a routing, model,
business-API, or Langfuse-ingestion failure. Final acceptance now requires exactly one
complete root reply. Because native child turns are asynchronous actors, observability
uses one root trace plus one independent trace per child turn under the same Langfuse
session, linked by reciprocal root/spawn/child ids rather than cross-trace
`parentObservationId`.
