## 1. Baseline and contract evidence

- [x] 1.1 Verify branch `ttc-kevin-2026.7.1` points to `v2026.7.1-2` and record the 7.1 JSON/JSONL session paths alongside the first 7.2 beta SQLite/session commit evidence.
- [x] 1.2 Inspect the sibling `../codex` repository's app-server protocol/runtime source and record the exact public lifecycle contract used by the 7.1 Codex extension.
- [x] 1.3 Inventory the account-owned commits and current worktree changes, classify each as required for Langfuse/Codex runtime, and retain only changes that fit the plugin-first design.

## 2. Independent Langfuse package

- [x] 2.1 Port the independent `extensions/openclaw-langfuse` manifest, entry points, package metadata, and 7.1 compatibility bounds without private plugin identifiers or core imports.
- [x] 2.2 Keep Langfuse runtime dependencies owned by the extension; remove any root dependency that the independent package/runtime build does not require.
- [x] 2.3 Port tracing, generation, tool observation, prompt management, redaction, lifecycle flush/shutdown, credentials, and bounded delivery diagnostics to the 7.1 SDK contract.
- [x] 2.4 Add a plugin-local 7.1 session/transcript compatibility adapter for file-backed JSON/JSONL reads and update recovery/prompt-management callers to use it.
- [x] 2.5 Ensure recovery and export failures are isolated from agent execution and expose actionable status without claiming delivery that did not occur.

## 3. Codex runtime integration

- [x] 3.1 Map the existing 7.1 Codex public hooks (`before_agent_run`, `llm_input`, `llm_output`, tool hooks, and `agent_end`) to stable per-turn Langfuse correlation state.
- [x] 3.2 Preserve available model, provider, usage, latency, runtime-engine, transport, session, request, tool, and failure metadata with bounded optional fields.
- [x] 3.3 Add focused hook-contract tests covering successful and failed model calls, successful and failed tools, concurrent/sequential turn separation, and missing optional metadata.
- [x] 3.4 Only if task 3.3 proves a required event unreachable, add the smallest additive core/SDK seam, document its public contract, and cover producer/consumer behavior with tests; otherwise leave Codex core untouched.
- [x] 3.5 Start the rollout-trace monitor after the Codex turn becomes active, drain and stop it on every terminal path, and prove provider-request diagnostics arrive before `llm_output` while the turn is still running.

## 4. Docs, inventory, and package verification

- [x] 4.1 Add the independent plugin reference and inventory metadata for the 7.1-compatible plugin, keeping user-facing wording as plugin/plugins.
- [x] 4.2 Add or update independent npm runtime/package build coverage so the extension can be built and loaded without relying on private host internals.
- [x] 4.3 Update focused test mocks and fixtures for the 7.1 file-backed session and diagnostics contracts.

## 5. Validation and closeout

- [x] 5.1 Run focused Langfuse tests with `node scripts/run-vitest.mjs extensions/openclaw-langfuse/src` and resolve all failures.
- [x] 5.2 Run the 7.1 extension typecheck with `node scripts/run-tsgo.mjs -p tsconfig.extensions.json --pretty false` (or the narrow extension project when supported).
- [x] 5.3 Run targeted Codex app-server hook tests, package/runtime build checks, formatting checks, and `git diff --check`.
- [x] 5.4 Confirm no SQLite schema/version/session migration changes, inspect production-vs-test diff stats, and verify the main worktree remains unchanged.
- [x] 5.5 Record final evidence, remaining validation gaps, and rollback instructions in the handoff; mark the OpenSpec tasks complete only after all required checks pass.
- [x] 5.6 Run a real 19789 Codex request and use the Langfuse observations API to prove every provider generation appears during execution, becomes complete on the same observation ID, tool spans attach to the corresponding generation, runtime metadata is present, and the OpenClaw reply completes.

## 6. 7.2 provider-request parity correction

