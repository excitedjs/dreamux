# TeamLeader-scoped Team MCP transfer back technical design

> **Archived 2026-09-01.** Fully superseded; see the companion proposal above.

- **Status:** Implemented design history; current behavior is in [Current architecture](/.agents/domains/current-architecture.md)
- **Companion to:** [TeamLeader-scoped Team MCP transfer back](team-mcp-teamleader-transfer-back.md)
- **Source baseline:** `team/codex-next-0629-1928` at `91f02bc`

Admin method strings in this design preserve the pre-namespace-cleanup names
from that source baseline. Current product names are documented in
[Current architecture](/.agents/domains/current-architecture.md).

This design implemented only its original slice: expose `team.transfer_back` to a
TeamLeader and create a clear core Channel service boundary for channel-binding
ownership. It does not implement `team.send` or Team peer messaging.

## Settled choices

| Choice | Decision |
|---|---|
| Scope carrier | Descriptor/CLI-bound caller scope, not model text. |
| TeamLeader tool surface | Only `transfer_back`; no Team lifecycle or binding tools. |
| TeamLeader target resolution | Explicit `meta` only; no no-meta inference path. |
| Binding source of truth | Trust active binding rows for `team_name` and `leader_name`. |
| Binding ownership | Core `ChannelService` owns target resolution plus binding writes/deactivation. |
| Transfer API | One `ChannelService.transferBack` with optional expected-owner narrowing. |
| Tool response assembly | Admin methods compose service facts into model-facing responses. |
| Provider metadata | Keep current `meta -> provider resolveTarget -> target_key` flow in this slice. |
| Admin IPC trust | Do not add per-tool/admin-method identity restrictions; local admin IPC remains trusted. |
| Future `team.send` | Record the requirement, but leave it out of this slice. |

## Source-baseline facts

- Team MCP is currently dispatcher-only in practice: the descriptor is assembled
  for the dispatcher at
  `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts:28`.
- `teamMcpServerDescriptor` has only dispatcher/admin-socket arguments today
  (`/packages/dreamux/src/service/team-collection/mcp-config.ts:6`).
- `runTeamMcp` validates only `dispatcherId`, and `tools/list` always returns
  the full Team MCP surface (`/packages/dreamux/src/mcp/team-mcp.ts:32`,
  `/packages/dreamux/src/mcp/team-mcp.ts:101`).
- The current Team MCP `transfer_back` schema requires `meta`
  (`/packages/dreamux/src/mcp/team-mcp.ts:133`,
  `/packages/dreamux/src/mcp/team-mcp.ts:262`).
- The admin method for `mcp.team.transfer_back` always calls the dispatcher path
  and requires `meta` (`/packages/dreamux/src/admin/methods.ts:346`).
- `DispatcherService.bindTeamChannel` currently resolves the Team through
  `TeamCollection.get()` and delegates to `TeamService.bindChannel`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts:431`).
- `TeamService.bindChannel` only checks the Team record status, resolves the
  target by calling back through `TeamChannelContext`, then writes the binding
  row with `teamName` and `leaderName`
  (`/packages/dreamux/src/service/team-service/index.ts:338`).
- `DispatcherService.transferTeamChannelBack` already follows the cleaner shape:
  resolve channel and target, then call `TeamCollection.transferChannelBack`
  without loading a `TeamService`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts:443`).
- There is no full Channel service today. `ChannelSessions` owns live
  `ChannelSession` objects, provider tool forwarding, target resolution, and
  channel MCP descriptor assembly, while `ChannelBindingStore` is constructed
  separately by `DispatcherService`.
- The channel binding store records `channel_id`, `target_key`, `meta`,
  `team_name`, `leader_name`, and `active`
  (`/packages/dreamux/src/service/channel-binding/store.ts:21`).
- `TeamCollection.resolveChannel` currently resolves active binding rows and then
  checks `TeamStore` to exclude closed Teams before inbound delivery
  (`/packages/dreamux/src/service/team-collection/index.ts:205`).
