# service/

The Dispatcher Service module: the real entity the server launches per
dispatcher. It holds the dispatcher agent and orchestrates everything below it.
`server.ts` is wiring only — all per-dispatcher orchestration lives here.

One service class per file or directory; a class with helpers gets a directory
whose `index.ts` is the class and whose siblings are its helpers.
`service/index.ts` is the only package-internal service facade (`Dispatchers`,
`DispatcherService`, `TeamService`, `WorkflowService`, and the Workflow result
types). Sub-service directories must not re-export sibling modules — this is
the package-wide re-export ban (`packages/eslint-config/index.js`'s
`withPackageEntryOnlyReexports`), not a service-only rule; callers import the
owning module directly unless the symbol belongs on that facade.

## Collections and Services

The layout is symmetric on purpose, and the two halves own different things:

- A **Collection** owns its store, its factory, lookup/list, the instances this
  process holds, materialization dedup, and exact-instance eviction. It does
  not own an entity's lifecycle.
- A **Service** owns exactly one entity: its record or identity, its
  operations, its runtime-backed work, and its close.

`Dispatchers` → `DispatcherService` → (`TeamCollection` → `TeamService`,
`TeammateCollection` → `TeammateService`) is that pattern at every level. A
Team's members are the same pair again, scoped to the Team.

## What goes where

- **`dispatchers/`** — the process-level `Dispatchers` collection: a factory
  plus cache over per-dispatcher `DispatcherService` aggregates, its Commands,
  and its errors. Its `commands.ts` owns the whole Dispatcher namespace:
  enumeration and status plus the addressed Dispatcher Agent's own
  `dispatcher.submit` / `dispatcher.interrupt`. There is no start/stop Command:
  every configured, enabled Dispatcher starts when the daemon starts, and
  nothing stops one independently while the process is up. A Team Command names exactly one
  Team; neither namespace addresses the other's recipient. It owns no teammate/team/channel state; each
  `DispatcherService` builds and owns its own object graph. Shutdown closes the
  factory admission before sweeping the existing aggregates, so no dispatcher
  can materialize after the sweep snapshot.
- **`server.ts` + `admin/socket.ts`** — the process admission boundary. Admin
  requests execute through `Server.admitAdminRequest()`; shutdown closes that
  admission and publishes every materialized dispatcher fence before draining
  accepted requests, then shuts down dispatchers and the socket. A request
  racing the fence gets `ServerShuttingDownError`.
- **`dispatcher-service/index.ts`** — one dispatcher-local aggregate. It *has
  an* agent: a contained `TeammateService` built by `agent.ts` from the
  dispatcher root `identity.json`, structurally outside the `teammate/`
  collection so read chokepoints never enumerate it. The aggregate keeps
  restart-notice injection (`restart-notice.ts`), role→MCP delegate assembly
  (`mcp-delegates.ts`), the admission/drain gate for external mutating work
  (`inbound-task-drain.ts`, `teammate-ops.ts`), the TeamLeader handle
  (`team-leader-handle.ts`), Team runtime stop containment
  (`team-runtime-stop.ts`), Workflow wiring (`dispatcher-workflows.ts`), and
  the input-source lifecycle (`input-source-lifecycle.ts`,
  `input-source-start-rollback.ts`) that owns prepare/start single-flight,
  prepared Channel sessions, ordered publication, and failed-start rollback.
  Ordinary start leaves the dispatcher runtime dormant; unbound channel
  inbound, dispatcher cron, or an explicit resume notice lazy-starts it.
- **`channel-service/`** — build, hold, hand out, and close the dispatcher's
  Channel instances, plus the Channel MCP delegates. There is no binding table
  and no route owner here: a Channel decides where a message goes and says so
  by naming a Team, so Core neither stores that decision nor reconstructs it,
  and nothing here resolves a target or authorizes an egress. An instance is
  published as live only after provider start succeeds.
  `commands.ts` owns `channel.list`, which reads public Channel metadata through
  `DispatcherService.listChannels()`: configured id, provider ref, opaque
  identity (empty when absent), and live status, in configuration order. The
  command also works for stopped dispatchers without starting sessions; it never
  returns provider configuration. Callers use the admin socket or the Channel's
  in-process `invoke` port only; there is no public CLI wrapper, since that
  surface is reserved for host lifecycle operations. The shared output DTO is
  `ChannelMetadata` in `channel-service/types.ts`.
- **`team-collection/`** — `TeamCollection` owns the Team store, worktrees,
  create/list/history, and the Team Commands and MCP delegate.
  `runtime-registry.ts` owns materialization: one construction per team id,
  shared by create and rebuild, plus the cache and the private scheduler
  handles. `read-model.ts` projects a Team that is not materialized;
  `worktree-cleanup.ts` finishes a closed Team's reclamation from its record
  alone; `create-request.ts` decides replays against the record that answered.
