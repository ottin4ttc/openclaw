## Context

The current Codex plugin already owns a process-wide shared-client map keyed by app-server start identity and already has race-safe retire/close primitives. A normal turn releases its lease, but the shared client remains warm unless the caller opts into one-shot cleanup. The new policy adds idle reclamation without changing unrelated Codex or OpenClaw runtime behavior. See `proposal.md` and the capability spec for the motivation and behavior contract.

## Goals / Non-Goals

**Goals:**

- Add one generic Codex plugin `appServer.sharedClientIdleTimeoutMs` setting. Deployments may choose different values; the runtime contains no Eval/production branching.
- Reclaim only clients that are idle, unclaimed, and free of native-child work.
- Reuse existing retirement and process-wait behavior rather than inventing a second shutdown path.
- Make acquire, release, timeout, and close races deterministic and observable.
- Keep the default behavior warm-client compatible when the timeout is unset or zero.

**Non-Goals:**

- Do not change `agents.defaults.maxConcurrent`, `agents.defaults.subagents.maxConcurrent`, or `cron.maxConcurrentRuns`.
- Do not add a global active-thread admission cap in this phase.
- Do not force-close active turns, pending acquisitions, or native child work.
- Do not define unrelated Codex profile values or OpenClaw scheduler policy.
- Do not expose the internal `cleanupBundleMcpOnRunEnd` flag as a user-facing request parameter.

## Decisions

### 1. Put the setting under the Codex plugin app-server configuration

Add `sharedClientIdleTimeoutMs` to `plugins.entries.codex.config.appServer`, with `0` or omission meaning disabled. This keeps ownership with the component that owns the shared-client map and lets each deployment select its own value. The plugin manifest schema, typed config reader, normalized runtime options, and config help must describe the same field and validation.

The effective policy will be installed into the `Symbol.for`-backed shared-client state once by the Codex plugin registration/startup hook, before any shared-client acquisition. Client acquisition paths will not each rediscover the timeout; they will use the process-wide startup policy. Discovery-only registration must not start the reaper. Invalid values must be rejected by the plugin configuration gate before this policy is installed; the existing fail-open `readCodexPluginConfig()` compatibility parser must not silently disable an invalid idle policy. Runtime configuration changes are intentionally unsupported and require a Gateway restart.

Alternative rejected: a top-level OpenClaw scheduler setting. That would mix process lifecycle with message/run scheduling and would affect non-Codex runtimes.

### 2. Use one process-wide idle sweep, not one timer per Agent

The shared-client state will track a monotonic `lastIdleAt`, native-child activity holds, and the reaper lifecycle. `lastIdleAt` is set at the transition where the entry has no active lease, pending acquire, or child hold. If the last ordinary lease releases while a pending acquire or child hold remains, the transition that clears the final pending acquire or child hold establishes the idle timestamp. When the policy is enabled, one unref'ed sweep timer stored in the `Symbol.for` shared state periodically scans the shared-client map. The implementation uses a fixed minimum sweep interval so very small configured timeouts cannot create a hot O(N) loop, and uses the existing Node-safe timer normalization rather than exposing another setting. The timer is stopped on process shutdown; it is never reconfigured in place.

Alternative rejected: a timer per client. It is simpler locally but creates another resource proportional to the very Agent count this change is protecting.

### 3. Reuse retire-and-wait for the close transition

The sweep will remove or retire only the exact current entry, mark it close-when-idle, and use the existing `closeAndWait({ exitTimeoutMs, forceKillDelayMs })` path after the entry is unclaimed. Each entry may have only one in-flight close operation. A new acquire racing after retirement will create a fresh entry and cannot receive the retired client. Close failures are caught, isolated to that client, and logged with a non-secret cache identity.

The implementation must preserve the existing pending-acquire and active-lease checks. Idle detection is a candidate decision; the final retirement check must happen against the current entry immediately before closing.

### 4. Treat native child work as an activity hold

The existing one-shot cleanup path already defers parent client retirement while native children settle. Idle reclamation will expose an explicit retain/release activity-hold seam owned by the native child monitor: a parent run or native child monitor must retain a hold until child completion is observed, and release it exactly once on every terminal path, including cancellation/interruption, parent replacement, monitor disposal, and late or unsupported child events. Duplicate release is safe. The reaper must skip entries with such a hold even when the parent turn has released its ordinary lease.

Alternative rejected: infer child activity from elapsed time or process inspection. That would race with child completion and make cleanup dependent on platform-specific process trees.

### 5. Keep lifecycle ownership narrow

Idle timeout is a shared-client lifecycle policy only. The implementation will not define unrelated Codex profile values, use OpenClaw scheduler settings as a substitute, or add an active-cap queue in this change.

### 6. Roll out through deployment-owned plugin config

Deployment operators may set a positive timeout in the Codex plugin `appServer` config; omission or zero remains a safe rollback to warm-client behavior. Changing the value requires the normal Gateway restart boundary before any client observes it. No environment-specific value or branch is encoded here.

## Risks / Trade-offs

- **Risk:** The next request after idle reclamation pays app-server startup and initialization latency. → **Mitigation:** Let each deployment choose its timeout and measure p50/p95 startup latency before tuning.
- **Risk:** A race can close a client just as a new run acquires it. → **Mitigation:** Retire the exact current map entry and re-check leases, pending acquires, and child holds before close; acquire after removal always initializes a new client.
- **Risk:** Native child work can outlive the parent turn. → **Mitigation:** Keep an explicit child activity hold and reuse the existing deferred cleanup boundary.
- **Risk:** A close operation can hang or fail. → **Mitigation:** Reuse bounded `closeAndWait` timeouts, catch rejected close promises from timer callbacks, log a credential-free failure, and keep unrelated entries usable.
- **Risk:** A short timeout can cause startup churn under bursty traffic. → **Mitigation:** Keep the default at zero, make the timeout deployment-specific, and observe structured idle-retire/close-failure logs before selecting an operational value.
- **Risk:** Idle timeout alone may not protect a burst where many Agents become active simultaneously. → **Mitigation:** Treat `TasksMax` as the hard backstop and leave a follow-up for a Codex-owned active admission cap if measurements show burst exhaustion after cleanup is correct.

## Migration Plan

1. Add the config field with default `0` and validate the config/manifest/help surfaces fail-closed before startup policy installation.
2. Implement the shared-client idle sweep and activity-hold lifecycle using the existing retire/close primitives.
3. Add deterministic unit tests for default behavior, idle close, active/pending protection, native-child deferral, re-acquire races, and close failures.
4. Deploy a positive timeout to a disposable canary, restart the Gateway, and observe `TasksCurrent`, resident app-server/code-mode-host counts, startup latency, and close failures under representative multi-Agent traffic.
5. Roll back by setting the timeout to `0`/omitting it and restarting the Gateway; this restores warm-client behavior without changing Agent state or Codex home files.

The exact operational timeout remains a deployment choice; implementation accepts the configured duration without hard-coding environment-specific values.
