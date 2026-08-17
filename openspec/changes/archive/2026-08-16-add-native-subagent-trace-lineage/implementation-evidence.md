# Implementation evidence

## Revisions and source boundary

| Component                    | Evidence                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| OpenClaw and Langfuse plugin | `2026.7.1`, base `343f31e19cca0704887e434fa31b3dd64c50b037` plus this worktree |
| Langfuse SDK                 | `3.38.6`                                                                       |
| sibling Codex                | `db887d03e1f907467e33271572dffb73bceecd6b`                                     |

The target runtime is the bundled Codex app-server harness. ACP, ACPX, the
Codex ACP adapter, and their dependency versions are not implementation
boundaries for this change.

Direct sibling Codex evidence:

- `codex-rs/app-server-protocol/src/protocol/event_mapping.rs` maps spawn and
  interaction start/end with stable parent/child thread, turn, call, model,
  reasoning, time, and status facts; `SubAgentActivity` adds stable activity
  event and child-thread identity.
- `codex-rs/rollout-trace/README.md` states that spawned children derive the
  parent trace context and share the root rollout bundle/writer.
- `codex-rs/rollout-trace/src/model/conversation.rs` records inference ownership
  by thread/turn and the tool calls started by that inference.
- `codex-rs/rollout-trace/src/raw_event.rs` shows that a raw tool lifecycle event
  does not itself carry inference-call identity, so provider parenting cannot be
  inferred from order.
- `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` normalizes the exact
  `spawn_agent.agent_type`, passes it to `thread_spawn_source`, and emits
  `SubAgentActivity(kind = started)` with the same originating spawn call id but no
  role field.
- `codex-rs/core/src/tools/handlers/multi_agents_common.rs` stores that same value as
  `ThreadSpawn.agent_role`; therefore joining `agent_type` to the v2 child through the
  stable spawn call id is contract-backed and does not infer role from task path.

OpenClaw's current owners are
`extensions/codex/src/app-server/native-subagent-monitor.ts` for native-child
topology/lifecycle and `rollout-trace-diagnostics.ts` for exact
`threadId + turnId` model/tool diagnostics. Langfuse already consumes the
trusted internal diagnostic bus.

## Corrected implementation direction

- No public `native_child_event` hook, dedicated Plugin SDK entrypoint, or
  hook-specific public event type. The existing internal diagnostic union has
  additive native-child variants for the already-supported plugin boundary.
- No ACP/ACPX capability, adapter, config, release, or dependency change.
- Versioned bounded `codex.native_child.lifecycle` and
  `codex.native_child.status` internal diagnostics.
- Child rollout drains reuse the shared bundle and exact child thread/turn,
  adding child ownership and the parent OpenClaw run/turn identity.
- The original implementation kept one session per conversation and nested each child
  beneath the root turn trace. Fresh live evidence below supersedes that topology:
  native `spawn_agent` is asynchronous, so the target model is one root trace per
  OpenClaw turn plus one deterministic trace per child turn, correlated through the
  shared session and reciprocal trace/spawn/thread/turn ids.
- A child tool uses a proven generation parent only when stable inference/tool
  evidence exists; otherwise it is attached to the proven child with
  `partial_parenting = true`.
- `complete`, `partial`, and `unsupported` affect observation evidence only and
  never OpenClaw or Codex execution.

## Verification status

Fresh narrow local fallback commands on 2026-08-14:

```text
node scripts/run-vitest.mjs extensions/codex/src/app-server/native-subagent-monitor.test.ts extensions/codex/src/app-server/rollout-trace-diagnostics.test.ts
node scripts/run-vitest.mjs extensions/openclaw-langfuse/src/native-child.test.ts extensions/openclaw-langfuse/src/diagnostics.test.ts extensions/openclaw-langfuse/src/tracer.test.ts
node scripts/run-vitest.mjs src/infra/diagnostic-events.test.ts
./node_modules/.bin/vitest run --config test/vitest/vitest.extensions.config.ts extensions/openclaw-langfuse/src/tracer.test.ts
node scripts/run-tsgo.mjs -p tsconfig.core.json
node scripts/run-tsgo.mjs -p tsconfig.extensions.json
```

