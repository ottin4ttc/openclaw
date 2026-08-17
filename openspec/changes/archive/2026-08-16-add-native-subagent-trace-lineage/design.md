## Context

OpenClaw 2026.7.1 runs OpenMAI Codex Agents through the bundled Codex app-server harness, not ACP/ACPX. The Langfuse plugin already creates one trace for each OpenClaw turn and one Langfuse session for the OpenClaw conversation. Codex `spawn_agent` starts an independent child thread asynchronously; a parent becomes synchronously dependent only when it explicitly calls `wait_agent`. The trace model therefore follows actor turns rather than forcing every child lifetime into the parent turn trace.

The app-server integration already has the necessary owner boundaries:

- `native-subagent-monitor.ts` observes `thread/started`, `subAgentActivity`, child `turn/started`/`turn/completed`, status changes, and parent/child thread topology;
- `rollout-trace-diagnostics.ts` drains one exact Codex `threadId + turnId` from the shared rollout bundle and emits model/tool diagnostics;
- the internal diagnostic bus is already consumed by the Langfuse plugin without expanding the public plugin hook contract.

Sibling Codex source proves that spawn/activity events carry stable parent/child/thread/turn/call facts, spawned children share the root rollout writer, reduced inference records own thread/turn plus the tool calls started by that inference, and raw tool events alone do not contain inference-call identity. The implementation must preserve those evidence limits.

## Goals / Non-Goals

**Goals:**

- Emit bounded internal diagnostics for Codex native-child lifecycle and status.
- Drain child rollout diagnostics by exact child `threadId + turnId`.
- Preserve one Langfuse session per conversation, one root trace per OpenClaw turn,
  and one child trace per Codex child turn.
- Attach child-owned model/tool observations only through stable upstream identity.
- Prefer complete, API-verifiable delivery over immediate per-event visibility, while
  keeping telemetry off the Agent execution critical path.
- Keep parent, child, telemetry, and Langfuse failures independent.
- Degrade to existing parent-only tracing when diagnostics are absent or incomplete.

**Non-Goals:**

- Adding ACP/ACPX events, capabilities, config, dependency pins, or adapter changes.
- Adding a public `native_child_event` plugin hook, dedicated Plugin SDK entrypoint, or
  hook-specific public event type. The existing internal diagnostic union receives
  additive native-child variants because it is the already-supported plugin boundary.
- Reusing OpenClaw `sessions_spawn` hooks for Codex-native children.
- Inferring lineage from event order, role, model, nickname, prompt, task text, or raw paths.
- Exporting task bodies, prompts, model/tool payloads, credentials, account ids, or OpenMAI policy in lifecycle diagnostics.
- Making Langfuse or complete lineage required for Agent execution.

## Decisions

### 1. Keep the producer inside the bundled Codex app-server integration

`run-attempt.ts` passes the active OpenClaw run/turn/session/Agent identity plus rollout root, capture policy, and base diagnostic fields into `registerCodexNativeSubagentMonitor()`.

The monitor binds those parent facts to authoritative child notifications. It emits a versioned internal `codex.native_child.lifecycle` diagnostic only when parent turn and child thread identity are proven. It emits a bounded turn-local status diagnostic before trace finalization with coverage, drain, drop, active-child, and partial-reason counters.

MultiAgent v2 emits the originating spawn as a parent-scoped
`subAgentActivity(kind = started)` item whose event id is the spawn call id. That item
is an authoritative child-start fact even when a separate child `thread/started`
notification is not visible to the parent client. Duplicate item delivery remains
idempotent. When `thread/started` is available, the monitor preserves nested
`thread_spawn.agent_role` (falling back to `thread.agentRole`) while retaining
`agent_path` only for in-process child correlation; task/path values are not emitted
and suffixes are never promoted to configured roles. In the v2
parent-client path, Codex does not include the role in `SubAgentActivity`. The
consumer therefore joins the activity's stable originating spawn call id to the exact
successful `spawn_agent.agent_type` input. Sibling Codex proves that this value is passed
unchanged to `thread_spawn_source(..., agent_role, ...)`; it is not inferred from task
name, path, nickname, model, or event order.

No public hook is added. Langfuse subscribes through the existing internal diagnostic subscription, so default plugins and non-Codex runtimes see no new required surface.

Lifecycle and final status use the same async diagnostic queue as provider and tool lifecycle events. Producer emission order is therefore preserved through delivery, and the final status cannot overtake child call diagnostics already emitted by the drain.

