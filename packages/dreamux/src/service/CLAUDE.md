# service/

The Dispatcher Service module: the real entity the server launches per
dispatcher. It holds the dispatcher agent and orchestrates everything below it.
`server.ts` is wiring only — all per-dispatcher orchestration lives here.

One service class per file or directory; a class with helpers gets a directory
whose `index.ts` is the class and whose siblings are its helpers.
`service/index.ts` is the only package-internal service facade (`Dispatchers`,
`DispatcherService`, `TeamService`, `WorkflowService`, and the Workflow result
types). Sub-service directories must not re-export sibling modules; callers
import the owning module directly unless the symbol belongs on that facade.

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
  and its errors. It owns no teammate/team/channel state; each
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
- **`team-collection/`** — `TeamCollection` owns the Team store, worktrees,
  create/list/history, and the Team Commands and MCP delegate.
  `runtime-registry.ts` owns materialization: one construction per team id,
  shared by create and rebuild, plus the cache and the private scheduler
  handles. `read-model.ts` projects a Team that is not materialized;
  `worktree-cleanup.ts` finishes a closed Team's reclamation from its record
  alone; `create-request.ts` decides replays against the record that answered.
- **`team-service/`** — `TeamService`, the single per-Team entity holding its
  own `TeamRecord`: status, delivery, shared workspace, members, and the
  dissolve it submits and then runs behind the receipt. `closing.ts` owns the
  stop-and-close sequence and the host sweep; `collaborators.ts`,
  `completion-targets.ts`, `leader-agent.ts`, `roster-projection.ts`,
  `team-view.ts`, `closed-fact.ts`, and `delivery-result.ts` are its parts.
  `DispatcherService.team()` returns a `TeamLeaderHandle` to admin/MCP
  team-leader callers, never the concrete `TeamService`.
- **`teammate-collection/` + `teammate-service/` + `completion-router/`** —
  `TeammateCollection` constructs, subscribes to, caches, resolves, and reads
  entities, and owns the Team-scoped bulk close a dissolve needs
  (`dissolve-members.ts`); it does not own an entity's close state machine.
  `TeammateService` owns one identity, its process-local Workflow lock, its
  runtime, its canonical Turn objects, terminal outcome/delivery convergence,
  and idempotent logical close. `completion-router/` is the stateless
  per-dispatcher delivery policy; it keeps no Turn registry or terminal cache.
- **`agent-entity/`** — neutral identity/activity/runtime-state stores, agent
  config, read helpers, and the history-query reader. Never under a Collection.
- **`worktree/`** — `WorktreeManager` (default work dir, reuse-cwd, and managed
  modes), workspace resolution, and the repository-request reader that says
  what a caller may ask for a working directory.
- **`scheduler/`, `workflow-service/`, `dispatcher-core-events/`, `mcp/`** —
  cron, Workflow runs, the Core event publisher, and the shared MCP
  descriptor/lease/projection helpers each delegate builds on.
- **Root helpers** — `deduplicate.ts`, `serial-queue.ts`, `shutdown-errors.ts`,
  `dispatcher-workspace.ts` (the dispatcher-cwd policy shared by startup, the
  dispatcher service, `dreamux doctor`, and `worktree/`), `legacy-state.ts`,
  `name-allocator.ts`, `submission-sources.ts`, `channel-submission.ts`, and
  `frozen-snapshot.ts` live at the root because no single service owns them.

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
- **Every settled turn is reported.** Completion delivery folds on the
  provider's own completion token when there is one, delivers a failed or
  stopped turn without inventing one, and keeps per-recipient FIFO order.
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
- **Old state fails loud, it is never migrated.** 0.x has no schema migration.
  `legacy-state.ts` is the one place that knows the removed layout: it probes
  the removed leaves so `dreamux serve` aborts and `dreamux doctor` names the
  path to delete, and it rejects removed *fields* left in a present record.
  Detection only — legacy paths are never read for migration, rewritten, or
  removed. A current-layout `turn.jsonl` left by an older Dreamux is inert
  residue that no path creates, opens, validates, or deletes.
- **Reject a removed field only when accepting it would lose something.** The
  rejected-field list is narrower than "every field ever deleted", because each
  entry costs the operator a rebuild. A field earns rejection when a released
  build wrote it AND accepting the record would silently discard a fact this
  reader cannot see — `checkpoint`, or `session_ref`, whose resumable id sits one
  level below where `session_id` is read. Two kinds of leftover do not qualify. A
  field this version never consults (`role`, derived from the owning directory;
  `transcript_locator`, replaced by the Activity seam's opaque id) is inert
  residue. And a shape no released build ever wrote cannot reach a real upgrade,
  so gating on it buys nothing: a field's own type check is the better gate,
  because "no usable id found" already degrades correctly to "start a fresh
  session", while a present-but-corrupt value still fails validation.