- After inbound routing finds a binding, `DispatcherService.routeChannelInput`
  loads the live `TeamService` only to call `deliverToLeader`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts:455`).
- `TeamService` still owns the live Team runtime aggregate: leader
  `TeammateService`, team member collection, scheduler, shared workspace,
  leader delivery, and dissolve cleanup.

## Flatten non-policy launch options

Remove `TeamMateLaunchPolicy` and `TeamService.leaderLaunchPolicy()`.

Current behavior is only a pair of construction-time additions:

- extra MCP server descriptors;
- disabled runtime-native features.

Use flat construction options instead of a `Policy` wrapper. The exact naming can
follow the surrounding code, but the resulting shape should be equivalent to:

```ts
interface TeammateServiceOptions {
  mcpServers?: readonly AgentRuntimeMcpServer[];
  disableFeatures?: readonly string[];
}
```

`TeamService.buildLeader()` should assemble the TeamLeader's MCP descriptors
inline or via a small helper whose name says what it builds, not
`leaderLaunchPolicy`.

Do not keep a field named `launchPolicy` that merely holds the flattened shape.
The `TeammateServiceOptions` fields and the `createTeamLeaderAgent` dependency
fields should be named directly as `mcpServers` and `disableFeatures`.

Also remove non-policy union aliases where they only rename simple options:

- inline `TeamMateWorktreeCleanupPolicy` as `'keep' | 'delete-on-close'` in the
  containing interfaces, or rename only if there is a real readability gain;
- inline `JsonDocumentCorruptPolicy` as `'fail-loud' | 'warn-rebuild'` in
  `JsonDocumentStoreOptions` and the private field type.

Keep real access-policy names such as `DmPolicy` and `GroupPolicy`; those encode
authorization semantics and are not the same category.

## Introduce core ChannelService

Introduce a dispatcher-local core `ChannelService`. It is not a Channel provider
and it is not Feishu-specific. It is the Dreamux core service that owns:

- the existing live `ChannelSessions` behavior;
- channel id/provider selection helpers currently on `DispatcherService`;
- provider target normalization through the `ChannelSession.resolveTarget` seam;
- the dispatcher-local `ChannelBindingStore`;
- TeamLeader channel-egress checks that combine target normalization,
  message-ownership facts, and binding ownership.

Implement this as a new `service/channel-service/` wrapper around the existing
`ChannelSessions` helper, then make `ChannelSessions` private to that service.
The service's semantic role is to manage all Channel sessions under one
Dispatcher plus the durable binding state attached to those sessions. Do not
rename/expand `ChannelSessions` directly in this slice.

The service should expose a small route-owner shape:

```ts
export interface ChannelRouteOwner {
  kind: 'team';
  teamName: string;
  leaderName: string;
}
```

This does not require a persisted format change. The store can keep its current
`team_name` and `leader_name` columns while the service API uses the clearer
owner model.

`ChannelService` should own these operations:

- `bindTarget({ owner, channelId?, meta })`;
- `transferBack({ expectedOwner?, channelId?, meta })`;
- `resolveInboundBinding({ channelId, target })`;
- `ownerCanUseTarget({ owner, targetKey })`;
- `activeBindingSummaryForOwner(owner)`;
- `transferAllForOwner(owner)`;
- live-session operations currently on `ChannelSessions`: build/adopt/close,
  channel MCP descriptors, tool invocation, target resolution, and
  `messageBelongsToTarget`.

The Channel service may store route owners, but it must not construct or own
Teams or TeamMates. It treats the owner as routing data.

`ChannelService` should own the dispatcher config facts it needs for channel
selection. Prefer passing `dispatcherId`, `config`, `ChannelProviderCatalog`, and
the channel logger/admin-socket options directly into `ChannelService`, mirroring
the existing `ChannelSessionsOptions`, so `resolveChannelId`,
`channelProviderRef`, and `resolveToolChannelId` move out of `DispatcherService`
without a callback-shaped dependency on the dispatcher aggregate.

## Dispatcher and Team boundary

`DispatcherService` remains the orchestration point across agents, Teams, and
channels. It should own one `ChannelService` and one `TeamCollection`.

`TeamCollection` should stop receiving `ChannelBindingStore`. It can expose a
small Team fact query for orchestration:

```ts
requireOpenTeamRouteOwner(teamId: string): Promise<ChannelRouteOwner>
```

That method only validates Team existence/open status and returns
`teamName/leaderName`. It does not resolve channel targets or mutate binding
rows.

`TeamService` should stop receiving `ChannelBindingStore` and should drop
channel-binding methods such as `bindChannel` and `resolveLeaderChannel`.
It remains responsible for the live Team runtime aggregate: leader
`TeammateService`, team-scoped member collection, scheduler, shared workspace,
leader delivery, and dissolve cleanup.

`TeamMateService` remains the generic agent entity wrapper. It should not gain
channel-binding responsibilities.

Construction order should keep dependencies one-way:

1. create shared stateless stores and helpers (`WorktreeManager`, identity and
   turns stores, `ChannelBindingStore`);
2. construct `TeamCollection` without channel-binding dependencies;
3. construct `ChannelService` with the channel dependencies plus
   `ChannelBindingStore`;
4. construct agent services that need live channel descriptors from
   `ChannelService`.

Do not pass Team lifecycle callbacks into `ChannelService` for inbound routing in
this slice. The closed-Team delivery guard stays in `DispatcherService`, after
ChannelService resolves the binding owner and before the dispatcher calls
`deliverToLeader`.

## MCP shim shape

Extend `TeamMcpOptions` with a narrow caller scope:

```ts
export type TeamMcpCallerKind = 'dispatcher' | 'team_leader';

