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
`TeammateCollection` → `AgentService`) is that pattern at every level.
`AgentService` carries that name rather than `TeammateService` because the
same class is also the dispatcher agent and a Team's leader, each built
outside any Collection. A Team's members are the same pair again, scoped to
the Team.

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
- **`dispatcher-service/index.ts`** — one dispatcher-local aggregate. It has no
  per-verb Team/Channel pass-through methods: `readonly teams` (`TeamsPort`),
  `readonly teammates` (`TeammateOps`), `readonly channels` (`ChannelService`),
  and `readonly scheduler` (`SchedulerCommands`) are exposed directly, and every
  caller (Commands, MCP delegates) reaches the owning port itself instead of a
  forwarding method per verb. `workspace()` is the one surviving pass-through:
  both the TeamMate and Team Command/MCP surfaces resolve a request's default
  `cwd` from it, and it is a dispatcher-level fact neither domain owns. It *has
  an* agent: `agent.ts`'s `DispatcherAgent` is its one agent owner, covering
  dispatcher-root identity ensure, construction as a contained `AgentService`
  through the per-dispatcher `AgentServiceFactory`, the one `mustAgent()`
  accessor, lazy activation with resume-notice injection (consuming the
  restart marker owned by `restart-intent.ts`), and the one runtime-status
  projection (`status()`, speaking `AgentRuntimeStatus` directly) that
  `dispatcher.status`/`dispatcher.list` both read through — structurally
  outside the `teammate/` collection so read chokepoints never enumerate it.
  The aggregate keeps role→MCP delegate assembly (`mcp-delegates.ts`) and
  `restart-intent.ts` (issue #78's restart marker, a plain constructor value
  `server.ts` loads once before any `Dispatchers`/`DispatcherService` exists —
  there is no setter). Its dispatcher-scoped Workflow scope is a plain
  `WorkflowService` (`workflow-service/index.ts`) constructed directly in the
  aggregate's own constructor, the same way `SchedulerService` is: there is no
  separate Workflow-owning wrapper class, and `get workflows()` is the one
  place that wraps `run`/`stop` with this dispatcher's admission gate.
  `lifecycle.ts`'s `DispatcherLifecycle` is this dispatcher's one
  admission gate and its one terminal close, alongside start
  single-flight (`ChannelService` itself is the one owner of every built
  Channel instance): `admit()` is the single check
  every externally-admitted operation crosses (folding the former standalone
  `DispatcherTaskDrain`), `isClosing()` is the same fact `TeammateCollection`
  and `TeamCollection` read at construction, and `close()` (R10/R11) is the
  one terminal close a failed `start()` reuses instead of
  a separate rollback path — there is no restart after it runs. Its prepare
  and start sequencing is one `try` block covering every step from the
  dispatcher-row lookup on, so a shape failure this early (an unrunnable
  channel provider, a missing dispatcher row) closes the same way a failure
  deeper in startup does, instead of leaving the dispatcher stuck admitting
  work it never finished starting. `lifecycle.ts` fans Workflow start/recover/
  close-admission out to the Team scope
  (`teams.startWorkflows()`/`recoverWorkflows()`/`closeWorkflowAdmissions()`)
  explicitly, right beside the equivalent scheduler fan-out
  (`teams.startSchedulers()`/`stopSchedulers()`) — neither is hidden inside a
  wrapper. Closing stops every runtime it can reach, waits for every
  already-admitted operation to settle, then repeats the same runtime sweep
  once more before releasing channels. The first pass runs before the drain,
  not after: an admitted `send`/`spawn` can be sitting inside a runtime start
  with no timeout of its own (codex `thread/start` is one such call), so a
  drain that ran first would wait on exactly the runtime the sweep exists to
  kill — stopping the runtime first is what tears down its RPC client and
  rejects that pending start, which is what lets the drain converge. The
  second pass, after the drain, catches a pre-fence admission that only
  reaches its own runtime start (or, since `stopForHost()` fences an entity's
  admission only for its own convergence and never moves its phase, a revived
  runtime) after the first pass already passed it by; every step it repeats is
  idempotent, so nothing is lost when there was nothing left to catch.
  `TeammateCollection`'s and `TeamCollection`'s own entity-construction paths
  separately self-close against `isClosing()` the instant they register a
  brand-new entity — a different gap (a new entity's first submission) than
  the one the two-pass runtime sweep covers, not a substitute for it. Ordinary
  start leaves the dispatcher runtime dormant; unbound channel inbound,
  dispatcher cron, or an explicit resume notice lazy-starts it.
- **`channel-service/`** — `index.ts`'s `ChannelService` is the single owner of
  the dispatcher's whole channel lifecycle: the runnable-channel shape guard,
  build, the per-session initialize/start sequencing, the Core-port-lease
  tracking that fences a session's Command admission, close (collecting and
  reporting every session's close failure instead of swallowing it), the
  public inventory read, and the Channel MCP delegate assembly — one
  `Map<channel_id, {instance, portLease, live}>` behind all of it, with each
  channel's provider resolved from the catalog at most once. `mcp-delegate.ts`
  (the per-channel MCP builder `ChannelService` calls) and `core-port.ts` (the
  in-process `invoke` + event port a Channel session is given) are its only
  siblings. There is no binding table and no route owner here: a Channel
  decides where a message goes and says so by naming a Team, so Core neither
  stores that decision nor reconstructs it, and nothing here resolves a target
  or authorizes an egress. An instance is published as live only after
  provider start succeeds.
  `commands.ts` owns `channel.list`, which reads public Channel metadata through
  `ChannelService.list()`: configured id, provider ref, opaque
  identity (empty when absent), and live status, in configuration order. The
  command also works for stopped dispatchers without starting sessions; it never
  returns provider configuration. Callers use the admin socket or the Channel's
  in-process `invoke` port only; there is no public CLI wrapper, since that
  surface is reserved for host lifecycle operations. The shared output DTO is
  `ChannelMetadata` in `channel-service/index.ts`.
- **`team/`** — one directory, files ordered by R7's declared direction: store
  → service → collection. Two `.dependency-cruiser.cjs` rules enforce that
  direction at error severity — a store-tier file never imports a service- or
  collection-tier file, and a service-tier file never imports a
  collection-tier file. The store tier (`types.ts`, `requests.ts`,
  `create-request.ts`, `store.ts`, `errors.ts`) is `TeamRecord`'s persisted
  shape, `team.create` replay bounds, and the durable `TeamStore` itself — one
  `TransactionalStore<TeamRecord | null>` per Team id, holding no
  event-publish responsibility of its own. The service tier (`roster.ts`,
  `leader.ts`, `completion-targets.ts`, `closing.ts`, `team-summary.ts`,
  `service.ts`) is `TeamService`, the single per-Team entity: its constructor
  builds the contained TeamLeader (`leader.ts`'s factory), its Team-scoped
  `TeammateCollection`, its Workflows, and its Team scheduler directly — there
  is no separate collaborators file. A `cron.create`/`.update`/`.delete`
  crosses this Team's own closing fence before the dispatcher's admission,
  composed directly into the single `admit` closure `SchedulerService` is
  built with (`this.admit` first, then `deps.admitOperation`) — there is no
  second, `SchedulerCommands`-shaped object wrapping the public surface, so a
  mutation racing an in-flight dissolve is still refused before it reaches the
  store. It also holds `roster.ts`'s
  `TeamRosterProjection`, which publishes both `teammate.state` and
  `team.state` itself on every relevant transition (a Team's aggregate event
  has no other source to ask). `closing.ts`'s `TeamClosing` owns the
  stop-and-close dissolve sequence, the abandoned-creation cleanup, and the
  host sweep, all taking the TeamLeader as a plain argument rather than
  through a leader-holder callback; its retirement broadcast uses the shared
  `ClosedFactPublisher`. `leader-handle.ts` (`TeamLeaderHandle`,
  `TeamLeaderTeammateOps`, the `teamLeaderHandle()` factory) and
  `teams-port.ts` (the `TeamsPort` interface) sit at this same tier — each
  depends on `service.ts`'s `TeamService` type and on modules outside
  `team/`, never on the collection tier below — though neither is part of the
  `TeamService` class itself. The
  collection tier (`read-model.ts`, `index.ts`, `commands.ts`, `mcp.ts`) is
  `TeamCollection`: one materialization cache (construction dedup,
  live-instance eviction, and the closed-Team worktree reclamation sweep
  merged into the same class) plus `read-model.ts`'s not-materialized Team
  projection and the Team Commands and MCP delegate. `TeamCollection`
  implements `TeamsPort` directly (no `.port`/`.commands` adapter object,
  the same shape `SchedulerService` uses for `SchedulerCommands`): every
  per-Team operation an admin/MCP caller reaches — including `leaderScope()`,
  which builds the `TeamLeaderHandle` admin/MCP team-leader callers reach
  through `DispatcherService.teams` (no forwarding method on `DispatcherService`
  itself) — gates itself on the injected `admitOperation` internally, never the
  concrete `TeamService`. This
  directory merge is a code-location, ownership, and internal-API change
  only: `record.json`'s shape, field meanings, and owner are unchanged, so no
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/` update accompanies
  it.
- **`agent/` + `completion-router/`** — `agent/` is one directory, files
  ordered by R7's declared direction rather than by the class-plus-helpers
  rule above: store → service → collection. Two
  `.dependency-cruiser.cjs` rules enforce that direction at error severity —
  a store-tier file never imports a service- or collection-tier file, and a
  service-tier file never imports a collection-tier file. The store tier
  (`identity.ts`, `store.ts`, `runtime-state.ts`, `activity.ts`,
  `records.ts`, `requests.ts`, `runtime-id.ts`, `types.ts`) is neutral
  identity/activity/runtime-state persistence, history-query reading, and the
  directory's data types; it is never under a Collection, and it is shared —
  `team/service.ts` and `dispatcher-service/` read it directly for the Team
  leader and the dispatcher agent, both of which live outside
  `TeammateCollection`. It sits inside `.dependency-cruiser.cjs`'s
  `service-primitives` layer rather than a separate `service/agent/` layer,
  alongside `worktree/`/`mcp/`/`dispatcher-core-events/` — it is the same
  neutral kernel those directories read, not a tier ranked ahead of or behind
  them. The service tier (`runtime-generation.ts`, `turn.ts`, `admission.ts`,
  `submission.ts`, `channel-submission.ts`, `completion-renderer.ts`,
  `factory.ts`, `service.ts`, `service-types.ts`) is `AgentService` — named
  for the entity rather than for `TeammateCollection`, because the same class
  also serves as the dispatcher agent and a Team's leader. It owns one
  identity, its process-local Workflow lock, its runtime, its canonical Turn
  objects, terminal outcome/delivery convergence, and idempotent logical
  close; its retirement broadcast is the shared `ClosedFactPublisher`, and it
  is constructed per-entity by `AgentServiceFactory`, the per-dispatcher
  factory that owns the shared `AdmissionLedger`. `channel-submission.ts` (the
  Channel-facing submission reader) sits in this tier because it needs
  `submission.ts`, not the store or collection tier. The collection tier
  (`index.ts`, `commands.ts`, `mcp.ts`, `system-prompt.ts`, `errors.ts`,
  `dissolve-members.ts`, `agent-config.ts`) is `TeammateCollection`: it
  constructs, subscribes to, caches, resolves, and reads ordinary-TeamMate
  entities only — never the dispatcher agent or a Team's leader — and owns
  the Team-scoped bulk close a dissolve needs (`dissolve-members.ts`); it
  does not own an entity's close state machine. This directory merge and the
  `AgentService` rename are a code-location and naming change only:
  `identity.json`'s shape, field meanings, and owner are unchanged, so no
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/` update
  accompanies it. `completion-router/` is the stateless per-dispatcher
  delivery policy; it keeps no Turn registry or terminal cache, and reads
  the dispatcher admission gate before it queues a delivery.
- **`worktree/`** — `WorktreeManager` (default work dir, reuse-cwd, and managed
  modes), workspace resolution, and the repository-request reader that says
  what a caller may ask for a working directory.
- **`scheduler/`** — one directory, the per-domain template plus two
  scheduler-specific files. `index.ts` is `SchedulerService`, implementing
  `SchedulerCommands` directly (no `.commands` adapter object): it owns the
  timers, `fireSeq` (the per-fire counter feeding `sourceId`) and
  `lifecycleGeneration` (the stop/start epoch a stale timer callback checks
  before acting), the pure `advanceJob` recompute and the one impure `rearm`
  it feeds, and the lifecycle verbs (`start`/`stop`/`deleteStoreFile`).
  `requests.ts` holds the request readers (`cronCreateRequest`,
  `cronUpdateRequest`, `cronJobIdParam`) and the result projections
  (`cronJobResult`, `cronListResult`) shared by `commands.ts` and `mcp.ts`.
  `commands.ts` declares the `scheduler.cron.*` Commands; `mcp.ts` is the cron
  MCP delegate; `errors.ts` holds `CronJobNotFoundError`. `types.ts` holds the
  domain types (`CronJob`/`CronJobAction`/`CronPromptAgentAction`/
  `CronJobCreateInput`/`CronJobUpdateInput`), the request/result interfaces,
  and `SchedulerCommands` — no codecs. `SchedulerServiceOptions` (a
  constructor-options bag naming the concrete `CronJobStore`, not a data type)
  is declared in `index.ts` beside the `SchedulerService` it configures. The two
  scheduler-specific files: `store.ts` (`CronJobStore` plus
  `detectLegacyCronJobStore` — persistence only, no domain types) and
  `cron-validation.ts` (the shared cron-expression/timezone rule set both
  `create` and `update` validate against). A Team-scoped cron mutation is
  fenced by composing the Team's own admission ahead of the dispatcher's in
  the `admit` closure the owner passes at construction, not by a separate
  Team-scoped wrapper — see the `team/` bullet above. This directory's
  persisted `cron-jobs.json` shape, field meanings, and owner are unchanged, so no
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/` update accompanies
  it.
- **`workflow-service/`, `dispatcher-core-events/`, `mcp/`** —
  Workflow runs (`workflow-service/`: `index.ts`'s `WorkflowService`
  collection over each live run's `run.ts` (which owns the run's terminal
  task and the Workflow agent system prompt directly), its `journal.ts`
  (durability: `create`/`ensureAgentResult`/`ensureTerminal`/`recover`),
  `store.ts`, the forked runner (`runner.ts`, `runner-process.ts`,
  `script-compiler.ts`), the IPC codec (`protocol.ts`), `semaphore.ts`,
  `mcp.ts` (the four Workflow tools — `workflow_run`/`workflow_status`/
  `workflow_stop`/`workflow_list` — composed onto the TeamMate MCP server,
  since Workflow has no MCP server of its own), and
  `limits.ts`/`requests.ts`/`commands.ts`/`errors.ts`/`types.ts` support), the
  Core event publisher plus `conversation-projection.ts` (the display-only
  stream of one Agent's conversation: input and activity facts, keyed on the
  Agent and never on a submission), and the shared MCP
  catalog/lease/projection helpers each delegate builds on.
- **Root helpers** — `dispatcher-workspace.ts` (the dispatcher-cwd policy
  shared by startup, the dispatcher service, `dreamux doctor`, and
  `worktree/`), `name-allocator.ts`, and `submission-sources.ts` live at the
  root because no single service owns them. `channel-submission.ts` moved into
  `agent/` (see the `agent/` bullet above) once it needed `submission.ts`, so
  it is no longer a root file. The cross-domain primitives that used to live
  here too — the closed-fact broadcast, in-flight-work admission counting,
  deduplication, the keyed serial queue, and shutdown-failure aggregation —
  carried no service-layer dependency of their own and moved to `platform/`.

## Invariants (why it's shaped this way)

- **Drive every runtime through the published AgentRuntime interface.** The
  service resolves a provider from the registry-backed catalog and calls the
  same contract for every runtime; it knows no runtime specifics. The same
  applies to Channels through `ChannelProvider`.
- **The operation is the fence.** A nullable `Promise` field *is* the state: a
  dissolve, a host stop, or a start publishes its promise before doing the work
  behind it, and a second caller joins that promise instead of starting a
  second operation. Do not add a boolean beside a task, or a phase enum beside
  either. The one named exception is `DispatcherLifecycle`'s terminal `close()`:
  `isClosing()` is a fact `admit()`, `TeammateCollection`, and `TeamCollection`
  all read directly off this same object, so it must never revert — including
  during the gap between a failed release and a retried one, when the release
  task itself is momentarily `null` so the retry can run. A permanent `closed`
  boolean plus a retryable `closing` task is what that external reader
  requires; an operation with no such reader (dissolve, host stop, start)
  keeps the one-field shape.
- **A child under construction checks its parent's close, not the other way
  around.** An admitted `spawn`/`send`/`create` crosses its owner's admission
  fence before `close()` can raise it, but only finishes materializing its
  entity afterward — invisible to any sweep the close already ran, and about
  to submit input to a runtime the close is trying to stop. Rather than
  sweeping twice to catch that race, `TeammateCollection`'s and
  `TeamCollection`'s own construction paths read the owner's `isClosing()` as
  soon as the entity exists — synchronously, the moment they register it into
  the live map, for `spawn`/`createFreshEntity` and every `TeamCollection`
  path; after the async build for `send`'s reopen, since composing a launch
  draft (`teammateLaunch`) puts an `await` before the entity exists — and
  self-close it (`stopForHost()`) right there, before it is handed back for
  its first submission. For `TeammateCollection`
  this preempts the entity's first submission outright — it throws before
  `spawn` gets to submit anything. For `TeamCollection` it cannot: a Team's
  leader may already have taken its first submission by the time `track()`
  runs (`TeamService.createNew` submits it internally, before the collection
  ever sees the object), so this only stops the runtime as soon as the
  collection notices, rather than leaving it running until a later sweep
  reaches it. This closes the gap for a brand-new entity's first submission
  only. It is not a substitute for the dispatcher's own two-pass runtime sweep
  (see the `dispatcher-service/index.ts` bullet above): an
  already-materialized entity's pre-fence admission can still start, or
  revive, a runtime after the sweep's first pass already reached that entity,
  because `stopForHost()` fences admission only for its own convergence and
  never moves the entity's phase — catching that is what the sweep's second,
  post-drain pass is for.
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
  closed before the record says closed. Closing the scheduler deletes its cron
  store file as part of that same close pass, before the durable commit runs —
  not after — because a dissolve that stopped the scheduler and then failed to
  commit must not leave jobs a later `start()` would arm again; that the jobs
  stay gone from a Team which stayed open is the price of canceling them for
  real. Any failure before the commit lands — stopping, closing, or the commit
  itself — gives the reversible admissions (Workflows, scheduler) back.
  `worktree.cleanup_state`
  plus `worktree_cleanup_force` is the only restart-recovery authority; there
  is no persisted dissolve state machine.
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