Results for this worktree: Langfuse native-child/diagnostics tests passed
`86/86`, SDK delivery tests passed `37/37`, the full Langfuse tracer suite passed
`115/115`, Codex native-subagent/rollout diagnostics tests passed `56/56`, and
core diagnostic-event tests passed `34/34` (`328` tests total).
`git diff --check`, OpenSpec strict
validation, Oxfmt, Oxlint, and production core/extensions tsgo checks passed. The focused tests cover concurrent and persistent
children, exact child turn drains, one 500-millisecond parent-level wait across
all child drains, lifecycle admission during that window, inference-to-tool
linkage, ordered child call/status delivery, finalization-cursor rejection,
producer-health downgrade after late facts, unresolved observation-delivery
classification, monotonic partial downgrade, raw-tool partial parenting,
root-generation owner rejection, lifecycle privacy and 16 KiB
bounds, mutation/active-child/pending-join bounds, duplicate and late facts,
unknown versions, fail-open monitor phases, parent-only fallback, all three
lineage states, shutdown, service restart, and delivery failure isolation.

The latest numbering tests also prove that root display slots remain stable when
child generations arrive first: root calls use `llm-call-N`, and each child uses
`llm-call-N-M` with `M` restarting at one for every child. Child lifecycle and
model/tool facts that arrive before spawn ownership are held until the stable
spawn tool is known; they are not materialized under a guessed parent.

Blacksmith Testbox was attempted first but could not start because the selected
binary failed its basic `--version`/`--help` sanity checks. The commands above
are the explicitly reported narrow local fallback; no broad local gate is
claimed. Test-type checking is also not claimed because this 7.1 branch has
about 940 pre-existing test-type errors outside the touched production lanes.

Fresh autoreview first found two actionable P2 defects: native-child diagnostics
beyond the captured finalization cursor could still materialize observations,
and unresolved SDK observation delivery did not prevent provisional
`complete`. The fixes reject late facts without reopening the trace, mark the
producer unhealthy for subsequent turns, and classify unresolved delivery as
partial. The post-fix fresh autoreview reported no accepted/actionable findings
(`patch is correct`, confidence `0.82`). Native child-agent review attempts also
returned `401 Unauthorized` from the configured child credential; that failed
path is not counted as review evidence. The old ACP/ACPX/public-hook totals
remain excluded.

## Historical deployed Langfuse evidence (not current acceptance)

An earlier local OpenClaw 2026.7.1 probe used the packaged artifact
`/tmp/openclaw-langfuse-package/openclaw-openclaw-langfuse-2026.7.1.tgz` and
agent `openmai-u1861319839285792768`. The gateway was started only for the
isolated probe and stopped afterward; no credential, OAuth, or runtime database
content was modified by the probe.

The Langfuse public trace API returned two traces for the explicit session
`agent:openmai-u1861319839285792768:openresponses:e2e-20260813-model-routing-1`:

- `20ef18fce7324b366ffca6a295ec28fc`: one turn with two native children;
- `8776bd2d190e2f26c7d1db9e587560a5`: a follow-up turn.

The observations API for the first trace returned 15 observations. It proved:

- root `llm-call-1` / `llm-call-2` / later root calls use `ClawOS/gpt-5.6-sol`;
- child A has `llm-call-1-1` with `ClawOS/gpt-5.6-luna`;
- child B has `llm-call-2-1` and `llm-call-2-2` with `ClawOS/gpt-5.6-terra`;
- each child generation's `parentObservationId` resolves to its deterministic
  `native-child:*` observation;
- each `native-child:*` observation's parent resolves to its corresponding
  `tool:collaboration.spawn_agent` span;
- all non-root `parentObservationId` values resolve within the same trace;
- the follow-up trace has the same `sessionId` and a distinct trace id.

This is historical baseline evidence that the native Codex app-server path can
expose multiple child models and a Langfuse tree. It is not acceptance evidence
for the current worktree or current artifact. A fresh API query is required to
prove the deterministic ordering contract after this change: `llm-call-N-M`
must derive from stable spawn ownership and child-local order rather than
delivery timing, including out-of-order diagnostics. ACPX is outside this
change and is not an alternate OpenMAI routing path.

