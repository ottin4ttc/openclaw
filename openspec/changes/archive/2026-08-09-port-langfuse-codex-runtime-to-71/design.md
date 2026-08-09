## Context

`v2026.7.1-2` still owns sessions in JSON/JSONL files and exposes the Codex app-server lifecycle through public plugin hooks. The current Langfuse work was developed against newer mainline APIs, so the port must adapt its session and diagnostics boundary without importing the later SQLite/session implementation. See `proposal.md` and the capability specs for the externally observable contract.

## Goals / Non-Goals

**Goals:**

- Keep all Langfuse-specific tracing, prompt management, redaction, recovery, lifecycle, and delivery state inside the independent `openclaw-langfuse` extension.
- Use the 7.1 public plugin SDK and Codex lifecycle hooks to correlate turns, model calls, and tools.
- Match the 7.2 provider-request observation structure: every concrete provider request owns one stable, real-time Langfuse generation and the tools it triggered.
- Put any 7.1 file-backed session compatibility in a small plugin-local adapter with no schema or core persistence changes.
- Preserve host behavior when Langfuse is unavailable, misconfigured, or being shut down.
- Make package metadata, dependency ownership, docs, and focused tests prove independent installation on the 7.1 host.
- Preserve plugin skill discovery and relative skill assets in Codex sandboxes without making plugin authors manage sandbox-specific copies or paths.

**Non-Goals:**

- Porting the 7.2 beta SQLite session/accessor/migration work.
- Adding a new session database, schema version, JSON sidecar, or core Langfuse integration.
- Replacing or forking the Codex app-server protocol or copying private Codex implementation details into the plugin.
- Adding a core seam before a focused hook-contract test proves the required event is unreachable.
- Mounting the full host state directory, manually duplicating plugin skills into generated discovery directories, or teaching the Codex plugin user-specific host paths.

## Decisions

1. **Plugin-first ownership.** The extension owns Langfuse SDK dependencies, initialization, configuration, redaction, observation mapping, recovery, flush/shutdown, diagnostics, and delivery status. This preserves the host's plugin-agnostic core and keeps the diff close to the stable 7.1 branch.

