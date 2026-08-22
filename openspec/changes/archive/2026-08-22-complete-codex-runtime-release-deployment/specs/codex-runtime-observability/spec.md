## MODIFIED Requirements

### Requirement: Minimal seam policy

The runtime SHALL use existing public hooks for all observable events and SHALL
add a core or SDK seam only when a required event cannot be reached otherwise;
any seam MUST be additive, narrowly scoped, documented, and covered by focused
tests. The OpenClaw native-hook relay is an optional compatibility layer: when
its explicit relay setting is disabled, the runtime SHALL omit only OpenClaw
relay registration and configuration injection, while leaving Codex-owned user
and plugin hooks unchanged. The setting SHALL follow the host's normal
configuration lifecycle and SHALL NOT promise live reconfiguration of an
already-running Codex thread. The operator-facing configuration contract SHALL
state that the operator must restart Gateway before relying on a changed
setting.

#### Scenario: Existing hooks are sufficient

- **WHEN** the required model and tool facts are available through current hooks
- **THEN** no Codex core-path modification is required for the plugin

#### Scenario: A required event is unreachable

- **WHEN** a required observable event is proven absent from current public hooks
- **THEN** the implementation adds only the smallest additive seam needed to
  publish that event and verifies both the new path and existing hook behavior

#### Scenario: OpenClaw relay is disabled by configuration

- **WHEN** the host configuration explicitly disables the OpenClaw compatibility
  relay
- **THEN** no OpenClaw relay commands are injected for that fresh Codex thread
- **AND** Codex-owned hooks remain enabled and are not replaced with an empty
  global hook configuration

#### Scenario: Relay mode changes before restart

- **WHEN** an operator changes the relay setting while a Codex thread is running
- **THEN** the runtime makes no live-reconfiguration guarantee
- **AND** the setting is supported as a stable configuration only after a
  Gateway restart