The fresh local API probe on 2026-08-13 was blocked before authentication:
`langfuse.ttcadvisory.com` did not resolve from this environment. No current
Langfuse API acceptance is claimed.

The local target Agent at `18789` still has an old explicit ACPX runtime
override in its user configuration. It was not changed during this work, so it
is not evidence for the native 7.1 Agent-local Codex Home path. The current
`extensions/openclaw-langfuse/dist/index.js` is also not claimed as a reviewed
bundle: source tests pass, but a fresh production build/parity check is still
required before packaging that file.

At that point the deployment artifact/API acceptance tasks remained open. The
fresh deployed evidence below supersedes that earlier status.

## Current packaged local evidence

Trace `166207bf020979f7b58ad4a758681779` on local OpenClaw 2026.7.1 returned the
normal caller result `PARENT_READY｜CHILD_ROLE_READY` and proved the intended
root-generation → spawn-tool → child → child-generation hierarchy. Its API data also
proved Luna model selection, four request summaries, Responses Lite system-prompt
size/hash, `complete` lineage, and zero dropped events. It did not prove configured
role reporting: the child remained `native-child:candidate_conclusion` with no `role`,
despite the rollout `thread_started` payload recording `agent_role = draft_writer`.
At that point tasks 3.6 and 5.8 were reopened until stable-call-id enrichment and
late rename could be implemented and re-proven through the observations API. The
fresh acceptance evidence below closes that historical gap.

The same trace contains three `response_stream_disconnected` Luna generations followed
by a fourth successful generation. This is provider retry evidence, not Langfuse
ingestion or hierarchy failure; all four attempts are expected to remain observable.

## Fresh local acceptance evidence (2026-08-15)

The reviewed bundled artifact was installed with the OpenClaw 2026.7.1 npm-pack
path and the isolated gateway was restarted on `127.0.0.1:18789`. Preflight
reported OpenClaw and Gateway `2026.7.1`, the configured Codex app-server
`homeScope = "agent"`, Gateway readiness, and a single listener on port 18789.
The target Agent's existing `<agentDir>/codex-home` contains the four managed
role files: `talent_analyst = gpt-5.6-terra`, `draft_writer = gpt-5.6-luna`,
`result_verifier = gpt-5.6-sol`, and `lark_reader = gpt-5.6-terra`.

The explicit acceptance session was
`agent:openmai-u1861319839285792768:e2e-person-job-four-role-20260814-1`.
The Langfuse traces API returned four distinct traces for that one session:

