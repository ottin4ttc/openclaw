# codex-runtime-observability Specification

## Purpose

Make Codex app-server turns observable through the public OpenClaw runtime lifecycle so the Langfuse plugin can correlate model, tool, usage, transport, and failure data without coupling to private Codex internals.

## Requirements

### Requirement: Per-turn Codex correlation

The runtime SHALL expose enough public lifecycle data for a plugin to correlate each Codex app-server turn, its model invocation, and its tool calls under one stable turn identity.

#### Scenario: Turn emits lifecycle events

- **WHEN** a Codex app-server turn starts, invokes the model, and ends
- **THEN** public plugin hooks expose matching turn context to the start, model, tool, and end handlers

#### Scenario: Multiple turns run in one session

- **WHEN** two turns execute sequentially or concurrently in the same session
- **THEN** their observable events remain attributable to the correct turn and are not merged by the plugin

### Requirement: Model-call diagnostics

The runtime SHALL expose model, provider, request/response, usage, latency, and error facts that are available at the Codex app-server boundary through public hook payloads or a documented minimal seam.

#### Scenario: Model call succeeds

- **WHEN** Codex returns a successful model response with usage data
- **THEN** the model lifecycle event includes the model reference, response outcome, usage fields, and timing metadata available at that boundary

#### Scenario: Model call fails

- **WHEN** the model request fails, is cancelled, or times out
- **THEN** the terminal lifecycle event includes a classified failure outcome and the plugin can record it without inspecting private Codex state

### Requirement: Live provider-request delivery

The Codex extension SHALL monitor the active turn's rollout trace while the turn is running, publish one stable provider-request lifecycle for every concrete Codex inference call, and perform one bounded final drain before aggregate terminal reconciliation.

#### Scenario: Three provider requests occur in one turn

- **WHEN** one Codex turn performs three concrete provider requests
- **THEN** the runtime publishes three distinct started and terminal diagnostic pairs ordered as provider request indexes 1, 2, and 3
- **AND** each pair retains one stable call identity from start through completion, failure, or cancellation

#### Scenario: Provider request completes during an active turn

- **WHEN** Codex appends provider request start and completion events before the app-server turn completes
- **THEN** the corresponding public model lifecycle diagnostics become observable while the turn is still active
- **AND** consumers do not need to wait for `agent_end` to create or complete the corresponding observation

#### Scenario: Terminal event arrives without an observed start

- **WHEN** the monitor first observes a provider terminal event after its start record was missed
- **THEN** the runtime publishes one synthetic start followed by the terminal event with the same call identity and provider request index

#### Scenario: A lifecycle event is delivered more than once

- **WHEN** background polling and final drain encounter the same provider lifecycle record
- **THEN** the runtime publishes that start or terminal event only once

#### Scenario: Final monitor drain emits no new events

- **WHEN** the background monitor already emitted the provider-request lifecycle before terminal finalization
- **THEN** the runtime still waits for queued diagnostic delivery before aggregate terminal hooks and `agent_end`
- **AND** no late provider-request observation appears after final drain completes

#### Scenario: Attempt exits through an error path

- **WHEN** the active turn throws, times out, or is cancelled
- **THEN** the rollout monitor stops idempotently and does not continue polling after attempt cleanup

### Requirement: Tool lifecycle observability

The runtime SHALL emit internal before/after tool diagnostics with stable tool identity, sanitized call data, result or error, and timing. When reduced rollout evidence links a tool to an inference, the diagnostic SHALL carry that triggering provider-call identity. When only stable native-child ownership is available, it SHALL carry the child thread without fabricating a provider parent. Event order alone SHALL NOT establish provider ownership.

#### Scenario: Tool has stable inference linkage

- **WHEN** a reduced inference record names the tool call as started by that response
- **THEN** the tool diagnostic carries the matching provider-call identity

#### Scenario: Tool has only child ownership

- **WHEN** a child tool event has a stable child thread but no stable inference relationship
- **THEN** the diagnostic carries child ownership only
- **AND** it does not assign the latest preceding inference