2. **Public Codex hooks before core edits.** Map `before_agent_run`, `llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, and `agent_end` into a per-turn observation state. Those hooks provide aggregate turn telemetry but not exact provider-request facts. The Codex extension therefore owns one narrow seam: opt-in rollout-trace startup, an active-turn polling monitor, and a bounded final drain that publishes provider-request and rollout tool lifecycle diagnostics before aggregate terminal hooks. Port the 7.2 event-projector reconciliation that suppresses native tool diagnostics only after the equivalent rollout tool lifecycle has been delivered. Provider observability requires no `src/**` core change; a separate generic plugin-SDK harness helper is permitted for sandbox skill path projection so the extension does not import core internals.

3. **Provider-request identity is the generation identity.** Codex creates a unique `inference_call_id` after each concrete provider request is built. The Codex extension orders those calls by rollout source sequence and publishes a stable `providerRequestIndex`. The Langfuse plugin preserves the invariant `inference_call_id -> providerRequestIndex -> exactly one llm-call-N`: a started diagnostic creates or claims the generation immediately, and the matching terminal diagnostic updates the same observation with output, usage, end time, and failure data. Terminal-only events may synthesize the missing start, late starts may enrich the existing observation, and repeated delivery is idempotent; none of those cases may allocate a second generation.

4. **Aggregate hooks are fallback, not ownership.** Aggregate turn hooks may establish the trace and provide fallback data when provider-request diagnostics are unavailable. Once provider-request ownership exists, aggregate terminal events must not create or overwrite an additional generation. Tool observations use the provider generation active for their rollout lifecycle; final drain completes provider and tool delivery before aggregate terminal reconciliation and `agent_end`.

5. **Local 7.1 session adapter.** The plugin adapts the 7.1 file-backed session resolver/store reader to the newer plugin behavior. It reads existing JSON/JSONL records, derives the requested transcript/session key, and never writes or migrates session state. This avoids a compatibility layer for APIs that do not exist on the baseline.

6. **Failure isolation and lifecycle flushing.** Observation and export errors are converted into bounded plugin diagnostics. Host agent execution remains successful or fails according to its own runtime result. Long-lived processes use the Langfuse batch lifecycle; shutdown/flush paths explicitly drain pending work where the 7.1 host allows it.

7. **Dependency and package boundary.** Langfuse runtime packages remain plugin-owned and are represented in the extension package metadata and lock/shrinkwrap. Root dependencies are retained only when the 7.1 bundling/runtime test proves the host package manager requires them; otherwise the root entry is removed.

8. **Evidence-driven Codex runtime decision.** The sibling `../codex` source is checked directly for the app-server protocol/runtime contract. App-server v2 exposes aggregate turn state, while rollout trace assigns a unique `inference_call_id` to each concrete provider attempt and records its request, response, usage, failure, or cancellation exactly once. The exact `@openai/codex@0.144.3` Darwin ARM64 package was also inspected: its binary contains `CODEX_ROLLOUT_TRACE_ROOT`, `trace.jsonl`, `inference_started`, `inference_completed`, `inference_failed`, and `inference_cancelled` support. The 7.2 OpenClaw implementation is the structural reference; the port adapts only the APIs that differ on 7.1 instead of inventing a separate observation model.

9. **Sandbox-readable skill locations.** Plugin skill source remains in each plugin's declared `skills` directory. OpenClaw may publish generated host symlinks under `plugin-skills` for discovery, but a sandboxed Codex harness must rebuild `<available_skills>` from the materialized sandbox workspace and rewrite every location to `/workspace/.openclaw/sandbox-skills/skills/...`. Reuse the embedded runner's existing materialization and path-mapping rules through one generic agent-harness SDK helper; do not mount the entire host state directory or teach the plugin about user-specific paths.

10. **Fail closed in sandboxes; preserve non-sandbox compatibility.** A non-sandboxed harness keeps the existing snapshot prompt byte-for-byte. A sandboxed harness always discards the host-path snapshot, reloads workspace-only entries from the materialized skills root with the sandbox eligibility context, and maps those entries to container paths. If materialization is missing or yields no eligible entries, omit the unavailable skill instead of restoring an unreadable host location.

11. **Deployed artifact is the acceptance boundary.** The Gateway loads `extensions/openclaw-langfuse/dist/index.js`, not the TypeScript source. A Langfuse behavior change therefore requires the package-local runtime build, a sentinel check against the generated `dist`, and a restart of only the isolated 19789 Gateway before live proof. The E2E client must use the same 7.1 checkout plus `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` for `~/.openclaw.20260701`; a globally installed or 7.2 CLI is not valid acceptance evidence. The package-local runtime build remains the fast deployment path; the separate formal DTS/package gate has now also passed.

### Sandbox skill path lifecycle and root cause

The same plugin skill has three distinct path identities during one run:

1. **Plugin source:** the plugin owns its declared `skills` directory and all relative assets such as `references/**`.
2. **Host discovery:** OpenClaw generates a host `plugin-skills/<name>` symlink so normal discovery can retain plugin identity and metadata. This directory is generated state, not an installation target for manual copies.
3. **Sandbox materialization:** the embedded runner copies the selected skill directory into its materialized skills workspace and mounts it at `/workspace/.openclaw/sandbox-skills/skills/<name>`.

The 7.1 Codex harness skipped stage 3 when building its prompt: `run-attempt.ts` injected the host `skillsSnapshot.prompt` directly. The model consequently tried `/home/sandbox/.openclaw.20260701/plugin-skills/...`, even though the readable file had already been materialized under `/workspace/.openclaw/sandbox-skills/skills/...`. The generic `resolveAgentHarnessSkillsPromptForRun` seam now reuses the embedded runner's input selection, eligibility filtering, workspace-only loading, and path mapping. The Codex extension consumes that SDK seam and injects the rebuilt catalog through the turn collaboration developer instructions; it does not duplicate the catalog in user input.

### End-to-end evidence and findings

| Scenario                           | Runtime evidence                                                                                                                                                                                                                                                                                                                                                                                                                              | Result               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Fresh sandbox turn                 | `company-job-search/SKILL.md` read from `/workspace/.openclaw/sandbox-skills/skills`; no initial missing-file event                                                                                                                                                                                                                                                                                                                           | Passed               |
| Same OpenClaw session, second turn | `ttc-my-talent/SKILL.md` read through two completed sandbox commands; 0 failures                                                                                                                                                                                                                                                                                                                                                              | Passed               |
| Same Codex thread, next turn       | `ttc-public-talent/SKILL.md` read with the preceding Codex thread id retained and a new turn id                                                                                                                                                                                                                                                                                                                                               | Passed               |
| Relative asset traversal           | `company-job-search/SKILL.md` and `references/crm-query-input-output.md` both read from the materialized skill directory                                                                                                                                                                                                                                                                                                                      | Passed               |
| Fresh real business flow           | Orchestrator skill listing completed, the skill plus both declared references were read, then `openmai_internal_api_call` completed; final turn status was `completed` with 0 tool failures                                                                                                                                                                                                                                                   | Passed               |
| Deployed artifact freshness        | The source contained `prior_conversation_projection` while the loaded `dist` did not; the package-local runtime build regenerated `dist` in 2.7 seconds, the sentinel appeared, and only 19789 was restarted                                                                                                                                                                                                                                  | Passed after rebuild |
| Two-turn deployed business flow    | Both turns used session `e414e7fe-85a3-4b8a-b490-d05a0e1a7b75`; run `ba47728f-9e5e-4d52-b4e0-4418812172ac` returned 9 real positions after 3 successful tool calls, and run `d3eda655-bc0b-44d7-a183-9983b899929b` reused the prior result and made 5 more successful tool calls                                                                                                                                                              | Passed               |
| Same Codex thread resume           | Both turns used thread `019fe4e6-98cb-74d0-bd20-b1538085c86e` with distinct turn ids and no dynamic-tool rotation                                                                                                                                                                                                                                                                                                                             | Passed               |
| Langfuse trace projection          | Second trace `c7c05801e2233dd854c91c328e9a892c` exported 8/8 prior rows with `prior_conversation_projection=value`; the union of row keys was only `role`, `content`, `tool_calls`, and `tool_call_id`                                                                                                                                                                                                                                        | Passed               |
| Langfuse observation fidelity      | Traces `a0611ed754849e7952a37683e0e6ea7e` and `c7c05801e2233dd854c91c328e9a892c` contained 4+6 generations and 3+5 tool spans; every observation had input/output/end time, every generation had model/usage, and every tool parent resolved to its triggering generation                                                                                                                                                                     | Passed               |
| Skill authority and API fidelity   | Trace `88ed42895fbdbbe78d0a73f9de85e3e6` returned an empty `skills.list(authority=orchestrator)` catalog, then read `company-job-search` and its reference from sandbox-materialized file locations and completed the real API call. Live Langfuse trace and observations APIs returned HTTP 200; all 13 observations had input/output/end time and every tool parent resolved, while the downloaded export omitted observation input/output. | Passed               |
| Formal DTS/package build           | The full `pnpm build` completed in 1439.0 seconds; `tsdown` accounted for 1422.5 seconds and the Plugin SDK export check passed 4/4. The slow phase was declaration generation rather than Gateway, TypeBox, or Langfuse runtime work.                                                                                                                                                                                                        | Passed               |
| Mandatory final review             | The final `autoreview` exited 0 with no accepted or actionable findings after the tool-only rollout-capture gate gained a focused regression; `run-attempt.hooks.test.ts` passed 26/26.                                                                                                                                                                                                                                                       | Passed               |

The Codex session record confirms all six OpenClaw plugin skill `<location>` values were present in `turn_context.collaboration_mode.settings.developer_instructions` as container paths. Raw rollout and session searches found no host `plugin-skills` or plugin-source path in that catalog, and the user message did not contain duplicated `<available_skills>` markup.

One turn intentionally rotated from the earlier Codex thread because the logged dynamic-tool catalog fingerprint changed; the following turns resumed the replacement thread successfully. Therefore thread-id continuity plus the explicit rotation reason is the acceptance signal. The aggregate `replayInvalid` result flag alone is not a reliable resume verdict.

The final acceptance rerun did not rotate: both turns retained one Codex thread while using separate turn ids. Its second Langfuse trace had a non-empty value projection with no `timestamp`, `provider`, `model`, `usage`, `stopReason`, `idempotencyKey`, `sourceChannel`, or `__openclaw` keys. This distinguishes semantic conversation history from persisted runtime envelopes and confirms that the deployed plugin, not merely the source helper, owns the observed result.

The stale-dist failure is a deployment lesson, not another tracing algorithm defect. Before the package-local rebuild, Langfuse faithfully reflected the old generated bundle even though source tests described the new projection. Future E2E work must prove a generated sentinel before restart and capture the post-restart plugin initialization log; otherwise a source/runtime mismatch can masquerade as a failed implementation.

Codex has two separate skill authorities. `skills.list` enumerates orchestrator-owned `mcp/skill` resources from the orchestrator provider; it does not enumerate file-backed skills injected into `<available_skills>`. OpenClaw plugin skills use the latter contract, so an empty orchestrator list is valid when no `codex_apps` MCP skill resource is registered. The model should read the sandbox-materialized `<location>` directly instead of using `skills.list` as a discovery prerequisite. Langfuse acceptance must likewise use the public observations API for observation details: the downloadable trace export can omit observation input/output even when the API records are complete.

Two adjacent findings are outside this fix's ownership. First, a restricted coding-agent shell cannot use the normal `openclaw agent` CLI against the host state database or loopback socket; E2E automation must use the approved Gateway WebSocket client rather than interpreting that local EPERM/readonly fallback as a product failure. Second, Codex still logs a non-fatal `AGENTS.md` discovery warning for a sandbox-escaped `/.git` path. Direct upstream inspection shows `codex-rs/core/src/agents_md.rs` walks project-root markers upward with `FindUpErrorPolicy::Propagate`; after reaching the container root it probes `/.git`, and the OpenClaw exec-server correctly rejects that path because it is outside `/workspace`. The caller logs and skips automatic project-doc discovery, while OpenClaw's explicit workspace instructions, sandbox skill reads, API execution, and final replies remain intact. Changing that independent Codex/filesystem-marker contract would broaden this port, so the warning is recorded as a follow-up rather than hidden by a permissive filesystem fallback.

### Producer-consumer evidence map

1. `../codex/codex-rs/rollout-trace/src/inference.rs` creates one UUID `inference_call_id` after each concrete request is built, reuses it for start and terminal records, and atomically permits only one terminal record.
2. `../codex/codex-rs/rollout-trace/src/raw_event.rs` persists that identity on inference events. Tool events expose a stable `tool_call_id` but no explicit inference identity.
3. `extensions/codex/src/app-server/rollout-trace-diagnostics.ts` orders raw events by rollout sequence, assigns the ordered `providerRequestIndex`, emits provider start/terminal diagnostics with the stable call ID, and emits tool lifecycle events in the same source order.
4. `src/infra/diagnostic-events.ts` dispatches the queued diagnostics in order. `extensions/openclaw-langfuse/src/diagnostics.ts` maps the call ID and provider index to exactly one `llm-call-N`, then parents each following rollout tool span to the latest preceding provider generation.
5. `extensions/codex/src/app-server/event-projector.ts` buffers equivalent native tool diagnostics until the rollout final drain reports phase-level coverage, drops covered phases, and replays only missing native fallback phases.

## Risks / Trade-offs

- **[Risk] 7.1 SDK payloads omit a field used by the newer plugin.** → Keep fields optional, preserve bounded metadata, and add only a narrow seam when a focused contract test proves the omission blocks a required scenario.
- **[Risk] File-backed session records are malformed or missing during recovery.** → Treat recovery as best-effort, return an actionable diagnostic, and keep normal tracing/export independent from recovery reads.
- **[Risk] Buffered export loses observations on abrupt process termination.** → Flush at explicit lifecycle boundaries and report delivery state; the host cannot guarantee delivery after an external hard kill.
- **[Risk] A root dependency accidentally makes the plugin non-independent.** → Run the independent runtime/package build test and inspect the dependency graph before finalizing package metadata.
- **[Risk] New code drifts toward 7.2 APIs.** → Typecheck against the 7.1 checkout, keep compatibility helpers local to the extension, and forbid SQLite/session schema changes in review and validation.
- **[Risk] Aggregate and provider-request paths race or deliver late.** → Key all provider lifecycle state by stable call identity, drain diagnostics before aggregate terminal hooks, and test late-start, terminal-only, duplicate, and cleanup paths.
- **[Risk] Native and rollout tool diagnostics both export the same execution.** → Reuse the 7.2 suppression ledger and suppress the native copy only after the rollout lifecycle key is confirmed delivered.
- **[Risk] A Codex sandbox prompt exposes host-only plugin skill paths.** → Rebuild the harness catalog from materialized skill entries, assert that host `plugin-skills` paths are absent, and live-read the projected `SKILL.md` inside the sandbox.
- **[Risk] Missing materialization silently restores the host snapshot.** → Fail closed with no skill entry and lock that behavior with a harness regression.
- **[Risk] A first-turn read passes but resume or relative assets fail.** → Test multiple plugin skills and referenced files across one OpenClaw session and one resumed Codex thread, then run a fresh real business-tool flow.

## Account-owned change inventory

- Retain the Langfuse portability/package work from `b8e3088d021` and the Langfuse/Codex per-call observability intent from `2aeb97a3b34`, but re-implement only their plugin and Codex-extension portions on the 7.1 contracts.
- Do not cherry-pick the broad session/upstream merge commits (`eb3deecac85`, `5bb1adb2143`) because they include the later SQLite session direction and unrelated mainline churn.
- Do not port `fd31d4e9cfb` (DeepSeek model configuration), `67ef223e83e` (workspace-wide source-build packaging), or the auth/provider portions of `11ffffb2d09`; they are outside the Langfuse/Codex runtime objective.
- Do not reapply `8f088da195c`: the 7.1 baseline already preserves sandbox write stdin through the current `python -c` pinned mutation path.

## Migration Plan

1. Verify the branch is based on `v2026.7.1-2`, inventory existing account commits, and capture the 7.1 versus 7.2 session-storage diff.
2. Port and adapt the independent Langfuse extension, package metadata, docs, and tests.
3. Port the 7.2 provider-request identity, live generation lifecycle, rollout tool parenting, final-drain ordering, and duplicate-suppression behavior through the 7.1 plugin boundaries.
4. Run focused plugin tests, 7.1 extension typecheck, package/runtime build checks, and Codex hook tests.
5. Verify a real multi-tool request on port 19789 through the Langfuse observations API, not only the UI or trace root.
6. Verify a sandboxed Codex turn can read and invoke a plugin skill without first failing on a host-only path.
7. Verify non-sandbox compatibility, missing-materialization fail-closed behavior, resumed-thread reads, relative references, and a real read-only OpenMAI tool invocation.
8. Roll back by removing the extension (and any explicitly justified additive seam); the host's session files and schema remain unchanged.

## Open Questions

The sandbox skill behavior, formal DTS-producing build, Plugin SDK export check, and mandatory final review are resolved. The non-fatal Codex `AGENTS.md` `/.git` sandbox warning remains a separate follow-up. Exact provider-request tracing is intentionally opt-in because Codex rollout bundles can contain prompts, responses, tool I/O, and local paths. Aggregate tracing remains available without content capture.