- [x] 6.1 Record the 7.2 OpenClaw and sibling Codex producer-consumer evidence map from `inference_call_id` through provider-request diagnostics to `llm-call-N`.
- [x] 6.2 Port stable call identity and provider request ordering so each started diagnostic creates or claims exactly one real-time generation and its terminal diagnostic completes the same observation.
- [x] 6.3 Port rollout tool lifecycle parenting and native duplicate suppression so each tool observation belongs to the provider generation that triggered it and is exported once.
- [x] 6.4 Add producer and consumer regressions for three provider requests, terminal-only delivery, late starts, duplicate polling/final-drain delivery, aggregate fallback suppression, and cleanup ordering.
- [x] 6.5 Prove started generations are queryable before `agent_end`, terminal updates preserve their observation IDs, and final drain leaves no late or duplicate observations.
- [x] 6.6 Send a real multi-tool Codex request through the isolated 19789 instance and verify exact generation fields plus `parentObservationId` relationships through the Langfuse observations API.
- [x] 6.7 Send two turns through the same 19789 Codex session and verify through the Langfuse trace API that the second trace has non-empty top-level `prior_conversation` metadata with correct message/retained counts and no `llm_input-fallback` ownership.
- [x] 6.8 Project `prior_conversation` to bounded value-bearing API messages and omit runtime envelopes from the top-level trace metadata.

## 7. Codex sandbox plugin-skill path parity

- [x] 7.1 Rebuild Codex harness skill prompts from sandbox-materialized entries instead of reusing host `plugin-skills` snapshot locations.
- [x] 7.2 Expose only the narrow generic agent-harness helper required by the Codex plugin boundary and add a regression proving host paths are absent from the sandbox prompt.
- [x] 7.3 Redeploy the 19789 instance and prove a real Codex sandbox turn reads a plugin `SKILL.md` from `/workspace/.openclaw/sandbox-skills/skills` without an initial missing-file failure.
- [x] 7.4 Add regressions proving non-sandbox snapshots remain unchanged, sandbox entries are rebuilt, and missing materialization omits the skill rather than restoring a host path.
- [x] 7.5 Run multiple turns in the same 19789 OpenClaw session and prove `company-job-search`, `ttc-my-talent`, and `ttc-public-talent` plus a declared `references` file are readable from materialized paths.
- [x] 7.6 Prove a subsequent turn resumes the same Codex thread after any explicitly logged dynamic-tool catalog rotation, while retaining container skill locations and producing no tool failures.
- [x] 7.7 Run a fresh real business flow that lists skills, reads the selected skill and its references, invokes `openmai_internal_api_call`, and completes the final reply with no host-path match in rollout/session evidence.
- [x] 7.8 Verify 19789 remains healthy on the 7.1 checkout throughout E2E testing and the separate 18789 process remains unchanged.
- [x] 7.9 Run a full DTS-producing build and `check-plugin-sdk-exports` before formal packaging; the fast deployed build intentionally skipped DTS and leaves generated declaration artifacts absent.
- [x] 7.10 Rerun mandatory `autoreview` after its isolated Codex authentication is restored; the current attempt was blocked by upstream 401/403 and is not a clean-review claim.
- [x] 7.11 Investigate the separate non-fatal Codex sandbox `AGENTS.md` discovery warning for escaped `/.git`; upstream project-root marker discovery propagates the expected sandbox rejection after probing `/.git`, while explicit workspace instructions and accepted E2E flows remain intact, so the independent contract change stays a follow-up.

## 8. Deployed end-to-end acceptance

- [x] 8.1 Rebuild only the publishable `openclaw-langfuse` runtime, verify `prior_conversation_projection` exists in the generated `dist`, and avoid the unrelated full DTS build during the focused deployment loop.
- [x] 8.2 Restart only the 19789 7.1 Gateway, verify `/healthz` and `/readyz`, confirm the Langfuse plugin initializes, and prove the 18789 listener remains unchanged.
- [x] 8.3 Use the matching 7.1 CLI plus `~/.openclaw.20260701` state/config roots to run two real OpenMAI business turns under one explicit session key; require materialized skill/reference reads, real API calls, successful replies, and zero tool failures.
- [x] 8.4 Prove the two turns share OpenClaw session `e414e7fe-85a3-4b8a-b490-d05a0e1a7b75` and Codex thread `019fe4e6-98cb-74d0-bd20-b1538085c86e`, while retaining distinct run and turn identities.
- [x] 8.5 Query Langfuse trace and observations APIs for traces `a0611ed754849e7952a37683e0e6ea7e` and `c7c05801e2233dd854c91c328e9a892c`; verify 10 complete generations, 8 complete tool spans, zero orphan tool parents, and second-turn history projected as 8/8 value-bearing rows with no runtime-envelope keys.
- [x] 8.6 Query trace `88ed42895fbdbbe78d0a73f9de85e3e6` through the live Langfuse trace and observations APIs; verify all 13 observations retain input/output/end time with zero orphan parents, document that the downloaded export is not observation-complete, and prove an empty orchestrator skill catalog is independent from sandbox-materialized file skills.
