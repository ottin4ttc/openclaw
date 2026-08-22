## Context

The current branch contains three source commits after the previous 7.1
baseline: the sandbox directory-stat fix, the Codex 0.148 pin/protocol
refresh, and the native-hook relay ownership/performance fix. This change only
owns generic OpenClaw runtime behavior. Eval, OpenMAI/Langfuse artifacts,
systemd units, and temporary global-binary workarounds belong to the OpenMAI
deployment repository and are not part of this design.

## Goals / Non-Goals

**Goals:**

- Make runtime source behavior and generated/tested behavior agree.
- Keep the relay opt-out performance choice (`nativeHookRelay.enabled: false`)
  without disabling Codex's own hook engine.
- Make directory metadata checks correct and make relay configuration behavior
  explicit for loaded threads.
- Verify generic runtime behavior with focused tests and supported process
  boundaries.

**Non-Goals:**

- Do not change deployment directories, systemd units, or server state.
- Do not redesign ACP/ACPX, native-child trace topology, or Langfuse data
  modeling in this change.
- Do not turn a temporary global-binary workaround into a runtime contract.

## Decisions

### 1. Make relay disablement relay-only and restart-scoped

`nativeHookRelay.enabled=false` prevents OpenClaw compatibility relay
registration/config injection. It does not set `features.hooks=false` and does
not clear Codex hook arrays. The runtime does not guarantee that a changed
setting is visible before Gateway restart; after restart it is the stable
configuration for subsequent attempts and threads. The implementation will
not add a speculative live-thread mutation protocol.

Alternative rejected: globally disabling Codex hooks, which removes user and
plugin hook behavior; and silently pretending a loaded thread changed, which
would make Langfuse/performance results non-deterministic.

### 2. Pass the effective directory type through the safety proof

The stat plan opts into directory targets. The path guard will carry the
effective allowed type used by the successful directory fallback into the
canonical/writable checks, and tests will cover both normal directory stat and
an open-boundary implementation that cannot return a directory fd.

Alternative rejected: bypassing the root-file guard for stat, which would
weaken symlink and mount-boundary validation.

### 3. Keep the performance optimization measurable and bounded

The relay opt-out avoids per-tool OpenClaw CLI fanout. The command prefix
retains `exec env OPENCLAW_NO_RESPAWN=1` for any environment that does
enable relay. On Unix this makes the relay the direct child instead of allowing
OpenClaw to respawn it; Windows keeps its existing shell behavior and does not
claim the Unix process-group guarantee. Normal packaged compile-cache behavior
is unchanged when the variable is unset; relay commands explicitly set it to
avoid an extra respawn. Performance claims are outside this generic code
contract.
The source-checkout compile-cache respawn path also honors
`OPENCLAW_NO_RESPAWN`, closing the same process-tree escape without changing
normal compile-cache behavior.

## Risks / Trade-offs

- [Risk] A relay setting change appears ineffective until a Gateway restart.
  → Document the lifecycle boundary and test fresh-thread behavior.
- [Risk] A safety fallback could weaken mount validation. → Reuse the existing
  root/canonical/symlink guard and test the failure path explicitly.
