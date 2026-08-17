## Purpose

Define non-destructive OpenMAI role/model routing for OpenClaw 2026.7.1 while preserving existing Codex state, parent-owned tools, Lark safety, and reversible Agent lifecycle behavior. The native Codex app-server path uses the existing per-Agent home. ACP/ACPX are outside this capability; this change does not add automatic runtime switching or a Codex-home selector.

## ADDED Requirements

### Requirement: Native per-Agent Codex-home boundary

An OpenMAI Agent SHALL use OpenClaw 2026.7.1's existing native `CODEX_HOME = <agentDir>/codex-home` boundary. The OpenMAI plugin SHALL install its common role catalog into that existing home and SHALL NOT write ACP/ACPX runtime options, add a Codex-home selector, or read global `~/.codex`. ACP/ACPX are not provisioning or acceptance paths for this capability.

#### Scenario: OpenMAI Agent is created

- **WHEN** the OpenMAI plugin creates a new per-user Agent
- **THEN** its normal Agent entry contains the canonical id, workspace, Agent directory, and other existing OpenMAI-owned settings
- **AND** the plugin does not create or rewrite the Agent's runtime selection
- **AND** a native Codex app-server launch resolves `CODEX_HOME` from that `agentDir`

#### Scenario: Another Agent runs in the same instance on the native path

- **WHEN** two OpenMAI Agents use native Codex sessions
- **THEN** each launch resolves its own `<agentDir>/codex-home`
- **AND** neither Agent reads roles or runtime state from the other Agent home
- **AND** no shared ACP/ACPX role directory participates in their native routing

### Requirement: Configuration-only customization boundary

All OpenMAI role ids, model mappings, skill policy, tool ownership, Agent identity, and deployment paths SHALL live in the target Agent workspace, its existing native `CODEX_HOME`, or the OpenMAI provisioner. OpenClaw core and ACPX SHALL contain no OpenMAI home-selection mechanism.

#### Scenario: Default OpenClaw instance starts

- **WHEN** an instance has no OpenMAI Agent or profile
- **THEN** startup and normal Agent behavior are unchanged
- **AND** no OpenMAI role catalog is loaded

### Requirement: Non-destructive Codex profile merge

The provisioner SHALL add only the approved `features.multi_agent_v2` values, `agents.max_depth`, four role declarations, four role files, and the delimited workspace guidance. It SHALL preserve unknown top-level config, provider/model config, unknown feature keys, unknown Agent declarations, unknown `agents/*.toml`, `auth.json`, SQLite databases, sessions, logs, skills, caches, rollout traces, and every other unmanaged artifact. `config.toml` SHALL have mode `0600` after every successful write.

An absent approved field MAY be created and owned by OpenMAI. An existing field with the exact approved value SHALL be accepted as unowned. An existing conflicting value SHALL fail preparation before promotion rather than being overwritten.

#### Scenario: Existing provider and role config is present

- **WHEN** the Agent home already contains provider tables, unrelated feature values, unrelated Agent declarations, and unknown role files
- **THEN** profile preparation preserves all of them semantically
- **AND** it adds only non-conflicting approved OpenMAI values
- **AND** the resulting `config.toml` mode is `0600`

#### Scenario: Approved field conflicts

- **WHEN** an existing approved path has a different value or a same-named role file contains different unowned content
- **THEN** preparation fails before promotion
- **AND** the current home and Agent entry remain unchanged

#### Scenario: Runtime state is present

- **WHEN** `auth.json`, SQLite WAL/SHM files, sessions, logs, or rollout traces exist during install, reconcile, rollback, or deletion
- **THEN** the provisioner neither reads their secret contents nor modifies or deletes them

### Requirement: Explicit ownership and safe deletion

The profile SHALL persist a versioned, bounded, non-secret ownership manifest and SHALL mark generated role files. The manifest SHALL record only OpenMAI-created config paths, OpenMAI-created role filenames, profile version, and approved-value fingerprints. It SHALL NOT contain credentials, provider tokens, arbitrary paths, prompts, or personal data.

