## Why

The current development branch contains a large Langfuse implementation and Codex-runtime observability work, but it is based on newer mainline APIs and a session-storage transition that is not present in OpenClaw `v2026.7.1-2`. We need a maintainable 7.1 branch that keeps the file-backed session contract, ships Langfuse as an independent plugin, and preserves reliable Codex tracing without importing the later SQLite/session refactor. The current 7.1 port can collapse a multi-request Codex turn into one aggregate Langfuse generation, so the 7.2 provider-request observation structure is the required parity target.

End-to-end testing also confirmed a separate 7.1 Codex sandbox bug: the harness reused the persisted host `skillsSnapshot.prompt`, so the model was told to read generated host `plugin-skills` paths that do not exist inside the container. This is a runtime path-projection defect, not a requirement to copy every skill into `plugin-skills` and not a user configuration problem. The fix must preserve plugin ownership while projecting the already-materialized sandbox copy into the Codex prompt.

## What Changes

- Create the parallel `openclaw.20260701` worktree on `v2026.7.1-2` with branch `ttc-kevin-2026.7.1`.
- Port Langfuse tracing and prompt management into the independent `openclaw-langfuse` extension package, including package metadata, credentials, redaction, recovery, lifecycle, and focused tests.
- Trace Codex app-server turns through the existing public plugin lifecycle (`before_agent_run`, `llm_input`, `llm_output`, tool hooks, and `agent_end`) and preserve model, usage, error, tool, runtime, and transport metadata.
- Preserve every concrete Codex provider request as one independently visible, real-time `llm-call-N` generation with stable input, output, usage, timing, failure state, and correctly parented tool observations; one complete aggregate turn generation is not sufficient.
- Preserve plugin-skill usability under Codex sandbox execution by rebuilding the harness skill catalog with container-readable materialized paths instead of injecting host-only `plugin-skills` locations.
- Validate the sandbox fix through fresh-session, resumed-thread, multi-plugin, referenced-file, and real read-only business-tool flows on the isolated 19789 deployment; unit-only or model-reported path evidence is insufficient.
- Treat the installed 19789 runtime as the primary acceptance target: rebuild the package-local Langfuse `dist`, restart only the 7.1 Gateway, execute two real business turns through the matching 7.1 CLI in one session, and inspect both trace and observation APIs. Source-only, unit-only, stale-dist, or UI-only results are insufficient.
- Keep the 7.1 JSON/JSONL session store; implement session/recovery reads through the 7.1 public file-backed SDK adapter rather than adding SQLite compatibility code.
- Add only the smallest core/plugin-SDK seam when an observable Codex event cannot be reached through an existing public hook; do not port the broad 7.2 SQLite, session, or unrelated upstream merge.
- Add independent-package docs, manifest compatibility metadata, dependency ownership, and package/runtime tests for the 7.1 host.

## Capabilities

### New Capabilities

- `langfuse-plugin-tracing`: Independent Langfuse plugin for OpenClaw prompt management, trace/generation/tool observations, redaction, recovery, and delivery lifecycle on the 7.1 host.
- `codex-runtime-observability`: Per-turn Codex app-server tracing through public hooks, including model input/output, tool lifecycle, usage, failure, runtime engine, and transport metadata.

### Modified Capabilities

- None.

## Impact

- Primary code: `extensions/openclaw-langfuse/**` and its package/runtime documentation and tests.
- Codex integration: `extensions/codex/src/app-server/**` for narrowly tested lifecycle or sandbox-path parity fixes; shared harness path projection may use one generic plugin-SDK seam rather than plugin-private core imports.
- Public SDK/config: no SQLite schema, session-storage, protocol-version, or default config changes; any added export must be documented and contract-tested.
- Dependencies: Langfuse remains owned by the plugin package and its lock/shrinkwrap; no unrelated root dependency is added unless the 7.1 bundled build contract proves it necessary.
- Verification: end-to-end evidence from the deployed 19789 instance is the release gate, backed by focused plugin tests, Codex app-server hook/diagnostic tests, package-boundary/runtime build checks, formatting/diff checks, a 7.1 build smoke check where available, live Langfuse API evidence, and rollout/session evidence from fresh plus resumed Codex sandbox turns. The separate 18789 instance must remain unchanged.