### 2. Drain every proven child turn from the shared rollout bundle

When a child `turn/started` supplies a child turn id, the monitor starts the existing rollout monitor for that exact child thread and turn. On `turn/completed` or terminal status it performs one best-effort final drain for that child trace. Root-turn settlement uses one shared 500-millisecond wait window for child work that must be joined into the current answer because the rollout reader serializes access by trace root; it marks unresolved joined work partial and stops waiting instead of multiplying the timeout by the child count.

`thread/status/changed = systemError` is also a terminal boundary. Before emitting the
failed lifecycle fact, the monitor finalizes every still-active diagnostic turn for that
child through the same existing drain path. This preserves already-written model/tool
evidence and its queue order without adding another timeout or changing parent execution.

The root settlement window is not a child lifetime deadline. Lifecycle admission for a detached child trace remains owned by that child turn after the root trace finalizes. The producer closes root-trace admission before emitting root status, but does not discard, reparent, or force-finalize an independently tracked detached child. A fact arriving after its owning child trace finalizes remains late and cannot reopen that child trace.

Child drains reuse the root rollout capture policy and diagnostic base fields, adding:

- `nativeChildThreadId`;
- the parent OpenClaw turn identity;
- the existing OpenClaw run/session/Agent fields.

The root rollout monitor remains unchanged. Missing bundle, missing child turn, drain timeout, or incomplete terminal proof yields partial diagnostics and never delays or fails the Agent turn.

### 3. Preserve evidence-backed call ownership

Each child provider generation belongs to the deterministic child-turn trace selected by stable child thread and turn identity. A child tool is parented to a generation only when the reduced rollout state supplies the stable inference-to-tool relationship. Raw tool events do not carry that relationship, so the implementation never derives it from sequence.

When only child ownership is proven, the tool is attached directly to the child trace root with `partial_parenting = true`. When child ownership is not proven, existing root/unscoped behavior remains.

### 4. Keep actor turns in separate, correlated traces

```text
Langfuse session = OpenClaw conversation/session key
├── root trace = one user-message-to-final-response turn
│   ├── root generations and tools
│   └── tool:collaboration.spawn_agent
│       └── metadata link: childTraceId + childThreadId + childTurnId
├── child trace A = one native child turn
│   ├── child generations
│   └── child tools
└── child trace B = one native child turn
    ├── child generations
    └── child tools
```

The cross-trace relationship is a stable correlation link, not a fabricated
`parentObservationId` across trace ids:

```text
parent trace / spawn observation
└── childTraceId ──> child trace metadata
                     ├── parentTraceId
                     ├── spawnObservationId
                     ├── childThreadId / childTurnId
                     └── child generation -> child tool span
```

Langfuse does not support nesting one trace under another. Parent and child traces
share the OpenClaw conversation `sessionId`; the root spawn observation and child trace
carry reciprocal stable ids. Observation creation time and API response order are not
hierarchy. `parentObservationId` is used only inside one trace.

The same reciprocal metadata carries navigation URLs. The configured Langfuse base URL
plus `/trace/<traceId>` is sufficient because Langfuse redirects that stable route to
`/project/<projectId>/traces/<traceId>`. The plugin therefore does not discover, store,
or configure a project id. The deployed Langfuse 3.106.3 `PrettyJsonView` delegates
scalar metadata rendering to `ValueCell`, which detects absolute URLs and renders them
as links opening in a new tab; its JSON view also enables URL matching. The plugin only
needs to emit the absolute URL. Acceptance proves both the redirect target and the
clickable metadata rendering; no Langfuse frontend fork is part of this change.

Child trace roots are operator-readable without copying private prompts. Their name is
`<parent-agent-id>:native-child:<role>` when both proven components exist; late role
enrichment updates that name in place and never substitutes task name or `agent_path`.
The initial trace input is a bounded identity summary, then the exact child request may
enrich it with the existing bounded execution-context aggregate. Trace output follows
the latest child generation output only after existing capture/redaction/truncation. If
no such result exists, terminal lifecycle records only a bounded outcome summary. This
fallback cannot overwrite a real child result.

Generation names express trace-local logical order. Root generations use
`llm-call-N`; every child trace independently starts at `llm-call-1`. Parent generation
and spawn ownership remain metadata fields rather than being encoded into a fragile
cross-trace display number. Concurrent event arrival cannot renumber either trace.

