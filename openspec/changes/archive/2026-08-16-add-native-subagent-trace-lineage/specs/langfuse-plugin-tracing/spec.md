## ADDED Requirements

### Requirement: Actor-turn traces with native-child correlation

The plugin SHALL preserve one Langfuse session for an OpenClaw conversation, one root trace for each user-message-to-final-response OpenClaw turn, and one independent child trace for each Codex native-child turn. The root spawn observation and child trace SHALL carry reciprocal stable correlation fields. `parentObservationId` SHALL be used only between observations in the same trace.

#### Scenario: One turn uses multiple native children

- **WHEN** one Agent turn starts multiple Codex native children before producing the final reply
- **THEN** Langfuse contains one root trace and one distinct child trace per stable child thread/turn identity
- **AND** all traces share the same conversation session identity
- **AND** every root spawn and child trace carries reciprocal trace/spawn/thread/turn correlation ids

#### Scenario: One child performs multiple LLM and tool calls

- **WHEN** a native child performs multiple provider requests and tool calls in the turn
- **THEN** each provider request is a distinct generation in that child's trace
- **AND** each child-owned tool span is attached beneath the generation proven by stable call linkage or beneath the child trace root with `partial_parenting = true` when only stable child ownership is available

#### Scenario: Conversation continues for another turn

- **WHEN** the same OpenClaw conversation receives another user message after the prior turn completes
- **THEN** the new turn receives a new trace identity
- **AND** both traces share the same Langfuse session identity

### Requirement: Stable concurrent-child correlation

The plugin SHALL correlate native-child traces, generations, tool spans, and terminal updates only through stable internal diagnostic parent-trace, parent-turn, spawn-observation, child-thread, child-turn, and call identities. It SHALL NOT correlate or merge children by arrival order, role, model, nickname, prompt text, task text, or adjacency.

#### Scenario: Concurrent children interleave events

- **WHEN** two native children emit interleaved model, tool, follow-up, and terminal events
- **THEN** the session retains two sibling child traces linked to the same root trace
- **AND** every owned generation and tool span remains in the correct child trace

#### Scenario: Child receives a follow-up

- **WHEN** the parent sends additional work that starts another turn on an existing child thread
- **THEN** the follow-up receives a new child-turn trace with the same child-thread identity
- **AND** the plugin does not append the new turn to the prior child trace

#### Scenario: Persistent child is reused in a later turn

- **WHEN** a later user turn sends follow-up work to a child thread that appeared earlier
- **THEN** the later child turn materializes a new child trace keyed by parent trace, child thread, and child turn
- **AND** no observation, generation, tool span, or terminal update crosses between the child-turn traces

#### Scenario: Child relationship cannot be proven

- **WHEN** an event lacks a stable child or parent-turn identity
- **THEN** the plugin records only the valid root or unscoped observation allowed by its existing data model
- **AND** it does not invent a `parentObservationId`

### Requirement: Deterministic child trace links and trace-local call numbering

When stable spawn ownership is available, the plugin SHALL link the root
`tool:collaboration.spawn_agent` observation to the independent child trace with
reciprocal `parentTraceId`, `spawnObservationId`, `childTraceId`, `childThreadId`,
and `childTurnId` fields. The root spawn SHALL expose `childTraceUrl` and the child
trace SHALL expose `parentTraceUrl`, each using Langfuse's existing
`/trace/<traceId>` redirect route resolved from the configured base URL. These URLs
SHALL remain copyable and directly navigable without project-id discovery. Metadata
URL values SHALL render as clickable links in the supported Langfuse 3.106.3 trace
detail view without a custom frontend change. Root and child generations SHALL each use trace-local
`llm-call-N` numbering. Cross-trace ancestry SHALL NOT be encoded as a
`parentObservationId` or by embedding the parent call number in the child display name.
Concurrent delivery SHALL NOT renumber previously identified root or child calls.

#### Scenario: Root spawns one child with two calls

- **WHEN** `llm-call-1` invokes `tool:collaboration.spawn_agent` and that child performs two provider requests
- **THEN** the spawn tool is parented to root `llm-call-1`
- **AND** the spawn observation links to the child's independent trace
- **AND** the child generations are named `llm-call-1` and `llm-call-2` inside that child trace

#### Scenario: Child tool has proven provider ownership