export interface TeamMcpOptions {
  dispatcherId: string;
  callerKind?: TeamMcpCallerKind; // default: 'dispatcher'
  teamId?: string;
  leaderName?: string;
  adminSocketPath?: string;
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
}
```

Validation rules:

- `callerKind` defaults to `dispatcher`.
- `team_leader` requires a valid `teamId` and a valid `leaderName`.
- `dispatcher` ignores `teamId`/`leaderName` for behavior; the descriptor should
  not pass them.

`teamTools(callerKind)` returns:

- dispatcher: the existing unchanged tool list and schemas;
- team_leader: only `transfer_back`.

For both dispatcher and TeamLeader schemas, keep `meta` required and
`channel_id` optional. The TeamLeader description should state that `meta` is
the provider target selector that will be normalized by the channel provider.
This is viable because TeamLeaders already supply provider target selectors for
channel egress tools; this slice does not require them to infer target identity
from hidden binding state.

`callTool` forwards the descriptor-bound scope into admin params:

```ts
{
  dispatcher_id,
  caller_kind,
  team_id,      // only for team_leader
  leader_name,  // only for team_leader
  ...toolArgs
}
```

`mapToolCall(call, callerKind)` should reject every non-`transfer_back` call for
a `team_leader` caller even if a client manually sends a hidden tool name.

## CLI and descriptor wiring

Extend `dreamux team-mcp` with:

- `--caller <dispatcher|team_leader>`; default `dispatcher`
- `--team-id <id>`; required when `--caller team_leader`
- `--leader-name <name>`; required when `--caller team_leader`

Extend `teamMcpServerDescriptor` with optional caller fields:

```ts
interface TeamMcpServerDescriptorOptions {
  dispatcherId: string;
  adminSocketPath: string;
  callerKind?: 'dispatcher' | 'team_leader';
  teamId?: string;
  leaderName?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
}
```

The dispatcher descriptor remains behaviorally unchanged.

Inject the TeamLeader-scoped Team MCP descriptor when building the TeamLeader's
flat launch options, next to the existing TeamMate, cron, and channel
descriptors. Do not add a role switch inside generic `TeammateService`.

The TeamLeader MCP server name can remain `team`; TeamLeaders do not currently
receive a Team MCP descriptor, so this adds no duplicate name in their runtime
context.

## Admin routing

Update `mcp.team.transfer_back` to branch by `caller_kind`, defaulting to
`dispatcher` for compatibility.

Dispatcher branch:

- keep the current contract unchanged;
- require `meta`;
- resolve `channel_id` the same way as today;
- call the same dispatcher transfer method without an owner.

TeamLeader branch:

- require `team_id` and `leader_name` from descriptor-bound caller scope;
- require `meta`;
- accept optional `channel_id`;
- call the same dispatcher transfer method with a route owner:

```ts
transferTeamChannelBack(input: {
  expectedOwner?: ChannelRouteOwner;
  channelId?: string;
  meta: Record<string, unknown>;
}): Promise<ChannelBinding | null>
```

This is a product-level caller-scope constraint, not a new admin IPC security
boundary.

## Binding creation flow

Move binding creation out of `TeamService.bindChannel`.

`DispatcherService.bindTeamChannel` should:

1. ask `TeamCollection.requireOpenTeamRouteOwner(teamId)` for the Team route
   owner;
2. call `ChannelService.bindTarget({ owner, channelId, meta })`.

`ChannelService.bindTarget` should:

1. resolve `channelId`;
2. resolve `target` through the selected live channel session;
3. get the provider ref for the selected channel;
4. call `ChannelBindingStore.bind` with the supplied route owner's `teamName`
   and `leaderName`.

This uses the authoritative Team record without rebuilding a live `TeamService`
for a binding-store write, while keeping the actual binding mutation on the
Channel service.

If no other methods need it after this move, remove `TeamChannelContext`.

## Transfer-back flow

Use one underlying transfer-back path for dispatcher and TeamLeader calls.

`DispatcherService.transferTeamChannelBack` should:

1. pass `channelId`, `meta`, and optional `expectedOwner` to
   `ChannelService.transferBack`;
2. contain no separate dispatcher-vs-TeamLeader binding logic.

`ChannelService.transferBack` should:

1. resolve `channelId`;
2. resolve `target` through the selected live channel session;
3. resolve the active binding row by `(dispatcher_id, channel_id, target_key)`;
4. return `null` when no active row exists, preserving the existing dispatcher
   service/store behavior;
5. when `expectedOwner` is supplied, compare the row's `team_name` and
   `leader_name` to that owner;
6. fail when the supplied expected owner does not match the active binding row;
7. call `ChannelBindingStore.transferBack`.

Do not load `TeamService` for this path. The binding row already records the
Team and leader that wrote the active binding. Treat that row as the source of
truth for transfer-back ownership.

Admin methods decide the tool-facing response for a `null` transfer result. They
may surface an explicit not-bound response or error, but the domain service
contract should be unambiguous.

## Inbound routing shape

No new inbound behavior is required for this slice, but the design should not
deepen the current TeamService coupling.

Current inbound routing is already mostly outside TeamService:

1. channel provider normalizes inbound into an envelope with `target_key`;
2. `DispatcherService.routeChannelInput` should ask `ChannelService` for an
   active binding;
3. `ChannelService` reads the binding row and returns the route owner;
4. only after a binding is selected does `DispatcherService` load the
   `TeamService` and call `deliverToLeader`.

Active binding rows should be the channel routing source of truth. Team lifecycle
transitions such as dissolve should clear bindings through `ChannelService`.
The implementation must still preserve the existing "do not deliver to a closed
Team" failsafe. `DispatcherService.routeChannelInput` should check Team state
before `deliverToLeader`; `ChannelService` should not call into Team lifecycle
state for this guard. Do not rely only on dissolve-time binding cleanup as the
closed-Team guard.

## Admin response composition

Team MCP responses should be assembled in admin methods, not in domain services
and not in the stdio MCP shim. The current code returns model-facing structures
directly from `TeamCollection.list()`, `TeamService.status()`, and
DispatcherService forwarding methods; this slice should move those aggregate
projections toward `packages/dreamux/src/admin/methods.ts` as files are touched.

The stdio MCP shim lives in a separate process and should remain a thin JSON-RPC
adapter. It should make one admin request per tool call, and the serve-side admin
method should compose any Team/Channel/runtime facts in-process. This avoids
forcing a single MCP tool call to perform multiple cross-process admin RPCs.

Recommended shape:

- `TeamCollection` provides Team record/list/history facts and open-Team owner
  lookup. It should not include binding summaries in its domain return types.
- `TeamService` provides live Team detail facts such as leader status, member
  count, and shared runtime state. It should not include binding summaries.
- `ChannelService.activeBindingSummaryForOwner(owner)` provides binding facts.
- Admin methods compose `team.list`, `team.status`, and `team.history` responses
  from those service facts.
- `mcp.team.bind_channel` first asks Team services for the owner, then asks
  `ChannelService` to bind, then assembles the tool response at the adapter.
- `mcp.team.transfer_back` asks `ChannelService.transferBack` to mutate the
  binding row, then assembles the tool response at the adapter.
- `DispatcherService.dissolveTeam` should orchestrate binding cleanup via
  `ChannelService.transferAllForOwner` and Team runtime cleanup via
  `TeamService.dissolve`; `mcp.team.dissolve` should call that dispatcher
  orchestrator and assemble the returned tool response.

The model-facing shape should therefore live in `admin/methods.ts` or small
admin-side helpers called from it, not in `TeamService`, `TeamCollection`,
`ChannelService`, or `mcp/team-mcp.ts`.

Do not move orchestration that must also apply to non-MCP callers into the admin
method. Admin composes response shape; dispatcher services coordinate side-effect
ordering across domain services.

## Dissolve ordering

`DispatcherService.dissolveTeam(teamId)` must be the single orchestration seam for
Team dissolve side effects:

1. ask `TeamCollection.requireOpenTeamRouteOwner(teamId)` or an equivalent Team
   fact method for the route owner;
2. call `ChannelService.transferAllForOwner(owner)` to deactivate active channel
   bindings;
3. load the live Team through `teams.get(teamId)`;
4. call `TeamService.dissolve(input)` for leader/member shutdown, scheduler
   cleanup, worktree cleanup, and TeamRecord lifecycle update;
5. return facts that the admin method can shape for the MCP response.

`TeamService.dissolve` must drop its current binding-transfer loop and
`TeamServiceDeps` must stop carrying `ChannelBindingStore`. This prevents a
parallel binding authority and keeps programmatic `DispatcherService.dissolveTeam`
callers correct even when they do not go through MCP/admin.

## Delivery sequencing

Implementation may be split internally into focused development chunks:

- introduce `ChannelService` and move channel-binding ownership;
- expose TeamLeader-scoped `transfer_back`;
- do the mechanical policy flattening and read-view response cleanup touched by
  the change.

The final operator-facing deliverable should be one integrated PR targeting
`next`, with the internal sequence squashed or stacked however the authoring flow
requires.

## Error model

Use fail-loud errors with distinct messages for:

- missing TeamLeader caller fields;
- unknown `caller_kind`;
- dispatcher call missing `meta`;
- TeamLeader call missing `meta`;
- unknown `channel_id`;
- provider target resolution failure;
- no active binding for the resolved target, represented by the explicit
  `ChannelService.transferBack` null result and shaped by the admin method;
- resolved binding belongs to another Team/leader;
- hidden dispatcher-only Team tool called through a TeamLeader-scoped MCP shim.

Avoid introducing extra authorization vocabulary around local admin IPC. These
errors describe invalid product state or caller-scope mismatch.

## Documentation and bundled skill updates

Update text that currently says Team MCP is dispatcher-only:

- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`
- `/packages/dreamux/skills/.claude/skills/dispatcher/SKILL.md`
- `.agents/reference/dispatcher-skill.md`
- `.agents/reference/current-architecture.md`
- `.agents/reference/channel-runtime.md`
- `.agents/reference/service-topology.md`