The child trace identity is deterministic from
`(parentTraceId, childThreadId, childTurnId)`. Reusing one Codex child thread for a
later turn creates a new child trace. Lifecycle, generation, tool, and terminal
updates never cross child-turn trace ids.

`spawn_agent` remains asynchronous. If the parent calls `wait_agent`, Codex delivers
the child mailbox result to the active parent turn and the root may then produce its
single final response. The OpenClaw native-child monitor must not deliver the same
completion again as an internal task-completion message while that parent turn is
active. A genuinely detached child that finishes after the parent turn has settled may
use the existing out-of-band completion path, producing a later root turn/trace rather
than mutating the completed parent trace.

Execution dependency and trace topology are separate concerns:

- **joined**: the parent withholds its final response until the required child mailbox
  result is available, then synthesizes the answer inside the same root turn;
- **detached**: the parent finalizes without depending on that child result, and the
  child trace may settle later;
- one root turn may join some children and detach others;
- `wait_agent` waking for one mailbox update is not proof that every active child has
  completed;
- completion speed or event arrival order never changes trace topology. A fast detached
  child and a slow joined child both retain independent child-turn traces. When the
  available facts cannot prove which delivery mode applied, observability reports the
  relationship without inventing one.

### 5. Finalize once and classify coverage

The initial bounds are 64 active children, 4,096 lifecycle/call mutations, 16,384 UTF-8 metadata bytes per event, 512 pending ownership joins, 512 deferred child diagnostics, one aggregated diagnostic per overflow category, and one root-level finalization wait of at most 500 milliseconds across joined-child drains. Detached child traces use their own terminal/drain lifecycle and do not extend the root finalization window. Duplicate and non-terminal activity is dropped before unique start/terminal facts.

Runtime lineage metadata is:

- `complete`: authoritative child start/terminal ownership and child model/tool ownership were observed for the trace being classified, the applicable bounded drain completed, and no admitted fact was dropped or left unresolved; a known detached child still running at root finalization does not by itself make the root trace partial;
- `partial`: some child evidence exists, but lifecycle, ownership, terminal, drain, bounds, or delivery proof is incomplete;
- `unsupported`: no compatible Codex native-child diagnostics were observed for the turn, so parent-only tracing is authoritative.

Langfuse API evidence validates a deployment's claimed tree but is not an input available to the in-process classifier. These statuses are observation metadata only and never change OpenClaw or Codex execution.

Partial evidence is monotonic: a provider-owner mismatch, pending join, partial parenting, or other proven reason observed after a provisional complete status downgrades it to partial before final trace metadata is written.

A fact arriving after its owning trace finalizes does not reopen that trace. A detached child fact arriving after root finalization belongs to the still-active child trace and is not late merely because the root trace already ended. A genuinely late fact produces at most a bounded contract-violation diagnostic and prevents subsequent `complete` claims from that producer until restart or an explicit healthy turn re-establishes the contract.

### 6. Keep lifecycle metadata privacy-minimal

The lifecycle allowlist is limited to stable source event id, parent run/turn, parent/child thread ids, child turn id when known, lifecycle/status, timestamp, and proven role/model/reasoning/depth/outcome fields. Task bodies, task-name/agent paths, prompts, tool/model payloads, raw filesystem paths, credentials, credential references, account ids, and business policy are excluded.

Existing configurable Langfuse model/tool payload capture remains separate and retains its current redaction/truncation behavior.

### 7. Summarize child execution context at the child boundary

The root trace keeps the existing OpenClaw/Codex system-prompt and
pre-conversation metadata. A materialized child trace additionally receives
one bounded execution-context summary when the child's reduced rollout request
provides it. The producer derives request statistics from the exact child
`instructions`/`input`/`tools` payload; the consumer places the summary on the
child trace and its child generation metadata. A child may perform multiple
provider requests, so the child trace keeps a bounded aggregate with unique request
count plus first/latest request summaries instead of overwriting prior evidence. The
root trace receives only lightweight child-context coverage, role, effective-model,
and child-trace-link aggregates. This keeps parent and child contexts auditable without duplicating raw
prompts or conversation history. A missing summary is a partial-evidence reason, never
an admission gate.