- **WHEN** reduced rollout evidence proves that a child tool was started by child-trace `llm-call-2`
- **THEN** the child tool's `parentObservationId` identifies that same-trace `llm-call-2`
- **AND** API response ordering does not affect the relationship

#### Scenario: Concurrent child calls arrive out of order

- **WHEN** call diagnostics for two children interleave or reach Langfuse in a different response order
- **THEN** each trace retains its own one-based generation order
- **AND** cross-trace logical order is derived from correlation metadata rather than by renaming calls from arrival order

#### Scenario: Operator follows a reciprocal trace link

- **WHEN** a root spawn or child trace is queried through the public API
- **THEN** its reciprocal metadata includes an absolute `/trace/<traceId>` URL
- **AND** opening that URL resolves to the matching Langfuse project trace
- **AND** the supported Langfuse trace detail view renders the URL as a clickable link

### Requirement: Readable privacy-minimal child trace roots

Each child trace SHALL be named `<parent-agent-id>:native-child:<role>` when both the
OpenClaw Agent id and authoritative Codex role are available. Missing components SHALL
be omitted without deriving a role from task name or `agent_path`; recovery traces SHALL
use `<parent-agent-id>:native-child:recovered` when the Agent id is available. Late role
enrichment SHALL rename the existing trace while preserving the parent Agent prefix and
trace id.

The child trace root SHALL have non-null bounded input and output. Initial input SHALL
be a privacy-minimal child identity summary and SHALL be replaced or enriched by the
bounded execution-context summary when the exact child provider request is available.
Output SHALL use the latest child generation output that already passed existing
capture, redaction, and truncation policy. When no captured generation output is
available, terminal lifecycle SHALL write a privacy-minimal outcome summary. A terminal
fallback SHALL NOT overwrite an already published generation result. Raw spawn tasks,
system prompts, histories, tool payloads, and paths SHALL NOT be copied into the trace
root.

#### Scenario: Child trace is materialized before request context

- **WHEN** stable child identity exists before the first provider request
- **THEN** the child trace has a bounded identity-summary input and a parent-prefixed name
- **AND** it does not expose task text or `agent_path`

#### Scenario: Child request and result become available

- **WHEN** the child provider diagnostics publish bounded request context and a captured output
- **THEN** the same child trace input records the bounded execution-context summary
- **AND** its output records the latest sanitized child result

#### Scenario: Child terminates without a captured result

- **WHEN** terminal lifecycle arrives without a publishable generation output
- **THEN** the child trace output contains a bounded outcome summary
- **AND** an existing real child result is never replaced by that fallback

### Requirement: Child execution-context summary

The plugin SHALL retain the existing root-turn prompt metadata contract and SHALL
also attach a bounded execution-context summary to each materialized native-child
trace when the child provider request exposes it. For a child with multiple
provider requests, the child-trace summary SHALL retain a unique request count and
bounded first/latest request summaries rather than replacing all earlier evidence with
the latest request. The root trace SHALL expose only a lightweight aggregate of child-context
coverage, roles, and effective models; request-scoped prompt statistics remain on the
child trace and generation. The summary SHALL be
derived from the child's effective request, not copied from the parent trace or
inferred from the spawn task. It MAY include the child role/path, effective
provider/model, reasoning effort when supplied, fork/context source when supplied,
and prompt statistics such as system-prompt size/hash, input-message count/size,
and tool-definition count/size/hash. It SHALL NOT include raw system-prompt text,
spawn task bodies, full parent conversation, credentials, or tool payloads.

The summary is trace-only metadata. If the child request cannot provide it,
the child trace SHALL remain valid and the lineage MAY be classified
`partial` with a bounded `child_context_unavailable` reason; the child SHALL NOT
be dropped solely because the summary is unavailable.

The system-prompt portion of an available summary SHALL include at least its bounded
size, namespaced hash, and source (`instructions` or `input_messages`). Input-message statistics SHALL describe the exact child
provider request and SHALL NOT be labeled as inherited history unless Codex supplies
authoritative fork provenance. The final role/model acceptance uses explicit
`fork_turns = "none"`; the parent spawn span remains the source of that option.

The child trace SHALL treat Codex `agent_role` as the configured role. Task-name and
`agent_path` values remain internal correlation inputs and SHALL NOT be copied into
Langfuse metadata because model-generated task names may contain business content. The
plugin SHALL NOT present a task-name suffix as the configured role. When MultiAgent v2 omits role from the
parent-visible child activity, the plugin MAY use the stable originating spawn call id
to join the child to the successful spawn request's exact `agent_type`, which sibling
Codex passes unchanged into `thread_spawn.agent_role`. If that role arrives after child
materialization, the plugin SHALL update both the child trace name/metadata and root
child-role aggregates without creating a second child trace.