### Requirement: Runtime and transport metadata

The runtime SHALL expose available engine, runtime, channel/transport, session, and request identifiers as bounded metadata without requiring a plugin to load internal modules.

#### Scenario: Runtime metadata is available

- **WHEN** a Codex turn is delivered through a known transport and runtime engine
- **THEN** public hook payloads provide those identifiers for correlation and filtering

#### Scenario: Metadata is unavailable

- **WHEN** a field is not available at the public boundary
- **THEN** the runtime omits that field or marks it unknown rather than fabricating a value or failing the turn

### Requirement: Native compaction ownership

The runtime SHALL determine Codex native compaction ownership from the active
turn's harness provenance before falling back to persisted session metadata.
OpenClaw transcript/context-engine compaction SHALL NOT replace Codex app-server
automatic compaction when the active Codex runtime owns the turn. This decision
is per-turn and SHALL NOT persist a temporary harness marker into session state.
Unknown or non-native runtimes SHALL retain their existing compaction behavior.

#### Scenario: Active Codex runtime has no persisted harness marker

- **WHEN** a Codex app-server turn completes in a session whose persisted entry has no `agentHarnessId`
- **THEN** the compaction lifecycle uses the turn result's Codex harness provenance
- **AND** it defers automatic compaction ownership to Codex
- **AND** it does not invoke OpenClaw transcript/context-engine compaction solely because the session marker is absent

#### Scenario: Non-Codex runtime has stale session metadata

- **WHEN** the active turn identifies a non-Codex runtime while the persisted session retains an older native harness id
- **THEN** the active turn's provenance takes precedence
- **AND** the runtime does not route that turn through Codex native compaction

### Requirement: Minimal seam policy

The runtime SHALL use existing public hooks for all observable events and SHALL add a core or SDK seam only when a required event cannot be reached otherwise; any seam MUST be additive, narrowly scoped, documented, and covered by focused tests.

#### Scenario: Existing hooks are sufficient

- **WHEN** the required model and tool facts are available through current hooks
- **THEN** no Codex core-path modification is required for the plugin

#### Scenario: A required event is unreachable

- **WHEN** a required observable event is proven absent from current public hooks
- **THEN** the implementation adds only the smallest additive seam needed to publish that event and verifies both the new path and existing hook behavior

### Requirement: Sandbox-readable plugin skills

The Codex runtime SHALL preserve plugin skill discovery while ensuring every skill location shown to a sandboxed model is readable inside the selected sandbox environment.

#### Scenario: Plugin skill is used in a writable sandbox

- **WHEN** an enabled plugin declares a skill directory and a Codex turn runs in a writable sandbox
- **THEN** the skill remains present in `<available_skills>`
- **AND** its `<location>` points to the materialized container path under `/workspace/.openclaw/sandbox-skills/skills`
- **AND** reading that exact path succeeds inside the sandbox

#### Scenario: Host discovery uses plugin-skills symlinks

- **WHEN** OpenClaw discovers an enabled plugin skill through its generated host `plugin-skills` symlink
- **THEN** the sandbox prompt does not contain the host symlink path, host home shorthand, or the plugin source checkout path
- **AND** the plugin source remains owned by the plugin's declared `skills` directory rather than being copied manually into `plugin-skills`

#### Scenario: Skill has relative reference files

- **WHEN** a selected plugin skill declares or links a file under its own `references` directory
- **THEN** the model can resolve and read that file relative to the materialized skill directory
- **AND** the reference read does not escape to the plugin source checkout or host discovery symlink

#### Scenario: A later turn resumes the Codex thread

- **WHEN** a later turn in the same OpenClaw session resumes an existing Codex thread
- **THEN** the turn collaboration instructions still contain the container-readable plugin skill catalog
- **AND** the resumed turn can read a different plugin skill without an initial host-path failure
- **AND** the catalog is not duplicated into the user message

#### Scenario: Materialized skill is unavailable

