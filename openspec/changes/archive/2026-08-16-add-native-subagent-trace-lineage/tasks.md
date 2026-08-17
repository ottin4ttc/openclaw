## 1. Dependency and Event Evidence

- [x] 1.1 Record the exact OpenClaw 2026.7.1, sibling Codex, and Langfuse plugin revisions; map app-server child start/activity/terminal, rollout inference/tool, role/model/reasoning, timing, and outcome facts.
- [x] 1.2 Prove which app-server event or rollout record owns every required stable identity; classify missing terminal or call ownership as unsupported rather than inferring it.
- [x] 1.3 Adopt the bounds: 64 active children, 4,096 lifecycle/call mutations, 16,384 UTF-8 metadata bytes per event, 512 pending joins, one aggregate diagnostic per overflow category, and one root finalization drain of at most 500 milliseconds for joined-child work; detached child traces retain their own lifecycle.

## 2. Internal Diagnostic Contract

- [x] 2.1 Replace the ACP/ACPX/public-hook design and task claims with the bundled Codex app-server internal-diagnostics boundary.
- [x] 2.2 Add bounded versioned internal Codex native-child lifecycle/status diagnostic events with stable parent run/turn, parent/child thread, child turn, source event, timing, and outcome facts.
- [x] 2.3 Add optional native-child owner and proven triggering-provider identity to existing model/tool diagnostics without changing root-owned behavior.
- [x] 2.4 Enforce the lifecycle allowlist, metadata/event/active-child/join bounds, duplicate handling, ordered child call/status delivery, and post-finalization diagnostics before consumer delivery.
- [x] 2.5 Add internal diagnostic contract tests for absent, partial, duplicate, unknown-version, excessive, and late native-child facts.

## 3. Codex App-Server Producer

- [x] 3.1 Pass the active OpenClaw run/turn/session/Agent identity, rollout root, capture policy, and base diagnostic fields from `run-attempt.ts` into the native-subagent monitor.
- [x] 3.2 Emit idempotent child start/activity/turn/terminal lifecycle diagnostics only after parent-turn and child-thread ownership is proven.
- [x] 3.3 Start and finalize exact child `threadId + turnId` rollout monitors for concurrent and sequential child turns without changing the root monitor.
- [x] 3.4 Annotate child model/tool diagnostics with child thread and parent turn identity; attach triggering provider identity only when reduced inference ownership proves it.
- [x] 3.5 Emit bounded final coverage/drain status, admit bounded joined-child facts until the aggregate 500-millisecond root window closes, preserve detached child monitors until their own terminal/dispose boundary, and keep parent-only behavior when child rollout evidence is unavailable.
- [x] 3.6 Preserve authoritative Codex `agent_role` without deriving it from task/path identity, keep task paths out of lifecycle telemetry, classify MultiAgent v2 `subAgentActivity(kind = started)` as an idempotent authoritative start, and join its stable spawn call id to the successful spawn request's exact `agent_type` when v2 does not expose `thread/started` to the parent client.

## 4. Langfuse Child Observation Model

- [x] 4.1 Remove the nonexistent public `native_child_event` hook and consume lifecycle/status only through the existing internal diagnostic subscription.
- [x] 4.2 Implement the prior deterministic turn-local child-observation model. This
      historical nested topology is superseded by task 4.11.
- [x] 4.3 Implement the prior child-observation parenting model. Its stable ownership
      rules remain, while task 4.12 moves the child to an independent trace.
- [x] 4.4 Prove the prior one-trace-per-root-turn model and no cross-turn updates. Task
      4.11 supersedes only the child trace boundary.
- [x] 4.5 Finalize once after the bounded diagnostic drain, monotonically downgrade later proven partial evidence, and record `complete`, `partial`, or `unsupported` without changing Agent/child outcomes.
- [x] 4.6 Update plugin documentation for the internal producer, hierarchy, bounds, status semantics, partial parenting, failure isolation, deployment, and parent-only rollback.
- [x] 4.7 Prove the prior nested parent chain and `llm-call-N-M` numbering. Task 4.13
      supersedes the display-number contract while retaining stable spawn ownership.
- [x] 4.8 Add bounded child execution-context summaries from exact child provider requests, retain unique request count plus first/latest summaries for multi-call children, and expose only lightweight root child-context coverage/role/model metadata; preserve the root prompt contract and never copy raw prompt/history text into child lifecycle metadata.
- [x] 4.9 Bound concurrent Langfuse ingestion and preserve attributable delivery for
      every admitted observation across delayed, batched, retry, and reconciliation paths.
- [x] 4.10 Summarize Responses and Responses Lite child system instructions from the exact request, recording `systemPromptSource` plus bounded size/hash without raw prompt text.
- [x] 4.11 Replace turn-local nested child observations with one deterministic trace per
      native child turn while retaining one root trace per OpenClaw turn and one shared
      Langfuse session per conversation; keep this topology identical for joined and
      detached children.
- [x] 4.12 Put reciprocal `parentTraceId`, `spawnObservationId`, `childTraceId`,
      `childThreadId`, and `childTurnId` links on the root spawn and child trace; keep
      `parentObservationId` strictly within one trace.
- [x] 4.13 Restart generation names at `llm-call-1` inside each child trace and retain
      parent generation/spawn ownership as metadata instead of cross-trace display numbering.
- [x] 4.14 Extend ledger, SDK delivery attribution, finalization, and recovery so root and
      child traces settle independently: root settlement must not mark a child delivered,
      joined acceptance must await every required child trace, and detached child delivery
      may complete later without reopening the root trace.
- [x] 4.15 Represent joined and detached execution without a timing-based topology branch:
      a joined root stays active through mailbox result consumption and synthesis, while a
      detached child retains its own lifecycle after root settlement.