#### Scenario: Child request exposes prompt context

- **WHEN** a materialized child emits a provider-request diagnostic with prompt statistics
- **THEN** the child trace records a bounded execution-context summary
- **AND** the child generation records the same request-scoped prompt statistics
- **AND** raw system-prompt and conversation text remain governed by existing capture/redaction settings

#### Scenario: One child performs multiple provider requests

- **WHEN** one materialized child performs two or more provider requests
- **THEN** its child trace reports the unique request count plus bounded first/latest request summaries
- **AND** each child generation retains its own request-scoped prompt statistics
- **AND** the root trace reports child-context coverage, roles, and effective models without copying raw request content

#### Scenario: Child request context is unavailable

- **WHEN** a child lifecycle is proven but no child provider request exposes context statistics
- **THEN** the child trace and available child generations are still recorded
- **AND** the trace records `child_context_unavailable` only as partial observability metadata
- **AND** the OpenClaw turn and Codex child execution are unchanged

#### Scenario: Fresh role-specific child

- **WHEN** the parent spawns a role/model child with `fork_turns = "none"`
- **THEN** the spawn tool records that explicit option
- **AND** the child summary records system-prompt size/hash and exact input-message statistics
- **AND** the plugin does not claim the child inherited parent history

#### Scenario: Child instructions use the input-message request form

- **WHEN** a child provider request omits non-empty top-level `instructions` and carries its instructions as ordered `system`/`developer` input messages
- **THEN** the child trace and generation prompt statistics record `systemPromptSource = input_messages`
- **AND** they record bounded size/hash without raw instruction text

#### Scenario: Child task name differs from configured role

- **WHEN** a spawn uses task path `/root/candidate_conclusion` with `agent_type = draft_writer`
- **THEN** the child trace reports role `draft_writer` without copying the task path
- **AND** root child-role aggregates use `draft_writer`

#### Scenario: Configured role arrives after child materialization

- **WHEN** v2 first materializes one child from stable spawn ownership without a role and later exposes the same spawn call's exact `agent_type = draft_writer`
- **THEN** the existing child trace is renamed `openmai-u1861319839285792768:native-child:draft_writer` and records `role = draft_writer`
- **AND** the child trace id and root correlation link do not change
- **AND** root child-role aggregates include `draft_writer`

### Requirement: Child terminal outcomes and turn independence

The plugin SHALL record available child completion, failure, cancellation, interruption, and timeout outcomes without changing the parent Agent turn outcome. A child failure SHALL not prevent delivery of valid root or sibling traces.

#### Scenario: One sibling child fails

- **WHEN** one concurrent child fails while another child and the parent continue
- **THEN** the failed child trace records the classified outcome when supplied
- **AND** successful sibling and root traces remain deliverable in the same session

#### Scenario: Parent completes after child interruption

- **WHEN** a child is interrupted and the parent produces a final response
- **THEN** the child trace records interruption and the root trace records parent completion
- **AND** the plugin does not replace the parent outcome with the child outcome

### Requirement: Native child completion is delivered once

Codex native `spawn_agent` SHALL remain asynchronous. When an active parent turn calls
`wait_agent`, the Codex mailbox result SHALL be the only completion delivery consumed by
that turn. The OpenClaw native-child monitor SHALL NOT enqueue a second internal
task-completion message for the same child while the owning parent turn is active. A
detached child that completes after the parent turn settles MAY use the existing
out-of-band completion path, which SHALL create a later correlated root turn rather
than overwrite the completed root reply. Joined and detached execution MAY coexist in
one root turn, but both SHALL retain the same independent actor-turn trace topology.
The plugin SHALL NOT choose a topology from completion speed or event arrival order.

#### Scenario: Parent waits for child and produces a final report

- **WHEN** the parent calls `wait_agent`, consumes the child mailbox result, and emits a complete final report
- **THEN** OpenClaw does not enqueue the same child result as an internal task-completion message
- **AND** the caller and root trace retain exactly one final reply

#### Scenario: Parent performs independent work before joining

