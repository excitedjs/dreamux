# Channel-scoped collaboration operations and core events

- **Status:** Accepted
- **Date:** 2026-07-16
- **Affects:** Channel provider ABI, collaboration-space routing, dispatcher
  composition, Team and agent fact publication
- **PR / Issue:** N/A

## Context

Some Channel providers need a synchronous boundary between accepting an
external target and sending its first turn. The conversational Channel path is
intentionally more flexible: target-created notifications may provision in the
background, and ordinary delivery may use provider-declared fallback targets or
the dispatcher agent.

Providers also need live Team, TeamLeader, TeamMate, and turn facts without
receiving core services, stores, or provider-specific projections. Those facts
already have authoritative write points in Team, identity, and turn owners.

## Decision

Add three optional, provider-neutral capabilities to `ChannelRoutes`:

- synchronous `ensureCollaborationTarget`, implemented by the existing
  collaboration-space target owner and returning only the existing Team name;
- `deliverExact`, fenced by the expected Team name and restricted to the exact
  active collaboration route and TeamLeader;
- a dispatcher-scoped, read-only core event source backed internally by one
  in-process typed `EventEmitter` bus.

Provider input contains only neutral container, target, title, expected Team,
and turn data. Repository, cwd, workspace mode, dispatcher, channel, and
provider authority remain core-local. Workspace placement follows the existing
dispatcher configuration.

## Consequences

- Existing `deliver` and `targetLifecycle` behavior remains unchanged; older
  providers can ignore all three optional capabilities.
- Ensure succeeds only after Space binding, local workspace, Team, TeamLeader,
  active target, and exact route readiness agree under existing owner fences.
- Exact delivery never walks target fallbacks and never invokes the dispatcher
  agent. `sourceId` remains a live-runtime hint with no cross-restart guarantee.
- The bus is distribution infrastructure only. Team, identity, and turn stores
  remain authoritative and publish allowlisted facts after their normal write
  point.
- Channel sessions receive owned subscription handles, not the bus or its
  listener-management surface. Core revokes a session generation on stop or
  failed start.
- Events are best-effort and live-session-only. The bus retains no history and
  provides no delivery guarantee or historical query.
- The public surface has no remote close or cancel operation and does not add a
  new target owner or durable state format.

Guards live in the root-export/external-provider fixture tests, strict
collaboration routing tests, owner-publisher payload tests, and event-source
scope and cleanup tests.

## Alternatives Considered

- **Change `targetLifecycle(target_created)` to block until ready:** rejected
  because it would change existing conversational behavior.
- **Let the provider select repository or workspace policy:** rejected because
  local resource placement belongs to the dispatcher and collaboration binding.
- **Expose a callback on `ChannelSession`:** rejected because the session is the
  consumer; a scoped source gives the consumer explicit listener ownership and
  keeps core implementation classes private.
- **Have each entity inherit `EventEmitter`:** rejected because dynamic entity
  lifetimes would require distributed listener registration and cleanup. One
  dispatcher-owned bus preserves current state ownership with a smaller
  composition surface.