- [x] 4.16 Prefix child trace names with the parent OpenClaw Agent id, populate bounded
      privacy-minimal child trace input/output, and add reciprocal `/trace/<traceId>`
      navigation URLs that the supported Langfuse 3.106.3 trace detail renders as
      clickable links without a frontend fork.

## 5. Focused Verification

- [x] 5.1 Add diagnostic contract/privacy/bounds tests and prove no lifecycle task body, prompt, raw path, credential, account id, or business policy is emitted.
- [x] 5.2 Add native-subagent monitor tests for multiple concurrent children, child turns, activity, terminal/error/interruption, drain timeout, late facts, cleanup, and parent independence.
- [x] 5.3 Add rollout diagnostics tests for exact child thread/turn filtering, multiple model/tool calls, proven inference-to-tool linkage, and raw-tool partial parenting.
- [x] 5.4 Add historical nested-topology Langfuse tests for one turn with two children,
      independent outcomes, duplicates, deterministic ownership, and out-of-order delivery.
      Task 5.10 replaces the trace-shape assertions.
- [x] 5.5 Add multi-turn and compatibility tests for persistent child reuse, unsupported/partial/complete, missing credentials, Langfuse outage, plugin shutdown, and no effect on execution.
- [x] 5.6 Add regression coverage for child prompt statistics, multi-call first/latest aggregation, root child-context coverage, and unavailable child request context without changing child admission or parent execution.
- [x] 5.7 Add delivery regressions for high-observation turns, transient network failure,
      attributable batch success/failure, failed final barriers, and reconciliation without
      false settlement or observation loss.
- [x] 5.8 Add regressions for input-message developer/system prompt statistics, authoritative role overriding task path, v2 started activity producing complete start coverage, and late role enrichment renaming an already-materialized child span plus updating root role aggregates.
- [x] 5.9 Add a regression where a native child completes during an active parent turn,
      Codex `wait_agent` consumes the mailbox result, the parent emits one full final answer,
      and OpenClaw does not enqueue a second internal task-completion message.
- [x] 5.10 Add root/child independent-trace tests for concurrent children, detached
      completion, reciprocal links, trace-local numbering, within-trace tool parenting,
      same-session API grouping, and stable topology regardless of completion timing.
- [x] 5.11 Add one mixed-mode regression where a root joins one required child, detaches
      one non-blocking child, does not treat one `wait_agent` wake-up as a global barrier,
      and never duplicates either completion.
- [x] 5.12 Add regressions for system-error final-drain ordering, parent-prefixed late-role
      rename and recovery names, non-null child trace input/output with fallback protection,
      and reciprocal trace URLs.

## 6. Deployed Acceptance and Rollback

- [x] 6.1 Build reviewed plugin/runtime artifacts, verify bundle parity, and restart only the isolated target OpenClaw instance.
- [x] 6.2 On local OpenClaw 2026.7.1 port 18789, run two user turns under one explicit
      OpenClaw session; require two normal caller responses and verify through Langfuse APIs
      that they produce two traces sharing one session identity.
- [x] 6.3 Prove the prior nested topology with two interleaved native children through
      the observations API. Task 6.10 supersedes its trace-shape acceptance.
- [x] 6.4 Exercise child failure or interruption while the parent completes and prove sibling/root delivery and parent outcome remain independent.
- [x] 6.5 Exercise `complete`, `partial`, and `unsupported`; prove these change only Langfuse evidence/reporting while parent-only tracing and Agent execution remain unchanged.
- [x] 6.6 Exercise rollback to parent-only diagnostic consumption and document the exact version, deployment, verification, and recovery commands.
- [x] 6.7 Before each live attempt, preflight the exact Gateway process environment for
      Langfuse, provider stream, and OpenMAI read connectivity; use an acceptance-client
      timeout longer than the scenario budget and record provider, business API, caller,
      and telemetry failures separately.
- [x] 6.8 Re-run the complex person-job matching case until Langfuse APIs show all four
      requested role/model children (Terra, Luna, Sol, Terra), their spawn hierarchy,
      explicit `fork_turns = "none"`, child generations, tool calls, bounded context
      metadata including system-prompt size/hash, and a normal parent result. Trace
      `c6d5f6179737a16076f55d0613225293` remains recorded as failed evidence. This task
      proved the prior nested topology; tasks 4.11-4.14 and 6.10 supersede its trace-shape
      acceptance without invalidating its runtime/model evidence.
- [x] 6.9 Re-run the natural candidate-match request and require automatic
      `talent_analyst` and `result_verifier` children without mentioning delegation,
      exactly one complete user-visible root final, and no duplicate internal completion
      turn. Trace `87a31c49ccc31a4fed9f8b1de5b1416d` remains negative evidence for
      duplicate completion because `llm-call-24` overwrote the complete `llm-call-23` reply.
- [x] 6.10 Verify through Langfuse APIs that the root and both child-turn traces share
      the same session, carry reciprocal correlation ids, retain Sol/Terra/Sol models,
      expose child system-prompt summaries, and contain no cross-trace
      `parentObservationId`.
- [x] 6.11 Verify joined and detached behavior separately through caller output and
      Langfuse APIs: joined children are consumed before the single root final, detached
      child traces may settle later, and neither mode changes actor-turn trace topology.
- [x] 6.12 Verify through Langfuse public APIs that deployed child traces have
      parent-prefixed names, non-null bounded input/output, reciprocal ids and URLs, and
      that each `/trace/<traceId>` URL resolves to the matching project trace. Verify in
      the supported Langfuse 3.106.3 trace detail that reciprocal URL values are clickable
      and open the matching parent or child trace.
