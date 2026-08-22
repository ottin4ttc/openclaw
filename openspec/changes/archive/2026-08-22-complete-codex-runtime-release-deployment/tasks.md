## 1. Complete the bounded runtime fixes

- [x] 1.1 Update the sandbox path guard so the effective directory allowed-type used by the fallback is carried into the final boundary/writability checks; add a regression test for a directory-open failure path.
- [x] 1.2 Document the native relay configuration as restart-required for running Codex threads; retain tests proving `enabled: false` does not inject `features.hooks=false` or clear Codex-owned hooks.

## 2. Harden process lifecycle behavior

- [x] 2.1 Make both source-checkout compile-cache entrypoints honor `OPENCLAW_NO_RESPAWN`; preserve normal packaged behavior when unset and add source-checkout regression tests.
- [x] 2.2 Verify Unix relay commands avoid an extra shell wrapper and Windows relay commands remain platform-valid without claiming Unix process-group cleanup.

## 3. Verify the generic runtime contracts

- [x] 3.1 Run focused unit tests for the fs-bridge, Codex config/relay, compile-cache respawn, and protocol validators; run formatting and diff checks.
- [x] 3.2 Keep the explicit relay configuration tests and document that no live-reconfiguration API is provided before Gateway restart.
- [x] 3.3 Run the supported OpenClaw runtime smoke tests for normal and tool-enabled Codex turns without depending on a global binary or a deployment-specific path.
- [x] 3.4 Document the operator rule that Gateway must be restarted after changing `nativeHookRelay.enabled` before relying on the new setting.
- [x] 3.5 Record the source SHA, test evidence, and the explicit boundary that deployment, Eval, OpenMAI, Langfuse, and temporary global-binary workarounds are owned outside this change.
- [x] 3.6 Add a launcher E2E regression proving a source checkout with `OPENCLAW_NO_RESPAWN=1` does not perform compile-cache respawn.