Deletion SHALL remove a config field only when the manifest owns it and its current value still equals the approved value. It SHALL remove a role file only when the manifest owns it, the ownership marker is present, and the content still equals the approved template. It SHALL never delete the complete `config.toml` or `agents/` directory.

#### Scenario: Unknown role file exists

- **WHEN** profile deletion runs while `agents/custom.toml` is unowned
- **THEN** `custom.toml` remains unchanged
- **AND** only eligible OpenMAI-owned role files are removed

#### Scenario: Owned value was edited later

- **WHEN** an OpenMAI-owned config field or role file no longer matches the approved value
- **THEN** deletion retains it and reports a contested ownership mismatch
- **AND** it does not overwrite the later edit

#### Scenario: Ownership manifest is absent

- **WHEN** cleanup cannot prove ownership
- **THEN** it may remove only the separately delimited workspace guidance
- **AND** it does not delete `config.toml`, `agents/`, or any role file

#### Scenario: Ownership manifest is invalid

- **WHEN** cleanup finds malformed ownership metadata or an unsupported manifest version
- **THEN** it removes no managed config field or role file and returns a visible repair-required error
- **AND** Agent deletion retains the Agent entry and exact custom paths for retry
- **AND** the route layer still removes the separate delegation credential and invalidates JWT state

### Requirement: Targeted promotion, rollback, and recovery

Preparation SHALL stage and validate the target config, four role files, ownership manifest, and workspace block. The recovery journal SHALL record original bytes and modes only for touched artifacts. Promotion and rollback SHALL modify only those artifacts. Rollback SHALL restore an artifact only when its current bytes still match the promoted bytes, so concurrent or later edits are not overwritten.

#### Scenario: Agent config persistence fails

- **WHEN** the profile is promoted but OpenClaw Agent config mutation fails
- **THEN** rollback restores the prior touched artifacts
- **AND** unrelated files created before or during the attempt remain present

#### Scenario: Process crashes after promotion

- **WHEN** a recovery journal is found on the next reconcile
- **THEN** a valid promoted profile is finalized or the previous touched artifacts are restored
- **AND** recovery never replaces the complete Codex home or role directory

### Requirement: Explicit role and model mapping

The Agent-local catalog SHALL map `talent_analyst` to `gpt-5.6-terra`/high, `lark_reader` to `gpt-5.6-terra`/medium, `draft_writer` to `gpt-5.6-luna`/low, and `result_verifier` to `gpt-5.6-sol`/high. Role files SHALL omit `model_provider`, `service_tier`, and `developer_instructions`.

#### Scenario: Parent delegates bounded analysis

- **WHEN** the Sol parent spawns `talent_analyst`
- **THEN** the child resolves Terra/high through the active parent provider boundary

#### Scenario: Specialist model is unavailable

- **WHEN** Terra or Luna cannot be resolved
- **THEN** the specialist lane fails visibly without silent relabelling or substitution
- **AND** the Sol parent remains usable

### Requirement: Parent-owned delegation and side effects

The root SHALL select roles, own every `openmai_internal_api_call`, own all Lark writes and high-risk confirmation, integrate child results, and produce the final answer. Children SHALL receive bounded facts plus stable source ids. Native child nesting SHALL be depth one, no more than four children SHALL be active concurrently, and role/model overrides SHALL use `fork_turns = "none"` or a finite positive fork.

#### Scenario: Child needs OpenMAI data

- **WHEN** analysis requires an OpenMAI skill
- **THEN** the parent performs the dynamic-tool call and passes only the required bounded result fields
- **AND** the child returns a handoff request rather than fabricating data when more data is required

#### Scenario: Lark read lane is not proven

- **WHEN** binary, identity, guidance, or permission smoke evidence is missing
- **THEN** `lark_reader` remains unroutable
- **AND** all Lark operations stay in the parent

### Requirement: Conditional native delegation for complex candidate matching

The OpenMAI candidate-match route SHALL explicitly authorize Codex native delegation while keeping every live OpenMAI lookup in the root. After the root has loaded candidate facts, recalled current jobs, applied any required Pipeline intersection, and read job details, two or more distinct jobs entering candidate-fit comparison SHALL require one bounded `talent_analyst` child. A final answer that ranks or recommends two or more jobs SHALL additionally require one bounded `result_verifier` child before the root answers. Both children SHALL use `fork_turns = "none"` and receive only redacted candidate facts, required job facts, and stable job ids.

