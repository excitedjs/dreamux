# Channel-scoped collaboration operations and core events

- **Status:** Accepted (amended 2026-07-26)
- **Date:** 2026-07-16
- **Affects:** Channel provider ABI, collaboration-space routing, dispatcher
  composition, Team and agent fact publication
- **PR / Issue:** N/A

> **Amendment 2026-07-26 — optional per-target repo.** This decision originally
> kept repository/cwd/workspace-mode entirely core-local and rejected letting a
> provider select repository policy. It is superseded on that single point: a
> provider may now supply an optional repo (a source `path` and a `base_ref`)
> for one collaboration target. Core still owns everything else — it validates
> the request, maps it onto the existing Team/worktree creation options, and
> owns worktree lifecycle and cleanup. See "Optional per-target repository"
> below.

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
and turn data, plus the optional per-target repo described in the amendment
below. Cwd, workspace mode, dispatcher, channel, and provider authority remain
core-local. Absent an explicit repo, workspace placement follows the existing
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
- Each `ChannelSession.start` receives fresh process-local leases for strict
  routes and core events. Core revokes both before session close on stop or
  failed start. A later call through an old strict closure returns
  `dispatcher_unavailable` without entering routing or materializing a runtime.
- Failed start closes dispatcher admission, drains accepted work, and reuses the
  existing materialized-Team runtime sweep. Durable Team and target facts remain
  available for a later session generation to recover.
- Events are best-effort and live-session-only. The bus retains no history and
  provides no delivery guarantee or historical query.
- The public surface has no remote close or cancel operation and does not add a
  new target owner or durable state format.

Guards live in the root-export/external-provider fixture tests, strict
collaboration routing tests, owner-publisher payload tests, and event-source
scope and cleanup tests.

## Optional per-target repository

`ChannelCollaborationTargetEnsureInput` gains an optional
`repo: DreamuxManagedRepoRequest`, carrying a source `path` and a `base_ref`.

- **Constrained provider input; core keeps authority.** Collaboration routing
  validates the request with a small local validator (nonblank bounded `path`
  and `base_ref`) and forwards it into the provision input. A malformed request
  is rejected as `invalid_input`.
- **Direct mapping onto existing worktree creation.** When `repo` is present,
  core maps it onto the existing `TeamCollection.create` / `WorktreeManager`
  managed-worktree options, so the target's Team is created in a managed
  worktree branched from `base_ref`; managed mode and delete-on-close are core's
  fixed behavior, not provider input. When `repo` is omitted, the existing
  space-binding behavior is used.
- **Existing failure semantics.** A worktree failure keeps the existing
  `operation_failed` behavior.

## Alternatives Considered

- **Change `targetLifecycle(target_created)` to block until ready:** rejected
  because it would change existing conversational behavior.
- **Let the provider select repository or workspace policy:** originally
  rejected because local resource placement belongs to the dispatcher and
  collaboration binding. **Partially superseded (2026-07-26):** a provider may
  now supply one repo (`path` + `base_ref`) per target. The blanket rejection
  still holds for cwd, workspace mode, and any unconstrained repository/policy
  selection; core retains allocation, worktree lifecycle, and cleanup authority.
- **Expose a callback on `ChannelSession`:** rejected because the session is the
  consumer; a scoped source gives the consumer explicit listener ownership and
  keeps core implementation classes private.
- **Have each entity inherit `EventEmitter`:** rejected because dynamic entity
  lifetimes would require distributed listener registration and cleanup. One
  dispatcher-owned bus preserves current state ownership with a smaller
  composition surface.
