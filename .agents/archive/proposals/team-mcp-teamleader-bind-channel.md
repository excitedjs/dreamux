# Proposal: TeamLeader-scoped Team MCP channel binding

> **Archived 2026-09-01.** Superseded in location, kept in spirit: the tool is the Channel's, and the TeamLeader copy carries no team field. Current owner: [/.agents/domains/channel.md](/.agents/domains/channel.md).

- **Status:** Accepted for implementation after heterogeneous review
- **Date:** 2026-07-21
- **Affects:** `@excitedjs/dreamux` Team MCP projection, admin IPC caller
  scoping, Team route leases, bundled TeamLeader guidance
- **PR / Issue:** TBD

## Intent

Allow a TeamLeader that has created an external channel target to bind an
unowned target to its own current Team without exposing authority over any
other Team or collaboration-managed route.
Keep target selection provider-neutral and preserve the existing dispatcher
Team MCP contract.

## Scope

- Add `bind_channel({ channel_id?, meta })` to the TeamLeader Team MCP
  projection.
- Keep the dispatcher projection unchanged:
  `bind_channel({ team_name, channel_id?, meta })`.
- Bind TeamLeader calls to the descriptor-provided `team_id` and `leader_name`;
  never accept a model-supplied Team name for this projection.
- Give TeamLeader binding create-only ownership semantics: it may claim an
  unowned target, or receive idempotent success for the same Team/leader's
  existing explicit binding. It may not replace another owner or consume an
  active collaboration-managed route.
- Validate that descriptor scope against the current open, routable Team and its
  current leader generation while holding the Team route-publication lease.
- Reuse the current `ChannelService` target normalization and collaboration
  route-reconciliation path without interpreting provider `meta` in core.
- Update focused MCP, admin, service integration, model-facing contract, and
  architecture tests and documentation.

## Hard Constraints

- Core remains behind the neutral `ChannelProvider` seam. The selector `meta`
  stays an opaque provider-owned object, and core continues routing by the
  normalized `(channel_id, target_key)` pair.
- A TeamLeader call cannot name, override, or otherwise select another Team.
  The Team MCP shim omits `team_name`, and the admin server rejects it for a
  TeamLeader caller even if a raw local admin request supplies it.
- TeamLeader binding must not reuse the dispatcher's last-bind-wins mutation.
  An active binding owned by another Team/leader is rejected. An active
  collaboration target intent is rejected even when its current route happens
  to name the caller's Team. An existing explicit binding owned by the exact
  caller is returned unchanged, so the call does not clear a managed claim or
  detach collaboration intent.
- The admin handler derives a `TeamLeaderLease` from descriptor-bound
  `team_id` and `leader_name`. Route publication validates that lease against
  the current live Team generation under the same Team lifecycle queue used by
  explicit binding and Team closure.
- A stale leader generation, missing/closed Team, or Team that begins closing
  before the lease is acquired must fail before binding state changes or
  collaboration intent is detached.
- Provider target resolution happens before acquiring the Team route lifecycle
  queue. The route-specific lock is acquired before the Team lease, preserving
  the existing lock order and avoiding an external provider call while Team
  closure is blocked.
- Dispatcher callers keep the current omitted-`caller_kind` default, schema,
  arguments, target resolution, and binding semantics.
- `transfer_back` remains available in both projections with its existing
  semantics. It already has narrower authority: it can only deactivate a
  binding row whose authoritative owner exactly matches the descriptor-bound
  Team and leader. This change does not add a live-Team lease requirement or
  any new transfer authority.
- Descriptor scope is product semantics on the owner-only local `admin.sock`,
  not a new general admin IPC authentication layer. The server still validates
  the supplied current Team/leader generation for this route-creating action.

## Design

### MCP projection

`teamTools('team_leader')` returns, in order:

1. `bind_channel({ channel_id?, meta })`
2. `transfer_back({ channel_id?, meta })`

The TeamLeader binding description says that the operation binds the selected
target to "this Team" and has no `team_name` property. Runtime argument mapping
rejects a TeamLeader-supplied `team_name` and forwards only `channel_id`, `meta`,
and descriptor scope (`caller_kind`, `team_id`, `leader_name`). Dispatcher
mapping continues to require `team_name`.