Codex has two effective system-instruction request forms. Normal Responses requests
use a non-empty top-level `instructions` string. Responses Lite uses an empty
top-level string and prepends a textual `developer` message to `input` (alongside a
separate additional-tools record). Prompt statistics therefore prefer non-empty
`instructions`, then deterministically join only the ordered textual content of
`system`/`developer` input messages. They record `systemPromptSource`, character count,
and namespaced hash only. User/assistant messages and additional-tools records remain
part of their own input/tool statistics and are not counted as system instructions.
Because input-message instructions are already included in `inputMessagesChars`, they
are not added again to `totalChars`.

Codex MultiAgent v2 defaults omitted `fork_turns` to `all`; `none` creates a fresh child
with only its initial task plus child instructions, while a positive integer retains a
bounded parent suffix. Full-history `all` rejects role/model overrides. The final
four-role acceptance therefore uses explicit `fork_turns = "none"`. Langfuse reports
the spawn option on the parent tool and exact child request counts/hashes on the child;
it does not relabel input messages as inherited history without an authoritative source.

The successful single-child trace `285dcb46afd90ed0a3b774f9e0ce5b9c`
proved the spawn/child/generation hierarchy and normal parent result, but exposed three
remaining metadata defects: the Responses Lite developer prompt produced no
system-prompt stats, task path `candidate_conclusion` was shown instead of configured
role `draft_writer`, and the v2 spawn activity was recorded as generic activity so
`authoritativeStart` remained false. These are producer classification defects, not
evidence that the child lacked its own instructions. The explicit `fork_turns = none`
in that trace intentionally created a fresh child with no inherited parent history.

A later packaged local trace `166207bf020979f7b58ad4a758681779` closed the prompt and
start-classification defects but exposed the remaining v2 role-join defect. The normal
caller result was `PARENT_READY｜CHILD_ROLE_READY`; lineage was `complete`, the child
used `gpt-5.6-luna`, its span contained four exact request summaries including
`systemPromptSource = input_messages`, and its generations were correctly parented as
`llm-call-2-1` through `llm-call-2-4`. However, the child observation was named
`native-child:candidate_conclusion`, had `agentPath = /root/candidate_conclusion`, and
had no role; root child-context roles were consequently absent. The same rollout
bundle's `thread_started` payload records `agent_role = draft_writer`, while the
parent-visible v2 activity exposes only the spawn call id and path. This is a stable
identity join defect, not permission to relabel the task suffix as a role.

The current implementation resolves that defect by naming the child trace generically until the
stable spawn call exposes its exact `agent_type`, then updating the same child trace id to the
configured role. It does not copy `agent_path` into lifecycle events or Langfuse metadata; the path
remains internal to completion correlation.

The same trace also records three recoverable Luna provider attempts ending with
`response_stream_disconnected` / `connection_closed` before a fourth request succeeds.
Those ERROR generations are accurate provider evidence and remain visible. They do not
invalidate the successful parent result or complete lineage, and they must not be
deleted, merged into the final generation, or called a Langfuse connection-pool error.

### 8. Separate runtime success from telemetry delivery and accept only complete evidence

The deployment test has two independent success planes:

- the OpenClaw turn must return a normal business response to the caller after the
  required OpenMAI reads and Codex native-child work complete;
- Langfuse must retain the corresponding root trace and every linked child-turn trace
  through the public trace and observations APIs.

An LLM stream error is a runtime/provider outcome. A Langfuse ingestion error is a
telemetry-delivery outcome. A caller timeout or disconnect is an acceptance-client
outcome. The implementation and evidence SHALL classify these separately rather than
calling every missing trace a model error or treating a lone terminal error generation
as a successful trace.

Accuracy has priority over incremental visibility. The Langfuse delivery policy may
batch, delay, or retry observations, but it must bound concurrent ingestion requests,
retain stable observation ids, and preserve per-observation delivery attribution. Each
trace delivery barrier owns only that trace's admitted events: a root barrier must not
mark a linked child delivered, and a detached child barrier may settle later. A joined
session/deployment acceptance barrier must not claim success while required child traces
or trace/session metadata remain unsettled. Telemetry failure stays fail-open for Agent
execution, but deployed acceptance remains failed until the APIs show the complete
claimed traces.