| Trace                              | Result                                            | Evidence                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b55c8230144fe662c83425c31bf72389` | `partial` (negative evidence)                     | 82 observations; parent used one mailbox wait while other children were still active. Root output was later overwritten by a verifier completion. Partial reasons: `active_children_at_finalize`, `activity_after_terminal`, `partial_parenting`, `producer_unhealthy`. |
| `15cf9bad1590cd62343304644a8be53a` | `partial` (negative evidence)                     | 30 observations; serial child spawn was used, but a Lark child `exec_command` arrived after its wait and caused `partial_parenting`.                                                                                                                                    |
| `04fe89706bf636568a27f1a79e056bbe` | `complete` (passing complex turn)                 | 29 observations, 16 generations, 13 spans; normal full matching report; four children and zero partial reasons.                                                                                                                                                         |
| `5cf58140d85fd4ddf63ebf97529248f3` | `unsupported` (intentional parent-only follow-up) | No native child was requested; normal `FOLLOWUP_MATCH_OK` response. `prior_conversation_message_count = 54`, retained `29`.                                                                                                                                             |

The first trace is the business-runtime proof: observations include successful
OpenMAI job search/detail and private-talent API calls, with one documented
OpenMAI query-policy rejection; no provider or Langfuse failure was substituted
for that business result. The passing trace reuses the same verified facts and
returns a normal report with three real-but-uncertain jobs, match reasons, risks,
market-calibration limits, and no PII.

Trace `04fe89706bf636568a27f1a79e056bbe` proves through the observations API:

- root Codex runtime generations use `ClawOS/gpt-5.6-sol`;
- four stable `tool:collaboration.spawn_agent` spans carry exact
  `agent_type`, `task_name`, and `fork_turns = "none"`;
- child observations are `native-child:talent_analyst`,
  `native-child:draft_writer`, `native-child:result_verifier`, and
  `native-child:lark_reader`, with paths kept separate from roles;
- child models are Terra, Luna, Sol, Terra respectively;
- child generations are `llm-call-1-1`, `llm-call-3-1`, `llm-call-6-1`, and
  `llm-call-8-1`; each has the corresponding child observation as
  `parentObservationId`, and each child observation has its spawn span as parent;
- every child request has one user task message under `fork_turns = "none"`,
  while its own system/developer context is summarized as
  `systemPromptSource = input_messages`, `systemPromptChars = 31,383`, and a
  bounded hash; raw system prompt and parent history are not copied into child
  lifecycle metadata;
- all admitted parent ids resolve within the same trace, and
  `nativeChildLineage.status = complete` with authoritative start/terminal,
  provider-call ownership, tool-call ownership, zero dropped events, and zero
  partial reasons.

The final follow-up response proves the same OpenClaw session can continue across
turns: its `sessionId` matches the complex trace while its trace id is distinct,
and the trace metadata retains prior conversation (`54` messages, `29` retained).
The two earlier partial traces are retained as regression evidence, not promoted
to passing acceptance. They demonstrate why the final acceptance requires an
explicit post-child drain and API verification rather than trusting the last
visible response or UI ordering.

### Natural request with no child request

Trace `2a97e6360376f1028e0cf0633878c0b1` is a separate negative routing
example. Its candidate-match business calls and final ranked response succeeded,
but the observations API contains no `tool:collaboration.spawn_agent` span and
no `native-child:*` observation; lineage is correctly `unsupported` with
`childCount = 0`. This does not indicate a Langfuse projection loss because no
Codex child was created. It proves that explicit four-role acceptance alone did
not validate automatic business routing and motivates a new natural-prompt
acceptance run after the OpenMAI candidate-match policy is deployed.

### Natural request with automatic children but duplicate completion

After deploying the conditional OpenMAI routing policy, natural request trace
`87a31c49ccc31a4fed9f8b1de5b1416d` automatically spawned two children without the
user mentioning subagents, roles, models, or delegation. The observations API proves
`talent_analyst` used `ClawOS/gpt-5.6-terra`, `result_verifier` used
`ClawOS/gpt-5.6-sol`, both used `fork_turns = "none"`, and lineage was provisionally
`complete` with zero partial reasons.

The runtime reply still failed acceptance. Root `llm-call-23` produced the full
person-job matching report. `llm-call-24` then consumed an OpenClaw-generated
`[Internal task completion event]` for the already-waited verifier and replaced the
trace/caller output with a one-line supplement. Direct sibling Codex evidence shows
`spawn_agent` starts asynchronously, while `wait_agent` blocks on the parent mailbox
and delivers the child `FINAL_ANSWER` into the parent request. The OpenClaw native-child
monitor therefore duplicated a completion already consumed by the active parent turn.

This trace is negative evidence for terminal-output correctness, not a missing-child or
Langfuse-ingestion failure. The required fix is twofold: suppress duplicate OpenClaw
completion delivery while the owning parent turn is active, and represent each child
turn as its own Langfuse trace linked to the root spawn under the same session. Final
acceptance requires one complete root reply plus API-visible reciprocal root/child trace
links; UI nesting or the former same-trace child tree is no longer the target contract.

### Joined and detached native-child acceptance

The detached acceptance session was
`agent:openmai-u1861319839285792768:explicit:e2e-native-child-20260815-detached-3`.
The caller run `3ab865b8-520f-4431-80ac-fec9b38e3510` returned
`DETACHED_ROOT_OK` in 9,767 ms without waiting for its child. The Langfuse Public API
then returned three traces under that one session:

- root trace `e8cb5bdf5846774186d8f64890491911`, output
  `DETACHED_ROOT_OK`, lineage `complete`, and
  `activeChildrenAtRootFinalization = 1`;
- child trace `8cf92c1bf18e2771919788ede8f80752`, linked reciprocally to
  the root spawn, role `draft_writer`, model `ClawOS/gpt-5.6-luna`, outcome
  `completed`, four generations, and three tool spans; its final
  `llm-call-4` ended at `2026-08-15T12:08:57.515Z` with
  `DETACHED_CHILD_OK`;
- later root trace `3e4abe2ed6bdb70683b98baeb1461088`, which delivered the
  detached completion as `DETACHED_CHILD_OK` without reopening or overwriting the
  original root trace.

The detached child's attempted `exec_command sleep 8` encountered an isolated
exec-server transport recovery error. The child recovered and completed normally; the
error is retained as child tool/runtime evidence and is not classified as a Langfuse
or native-child topology failure. Public API files are
`/tmp/lf-session-e2e-native-child-20260815-detached-3.json` and
`/tmp/lf-obs-{e8cb5bdf5846774186d8f64890491911,8cf92c1bf18e2771919788ede8f80752,3e4abe2ed6bdb70683b98baeb1461088}.json`.
Every admitted `parentObservationId` resolves inside its own trace.

The joined acceptance session was
`agent:openmai-u1861319839285792768:explicit:e2e-native-child-20260815-joined-1`.
The caller run `3440803b-877f-4d67-a48a-4adddaad53b7` returned exactly
`JOINED_ROOT_OK`. The root trace `7a574c17ea6fd7b0b1df4bc381a27113`
contains this ordered evidence:

1. `llm-call-1` invoked `tool:collaboration.spawn_agent` with
   `agent_type = draft_writer`, `fork_turns = none`, and
   `task_name = joined_writer`;
2. `llm-call-2` invoked `tool:collaboration.wait_agent`, which ended with
   `timed_out = false`;
3. only after that wait, `llm-call-3` emitted the single root final
   `JOINED_ROOT_OK`.

The linked child trace `0b185167616232ef817538bc5726bd8a` has role
`draft_writer`, outcome `completed`, one `ClawOS/gpt-5.6-luna` generation named
`llm-call-1`, and final output `JOINED_CHILD_OK`. Its execution-context summary records
one exact request with `systemPromptSource = input_messages` and bounded size/hash
facts. Root lineage is `complete`, `activeChildrenAtRootFinalization = 0`, and has no
partial reasons. An eight-second delayed session query still returned exactly the root
and child traces, so no duplicate internal completion root turn was created. Both trace
observation sets have zero cross-trace `parentObservationId`; reciprocal cross-trace
correlation uses `parentTraceId`, `spawnObservationId`, and `childTraceId` metadata.
Public API files are
`/tmp/lf-session-e2e-native-child-20260815-joined-1-late.json`,
`/tmp/lf-obs-7a574c17ea6fd7b0b1df4bc381a27113.json`, and
`/tmp/lf-obs-0b185167616232ef817538bc5726bd8a.json`.

These two runs prove that execution dependency and trace topology remain separate:
joined and detached children both use independent child-turn traces under the same
conversation session, while only the joined parent withholds its final response for the
mailbox result.

### Parent-only rollback and recovery acceptance

The npm registry does not publish `@openclaw/openclaw-langfuse@2026.7.1`; an
explicit pack attempt returned HTTP 404. The exact parent-only baseline was therefore
exported from repository base revision
`343f31e19cca0704887e434fa31b3dd64c50b037` and packed as a tgz without modifying
the worktree:

```text
git archive --format=tar HEAD extensions/openclaw-langfuse | tar -x -C /tmp/openclaw-langfuse-parent-only.rd31tL
node scripts/lib/plugin-npm-package-manifest.mjs \
  --run /tmp/openclaw-langfuse-parent-only.rd31tL/extensions/openclaw-langfuse -- \
  npm pack --json \
  --pack-destination /tmp/openclaw-langfuse-parent-only.rd31tL \
  --cache /tmp/openclaw-langfuse-parent-only.rd31tL/npm-cache