- **WHEN** a sandbox run has a host snapshot for a skill but the materialized skills workspace does not contain an eligible copy
- **THEN** the runtime omits that skill from the sandbox prompt
- **AND** it does not fall back to the host snapshot or expose its unreadable location

#### Scenario: Harness runs without a sandbox

- **WHEN** the same harness resolves skills for a non-sandboxed run
- **THEN** it preserves the existing skills snapshot prompt without sandbox path rewriting

#### Scenario: First-use skill continues into a business tool

- **WHEN** a fresh Codex session selects a plugin skill that requires a read-only business tool
- **THEN** skill discovery, `SKILL.md`, and declared reference reads complete before the business tool is invoked
- **AND** the business tool and final Codex turn can complete without a skill-path failure

#### Scenario: Orchestrator resource catalog is empty

- **WHEN** a plugin skill is supplied as a file-backed `<available_skills>` entry and no orchestrator-owned skill resource is registered
- **THEN** `skills.list` for orchestrator authority may return an empty catalog without removing the file-backed skill
- **AND** the model can read the sandbox-materialized `<location>` directly without treating the empty resource catalog as a configuration failure

### Requirement: Deployed Codex end-to-end acceptance

The Codex runtime SHALL be accepted on 2026.7.1 only through the isolated deployed Gateway using the matching checkout CLI and state/config roots; unit tests, embedded source-only probes, and a newer globally installed CLI SHALL NOT substitute for this proof.

#### Scenario: Two real turns use one deployed session

- **WHEN** the matching 7.1 CLI sends two business requests through port 19789 with the same explicit session key
- **THEN** both requests resolve to the same OpenClaw session identity
- **AND** the second request can use value-bearing context from the first response
- **AND** both requests invoke the real read-only business tool and return a successful final reply
- **AND** tool summaries report no failures

#### Scenario: Codex thread remains resumable

- **WHEN** the second request starts after the first request completes
- **THEN** it resumes the first request's Codex thread with a distinct turn identity
- **OR** the runtime records an explicit supported rotation reason, such as a changed dynamic-tool catalog, before starting the replacement thread
- **AND** an aggregate `replayInvalid` flag alone is not treated as proof that resume failed

#### Scenario: Parallel 7.2 instance is present

- **WHEN** the isolated 7.1 Gateway is rebuilt or restarted for acceptance
- **THEN** only port 19789 is changed
- **AND** the separate 18789 listener remains running and is not used as the 7.1 test target

### Requirement: Internal Codex native-child lifecycle diagnostics

The bundled Codex app-server runtime SHALL optionally emit versioned internal native-child lifecycle diagnostics when it can prove that the active parent OpenClaw turn owns the named child thread. Each admitted event SHALL carry a stable source event id, parent run/turn identity, parent Codex thread identity, child thread identity, lifecycle kind, timestamp, and version. Child turn id, role, effective model, reasoning effort, depth, and classified outcome MAY be included only when supplied by the app-server boundary. Task paths remain internal correlation inputs and SHALL NOT be copied into lifecycle diagnostics. Lifecycle and status events SHALL use the same ordered async diagnostic stream as child model/tool events, and the final status SHALL follow every earlier child call diagnostic it summarizes. The runtime SHALL NOT add an ACP/ACPX event, capability, public plugin hook, dedicated Plugin SDK entrypoint, or hook-specific public event type for this feature. Additive variants MAY extend the existing internal diagnostic event union used by the supported plugin boundary.

#### Scenario: Codex starts a native child

- **WHEN** the app-server reports a child thread or sub-agent activity bound to the active parent turn
- **THEN** the internal diagnostics stream emits one idempotent child lifecycle event
- **AND** duplicate delivery retains the same source identity

#### Scenario: MultiAgent v2 exposes only spawn activity

- **WHEN** the parent receives `subAgentActivity` with `kind = started`, stable parent/child thread ids, and the originating spawn call id
- **THEN** the runtime classifies it as an authoritative `started` lifecycle fact
- **AND** later duplicate item delivery does not create a second child start