- **WHEN** the parent starts a child, performs unrelated work, and later waits because its final synthesis depends on the child result
- **THEN** the root trace remains active through spawn, wait, result consumption, synthesis, and one final response
- **AND** the child remains an independently correlated child-turn trace

#### Scenario: Detached child completes after parent settlement

- **WHEN** the parent turn settles without waiting and the child later completes
- **THEN** the child trace finalizes independently
- **AND** any required user-visible completion uses a later root turn/trace linked under the same session
- **AND** the completed parent trace is not reopened or overwritten

#### Scenario: One root joins one child and detaches another

- **WHEN** one root turn depends on one child result but starts another non-blocking child
- **THEN** the parent waits only for the required result before its final response
- **AND** both children retain independent child-turn traces under the same session
- **AND** the detached child's later completion does not make the completed root trace mutable

#### Scenario: Completion timing differs from delivery mode

- **WHEN** a detached child finishes quickly or a joined child finishes slowly
- **THEN** both children retain the same actor-turn trace shape
- **AND** the plugin does not infer joined or detached semantics from elapsed time or API ordering

### Requirement: Optional lineage degradation

The plugin SHALL treat native-child lineage as optional internal diagnostic enrichment and SHALL expose one of three observation-only states without changing Agent execution: `complete`, `partial`, or `unsupported`. `complete` SHALL require authoritative start/terminal and call-ownership coverage for the trace being classified, a successful applicable bounded drain, and no dropped or unresolved admitted facts. A known detached child that remains active when the root trace finalizes SHALL NOT by itself make root coverage partial; that child trace owns its later terminal coverage. `partial` SHALL mean that some native-child traces are usable but one or more required coverage conditions are not proven. A proven partial reason processed after a provisional `complete` status SHALL monotonically downgrade the status to `partial`. `unsupported` SHALL mean no compatible native-child diagnostics were observed and the existing parent-only trace remains authoritative. Existing parent trace, provider-generation, tool-span, recovery, and delivery behavior SHALL remain functional in every state. Langfuse API evidence SHALL validate a deployed completeness claim but SHALL NOT be an in-process classification input.

#### Scenario: Default host supplies no child lifecycle

- **WHEN** the plugin runs without compatible Codex native-child diagnostics
- **THEN** it preserves its existing one-root-trace-per-turn behavior
- **AND** it creates no fabricated child traces or required configuration key
- **AND** it records lineage status `unsupported` without classifying the Agent turn as failed

#### Scenario: Some child facts are observable

- **WHEN** child traces are delivered but terminal coverage, stable correlation, bounded drain, bounds, delivery, or API proof is incomplete
- **THEN** the session retains every reliably correlated child trace and the root records lineage status `partial`
- **AND** the status affects only observability reports, not the OpenClaw turn or Codex child execution

#### Scenario: Complete child coverage is proven

- **WHEN** the producer proves start, terminal, and call-ownership coverage and the final drain succeeds without drops or unresolved admitted facts
- **THEN** the trace records lineage status `complete`
- **AND** that status may be used for complete child-count, latency, token, and tool-call reporting

#### Scenario: A later queued call proves partial parenting

- **WHEN** a child call diagnostic processed after status proves a provider-owner mismatch, pending join, or partial parenting condition
- **THEN** lineage status is `partial` even if status had provisionally been `complete`
- **AND** the trace never retains a false complete claim

#### Scenario: Langfuse delivery is unavailable

- **WHEN** child trace delivery fails or the Langfuse service is unavailable
- **THEN** the plugin records the bounded delivery diagnostic supported by its existing lifecycle
- **AND** the OpenClaw Agent turn remains unaffected

#### Scenario: Child fact arrives after its child trace finalization

- **WHEN** a child fact arrives after the bounded final drain and that child trace's delivery lifecycle is finalized
- **THEN** the plugin does not reopen that child trace or create a replacement trace
- **AND** it records a bounded diagnostic when possible and does not affect the OpenClaw or Codex result
- **AND** a producer version that violated a prior complete-coverage claim is not used for subsequent `complete` classification until lifecycle health is re-established

#### Scenario: Detached child fact arrives after root finalization

- **WHEN** a detached child emits model, tool, or terminal facts after its linked root trace finalized
- **THEN** the plugin records them in the still-active child trace
- **AND** it does not reopen the root trace or classify the child fact as late solely because the root ended

### Requirement: Native-child API acceptance evidence

