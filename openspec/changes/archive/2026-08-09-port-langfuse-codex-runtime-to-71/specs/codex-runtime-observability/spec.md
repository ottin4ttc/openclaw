## Purpose

Make Codex app-server turns observable through the public OpenClaw runtime lifecycle so the Langfuse plugin can correlate model, tool, usage, transport, and failure data without coupling to private Codex internals.

## ADDED Requirements

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

The runtime SHALL expose public before/after tool events with tool identity, sanitized call data, result or error, and timing sufficient for a plugin observation.

#### Scenario: Tool is triggered by a provider response

- **WHEN** a provider response starts a tool execution during a multi-request turn
- **THEN** the rollout lifecycle preserves source ordering sufficient for the consumer to attach the tool to the latest preceding provider generation
- **AND** an equivalent native tool lifecycle is suppressed only after the rollout lifecycle has been delivered

#### Scenario: Tool succeeds

- **WHEN** a Codex tool call completes successfully
- **THEN** the paired public events identify the same tool call and expose its result and duration

#### Scenario: Tool fails

- **WHEN** a Codex tool call returns an error or is denied
- **THEN** the paired lifecycle data exposes the failure outcome and preserves the surrounding turn's terminal state

### Requirement: Runtime and transport metadata

The runtime SHALL expose available engine, runtime, channel/transport, session, and request identifiers as bounded metadata without requiring a plugin to load internal modules.

#### Scenario: Runtime metadata is available

- **WHEN** a Codex turn is delivered through a known transport and runtime engine
- **THEN** public hook payloads provide those identifiers for correlation and filtering

#### Scenario: Metadata is unavailable

- **WHEN** a field is not available at the public boundary
- **THEN** the runtime omits that field or marks it unknown rather than fabricating a value or failing the turn

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