```

The baseline tgz is
`/tmp/openclaw-langfuse-parent-only.rd31tL/openclaw-openclaw-langfuse-2026.7.1.tgz`
with SHA-256
`bd48b243ff361186565eb262cfc3b0547a64407caf759d66a3179399af598d26`.
Its `dist/index.js` SHA-256 is
`8c7519481d990dbcd46ece1dc1d755f76d71adcfed100b010b68564d5e5a67c8`
and contains no `codex.native_child`, `nativeChildLineage`, or `native-child:`
marker. It was deployed with:

```text
openclaw plugins install npm-pack:/tmp/openclaw-langfuse-parent-only.rd31tL/openclaw-openclaw-langfuse-2026.7.1.tgz --force
openclaw gateway restart
```

After restart, Gateway `2026.7.1` was ready on port 18789 and loaded the exact
parent-only dist hash. Caller run `87731bbd-1fb2-4c94-bab4-51412555b424`
returned `PARENT_ONLY_OK`. The Langfuse Public API returned one root trace
`4a71a62260432a307cfe6883bfe4288b`, one Sol generation, zero native-child
observations, no cross-trace parent, and no `nativeChildLineage` metadata. This proves
the baseline plugin remains functional without native-child diagnostic consumption.
The API files are
`/tmp/lf-session-e2e-native-child-20260815-parent-only-1.json` and
`/tmp/lf-obs-4a71a62260432a307cfe6883bfe4288b.json`.

Recovery used the reviewed candidate tgz:

```text
openclaw plugins install npm-pack:/tmp/openclaw-native-child-pack.pLf4iy/openclaw-openclaw-langfuse-2026.7.1.tgz --force
openclaw gateway restart
```

The candidate tgz SHA-256 is
`a6e3a97ac3dbd77ab17033f68c275414e43b3675e3c63b396235ceb901d77a84`;
the installed `dist/index.js` SHA-256 is
`e08e1f9aabff0459261c12afd500ecbc10abc4de0abea99f9b4a91d770b3e673`.
Gateway `2026.7.1` recovered ready with one listener process. Caller run
`441edf41-ca52-42de-9b49-79533c0230b9` returned `RECOVERY_OK`, and Public API
trace `f9b30f8b43830efe74678dd8498e7c48` again contained the candidate-only
`nativeChildLineage.status = unsupported` parent-only classification. The API file is
`/tmp/lf-session-e2e-native-child-20260815-recovery-1.json`.

### Parent-prefixed child roots and reciprocal navigation acceptance (2026-08-16)

The final candidate was rebuilt through the repository package-runtime builder and
installed on the local OpenClaw 2026.7.1 instance with `npm-pack:<tgz> --force` for
both `codex` and `openclaw-langfuse`. Gateway restart left one listener on
`127.0.0.1:18789`. The installed artifacts exactly match the reviewed workspace
runtime files:

- Codex tgz SHA-256:
  `9dbf6577bb8d6bdd4c3f04dfcbb2f26f6316e69cbf51a72dd55287ce68c7d995`;
- Langfuse tgz SHA-256:
  `c47c76998e0935f73d7aa7e4a46b8051a7fb0fe9525e0c4bbd3f788dd370a329`;
- installed/workspace Langfuse `dist/index.js` SHA-256:
  `df390e5b82fc329771e3a39f9293d45a128046c7b35423c76deaa05dafe60d27`;
- installed/workspace Codex `run-attempt` chunk SHA-256:
  `994846dc102293450e38818d8600cd6cbfaf0acde322750a9704a374f7e4955c`.

The complex person/job matching session was
`agent:openmai-u1861319839285792768:explicit:e2e-native-child-20260816-links-1`.
Caller run `6c16035d-035e-46ef-9c80-18b94f511a7a` completed successfully in
378,545 ms with one full final response based on 12 real candidate records and two
real job records. The response ranked both person-to-job and job-to-person directions,
retained evidence gaps as `UNKNOWN`, and did not replace the result with a child
completion notice.

Langfuse Public API returned one root trace and three independent child traces under
that same session:

| Trace                              | Name                                                        | Model                  | Generations | Input/output      | Terminal       |
| ---------------------------------- | ----------------------------------------------------------- | ---------------------- | ----------: | ----------------- | -------------- |
| `4e9a0c1368946a6959c4bc59bd9caa99` | `openmai-u1861319839285792768`                              | `ClawOS/gpt-5.6-sol`   |          30 | non-null/non-null | caller success |
| `338c3c2b07b9dbe1a68de8885616110a` | `openmai-u1861319839285792768:native-child:talent_analyst`  | `ClawOS/gpt-5.6-terra` |           3 | non-null/non-null | completed      |
| `5b66e9008e61c39fb2a32951ec3626e7` | `openmai-u1861319839285792768:native-child:draft_writer`    | `ClawOS/gpt-5.6-luna`  |           1 | non-null/non-null | completed      |
| `1e280aa3771305b65bbd78fcd6ca4d5d` | `openmai-u1861319839285792768:native-child:result_verifier` | `ClawOS/gpt-5.6-sol`   |          20 | non-null/non-null | completed      |

Each child input is the bounded request summary only: provider/model, unique request
count, input/system-prompt sizes, and namespaced hashes. No raw spawn task, raw system
prompt, history, or path is copied into the child trace root. Each child output is the
captured and sanitized generation result rather than a null placeholder.

All three root `tool:collaboration.spawn_agent` spans carry the exact
`agent_type`, `fork_turns = none`, reciprocal child/thread/turn ids, and an absolute
`childTraceUrl`. Each child trace carries the matching `parentTraceId`,
`spawnObservationId`, `childTraceId`, and absolute `parentTraceUrl`. Requests to the
four `https://langfuse.ttcadvisory.com/trace/<traceId>` URLs returned HTTP 307 and
redirected to `/project/cmhlfakfx02mkpt07iaox442o/traces/<same-trace-id>`.

