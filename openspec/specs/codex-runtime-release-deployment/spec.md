# codex-runtime-release-deployment Specification

## Purpose

Define the generic OpenClaw runtime contracts needed to keep Codex sandbox
boundary checks and native hook process behavior correct across supported
execution modes, without prescribing a deployment topology.

## Requirements

### Requirement: Directory metadata boundary

The sandbox filesystem bridge SHALL allow metadata inspection of an existing
directory while preserving the same mount, canonical-path, symlink, and
writability checks used for file targets. A fallback that permits a directory
MUST carry its effective directory type through the final safety validation.

#### Scenario: Existing directory is inspected

- **WHEN** a stat request targets an existing directory inside an allowed mount
- **THEN** the bridge returns directory metadata
- **AND** the canonical path remains inside the allowed mount

#### Scenario: Directory handle fallback is used

- **WHEN** the initial boundary opener cannot return a directory handle but a
  supported directory fallback succeeds
- **THEN** the final safety check uses `allowedType: "directory"`
- **AND** the bridge does not bypass root, symlink, or mount validation

### Requirement: Native relay process boundary

When OpenClaw installs a native hook relay command on Unix, the command SHALL
avoid an extra shell wrapper and SHALL prevent OpenClaw's own detached CLI
respawn so the relay remains the direct child that Codex can clean up. This
contract applies to relay-enabled runs and does not require any
deployment-specific executable path.

#### Scenario: Relay command is constructed on Unix

- **WHEN** a Codex native relay command is built on Unix
- **THEN** it uses `exec` and `OPENCLAW_NO_RESPAWN=1`
- **AND** the relay is the direct child rather than an OpenClaw respawned child

#### Scenario: Relay command is constructed on Windows

- **WHEN** a Codex native relay command is built on Windows
- **THEN** the Unix-only `exec` and environment prefix are omitted
- **AND** the command remains valid without claiming Unix process-group cleanup

### Requirement: Compile-cache respawn boundary

The source-checkout compile-cache respawn path SHALL honor
`OPENCLAW_NO_RESPAWN=1` and avoid creating a detached replacement when the
caller is already inside a process-boundary-sensitive command. Packaged runtime
compile-cache behavior SHALL remain unchanged when the variable is unset; an
explicit truthy value intentionally opts out of cache relocation respawn for
process-boundary safety.

#### Scenario: Relay caller disables respawn

- **WHEN** a source-checkout entrypoint is invoked with
  `OPENCLAW_NO_RESPAWN=1`
- **THEN** compile-cache setup does not spawn a detached replacement

#### Scenario: Normal source startup remains compatible

- **WHEN** a source checkout starts without the no-respawn guard
- **THEN** existing compile-cache setup behavior remains unchanged

### Requirement: Runtime-only configuration lifecycle

The native relay setting SHALL be resolved from the host's normal plugin
configuration lifecycle. The runtime SHALL NOT guarantee that a setting change
is visible before Gateway restart, and SHALL NOT add a live thread migration
protocol solely for this setting. After restart, the setting is the stable
configuration for subsequent attempts and threads.

#### Scenario: Relay is disabled for a fresh thread

- **WHEN** `nativeHookRelay.enabled` is false before a new Codex thread starts
- **THEN** OpenClaw does not register or inject its compatibility relay
- **AND** Codex-owned user and plugin hooks remain enabled

#### Scenario: Relay setting changes before restart

- **WHEN** the setting changes while a Codex thread is running
- **THEN** the runtime makes no live-reconfiguration guarantee
- **AND** the operator restarts Gateway before relying on the new setting