The replacement wording should describe a caller-scoped Team MCP:

- dispatcher sees lifecycle and binding tools;
- TeamLeader sees only scoped `transfer_back`;
- both dispatcher and TeamLeader transfer-back use explicit provider target
  `meta`;
- `team.send` remains future work.

Also update service topology docs to reflect that channel binding creation,
lookup, egress ownership checks, summaries, and transfer-back are
`ChannelService` / `ChannelBindingStore` responsibilities, not Team or TeamMate
service responsibilities.

Concrete source paths to retire or move:

- `TeamService.bindChannel` and `TeamService.resolveLeaderChannel`;
- `TeamService.dissolve`'s binding-transfer loop;
- `activeGroupBindingFor` and the TeamCollection internal binding reads used by
  list/history/status summaries;
- `DispatcherService.teamLeaderCanUseChannel`;
- `authorizeTeamLeaderChannelEgress` and its three-function context should
  collapse into `ChannelService` egress authorization helpers.

## Test coverage

MCP shim tests:

- dispatcher `tools/list` is unchanged;
- TeamLeader `tools/list` contains only `transfer_back`;
- TeamLeader `transfer_back` schema still requires `meta`;
- TeamLeader calling a hidden lifecycle tool returns an error;
- TeamLeader `transfer_back` forwards `caller_kind`, `team_id`, and
  `leader_name`;