### Server boundary and route lease

`adminMethods['team.bind_channel']` branches on `caller_kind`:

- dispatcher: call the existing dispatcher bind path with `team_name`;
- TeamLeader: reject `team_name`, derive `TeamLeaderLease` from `team_id` and
  `leader_name`, and call a dedicated leased bind entry point.

`TeamCollection` gains a routable TeamLeader lease capability that combines
the current-generation check, `ensureRouteReady()`, the closing fence, and the
existing route lifecycle queue. This is distinct from the existing member
operation lease, which does not require route readiness.

`TeamChannelCoordinator` resolves `channel_id` and the provider target before
entering the route mutation path. Collaboration route reconciliation then
acquires the route-specific lock and enters the routable TeamLeader lease. The
leased path checks for active collaboration intent before mutation and uses an
atomic Channel binding operation that creates only an unowned route or returns
the exact owner's existing explicit binding. It never detaches collaboration
intent. The dispatcher path remains unchanged and still commits its explicit
replacement before detaching collaboration intent.

The leased bind path must not validate the leader in one unlocked step and bind
in another. Validation and route publication stay inside the Team lifecycle
lease so Team close/replacement cannot cross the mutation.

The new mutation remains on `DispatcherService` / `TeamChannelCoordinator` /
`CollaborationRouteReconciler`. It must not be added to `TeamLeaderHandle`,
`TeamService`, or the Channel provider contract.

### Errors

Malformed TeamLeader scope or a supplied `team_name` is `BAD_REQUEST`.
A missing, closed, closing, wrong-generation, or stale-leader Team scope is
reported as `TEAM_NOT_FOUND`, matching other TeamLeader-scoped admin lookups
without exposing a second authorization taxonomy.
An occupied or collaboration-managed target is reported as `TEAM_BIND_FAILED`
with a public-safe conflict message. A successful TeamLeader bind returns the
same `ChannelBinding` result shape as dispatcher binding.

## Acceptance

- Dispatcher Team MCP tool names and `bind_channel` schema are unchanged.
- TeamLeader Team MCP lists exactly `bind_channel` and `transfer_back`.
- TeamLeader `bind_channel` requires `meta`, optionally accepts `channel_id`,
  and has no `team_name` field.
- A TeamLeader call forwards descriptor-bound scope and cannot override it with
  tool arguments or raw admin `team_name`.
- A current TeamLeader can bind a provider-normalized target to its Team, and
  inbound routing observes that binding.
- Wrong-Team input, occupied targets, active collaboration-managed targets, and
  stale/replaced leader generations are rejected before binding mutation or
  collaboration intent detachment.
- A same-owner explicit binding is idempotent and unchanged; a same-owner
  managed binding retains its claim and active collaboration intent.
- Target resolution completes before the Team route lease. Bind versus close,
  stale-generation, starting-leader, and managed-claim races preserve the
  current route/intent and fail closed.
- Existing dispatcher binding keeps replacement semantics, including commit
  before collaboration detach; its bind-versus-close tests and both
  dispatcher/TeamLeader transfer-back tests remain green.
- Model-facing gates are updated together: current architecture, channel
  runtime/domain references, service/model-writing references, bundled
  `team-workflow`, Team MCP tool/schema tests, skill tests, contract whitelist,
  and prompt registry parity.
- Raw admin tests cover TeamLeader `team_name` as `BAD_REQUEST`, missing/closed/
  closing/stale scope as `TEAM_NOT_FOUND`, occupied/managed targets as
  `TEAM_BIND_FAILED`, and omitted `caller_kind` dispatcher compatibility.
- Core/model-facing text contains no provider-specific selector fields or
  platform identifiers.

## Out of Scope

- Creating or deleting the external Feishu/Lark group or any other provider
  container.
- Exposing Team create, send, read, dissolve, or peer-Team tools to TeamLeaders.
- Letting a TeamLeader select a Team by name.
- Proving which external platform identity created a target. Core has no neutral
  creator fact; safe create-only route semantics prevent target takeover without
  inventing provider-specific ownership.
- Changing Channel provider contracts, binding persistence, target selector
  shape, or dispatcher routing behavior.
- Broadening `transfer_back`, TeamLeader channel egress, or collaboration-space
  lifecycle authority.