#### Scenario: Role and task path differ

- **WHEN** Codex supplies both `agent_role` and a distinct `agent_path` or task name
- **THEN** lifecycle diagnostics preserve `agent_role` as the role and keep `agent_path` internal
- **AND** the runtime does not derive the configured role from the task-name path suffix

#### Scenario: MultiAgent v2 omits role from parent activity

- **WHEN** a successful v2 spawn exposes `agent_type` on the spawn request and the child activity exposes the same stable originating spawn call id but no role
- **THEN** observability may join those exact facts by the stable call id and report `agent_type` as the configured child role
- **AND** it does not derive role from task path, nickname, model, prompt text, or event arrival order

#### Scenario: Child reaches a terminal state

- **WHEN** a proven child turn completes, fails, is cancelled, is interrupted, or times out
- **THEN** the runtime emits the classified terminal lifecycle fact when sufficient evidence exists
- **AND** the parent turn remains independently able to complete

#### Scenario: Child thread enters system error with an active diagnostic turn

- **WHEN** the app-server reports `systemError` for a proven child whose rollout diagnostic turn has not finalized
- **THEN** the monitor performs that turn's existing best-effort final drain exactly once
- **AND** queued child model/tool diagnostics are delivered before the failed terminal lifecycle fact
- **AND** drain failure or timeout remains observability-only and does not replace the parent outcome

#### Scenario: Child fact cannot be bound

- **WHEN** a notification lacks stable parent-turn or child-thread identity
- **THEN** no unscoped child lifecycle event is emitted
- **AND** a bounded diagnostic marks otherwise observed coverage partial

#### Scenario: Final status follows child calls

- **WHEN** a child drain emits model or tool diagnostics before its final native-child status
- **THEN** the internal diagnostic stream delivers those call diagnostics before the status
- **AND** the consumer does not classify complete coverage before processing the queued child facts

### Requirement: Exact child rollout ownership

The Codex app-server monitor SHALL start and finalize rollout diagnostics for each proven child `threadId + turnId`. Model and tool diagnostics from that drain SHALL retain the parent OpenClaw run/turn and the child thread identity. A tool SHALL carry its triggering provider-call identity only when reduced rollout evidence proves the relationship.

#### Scenario: One child performs multiple model and tool calls

- **WHEN** one child turn contains multiple inference and tool calls
- **THEN** each diagnostic retains that child thread and parent turn identity
- **AND** a tool is linked to an inference only through the reduced inference record's owned tool ids

#### Scenario: Concurrent children interleave

- **WHEN** two children run concurrently
- **THEN** exact thread/turn filtering keeps their model, tool, lifecycle, and outcome facts distinct
- **AND** event arrival order does not reassign ownership

#### Scenario: Raw tool has no inference identity

- **WHEN** a raw tool event proves child ownership but has no inference-call relationship
- **THEN** the diagnostic omits the triggering provider-call identity
- **AND** consumers may parent it directly to the child as partial parenting

### Requirement: Optional bounded enrichment

Native-child diagnostics SHALL be best-effort and optional. No child diagnostics, a missing rollout bundle, an unknown optional field, a drain failure, or an observability exception SHALL preserve existing parent turn, model, tool, and terminal behavior. Enrichment SHALL admit at most 64 active children, 4,096 lifecycle/call mutations, 16,384 UTF-8 metadata bytes per event, and 512 pending ownership joins per turn. Each child turn MAY perform one best-effort final drain. Root finalization SHALL wait no longer than one 500-millisecond window across joined-child drains; unresolved joined work SHALL degrade root coverage without delaying the parent further. A detached child SHALL retain its own terminal/drain lifecycle and SHALL NOT extend the root finalization window.

#### Scenario: Turn has no compatible diagnostics

- **WHEN** the runtime creates no native child or cannot expose stable child facts
- **THEN** existing parent-only diagnostics remain unchanged
- **AND** consumers classify child lineage as unsupported rather than failed