A complete native-child lineage claim SHALL require Langfuse trace and observations API evidence showing the root trace, stable linked child traces, reciprocal correlation ids, within-trace parent relationships, child-owned generations and tool spans, and available terminal outcomes. UI-only grouping, model-name matching, or a root trace without linked child traces SHALL NOT be sufficient.

Deferred child-owned diagnostics awaiting spawn ownership SHALL be bounded to
512 entries per turn. Overflow is recorded as partial evidence and does not
affect Agent execution.

#### Scenario: Inspect a completed multi-child turn

- **WHEN** a real turn with at least two native children and multiple child provider or tool calls completes
- **THEN** the trace API confirms one root trace plus one trace per child turn under the conversation session identity
- **AND** the root spawn observations and child traces carry reciprocal correlation ids
- **AND** the observations API confirms every `parentObservationId` resolves inside its own trace
- **AND** root and child traces each use stable trace-local `llm-call-N` numbering

#### Scenario: Inspect partial native-child evidence

- **WHEN** the host omits one or more stable facts required for a complete hierarchy
- **THEN** acceptance classifies the result as partial native-child observability
- **AND** it does not claim complete lineage or classify the plugin or Agent turn as failed solely for the missing facts

### Requirement: Accurate bounded Langfuse delivery

The plugin SHALL prioritize complete, API-verifiable turn delivery over immediate
per-event visibility. It SHALL bound concurrent Langfuse ingestion requests and SHALL
retain stable trace and observation identities across delayed delivery, retries, or
reconciliation. A delivery callback or final barrier SHALL NOT mark an admitted
observation delivered unless that specific observation, or an attributable batch
containing it, is acknowledged. A failed delivery SHALL remain isolated from OpenClaw
and Codex execution, but the deployment SHALL NOT pass acceptance until every claimed
generation, tool span, linked native-child trace, and trace/session field is visible
through the public APIs.

#### Scenario: A complex turn emits many observations

- **WHEN** one turn emits concurrent root and child generations, tool spans, and updates
- **THEN** the plugin bounds simultaneous Langfuse ingestion work
- **AND** delayed or batched delivery preserves stable ids and exact parent relationships
- **AND** real-time display latency does not cause observations to be dropped

#### Scenario: One SDK callback acknowledges a batch

- **WHEN** a Langfuse flush callback contains multiple create or update events
- **THEN** every item is matched by trace, observation, and event type to its own delivery ticket
- **AND** success settles every attributable item in that batch
- **AND** a callback error or HTTP 207 failure marks every attributable item in that batch failed

#### Scenario: Observation bursts overlap flush triggers

- **WHEN** new observations reach the flush threshold while an ingestion request is active
- **THEN** the plugin keeps at most one ingestion request active
- **AND** coalesced automatic flushes continue until every full queued batch has been attempted
- **AND** an explicit final barrier waits for its attributable watermark rather than only the first batch

#### Scenario: One delivery attempt fails transiently

- **WHEN** Langfuse ingestion reports a network failure before the final barrier
- **THEN** the affected observations remain unsettled for bounded retry or reconciliation
- **AND** a later callback for a different observation cannot settle them accidentally
- **AND** the plugin does not claim a complete delivered trace until API evidence confirms it

#### Scenario: Only a terminal error generation is persisted

- **WHEN** the runtime emitted earlier generations or tools but the Langfuse API contains only a later terminal error
- **THEN** acceptance classifies telemetry delivery as failed
- **AND** it does not reinterpret the missing observations as a model-only failure or a valid partial child tree

## MODIFIED Requirements

### Requirement: Trace model and tool activity

The plugin SHALL create a stable trace for each observable root or native-child agent turn and SHALL record every distinct provider request and tool-call lifecycle when those events are available through public runtime hooks. A tool SHALL use the triggering same-trace provider generation as its parent when stable call linkage proves that relationship. When only stable native-child ownership is proven, the tool MAY attach directly to the child trace root with `partial_parenting = true`. When neither relationship is proven, the plugin SHALL preserve existing root/unscoped behavior and SHALL NOT invent a parent from event order.

#### Scenario: Successful model turn

- **WHEN** an agent turn emits input and output lifecycle events
- **THEN** Langfuse receives one correlated trace whose provider-request generations contain the available model, input, output, timing, usage, and error metadata

#### Scenario: Tool call has stable provider linkage

