## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Tool lifecycle observability

The runtime SHALL emit internal before/after tool diagnostics with stable tool identity, sanitized call data, result or error, and timing. When reduced rollout evidence links a tool to an inference, the diagnostic SHALL carry that triggering provider-call identity. When only stable native-child ownership is available, it SHALL carry the child thread without fabricating a provider parent. Event order alone SHALL NOT establish provider ownership.

#### Scenario: Tool has stable inference linkage

- **WHEN** a reduced inference record names the tool call as started by that response
- **THEN** the tool diagnostic carries the matching provider-call identity

#### Scenario: Tool has only child ownership

- **WHEN** a child tool event has a stable child thread but no stable inference relationship
- **THEN** the diagnostic carries child ownership only
- **AND** it does not assign the latest preceding inference