#### Scenario: Telemetry volume is excessive

- **WHEN** a documented bound is exceeded
- **THEN** duplicate or non-terminal updates are discarded before unique start/terminal facts
- **AND** coverage becomes partial without delaying or failing the Agent turn

#### Scenario: Fact arrives after its owning trace finalization

- **WHEN** a child fact arrives after that child trace's admission window closes
- **THEN** the runtime does not reopen the child trace or delay a root response
- **AND** it emits at most one bounded producer-contract diagnostic

#### Scenario: Multiple joined-child drains remain unsettled

- **WHEN** concurrent joined-child drains cannot all settle within the root finalization window
- **THEN** the producer records partial drain coverage and stops waiting after 500 milliseconds total
- **AND** the parent turn continues without accumulating one timeout per child

#### Scenario: Joined-child fact arrives during the root finalization window

- **WHEN** a stable child lifecycle or turn fact arrives before the 500-millisecond parent finalization window closes
- **THEN** the producer admits the bounded fact instead of classifying it as post-finalization
- **AND** any newly observed turn that cannot be drained within the same window makes coverage partial

#### Scenario: Detached child outlives the root turn

- **WHEN** the parent finalizes without depending on an active child result
- **THEN** the root trace closes without waiting beyond its bounded window
- **AND** the producer continues the detached child's own bounded diagnostics until that child turn settles
- **AND** later child facts are not classified as late solely because the root trace already finalized

### Requirement: Privacy-minimal lifecycle

Internal child lifecycle diagnostics SHALL exclude prompt text, spawn task bodies, task-name/agent paths, model inputs or outputs, tool arguments or results, raw filesystem paths, credentials, credential references, account identifiers, and deployment-specific business policy. Existing model/tool diagnostic payload settings remain separate.

#### Scenario: Spawn task contains private data

- **WHEN** a child is spawned with private or business content
- **THEN** the lifecycle diagnostic contains only allowed identity, timing, topology, model/role, and outcome fields
- **AND** the task body is not copied

### Requirement: Child request context facts

The Codex rollout producer SHALL attach bounded, privacy-minimal prompt
statistics to child model-call diagnostics when the reduced provider request is
available. The facts MAY include system-prompt, input-message, and tool-definition
counts/sizes plus namespaced hashes, alongside the already emitted provider/model
identity. The producer SHALL compute these facts from the exact child request and
SHALL NOT emit the request text, spawn task body, full conversation, tool
arguments/results, credentials, or paths. Missing request payloads remain a
best-effort observability gap and SHALL NOT change child execution.

For system-prompt statistics, the producer SHALL prefer a non-empty top-level
`instructions` string. When top-level instructions are absent or empty, it SHALL use
the ordered textual content of `request.input` messages whose role is `system` or
`developer`. The diagnostic SHALL identify the selected source as `instructions` or
`input_messages` and SHALL emit only the bounded character count and namespaced hash,
not the raw prompt. Additional-tools records and user/assistant content SHALL NOT be
misclassified as system instructions. When the selected source is `input_messages`,
`totalChars` SHALL NOT count the same embedded instruction text a second time.

#### Scenario: Child rollout request is readable

- **WHEN** a child inference record has a readable request payload
- **THEN** its model-call diagnostic includes bounded context facts
- **AND** the diagnostic retains the child thread and parent turn identities

#### Scenario: Responses Lite embeds developer instructions in input

- **WHEN** a child request has no non-empty top-level `instructions` and contains textual `developer` or `system` input messages
- **THEN** prompt statistics report `systemPromptSource = input_messages`
- **AND** the size/hash cover only the ordered instruction-message text
- **AND** no raw instruction text is emitted in lifecycle or prompt-stat metadata

#### Scenario: Child rollout request is missing

- **WHEN** a child lifecycle is available but its request payload cannot be read
- **THEN** the lifecycle and any available model/tool diagnostics are still emitted
- **AND** consumers may classify the trace partial without fabricating context facts
