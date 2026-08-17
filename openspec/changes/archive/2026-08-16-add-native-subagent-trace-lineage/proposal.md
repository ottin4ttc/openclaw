## Why

The Langfuse plugin already creates one trace per OpenClaw Agent turn, but Codex native `spawn_agent` activity is not represented as a reliable child tree. OpenClaw 2026.7.1's bundled Codex app-server integration already observes native-child thread lifecycle and reads Codex rollout-trace bundles containing thread topology, inference calls, tool calls, timing, models, and outcomes. The missing work is to project those authoritative facts through the existing diagnostics bus and consume them in Langfuse.

The earlier ACP/ACPX transport design targeted the wrong runtime. OpenMAI model routing uses the bundled Codex app-server harness, so this change SHALL NOT add ACP native-child events, ACP capabilities, public plugin hooks, ACPX adapter changes, or dependency pins.

## What Changes

- Add bounded Codex native-child lifecycle/status diagnostic events emitted by the bundled Codex app-server monitor, with stable OpenClaw run identity, parent Codex thread/turn identity, child thread identity, source event id, timing, role/model/reasoning when proven, and classified outcome. Deliver them through the same ordered async diagnostic queue as child model/tool facts so status cannot overtake the evidence it summarizes.
- Extend existing model/tool diagnostics with optional child-thread ownership and triggering provider-call identity derived from the same Codex rollout bundle. Never infer ownership from arrival order, role/model names, prompt text, task text, or nickname.
- Preserve one Langfuse session per OpenClaw conversation, one root trace per user-message-to-final-response turn, and one independent child trace per Codex native-child turn.
- Allow joined and detached child execution in the same runtime: a joined parent waits for and consumes the child result before its final response, while a detached child may finish after the parent turn. Keep the trace topology stable in both cases and link root spawn observations to child traces with reciprocal metadata.
- Name each child trace with its parent OpenClaw Agent id and authoritative role, populate the trace root with bounded privacy-minimal input/output summaries, and expose reciprocal absolute `/trace/<traceId>` navigation URLs that Langfuse 3.106.3 renders as clickable metadata links without project-id discovery or a Langfuse frontend change.
- Attach child-owned generations inside the child trace and attach tools beneath a proven same-trace generation or directly beneath the child trace root with `partial_parenting = true`.
- Preserve Codex's authoritative `agent_role` without deriving it from `agent_path`/task name, keep task paths internal to runtime correlation, and treat MultiAgent v2 `subAgentActivity(kind = started)` as an authoritative child-start fact.
- Summarize a child's effective system instructions from top-level `instructions` or, when absent, ordered `system`/`developer` input messages. Export only the source, bounded character count, and namespaced hash; never copy raw instructions into child lifecycle metadata.
- Reusing a persistent child in a later user turn creates a new observation in the new trace; observations and terminal updates never cross trace boundaries.
- Classify lineage as `complete`, `partial`, or `unsupported`. These states affect only Langfuse evidence/reporting and never OpenClaw, Codex, tool, child, or parent execution.
- Perform one bounded root-turn finalization wait of at most 500 milliseconds across joined-child drains and enforce documented active-child/event/metadata/join limits. This window is not a child lifetime deadline: detached child traces finalize independently, while late facts never reopen the already finalized root trace.
- On child `systemError`, final-drain every active child diagnostic turn before emitting the terminal lifecycle fact so already-produced model/tool diagnostics cannot be stranded.
- Bound concurrent Langfuse ingestion and prefer delayed, attributable, API-verifiable
  delivery over per-event immediacy; a lone terminal error or trace root never proves
  delivery of the generations, tools, and children emitted earlier in the turn.
- Keep Langfuse optional and fail-open for missing config, missing credentials, default instances, non-Codex runtimes, diagnostics gaps, plugin unload, and service outages.
- Preserve Codex `fork_turns` semantics: `none` is an intentional fresh child, omitted/`all` inherits full history, and a positive integer inherits only the latest N turns. The observability layer reports the choice but does not alter it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `codex-runtime-observability`: Project Codex app-server native-child topology and child-owned model/tool facts through bounded diagnostics.
- `langfuse-plugin-tracing`: Preserve actor-turn traces while adding stable root/child correlation, joined/detached execution semantics, and same-trace model/tool parenting.

## Impact

- Bundled Codex plugin: native-subagent monitor and rollout-trace diagnostics become the producer.
- Internal diagnostics contract: additive bounded child lifecycle/status and optional ownership fields.
- `extensions/openclaw-langfuse/`: consume optional diagnostics; no new public plugin hook or config key.
- OpenClaw core ACP/ACPX and dependency versions: unchanged.
- Default OpenClaw instances: unchanged when the Langfuse plugin is absent or disabled.