- **WHEN** a tool call starts and completes with a stable triggering provider-call identity during a traced turn
- **THEN** the trace contains one correlated tool observation with its name, sanitized arguments, result or error, and duration when available
- **AND** its parent observation is the provider-request generation identified by that stable linkage

#### Scenario: Native-child tool has only child ownership

- **WHEN** a native-child tool call has stable child ownership but no stable triggering provider-call identity
- **THEN** the tool observation is attached to that child trace root with `partial_parenting = true`
- **AND** the plugin does not assign the latest preceding generation by event order

#### Scenario: Turn fails

- **WHEN** the model or tool path ends with an error
- **THEN** the trace records the failure outcome and error metadata without throwing an additional uncaught plugin error into the agent runtime

### Requirement: Langfuse API acceptance evidence

The deployment SHALL be considered valid only when the OpenClaw caller receives a
normal final response and the Langfuse observations API confirms every provider
generation and tool parent relationship claimed by the selected lineage status; a
trace root, aggregate generation, lone terminal error generation, or UI-only view is
insufficient evidence. Complete lineage SHALL require all claimed linked child traces,
provider generations, tool relationships, available terminal outcomes, coverage
counters, and final-drain status. Partial lineage SHALL identify the missing coverage
or partial-parenting reasons explicitly and is not sufficient for the final complex
multi-child acceptance case.

#### Scenario: Inspect a completed multi-tool trace

- **WHEN** a real Codex request on the local OpenClaw 2026.7.1 port 18789 deployment completes and its trace is queried through `/api/public/observations?traceId=...`
- **THEN** every provider generation has a stable identifier, input, output or classified terminal error, end time, and usage when supplied by the provider
- **AND** every tool with stable provider linkage has that generation as `parentObservationId`
- **AND** every tool attached directly to a child trace root is marked `partial_parenting = true`

#### Scenario: Inspect an active trace

- **WHEN** the observations API is queried after a provider start but before the turn ends
- **THEN** the started `llm-call-N` generation is already present without waiting for aggregate `agent_end` processing

#### Scenario: Inspect two turns from one deployed session

- **WHEN** two completed real business turns share one explicit port 18789 session key
- **THEN** both trace API records use that same session key and have distinct trace identities
- **AND** the OpenClaw caller received a normal final response for both turns
- **AND** the second trace has a non-empty canonical `prior_conversation`
- **AND** the observations API shows at least two provider generations and two tool spans across the acceptance scenario
- **AND** every provider generation has input, output or classified terminal error, end time, model, and provider-supplied usage
- **AND** every tool span has input, output or classified error, end time, and any `parentObservationId` resolves to stable ownership within the same trace

#### Scenario: Downloaded trace export omits observation details

- **WHEN** a downloaded trace JSON omits observation input or output fields
- **THEN** acceptance queries the public observations API for the same trace before classifying the data as missing
- **AND** complete API observation records are treated as authoritative over the reduced download representation

#### Scenario: Runtime and telemetry failures are classified independently

- **WHEN** the LLM stream, OpenMAI read, acceptance caller, or Langfuse delivery fails
- **THEN** acceptance records each observed failure against its own boundary
- **AND** no Langfuse delivery gap is labeled a model failure without provider evidence
- **AND** no successful provider calls are treated as a successful deployment when the business reply or trace delivery is incomplete

#### Scenario: Native child completion notification is not a global barrier

- **WHEN** a parent uses a native `wait_agent`-style mailbox wait while more than one
  child is active
- **THEN** the implementation SHALL treat the wake-up as evidence for one child update,
  not as proof that every active child has reached terminal state
- **AND** a parent final response emitted while another child is active SHALL remain a
  normal runtime response; a proven detached child continues in its own trace, while an
  unresolved required/joined child makes root coverage `partial`
- **AND** acceptance SHALL NOT call that turn complete merely because the parent output
  was initially produced

#### Scenario: Child tool facts arrive after a parent wait

- **WHEN** a child reaches a mailbox-visible completion and subsequently emits a tool
  fact or terminal reconciliation event
- **THEN** the plugin SHALL retain the admitted late observation, preserve its stable
  parent ids, and downgrade the lineage to `partial` when the fact cannot be included in
  the completed coverage window
- **AND** the runtime outcome SHALL remain independent from that telemetry downgrade
- **AND** a complete multi-child acceptance turn SHALL perform an explicit final drain
  after the last child and SHALL contain no admitted late child facts
