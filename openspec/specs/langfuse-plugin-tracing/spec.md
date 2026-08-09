# langfuse-plugin-tracing Specification

## Purpose

Provide an independently installable Langfuse plugin that records OpenClaw model, tool, and recovery activity on the 2026.7.1 host without changing the host's session-storage contract.

## Requirements

### Requirement: Independent plugin lifecycle

The plugin SHALL load and unload through the public OpenClaw plugin contract, own its Langfuse runtime dependencies, and remain usable without a private or core-only plugin identifier.

#### Scenario: Plugin is discovered on the 7.1 host

- **WHEN** the plugin is installed and OpenClaw starts from `v2026.7.1-2`
- **THEN** the plugin manifest is accepted by the host and its runtime entry point can initialize without importing private OpenClaw modules

#### Scenario: Plugin is disabled or unloaded

- **WHEN** the plugin is disabled or its host lifecycle is shut down
- **THEN** it stops creating new observations, flushes pending delivery when possible, and does not prevent the host from shutting down

### Requirement: Trace model and tool activity

The plugin SHALL create a stable trace for each observable agent turn and SHALL record every distinct provider request and tool-call lifecycle when those events are available through public runtime hooks.

#### Scenario: Successful model turn

- **WHEN** an agent turn emits input and output lifecycle events
- **THEN** Langfuse receives one correlated trace whose provider-request generations contain the available model, input, output, timing, usage, and error metadata

#### Scenario: Tool call completes

- **WHEN** a tool call starts and completes during a traced turn
- **THEN** the trace contains one correlated tool observation with its name, sanitized arguments, result or error, and duration when available
- **AND** its parent observation is the provider-request generation that triggered the tool

#### Scenario: Turn fails

- **WHEN** the model or tool path ends with an error
- **THEN** the trace records the failure outcome and error metadata without throwing an additional uncaught plugin error into the agent runtime

### Requirement: Canonical pre-turn conversation context

The plugin SHALL record the canonical conversation history that existed before the current user prompt as top-level trace metadata, using `prior_conversation` and its count, truncation, and hash fields. The exported history SHALL be a bounded value projection containing only API-shaped `role`, `content`, `tool_calls`, and `tool_call_id` fields; runtime envelopes such as provider/model, usage, timestamps, idempotency keys, and internal mirror metadata SHALL NOT be copied into this projection. On a 7.1 host it SHALL accept the public `before_agent_run.messages` field as that history; when a newer host supplies `priorMessages`, that explicit alias takes precedence.

#### Scenario: Second turn in one Codex session

- **WHEN** a Codex session completes one user/assistant turn and starts a second turn
- **THEN** the second trace top-level metadata contains a non-empty `prior_conversation` representing the first turn
- **AND** `prior_conversation_message_count` matches the supplied source rows while `prior_conversation_retained_message_count` matches the projected rows retained after filtering and size bounds
- **AND** `prior_conversation_projection` identifies the value projection used for the exported rows
- **AND** the exported rows do not contain runtime envelopes or internal mirror metadata
- **AND** the trace is not accepted if an empty `llm_input` fallback overwrites or prevents this canonical history

#### Scenario: First turn has no prior history

- **WHEN** a Codex session starts its first user turn with no earlier messages
- **THEN** `prior_conversation` may be empty and its message counts are zero
- **AND** this first-turn state is not treated as evidence for the second-turn scenario

### Requirement: Provider-request generation fidelity

The plugin SHALL map each stable provider-request call identity to exactly one ordered `llm-call-N` generation, create that generation as soon as the provider start diagnostic is delivered, and update the same observation at terminal delivery.

#### Scenario: One turn makes three provider requests

- **WHEN** provider-request diagnostics identify three concrete calls in one turn
- **THEN** the trace contains exactly `llm-call-1`, `llm-call-2`, and `llm-call-3` for those calls
- **AND** no additional aggregate generation is created after provider-request ownership is established

#### Scenario: Provider request is visible during execution

- **WHEN** a provider start diagnostic is delivered while the agent turn is still running
- **THEN** its `llm-call-N` generation is queryable before `agent_end`
- **AND** the terminal diagnostic later updates the same observation identifier with output, end time, usage, and failure metadata when available

#### Scenario: First provider request reuses a hook generation

- **WHEN** aggregate hooks already created the first generation before provider diagnostics arrive
- **THEN** the first provider request claims and enriches that generation instead of creating a duplicate
- **AND** later provider requests receive their own ordered generations

#### Scenario: Provider lifecycle is late or repeated

- **WHEN** a terminal-only event, late start, or repeated diagnostic is delivered
- **THEN** the plugin creates or updates at most one generation for that provider call identity
- **AND** the generation index and observation identifier remain stable