The installed Langfuse SDK invokes one public flush callback with the queue items
removed for that request. The tracker therefore attributes every callback item by
`traceId + observationId + eventType`, including multi-item batches, and treats a
callback error (including the SDK's HTTP 207 path) as failure for every attributable
item in that callback. Ingestion flushes are serialized to one active request;
automatic flush requests are coalesced and continue draining full batches so a
high-observation turn cannot create unbounded request fan-out or strand queued events.

### Current deployed acceptance blockers

The 2026-08-14 local acceptance trace
`c6d5f6179737a16076f55d0613225293` is negative evidence, not a passing partial case:

- Codex rollout evidence contains 14 inference starts, 13 completed inference calls,
  one final inference transport failure, and 19 tool calls; this rules out a general
  model failure but confirms the final stream ended with `error decoding response body`.
- Langfuse persisted only the final error generation (`gen-14`) while Gateway logs show
  repeated SDK network failures, an initial TLS `ECONNRESET`, and failed final delivery
  plus its retry. The normal generations and tool calls were therefore not delivered.
- OpenMAI job search returned `token_exchange_failed` / `fetch failed`, so the business
  result prerequisite was not met.
- The HTTP acceptance caller disconnected after approximately 162 seconds, so no normal
  response reached the caller even though the Gateway continued processing until the
  turn settled.
- Persisted metadata reported native-child lineage `unsupported` with zero children,
  so the requested four-role Sol/Terra/Luna child proof is absent.

These are separate blockers. None may be reclassified as successful child-observability
acceptance, and the next live run must preflight the exact Gateway environment and use a
caller timeout longer than the bounded scenario budget.

The earlier multi-call child-summary replacement, prompt-source, authoritative-start,
and multi-item SDK delivery issues are closed by the current implementation and
regression suite. The remaining live metadata blocker before the next deployment is the
v2 spawn-call role join and late child-span rename described above. Intermittent
provider stream disconnects and Langfuse TLS timeouts remain separately classified.
The plugin does not treat a cold `fork_turns = none` child, its intentional lack of
parent history, or its first-request cache miss as a Langfuse defect.

## Risks / Trade-offs

- [Joined child terminal arrives during root finalization] → Admit it until the bounded root window closes; facts after the owning trace closes do not reopen it and produce at most one bounded violation.
- [Detached child outlives root finalization] → Keep the child-turn trace active and correlated; do not hold open or mutate the completed root trace.
- [Child turn id is missing] → Emit lifecycle evidence only; do not start a guessed rollout drain.
- [Raw tool lacks inference-call identity] → Parent to the proven child and set `partial_parenting = true`.
- [Persistent child is reused later] → Scope child trace identity by parent trace, child thread, and child turn; reject cross-turn terminal updates.
- [Parent waits for a native child] → Let Codex mailbox delivery satisfy the active turn once; do not re-inject the same completion through OpenClaw task delivery.
- [Detached child outlives the parent turn] → Finalize its independent child trace and use a later correlated root turn only when user-visible completion delivery is required.
- [High child concurrency creates telemetry pressure] → Enforce the documented bounds and degrade without changing runtime outcomes.
- [Per-event ingestion creates a request storm] → Bound in-flight delivery and allow
  delayed/batched publication; never trade trace completeness for real-time display.
- [Runtime, telemetry, and caller fail together] → Preserve separate outcomes and require
  both a normal reply and complete API evidence for deployed acceptance.
- [Langfuse is absent or unavailable] → Keep Codex diagnostics best-effort and existing parent execution unchanged.

## Migration Plan

1. Remove the staged nonexistent public native-child hook and all ACP/ACPX assumptions.
2. Add internal lifecycle/status diagnostic types and privacy/bounds tests.
3. Pass active parent turn and rollout context from `run-attempt.ts` into the native-subagent monitor.
4. Start/finalize exact child rollout drains and annotate child model/tool diagnostics.
5. Adapt Langfuse's existing diagnostic consumer to lifecycle/status events while using deterministic child-turn traces, correlation metadata, ledger recovery, and delivery tracking.
6. Add Codex monitor, duplicate-completion, rollout diagnostics, Langfuse joined/detached multi-child/multi-turn, partial-parenting, late-event, and parent-only tests.
7. Run focused tests and changed checks, then deploy only to the local OpenClaw 2026.7.1
   instance on port 18789 for API acceptance.
8. Query the Langfuse trace and observations APIs, validate root/child reciprocal links and every within-trace parent id, then present the session in logical root/spawn/child/call order.
9. Require a normal two-turn business conversation plus complete API delivery; classify
   provider, OpenMAI, caller, and Langfuse failures independently.
10. Roll back by disabling/removing optional diagnostic consumption; parent-only tracing remains supported.