- dispatcher `transfer_back` still requires `meta`.

Descriptor / launch-option tests:

- `teamMcpServerDescriptor` emits dispatcher args unchanged by default;
- TeamLeader descriptor emits `--caller team_leader`, `--team-id`, and
  `--leader-name`;
- a TeamLeader runtime context includes the `team` MCP server;
- a regular Team member runtime context still does not receive Team MCP;
- `TeammateService` consumes flat launch options rather than a
  `TeamMateLaunchPolicy` wrapper.

Admin and service tests:

- dispatcher `mcp.team.transfer_back` preserves the existing envelope and meta
  pass-through;
- TeamLeader transfer requires `meta`;
- TeamLeader transfer resolves `meta` through the channel provider;
- TeamLeader transfer succeeds when the resolved active binding row has matching
  `team_name` and `leader_name`;
- another Team's binding cannot be transferred;
- no active binding has a clear admin-shaped response while
  `ChannelService.transferBack` returns `null`;
- `bind_channel` writes through `ChannelService.bindTarget` without loading a
  live `TeamService`;
- binding a closed Team rejects from TeamRecord status.
- Team list/status/history responses still include binding summaries through
  admin method composition.
- dissolve clears active bindings through ChannelService before
  `TeamService.dissolve` runs.
- service-level unit tests assert that Team services do not import
  `ChannelBindingStore` or return binding summaries directly.