### Requirement: Langfuse API acceptance evidence

The deployment SHALL be considered valid only when the Langfuse observations API confirms the provider generations and tool parent relationships; a trace root, aggregate generation, or UI-only view is insufficient evidence.

#### Scenario: Inspect a completed multi-tool trace

- **WHEN** a real Codex request on the isolated 19789 deployment completes and its trace is queried through `/api/public/observations?traceId=...`
- **THEN** every provider generation has a stable identifier, input, output or classified terminal error, end time, and usage when supplied by the provider
- **AND** every rollout tool observation has the expected provider generation as `parentObservationId`

#### Scenario: Inspect an active trace

- **WHEN** the observations API is queried after a provider start but before the turn ends
- **THEN** the started `llm-call-N` generation is already present without waiting for aggregate `agent_end` processing

#### Scenario: Inspect two turns from one deployed session

- **WHEN** two completed real business turns share one explicit 19789 session key
- **THEN** both trace API records use that same session key
- **AND** the second trace has a non-empty canonical `prior_conversation`
- **AND** the observations API shows at least two provider generations and two tool spans across the acceptance scenario
- **AND** every provider generation has input, output or classified terminal error, end time, model, and provider-supplied usage
- **AND** every tool span has input, output or classified error, end time, and a `parentObservationId` that resolves to a generation in the same trace

#### Scenario: Downloaded trace export omits observation details

- **WHEN** a downloaded trace JSON omits observation input or output fields
- **THEN** acceptance queries the public observations API for the same trace before classifying the data as missing
- **AND** complete API observation records are treated as authoritative over the reduced download representation

### Requirement: Deployed bundle parity

The live 19789 Gateway SHALL load a generated Langfuse plugin bundle that corresponds to the source under test; source code or unit-test behavior that is absent from the loaded `dist` SHALL NOT be accepted as deployed behavior.

#### Scenario: Source changes projection behavior

- **WHEN** the source adds or changes a trace metadata contract such as `prior_conversation_projection`
- **THEN** the package-local runtime build regenerates `extensions/openclaw-langfuse/dist/index.js`
- **AND** a sentinel search confirms the new contract is present in the generated bundle before restart
- **AND** only the isolated 19789 Gateway is restarted before the E2E request
- **AND** the post-restart log confirms the Langfuse plugin initialized successfully

#### Scenario: Generated bundle is stale

- **WHEN** the source contains a required trace contract but the bundle loaded by the Gateway does not
- **THEN** the mismatch is classified as a deployment artifact failure
- **AND** Langfuse output from that process is not used to reject the current source implementation until the package-local bundle is rebuilt and the scenario is rerun

### Requirement: Privacy-preserving observation data

The plugin SHALL redact configured sensitive values before exporting prompts, completions, tool arguments, tool results, metadata, or error details, and SHALL avoid exporting credentials by default.

#### Scenario: Sensitive content is observed

- **WHEN** an input, output, argument, result, or error contains a configured secret or sensitive field
- **THEN** the exported observation contains the configured redaction marker or omission and does not contain the original secret

#### Scenario: Credentials are absent

- **WHEN** Langfuse credentials are missing or incomplete
- **THEN** the plugin reports a visible diagnostic/recovery status, keeps the host operation functional, and does not claim successful delivery

### Requirement: Delivery and recovery visibility

The plugin SHALL expose delivery outcomes and recovery actions through the host's public diagnostics or plugin status surfaces, including queued, delivered, failed, and flushed states.

#### Scenario: Buffered observations flush

- **WHEN** the plugin lifecycle reaches a flush or shutdown boundary
- **THEN** pending observations are flushed using the configured Langfuse lifecycle and the resulting delivery status is recorded

#### Scenario: Delivery fails

- **WHEN** Langfuse export fails or times out
- **THEN** the plugin records a bounded failure diagnostic with an actionable recovery indication and leaves the host agent turn unaffected

### Requirement: 7.1 session compatibility

The plugin SHALL read the 2026.7.1 JSON/JSONL session representation through public 7.1 file-backed APIs and SHALL NOT create, migrate, or require the later SQLite session schema.

#### Scenario: Recover a prior session

- **WHEN** a recovery or prompt-management operation requests an existing 7.1 session
- **THEN** the plugin resolves and reads the file-backed session data and correlates it to the Langfuse trace without writing a parallel session store

#### Scenario: SQLite-only session APIs are unavailable

- **WHEN** the host exposes no 7.2 SQLite session accessor
- **THEN** the plugin still loads and performs supported tracing/recovery using its local 7.1 compatibility adapter