The deployed Langfuse health endpoint reports version 3.106.3. Its tagged frontend
source renders trace metadata through `PrettyJsonView`; `ValueCell` detects absolute
URLs and emits `<a href=... target="_blank">`, while the JSON renderer sets
`matchesURL = true`. The reciprocal URL fields therefore appear as clickable metadata
links without a Langfuse frontend fork.

Generation numbering is trace-local and contiguous: root `1..30`, analyst `1..3`,
writer `1`, verifier `1..20`. Every populated `parentObservationId` starts with its own
trace id; cross-trace parent count is zero. One verifier `wait_agent` span lacked proven
provider-call ownership and was correctly retained at the child trace root with
`partial_parenting = true`, so root lineage is `partial` for evidence completeness only;
the OpenClaw/Codex run, all three child outcomes, and the caller response remained
successful.

Focused verification after rebuilding the publishable dist:

- infra diagnostics: 34/34;
- Codex app-server focused tests: 178/178;
- Langfuse plugin test directory: exit 0;
- plugin runtime build parity: `codex` 9 entries and `openclaw-langfuse` 1 entry;
- strict OpenSpec validation and `git diff --check`: pass.

The mandatory fresh Codex autoreview was attempted after synchronizing the rebuilt dist
into the isolated review checkout, but the external reviewer failed before review with
HTTP 401 from its configured OpenAI credential. The earlier actionable dist-parity
finding is independently closed by the standard package-runtime rebuild, parity check,
tgz content inspection, matching installed/workspace hashes, focused tests, and the
live Public API acceptance above.