Single-job detail or field lookup, fewer than two jobs entering comparison, career-direction analysis without live-job matching, and answers without a multi-job ranking SHALL NOT spawn a child merely to satisfy an observability shape. An unavailable collaboration tool or configured role SHALL degrade visibly while the root business path remains usable.

#### Scenario: Natural multi-job candidate match

- **WHEN** a user naturally asks which current jobs fit a supplied candidate without mentioning subagents
- **AND** the root obtains details for at least two distinct jobs and intends to rank or recommend multiple jobs
- **THEN** the root spawns `talent_analyst` for bounded comparison
- **AND** the root spawns `result_verifier` before producing the ranked recommendation
- **AND** the final answer integrates both child results while retaining all live API calls in the root

#### Scenario: Simple candidate lookup

- **WHEN** the request is a single-job detail or field lookup, fewer than two jobs enter comparison, or no multi-job ranking is produced
- **THEN** the root completes the request without spawning solely for trace shape

### Requirement: Delegation credential transaction safety

The OpenMAI delegation credential SHALL remain separate from Codex authentication. Agent creation, delegation-token persistence or rollback, deletion, and credential/JWT cleanup for one normalized Agent id SHALL be serialized. A failed credential write after first-time Agent creation SHALL roll back the new Agent/profile and partial credential. Deletion SHALL retain the Agent entry and its exact paths until delegation credential/JWT cleanup and profile cleanup succeed. Delegation cleanup SHALL complete before profile and Agent-entry deletion, and profile cleanup SHALL complete before Agent-entry deletion, so either failure leaves a durable retry anchor.

#### Scenario: Delegation token persistence fails

- **WHEN** Agent creation succeeds but `CredentialManager.setCredentials` fails
- **THEN** the new Agent entry and OpenMAI-owned profile are rolled back
- **AND** no partial delegation credential remains

#### Scenario: Profile cleanup fails before Agent deletion

- **WHEN** profile cleanup throws while deleting an Agent, including because its ownership manifest is invalid
- **THEN** delegation credentials are removed and JWT cache is invalidated
- **AND** the Agent entry and exact custom paths remain available for a retry
- **AND** the cleanup error remains visible

#### Scenario: Delegation cleanup fails before Agent deletion

- **WHEN** delegation credential removal or JWT invalidation fails while deleting an Agent
- **THEN** profile cleanup and Agent-entry deletion do not run
- **AND** the Agent entry and exact custom paths remain available for a retry
- **AND** a later delete retries delegation cleanup before removing the Agent

#### Scenario: Create and delete overlap credential persistence

- **WHEN** deletion for one Agent id arrives while its delegation credential is still being persisted
- **THEN** deletion waits for the create transaction to settle
- **AND** no credential can be written after the delete cleanup finishes

### Requirement: Runtime and Langfuse routing acceptance

Native-path acceptance SHALL use one stable deployed OpenClaw session and runtime evidence. It SHALL confirm the target process uses `<agentDir>/codex-home`, exercise Sol-to-Terra, Sol-to-Luna, and Sol-to-Sol delegation, bounded concurrency, follow-up, recursive-child rejection, parent-owned OpenMAI calls, and Lark gating. The final natural-business acceptance SHALL use a prompt that does not mention `spawn_agent`, subagents, delegation, role names, or model names and SHALL be accepted only after the caller receives exactly one complete business final and the Langfuse trace/observations APIs show one root trace plus the required linked child-turn traces, spawn links, child generations/tools, models, same session id, reciprocal correlation ids, and within-trace parent ids. Required analysis and verification children SHALL be joined before the root final; explicitly non-blocking children MAY be detached and settle later without changing the independent actor-turn trace topology or reopening the root trace.

#### Scenario: Observability is unavailable during normal execution

- **WHEN** the Agent routes roles correctly but Langfuse child enrichment is partial or unsupported
- **THEN** missing observability does not change the Agent result or tool execution
- **AND** deployment acceptance remains pending until a fresh API-verifiable trace is available