- egress authorization no longer routes through `TeamService.resolveLeaderChannel`
  or `DispatcherService.teamLeaderCanUseChannel`.

Prompt / skill contract tests:

- bundled dispatcher skill and base prompt no longer say Team MCP is
  dispatcher-only;
- prompt/skill text still teaches dispatcher `bind_channel({ team_name,
  channel_id?, meta })`;
- prompt/skill text teaches TeamLeader-scoped `transfer_back({ channel_id?,
  meta })` without implying TeamLeader `status`/`list` access.

## Validation surface

Expected focused checks for the implementation PR:

```bash
pnpm --dir packages/dreamux exec vitest run \
  tests/team-mcp.test.ts \
  tests/admin-methods-intent-note.test.ts \
  tests/team-collection-read-path.test.ts \
  tests/team-scheduler.test.ts \
  tests/teammate-mcp-skills.test.ts \
  tests/prompt-registry-parity.test.ts \
  tests/mcp-contract-whitelist.test.ts

pnpm --dir packages/dreamux run typecheck
pnpm --dir packages/dreamux run typecheck:tests
.agents/scripts/check.sh
```

If package-local tooling is unavailable in the checkout, use the Rush scripts
from the repo root rather than per-package install commands.

## Review focus

- Whether the new `ChannelService` wrapper fully owns binding read/write paths
  while leaving provider code Team-agnostic.
- Whether the DispatcherService closed-Team guard is preserved after inbound
  binding lookup moves to ChannelService.
- Whether any runtime needs a different MCP server name than `team` for the
  TeamLeader-scoped projection.
