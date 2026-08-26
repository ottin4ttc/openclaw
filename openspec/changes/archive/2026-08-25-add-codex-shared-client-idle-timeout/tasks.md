## 1. Configuration Contract

- [x] 1.1 Add generic `sharedClientIdleTimeoutMs` to the Codex plugin `appServer` typed configuration and normalize unset/zero as disabled for every shared client in the plugin process.
- [x] 1.2 Add schema validation, manifest metadata, labels, and help text for the non-negative integer timeout without environment-specific branches or OpenClaw scheduler changes.
- [x] 1.3 Route invalid timeout values through a fail-closed plugin configuration gate; add tests covering omitted/zero, positive values, negative values, fractional values, non-finite values, and effective runtime output.

## 2. Shared Client Idle Reclamation

- [x] 2.1 Extend the `Symbol.for` shared-client state and entries with monotonic idle timestamps, native-child activity holds, and one process-wide reaper lifecycle; preserve the existing per-Agent/start-identity cache key.
- [x] 2.2 Add one Codex plugin registration/startup configuration operation, before any shared-client acquisition and outside discovery-only registration, that installs the effective timeout for all acquisition paths and starts at most one singleton unref'ed sweep; do not add live reconfiguration.
- [x] 2.3 Implement the idle sweep and reuse the existing retire plus bounded `closeAndWait` path to remove an exact current entry, close its app-server, and isolate close failures from unrelated clients; use existing Node-safe timer normalization and a fixed minimum sweep interval.
- [x] 2.4 Make acquire/release/sweep races safe: set idle time when the last lease releases and, if a pending acquire or activity hold remains, when the final one clears; cancel/reset pending idle work on reuse, skip active leases/pending acquires/activity holds, and never return a retired or closed client.
- [x] 2.5 Add an explicit native-child monitor retain/release activity-hold API and integrate it with parent/child lifecycle so idle cleanup cannot close a client used by a native child; release each hold exactly once on normal terminal, cancellation/interruption, parent replacement, monitor disposal, and late/unsupported child paths, with safe duplicate release.
- [x] 2.6 Stop the reaper cleanly during shared-client shutdown/reset and avoid retaining timers or client references after Gateway teardown; serialize one close operation per entry and catch rejected bounded close promises from timer callbacks.

## 3. Regression and Lifecycle Tests

- [x] 3.1 Add shared-client tests for idle retirement, disabled warm-client behavior, active lease protection, pending acquire protection, and re-acquire races.
- [x] 3.2 Add tests for native-child deferral and every hold-release path, final hold/pending-drain idle timestamp initialization, bounded close/wait behavior including rejected timer close promises, one-client close failure isolation, and cleanup of the reaper timer.
- [x] 3.3 Add run-attempt/embedded-run tests proving idle cleanup does not interrupt active run behavior or alter unrelated runtime policy.
- [x] 3.4 Run the focused Codex app-server tests and the broader OpenClaw Codex/plugin test lanes; record resident-client and cleanup evidence from a disposable multi-Agent run. The full Codex extension lane passed locally; Testbox/CI remains an optional remote confirmation.

## 4. Deployment and Operations

- [x] 4.1 Document the generic Codex plugin `appServer.sharedClientIdleTimeoutMs` setting, default-zero rollback, and deployment-specific tuning without encoding environment logic.
- [x] 4.2 Add credential-free structured logs for idle retirements and close failures; do not add a new metrics subsystem in this phase.
- [x] 4.3 Deploy a positive timeout to a local canary, verify the Codex app-server count returns to baseline after an idle period, and confirm the `/v1/responses` turn completes.
- [x] 4.4 Roll back the timeout to zero/omitted, restart the Gateway, and verify warm-client reuse remains unchanged.