- **`team-service/`** — `TeamService`, the single per-Team entity. It holds a
  handle onto its Team's `TransactionalStore<TeamRecord | null>` — the
  committed record itself lives in `TeamStore`, one store per Team id, for the
  collection's life, so `TeamService` keeps no separate copy — plus the
  contained TeamLeader, the Team-scoped member collection, Workflows, the Team
  scheduler, and the dissolve it submits and then runs behind the receipt.
  `closing.ts` owns the stop-and-close sequence and the host sweep; `collaborators.ts`,
  `completion-targets.ts`, `leader-agent.ts`, `roster-projection.ts`, and
  `team-summary.ts` are its parts; its retirement broadcast uses the shared
  `ClosedFactPublisher`.
  `DispatcherService.team()` returns a `TeamLeaderHandle` to admin/MCP
  team-leader callers, never the concrete `TeamService`.
- **`teammate-collection/` + `teammate-service/` + `completion-router/`** —
  `TeammateCollection` constructs, subscribes to, caches, resolves, and reads
  entities, and owns the Team-scoped bulk close a dissolve needs
  (`dissolve-members.ts`); it does not own an entity's close state machine.
  `TeammateService` owns one identity, its process-local Workflow lock, its
  runtime, its canonical Turn objects, terminal outcome/delivery convergence,
  and idempotent logical close; its retirement broadcast is the shared
  `ClosedFactPublisher`.
  `completion-router/` is the stateless per-dispatcher delivery policy; it
  keeps no Turn registry or terminal cache, and reads the dispatcher admission
  gate before it queues a delivery.
- **`agent-entity/`** — neutral identity/activity/runtime-state stores, agent
  config, read helpers, and the history-query reader. Never under a Collection.
- **`worktree/`** — `WorktreeManager` (default work dir, reuse-cwd, and managed
  modes), workspace resolution, and the repository-request reader that says
  what a caller may ask for a working directory.
- **`scheduler/`, `workflow-service/`, `dispatcher-core-events/`, `mcp/`** —
  cron, Workflow runs, the Core event publisher, and the shared MCP
  descriptor/lease/projection helpers each delegate builds on.
- **Root helpers** — `deduplicate.ts`, `serial-queue.ts`, `shutdown-errors.ts`,
  `closed-fact.ts` (the one closed-fact broadcast a Team and a TeamMate each
  publish their own fact through), `in-flight-work.ts` (the work a scope has
  admitted and must join before it stops, counted the same way by the
  dispatcher gate, a Workflow run, the Workflow service, and a TeamMate's
  ordinary mutations),
  `dispatcher-workspace.ts` (the dispatcher-cwd policy shared by startup, the
  dispatcher service, `dreamux doctor`, and `worktree/`), `name-allocator.ts`,
  `submission-sources.ts`, `channel-submission.ts`, and `frozen-snapshot.ts`
  live at the root because no single service owns them.

## Invariants (why it's shaped this way)

- **Drive every runtime through the published AgentRuntime interface.** The
  service resolves a provider from the registry-backed catalog and calls the
  same contract for every runtime; it knows no runtime specifics. The same
  applies to Channels through `ChannelProvider`.
- **The operation is the fence.** A nullable `Promise` field *is* the state: a
  dissolve, a host stop, or a start publishes its promise before doing the work
  behind it, and a second caller joins that promise instead of starting a
  second operation. Do not add a boolean beside a task, or a phase enum beside
  either.
- **A closed entity is a record, not a dormant Service.** Terminal facts
  (`team.closed`, `teammate.closed`) evict the exact instance that ended. Read
  models, startup, and physical cleanup answer from records and never
  materialize a closed entity; only `send` may reopen a closed TeamMate, and it
  enters the cache only after that reopen succeeds.
- **One Team, one construction.** Creating a Team publishes its record before
  its object graph is finished, so create and rebuild share one keyed
  construction: a read that arrives mid-create joins it rather than building a
  second owner of the same Team.
- **Dissolve is a submission, and the durable close is its commit boundary.**
  The receipt says accepted and nothing more. Live children are stopped and
  closed before the record says closed; anything irreversible that a still-open
  Team would need — the cron store file — happens only after that commit, and a
  failed commit gives the admissions back. `worktree.cleanup_state` plus
  `worktree_cleanup_force` is the only restart-recovery authority; there is no
  persisted dissolve state machine.
- **A Team lends its directory, never its checkout.** The Team record is the
  single owner of the managed checkout and of what happened to it. A member
  that runs in that directory records a plain reuse-cwd workspace, so it can
  neither clean the Team's checkout nor hold a drifting copy of its state. The
  attempt that created a checkout is the only one that may discard it.
