# service/

The Dispatcher Service module (issue #135 entity, issue #233 restructure): the
real entity that the server launches per dispatcher. It holds the dispatcher
agent and orchestrates teammates. `server.ts` is wiring only — all per-dispatcher
orchestration lives here. One service class per file/dir; a class with helpers
gets a directory whose `index.ts` is the class and siblings are its helpers.
`service/index.ts` is the only package-internal service facade (`Dispatchers`,
`DispatcherService`, `TeamService`, `WorkflowService`, and
`ChannelToolAuthorizationError` from `channel-service/errors.ts`). Sub-service
directories must not re-export sibling modules; callers import the owning module
directly unless the symbol belongs on the explicit `service/index.ts` facade.

## What goes where

- **`dispatchers/index.ts`** — the `Dispatchers` collection: a thin factory + cache over
  per-dispatcher `DispatcherService` aggregates plus process-wide
  shutdown/restart hooks only. It owns **no** teammate/team/channel/router state —
  each `DispatcherService` builds and owns its own object graph (collections,
  stores, worktree manager, stateless `CompletionDeliveryPolicy`,
  `ChannelService`, and the
  dispatcher agent). This collection only keys them by dispatcher id (Phase 3,
  #233), and shutdown closes its factory admission before sweeping existing
  aggregates so no new dispatcher can materialize after the sweep snapshot.
- **`server.ts` + `admin/socket.ts`** — the process admission boundary. Admin
  socket requests execute through `Server.admitAdminRequest()`; shutdown closes
  this admission and synchronously publishes every materialized dispatcher
  fence before draining accepted admin requests, then shuts down dispatchers and
  the socket. Do not let admin handlers call mutating services outside this
  process-level gate.
- **`dispatcher-service/index.ts`** — one dispatcher-local aggregate
  (`DispatcherService`). It *has an* agent — a contained `TeammateService` built
  by `dispatcher-service/agent.ts` (Phase 5, #233) — that owns the agent runtime
  and logical-close lifecycle. `DispatcherService` keeps the dispatcher-only
  concerns the removed `DispatcherRuntimeService` held: the live `ChannelService`,
  restart-notice injection for explicit resume notices, provider/config-based
  role MCP descriptor assembly, channel-tool dispatch, channel binding ownership,
  completion routing, dispatcher-owned admission/drain for mutating external
  operations, Team/channel lifecycle coordination, and all-settled runtime
  shutdown sweeps. Ordinary start prepares channel sessions and input sources
  while leaving the dispatcher runtime dormant; unbound channel inbound,
  dispatcher cron, or an explicit resume notice lazy-starts the contained agent.
  A channel session is published as live only after provider start succeeds. It
  resolves a Turn's completion target before provider admission via
  `initiatorFor` and captures the resulting delivery closure (a team member →
  `TeamCollection`'s generation-bound, availability-gated completion adapter; a
  dispatcher-owned teammate / leader → the dispatcher's own `agent`
  `TeammateService`) and
  orchestrates Team route-owner facts with ChannelService binding operations via
  `TeamChannelCoordinator` and collaboration route reconciliation.
- **`team-collection/index.ts`** — `TeamCollection` (split out of the old
  `TeamManager`): owns the Team store, worktrees, create/list/history/read
  projection, route and generation leases, and the single durable Team dissolve
  lifecycle. The same availability fence gates every Team turn/mutation/route
  path. Dissolve owns durable acceptance, writer capture and `waitIdle`
  quiescence, both worktree assessments, the `logicalClosed` milestone,
  durable terminal-state observation, retry/recovery, and shutdown interruption.
  Its sibling modules are private implementation capabilities, not additional
  aggregate owners: `runtime-registry.ts` owns materialization/cache and private
  scheduler handles; `read-model.ts` owns public read projection;
  `dissolve-controller.ts` owns the immutable operation/TeamLeader generation,
  authoritative current-operation refresh, process-local operation registry,
  retry/recovery orchestration, `logicalClosed` settlement, closing-fence
  finalization, registry removal, shutdown suspension, and terminal logging.
  `dissolve-runner.ts` is a stateless accepted-phase executor: it requests those
  controller operations and never settles `logicalClosed`, removes operations,
  finalizes a fence, or logs a lifecycle terminal itself. Captured live writers
  expose only their name and neutral `waitIdle` capability, not their runtimes.
  **`team-service/index.ts`** — `TeamService`, the single per-team entity (holds
  its own `TeamRecord`): status/delivery/shared-workspace/member operations plus
  live-writer enumeration and the accepted operation's logical resource close.
  It propagates one shared cleanup state to leader and members, but it does not
  accept dissolve, detach routes, assess/delete worktrees, or own retry state.
  `TeamCollection` holds the Team scheduler lifecycle capability separately;
  do not add scheduler start/stop wrappers to the public `TeamService` surface.
  `DispatcherService.team()` returns only `TeamLeaderHandle` for admin/MCP
  team-leader callers, never concrete `TeamService`; keep dissolve,
  scheduler lifecycle, and route ownership inside dispatcher/team-collection
  orchestration. The handle is bound to a `TeamCollection` TeamLeader lease
  (`team_id` + current `leader_name` generation); every mutation rechecks
  open/not-closing/current generation, while reads use a separate
  generation-checked lease that remains available during close. Its teammate
  sub-surface must not expose raw `spawn`. Scoped self-dissolve goes through the
  descriptor-bound `TeamChannelCoordinator` path rather than growing a second
  state machine on this handle. Route publication uses a distinct
  routable TeamLeader lease that also starts/proves the leader before mutation;
  channel binding remains in dispatcher-side coordination, not on the handle.
- **`dispatcher-service/` (agent-side parts)** — the dispatcher agent's parts (Phase 5, #233):
  `agent.ts` builds the dispatcher's own agent as a contained `TeammateService`
  from the dispatcher root `identity.json` (role `dispatcher`), structurally
  outside the `teammate/` collection so read chokepoints never enumerate it.
  Runtime launch resolves through the same `identity.agent_runtime -> agents[]`
  path as child roles. `mcp-descriptors.ts` is the role-based MCP descriptor
  builder. `inbound-task-drain.ts` owns the dispatcher admission/drain gate for
  external work that may publish runtime, scheduler, route, or durable state.
  `team-channel-coordinator.ts` maps both Dispatcher and descriptor-scoped
  TeamLeader dissolve into the same TeamCollection lifecycle, derives the
  Dispatcher pre-acceptance deadline and returns only the durable accepted
  receipt, keeps TeamLeader channel-tool invocation inside its exact generation
  lease, and coordinates dispatcher/scoped-TeamLeader bind and transfer with
  collaboration-space route reconciliation.
  `channel-tool-invocation.ts` keeps TeamLeader egress authorization beside
  channel tool dispatch.
  `teammate-ops.ts` wraps dispatcher-scope mutating teammate ops with the
  dispatcher admission gate. Dispatcher and Team schedulers also receive this
  gate in their options and expose only `SchedulerCommands` to external callers,
  so public cron mutations and timer fires cannot write cron state or submit
  after dispatcher shutdown begins, and lifecycle verbs (`start` / `stop` /
  `deleteStoreFile`) remain owner-only through the dispatcher container or
  `TeamCollection`'s private capability map. `restart-notice.ts` owns explicit
  resume-notice injection. `team-runtime-stop.ts` keeps Team runtime stop
  failures contained so dispatcher shutdown can keep sweeping later-owned
  resources before returning an aggregate error.
  `input-source-lifecycle.ts` owns dispatcher preparation/start single-flight
  state, prepared Channel sessions, dispatcher agent/workspace publication,
  ordered Channel session publication, and failed-start rollback. It applies the
  aggregate availability fact internally; `DispatcherService` retains public
  facade methods plus the aggregate stop ordering across every owned service.
- **`channel-service/`** — the dispatcher-local core Channel service. It wraps the
  private live `ChannelSessions` helper, owns channel-tool dispatch, provider
  target resolution, TeamLeader egress checks, and all `ChannelBindingStore`
  reads/writes/summaries/transfer-back operations. It treats Team route owners as
  flat routing data and does not import Team service types. The dispatcher base prompt and runnable-channel guard stay under `dispatcher-service/`. There
  is **no** `DispatcherRuntimeService`; a stateless completion-delivery policy
  prepares the target once and retries only explicit pre-admission failures,
  while `TeammateService.prepareCompletion` captures the target-side submission
  closure before the source Turn can settle.
- **`collaboration-space/route-reconciliation.ts`** — the route reconciler owned
  by `CollaborationSpaceService`: it is the single place that reconciles
  collaboration target intent with authoritative channel bindings, coordinates
  explicit Team binds/transfers, releases managed routes by exact `claim_id`, and
  detaches stale collaboration target records. Keep route provenance here and in
  `ChannelBindingStore`; do not re-infer managed ownership from a Team owner
  tuple elsewhere. Every operation needing both scopes takes the target lock
  before the Team lease; scoped transfer validates its generation inside that
  lock. Target close uses a two-phase generation handoff: persist and accept
  under the target lock, release it while awaiting Team `logicalClosed`, then
  reacquire and exact-match before final target close. Validate each handoff
  through the authoritative TeamCollection record after lock acquisition; never
  pass a stale record as a lock exemption.
  `target-close-lifecycle.ts` contains only that target-side two-phase handoff;
  it awaits the TeamCollection milestone and never owns a Team state machine.
- **`teammate-collection/` + `teammate-service/` + `completion-router/`** —
  `TeammateCollection` constructs, subscribes to, caches, resolves, and reads
  entities; it does not own their close state machine. `TeammateService` owns
  one identity, its process-local Workflow lock, runtime, canonical Turn
  objects, terminal outcome/delivery convergence, and idempotent logical close.
  `completion-router/` contains the stateless per-dispatcher delivery
  policy; it keeps no Turn registry or terminal cache. Neutral agent config and
  read helpers live under `agent-entity/`, never under the Collection. The
  cross-cutting helpers
  `worktree/`, `channel-binding/`, `legacy-state.ts`, `shutdown-errors.ts`, and
  `dispatcher-workspace.ts`
  (the issue #182 dispatcher-cwd policy used by `server.ts` startup, the dispatcher
  service, `dreamux doctor`, and the `worktree/` layer) live at the `service/` root
  because no single service owns them.
  Agent-centric teammates: **no `task`** — a teammate is a named, resumable agent.

## Invariants (why it's shaped this way)

- **Drive every runtime through the published AgentRuntime interface.** The service
  resolves a provider from the registry-backed catalog and calls the same
  contract for codex/claude/external; it knows no runtime specifics.
- **Team dissolve is one TeamCollection capability, not a family of wrappers.**
  MCP/admin/provider layers only bind caller scope and project the accepted
  handle. All Team work enters the same availability fence; every live shared
  worktree writer must expose neutral `waitIdle()`. WorktreeManager's
  non-destructive assessment runs before acceptance and after quiescence, and
  cleanup reassesses immediately before mutation. Do not add a `close` alias,
  provider branch, force-delete path, or TeamService-local state machine.
- **Same creation path for dispatcher and teammate agents.** Both go through
  `AgentRuntimeProviderCatalog.resolve(ref).createRuntime(...)`. No parallel
  worker/runtime tree.
- **cwd is supplied by the launcher.** The dispatcher agent's cwd is its
  validated workspace (`ensureDispatcherWorkspace(config, id)` in
  `dispatcher-workspace.ts`): every dispatcher MUST declare an explicit `cwd`,
  there is no state-dir fallback (issue #182 PR-4). A teammate's cwd is its
  resolved target (`identity.cwd`). Passed as the required `cwd` create-context
  field — never derived inside the runtime. Managed TeamMate/Team git worktrees
  live under that workspace at `<cwd>/.workspace/worktree/<repo-slug>/<slug>/`,
  never under `~/.dreamux`. When a `spawn`/`create` omits `repo` (issue #199),
  the work directory is dispatcher-local policy: isolated
  `<cwd>/.workspace/work/<name>/` when `dispatchers[].workspace.enabled` is true,
  or `<cwd>` itself when it is false (`WorktreeManager.prepareDefaultWorkspace`).
  Both are plain directories, not git worktrees, so the dispatcher cwd need not
  be a git repo; the result is persisted as a `reuse-cwd` worktree with
  `source_repo: null`. `WorktreeManager` resolves all three modes (default work
  dir, reuse-cwd, managed); the admin layer signals "default" by forwarding no
  cwd/worktree.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** A
  teammate/team-leader agent is simply not injected the "spawn teammate" tool;
  role differentiation is done by the MCP tool set + system prompt this service
  injects at launch.
- **`teammate.*` visibility is physical directory scoping plus one roster
  predicate (issue #199 Slice 4, issue #233).** After the symmetric layout, the
  scope IS the directory: `TeammateReadModel.rosterList` lists only
  `teammate/<name>/` for a dispatcher-scope read and only that team's members
  under `team/<team>/teammate/<name>/` for a team-scope read — the leader lives at
  the team root and is never a member row, so no post-filter is needed. The single
  read-by-name chokepoint `mustIdentity` then applies `assertInCollection` so a
  wrong-scope name resolves as "does not exist": a dispatcher-scope read sees
  only `role: 'teammate'` entities with `team_id === null`, a team-scope read
  only that team's `team_member` rows; the TeamLeader lives at the team root and
  is reached through `TeamService`, not the members collection. The
  Team service reaches its own leader + members through the team-scoped reads it
  drives; a dispatcher inspects Teams via `team.*` compact summaries, never
  `teammate.*`.
- **State is a symmetric directory per agent entity (issue #233).** Every agent
  is a directory holding `identity.json`: durable identity/lifecycle/worktree
  facts, optional append-only `identity_prompt` role guidance, and an atomic
  runtime-native `session_id` plus nullable `transcript_locator` checkpoint.
  It contains no per-Turn archive or rolling conversation projection.
  Placement is by role:
  `teammate/<name>/` for dispatcher-owned teammates, `team/<team>/` for the team
  *leader* (its identity sits at the team root, beside `record.json`), and
  `team/<team>/teammate/<name>/` for team members. The `teammate/` and `team/`
  dirs are blind-scan collections of entity dirs only — `channel-bindings.json`
  sits at the dispatcher root, never inside a collection. Identity create uses
  an atomic no-clobber write; later updates use atomic replacement. The store
  derives every path from the identity's `role` + `team_id` (`paths.ts`
  `dispatcherAgentEntityDir`). Reads/lists scan `<scope>/teammate/<name>/`; a
  team-scoped read-by-name two-probes (member dir, then team root for the
  leader). `last` reads the identity first (existence/scope), then delegates a
  cold bounded read to the selected provider's native transcript capability. It
  never materializes an entity or starts a runtime, so a closed teammate stays
  recoverable. Provider-native transcript paths are exposed only on direct
  TeamMate spawn/send receipts; `last`, history, status, Workflow, Channel, and
  logs never project them.
  Teammate **names stay dispatcher-global**: the live `AgentIdentityStore`
  checks persisted entity directory names before allocating a TeamLeader,
  dispatcher-TeamMate, or Team-member name. Directory names remain occupied
  even when an identity is unreadable, and identity creation is no-clobber.
  The reserved-name guard (`assertNotReservedAgentName`) blocks names that would
  recreate a legacy leaf (`records` / `turns` / …). `session_id` is the
  runtime-native thread id, persisted atomically with `transcript_locator`.
  A current-layout `turn.jsonl` left by an older Dreamux is inert residue:
  Dreamux never creates, opens, stats, lists, validates, repairs, migrates, or
  deletes it, and its condition cannot block startup or any lifecycle/read
  operation. Existing rolling conversation keys in `identity.json` are ignored
  as unknown legacy extras and may disappear on a later normal rewrite.
- **Old state fails loud, it is never migrated (issue #199 Slice 5, #233).** 0.x
  has no schema migration (issue #98). `legacy-state.ts` is the one place that
  knows the removed layout: `detectLegacyDispatcherState` probes the removed
  leaves (`teammate/identities/`, `teammate/records/`, `teammate/turns/`,
  `teammate/sessions.jsonl`, `teammate/history/`, `team/records/`,
  `team/channel-bindings.json`, `team/ledger/`) — the `teammate/`/`team/` parents
  stay valid as the new collection roots — and `dreamux serve` aborts startup
  while `dreamux doctor` diagnoses, naming the path to delete. Removed *fields*
  left in a present record (`checkpoint` / `checkpoint_kind` / `session_ref` /
  `display_name` / `close_status`, or a channel binding keyed by `team_id`) are
  rejected by that record's reader via `assertNoRemovedRecordFields`. Detection
  only: the legacy paths/files are never read for migration, rewritten, or
  removed.