### Isolated `occg2` joined acceptance after Codex 0.147 resume (2026-08-16)

The final candidate was deployed only to `120.48.4.131:/data/openclaw-2`. The running
second instance remained PID `1740233` on ports `18889/18890`; the first instance
remained PID `3935010` on port `18789`. Before and after deployment and acceptance,
`/data/openclaw/openclaw.json` retained SHA-256
`2dec7d87de83a64d8c712b6fb9d82d17e44eab5c241be3e3df2e0ca788b9a864`.
The second instance `/readyz` response remained healthy.

The managed tgz and installed artifact evidence was:

- Codex tgz SHA-256:
  `c10c23f0ac7f646e557964707d898bf88c5d3192504d3e2b4fce9448ec089a69`;
- Langfuse tgz SHA-256:
  `c47c76998e0935f73d7aa7e4a46b8051a7fb0fe9525e0c4bbd3f788dd370a329`;
- installed/workspace Codex `dist/index.js` SHA-256:
  `723078a0ae338a711bd8a0390dfb704c618ed6b293d7ef4915e8e89e8b62c40c`;
- installed/workspace Langfuse `dist/index.js` SHA-256:
  `df390e5b82fc329771e3a39f9293d45a128046c7b35423c76deaa05dafe60d27`.

The acceptance reused OpenClaw session
`agent:openmai-u1861319839285792768:explicit:native-trace-e2e-20260816-2`
after the Gateway/Codex app-server restart. Caller run
`89692849-dc5f-409f-b88c-b050a1945f59` completed successfully in 188,371 ms.
It first called the real OpenMAI job API, then strictly joined three unique, serial
native children and consumed the third verifier result before emitting the anonymous
person/job matrix. The caller result and Langfuse root output are identical.