- **A settled turn is reported unless its owner ended it.** Completion
  delivery folds on the provider's own completion token when there is one,
  delivers an independently failed or stopped turn without inventing one, and
  keeps per-recipient FIFO order. Whether to report at all is the recipient
  scope's fence, read when delivery would start: an entity's own close or host
  release, a Workflow's stop, a dissolving Team, and a dispatcher whose
  admission is closed produce no push. A delivery already started is never
  retracted.
- **Nested dispatch is prevented by MCP injection, not a runtime check.** Role
  differentiation is the tool set and system prompt injected at launch;
  `dispatcher-service/mcp-delegates.ts` is the whole role→servers decision.
- **Commands are domain-owned.** Each owning module declares its canonical
  Command definitions in its own `commands.ts`, and one registry serves both
  `admin.sock` and the in-process Channel `invoke`. Agent MCP is not a Command
  adapter: tools converge through the generic MCP infrastructure Commands and a
  runtime-bound delegate that calls domain objects directly.
- **Payload readers belong to the layer that owns the fact.** `command/` keeps
  only generic JSON and scalar readers; what a repository request, a history
  query, or a Team status means is read by its own module.
- **cwd is supplied by the launcher.** The dispatcher agent's cwd is its
  validated workspace; a TeamMate's is its resolved target. Managed worktrees
  live under that workspace at
  `<cwd>/.workspace/worktree/<repo-slug>/<slug>/`, never under `~/.dreamux`.
  When a `spawn`/`create` omits `repo`, the work directory is dispatcher-local
  policy: isolated `<cwd>/.workspace/work/<name>/` when
  `dispatchers[].workspace.enabled` is true, or `<cwd>` itself when it is
  false. Both are plain directories, so the dispatcher cwd need not be a git
  repo, and the result is persisted as a `reuse-cwd` worktree.
- **State is a symmetric directory per agent entity.** Every agent is a
  directory holding `identity.json`: durable identity/lifecycle/worktree facts,
  optional append-only `identity_prompt`, persisted admin skill sources, and one
  nullable `session_id` string. The session id is the provider's own prior
  session, persisted verbatim and returned only to the same provider — opaque to
  Core, which stores it, compares it for presence, and hands it back, never
  parsing, indexing, or branching on it. It contains no per-Turn archive and no
  conversation projection. Placement is by owner: `teammate/<name>/` for
  dispatcher-owned TeamMates, `team/<team>/` for that Team's leader (beside
  `record.json`), and `team/<team>/teammate/<name>/` for members. Roles are
  derived from the owning Service, Collection, and directory — never persisted on
  the identity.
- **Visibility is physical directory scoping plus one roster predicate.** A
  dispatcher-scope read lists only `teammate/<name>/`; a team-scope read lists
  only that Team's members, and the leader — which lives at the Team root — is
  reached through `TeamService`, never as a member row. The single
  read-by-name chokepoint applies the same scope check, so a wrong-scope name
  resolves as "does not exist".
- **Names stay dispatcher-global.** The identity store checks persisted entity
  directory names before allocating any concrete name; a directory name stays
  occupied even when its identity is unreadable, and identity creation is
  no-clobber. The reserved-name guard blocks names that would recreate a
  removed layout leaf.
- **Old state is never migrated, and a pre-#233 leftover is no longer actively
  detected either (R47).** 0.x still has no schema migration. `AgentIdentityStore`,
  `CronJobStore`, and `WorkflowRunStore` each hold their persisted document on
  a `TransactionalStore` (`@excitedjs/dreamux-utils`). `CronJobStore` and
  `WorkflowRunStore` each still raise `LegacyStateError` (`platform/errors.ts`)
  from their own inlined version check on a document whose `version` they do
  not recognize, and the identity reader still raises it on an identity file
  still keyed by the pre-#148 `provider_ref` format — both because accepting
  either would run the wrong thing, and every caller propagates the error
  rather than degrading to
  `null`/empty. What no longer happens: `dreamux serve` no longer
  runs a startup pre-flight that aggregates every dispatcher's cron store and
  removed-layout findings and aborts the whole process before the admin socket
  opens. Each store is now read only where its owning Service already reads
  it — a dispatcher's scheduler start, `dreamux doctor`'s cron rows — so a bad
  cron store now fails only that one dispatcher's start (logged, not fatal to
  the process) instead of blocking every dispatcher and the admin socket.
  `dreamux serve` no longer probes for a pre-#233 flat-layout leaf
  (`teammate/records/`, `team/ledger/`, a dispatcher-root
  `channel-bindings.json`, …) or for a record carrying a field this version no
  longer reads, and `dreamux doctor` no longer reports either. A leftover of
  either kind is now inert residue: nothing creates, reads, validates, or
  deletes it. The operator may delete it by hand at their own pace; the
  reserved-name guard exists precisely because that leftover can still be on
  disk beside a live entity directory.
