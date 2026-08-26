## Purpose

Provide a configurable, non-forced reclamation policy for cached Codex app-server clients so completed Agent work does not accumulate service processes while active sessions remain safe and reusable.

## ADDED Requirements

### Requirement: Idle timeout is configurable per Codex plugin deployment

The Codex plugin SHALL accept an optional `sharedClientIdleTimeoutMs` under its app-server configuration. The default SHALL be `0`; an unset or zero timeout SHALL preserve the current warm-client behavior, while a positive integer timeout SHALL enable idle reclamation for every shared Codex app-server client owned by that plugin process. Deployments SHALL be able to select different values without changing OpenClaw scheduler concurrency settings or endpoint-specific business logic.

#### Scenario: Default preserves warm clients

- **WHEN** the shared-client idle timeout is unset or zero
- **THEN** completed turns release their leases but idle shared clients remain available for reuse

#### Scenario: Deployment selects a positive idle timeout

- **WHEN** a deployment supplies a positive shared-client idle timeout
- **THEN** the running Codex plugin uses that value for all shared clients owned by that plugin process

#### Scenario: Invalid timeout is rejected

- **WHEN** the configured timeout is negative, non-finite, or not an integer duration
- **THEN** configuration validation rejects it before the Codex runtime starts

### Requirement: Only truly idle shared clients are reclaimed

The Codex plugin SHALL reclaim a shared app-server only when its idle timeout has elapsed and it has no active leases, pending acquisitions, or unfinished native-child activity holds. Reclamation SHALL retire the cached entry and wait for the app-server process to exit. An active turn SHALL never be force-closed solely because the idle timeout elapsed.

#### Scenario: Idle client is reclaimed

- **WHEN** a shared client has no active lease, no pending acquisition, no unfinished native-child activity hold, and remains unused for at least the configured timeout
- **THEN** the plugin retires the client, closes its app-server process, and removes it from the reusable cache

#### Scenario: Active client is protected

- **WHEN** a shared client has an active lease or pending acquisition at the timeout boundary
- **THEN** the plugin leaves the client running and does not interrupt the active turn

#### Scenario: Native child delays cleanup

- **WHEN** the parent turn is complete but a native child still uses the app-server
- **THEN** the plugin defers retirement until the child settles and then applies the idle policy

### Requirement: Idle policy is process-wide and reaches every shared client

The Codex plugin registration/startup hook SHALL install one process-wide idle policy for its shared-client state before any shared-client acquisition, including clients acquired by all supported Codex call paths. Discovery-only registration SHALL NOT start the reaper. The running process SHALL keep that policy until shutdown; configuration changes SHALL require a Gateway restart.

#### Scenario: All acquisition paths share one policy

- **WHEN** clients are acquired through conversation, control, model, migration, or Agent run paths in the same plugin process
- **THEN** each client is governed by the same effective `sharedClientIdleTimeoutMs` policy

#### Scenario: Configuration change requires restart

- **WHEN** an operator changes `sharedClientIdleTimeoutMs` while the Gateway is running
- **THEN** existing clients continue using the startup policy until the Gateway restarts

#### Scenario: Process shutdown stops idle policy

- **WHEN** Gateway shutdown begins
- **THEN** the process-wide reaper stops and releases its timer and client references

### Requirement: Native child activity is held explicitly

The native child lifecycle owner SHALL retain an activity hold on the parent shared client when a native child starts and SHALL release that hold exactly once on every terminal path, including normal completion, cancellation/interruption, parent replacement, monitor disposal, and late or unsupported child events. Duplicate release SHALL be safe. The idle reaper SHALL treat any such hold as active work, including after the parent turn releases its ordinary lease.

#### Scenario: Child hold protects parent client

- **WHEN** the parent turn is complete but a native child activity hold remains
- **THEN** the idle reaper does not retire the parent shared client

#### Scenario: Child hold release makes client eligible

- **WHEN** the final native child activity hold is released and no lease or pending acquisition remains
- **THEN** the client records its idle timestamp at that final hold-release transition and becomes eligible for normal idle timeout evaluation

#### Scenario: Idle timestamp starts after the final pending or child activity clears

- **WHEN** the last ordinary lease releases while a pending acquisition or native-child hold remains, and that final pending acquisition or hold later clears
- **THEN** the plugin records `lastIdleAt` at the clearing transition and measures the configured idle timeout from that point

### Requirement: Idle reclamation is race-safe and reusable

The plugin SHALL reset or cancel pending idle reclamation when a client is acquired again. Timer callbacks SHALL catch rejected bounded close operations. A client that was retired before a new acquisition SHALL NOT be returned to the caller; the caller SHALL receive a newly initialized client. Reclamation failures SHALL be logged with a credential-free client identity and SHALL NOT corrupt unrelated cached clients.

#### Scenario: Client is reused before timeout

- **WHEN** a client receives a new acquisition before its idle timeout expires
- **THEN** the pending reclamation is canceled and the existing client remains reusable

#### Scenario: Acquisition races with retirement

- **WHEN** an acquisition races with an idle sweep
- **THEN** the plugin serializes the decision so the caller receives either the still-valid client or a new client, never a closed client

#### Scenario: One client cleanup failure is isolated

- **WHEN** closing one idle client fails
- **THEN** the plugin records the failure and continues managing other shared clients
