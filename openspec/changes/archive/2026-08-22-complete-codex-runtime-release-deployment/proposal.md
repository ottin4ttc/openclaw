## Why

The Codex 0.148 runtime fixes still have two bounded code gaps: directory
metadata checks are incomplete on a fallback path, and native relay behavior
is not explicit when a loaded thread is resumed. These are OpenClaw runtime
contracts and should be fixed in the OpenClaw repository without turning a
temporary deployment workaround into a permanent architecture.

## What Changes

- Complete the directory `stat` fallback so its effective type remains part of
  the normal root/symlink boundary proof.
- Preserve the measured relay opt-out: disabling the OpenClaw compatibility
  relay must not disable Codex-owned hooks.
- Define the relay configuration lifecycle for loaded Codex threads without
  adding a live thread migration protocol.
- Make source-checkout compile-cache respawn honor the same no-respawn safety
  boundary as native hook relay commands.
- Add focused tests and documentation for these generic runtime contracts.

## Capabilities

### New Capabilities

- `codex-runtime-release-deployment`: Generic Codex runtime correctness and
  process-boundary contracts. Deployment-specific release orchestration is
  explicitly out of scope for this OpenClaw change.

### Modified Capabilities

- `codex-runtime-observability`: Clarify native relay opt-out ownership and
  loaded-thread/restart semantics while retaining public Codex turn and child
  observability contracts.

## Impact

- OpenClaw Codex harness, compile-cache startup path, sandbox filesystem bridge,
  focused tests, and runtime documentation.
- No OpenMAI/Langfuse package, Eval environment, systemd unit, global binary,
  or `/data/openclaw*` deployment change is part of this OpenClaw change.