Langfuse Public API returned the following four traces in the same session:

| Trace                              | Name                                                        | Model                  | Generations | Input/output      | Errors |
| ---------------------------------- | ----------------------------------------------------------- | ---------------------- | ----------: | ----------------- | -----: |
| `ddd6ed9715cd015c7adc279c32b22f86` | `openmai-u1861319839285792768`                              | `ClawOS/gpt-5.6-sol`   |          17 | non-null/non-null |      0 |
| `c1f0f307d6b99da5961b99961bb767cf` | `openmai-u1861319839285792768:native-child:talent_analyst`  | `ClawOS/gpt-5.6-terra` |           2 | non-null/non-null |      0 |
| `800ce0da94afa68f9e889a87a0b7f90c` | `openmai-u1861319839285792768:native-child:draft_writer`    | `ClawOS/gpt-5.6-luna`  |           1 | non-null/non-null |      0 |
| `799fec6772381c55dc8677741fe66322` | `openmai-u1861319839285792768:native-child:result_verifier` | `ClawOS/gpt-5.6-sol`   |           1 | non-null/non-null |      0 |

The root lineage is `complete`, `activeChildrenAtRootFinalization = 0`, with three
children, authoritative start and terminal coverage, zero dropped events, zero pending
ownership joins, and zero partial reasons. All 32 root observations and all child
observations have `endTime`; no root or child observation has level `ERROR`; every
populated `parentObservationId` resolves inside its own trace. Root spawn spans carry
the exact unique task names, roles, `fork_turns = none`, child/thread/turn ids, and
`childTraceUrl`. Every child carries the reciprocal `parentTraceId`, `parentTraceUrl`,
`spawnObservationId`, and `childTraceId`.

Each child execution-context summary records the exact role model plus a bounded
system-prompt summary with `systemPromptSource = input_messages`,
`systemPromptChars = 23,723`, and a namespaced hash; it does not copy raw prompt or
history text into lifecycle metadata. Child generation numbering restarts at
`llm-call-1`. The parent URL returned HTTP 307 to
`/project/cmn4k4p9n00jxpt07zaz0gyjj/traces/ddd6ed9715cd015c7adc279c32b22f86`;
the three child `/trace/<id>` URLs returned the same matching-id redirect shape.

The previous hard-path trace `a46547c149d69f55c56b372e85e28dc4` is retained only
as negative/pre-gold evidence. It contained one initial duplicate-task-name spawn
failure and finalized with one verifier still active. The later
`announce:codex-native` turn was therefore correct detached delivery, not a duplicate
of a verifier result consumed by the original root. The gold run above removes both
ambiguities: unique task names, strict serial joining, zero failed observations, zero
active children at root finalization, and no post-run `announce:codex-native`, queue
failure, stream-disconnect, or system-error log entry.

Direct Codex 0.147 inspection additionally confirmed the canonical completion envelope
is `Message Type: FINAL_ANSWER` in
`codex-rs/core/src/context/inter_agent_completion_message.rs`, and resumed app-server
listeners may be attached with raw events disabled in
`codex-rs/app-server/src/request_processors/thread_processor.rs`. The deployed parser
therefore accepts only canonical plaintext `agent_message` items with matching
author/recipient envelope identity; encrypted intermediate `MESSAGE` traffic is not
treated as completion. The bounded parent-rollout fallback is consulted only before an
otherwise-required OpenClaw announce, preserving detached delivery when the parent did
not consume the child.
