# Service Topology

This is the source-anchored ownership map for Dreamux service-layer objects.
Read current source first when behavior matters; this page records who is
allowed to build and hold each service object so future refactors do not
rediscover issue #233 by trial and error.

The layer is symmetric on purpose, and the two halves own different things. A
**Collection** owns its store, its factory, lookup/list, the instances this
process holds, materialization dedup, and exact-instance eviction; it does not
own an entity's lifecycle. A **Service** owns exactly one entity: its record or
identity, its operations, its runtime-backed work, and its close.

## Ownership Map

| Service object | Owner / construction sites | Holds / owns | Scope | Depends on / direction |
|---|---|---|---|---|
| `Server` admin admission | `createAdminSocketServer` is constructed by server wiring in `/packages/dreamux/src/server.ts`; admin socket request execution enters `Server.admitAdminRequest()` in `/packages/dreamux/src/admin/socket.ts`. | Process-level admin request admission and the in-flight admin request set. | Whole process. | Shutdown closes admin and dispatcher-factory admission synchronously, closes dispatcher ownership trees first, then drains accepted admin requests and closes the socket. Admin handlers should not bypass this capability when they may materialize dispatchers or mutate state. |
| `CoreCommandRegistry` | Built once by `/packages/dreamux/src/server/command-catalog.ts`'s `createCoreCommandRegistry`, called from server wiring in `/packages/dreamux/src/server.ts`, from the domain-owned definitions each module declares in its own `commands.ts`. Each domain's `commands.ts` factory takes only the narrow per-domain resolver the catalog derives from `server/command-host.ts`'s `CoreCommandHost`, never the full host (`server-commands.ts`'s single `server.status` definition is the one exception, since it stays at the package root as `Server`'s own Command, composition-tier like the catalog itself). | The one authoritative Command catalog: bounding, input validation, resolution, execution, and output validation. | Whole process. | Both adapters — the admin socket in `/packages/dreamux/src/admin/socket.ts` and a Channel's in-process `invoke` port in `/packages/dreamux/src/service/channel-service/core-port.ts` — name a Command and hand over JSON plus factual caller context. There is no per-adapter handler table, allowlist, or exposure flag. Agent MCP is NOT a Command adapter. |
| `Dispatchers` | Constructed by server wiring in `/packages/dreamux/src/server.ts`; the process collection lives in `/packages/dreamux/src/service/dispatchers/index.ts`, which constructs each `DispatcherService`. It lazily builds one `AgentIdentityStore` per dispatcher root, cached for the collection's life, and hands that same instance into the `DispatcherService` it constructs for that id — its own `summarize()`/`status()` fallback reads (used only when no live runtime status exists) and the live dispatcher agent's own identity writes therefore share one committed value instead of two independently cached copies of `identity.json`. | A `Map<string, DispatcherService>`, restart-intent consumer, all-settled process shutdown sweep, factory-admission fence, and cached root identity stores shared with each dispatcher it constructs. It owns no teammate/team/channel state. | Process-global collection over dispatchers. | May depend on config, `DispatcherStore`, provider catalogs, the MCP lease registry, the Command registry, and logging. It must only hand each dispatcher id to `DispatcherService`; it must not reach into per-dispatcher internals. Shutdown closes the dispatcher factory before taking the sweep snapshot, so `get()` cannot materialize a new aggregate after process shutdown starts. |
| `DispatcherService` | Constructed only by `Dispatchers.get()`. Its constructor is the dispatcher composition root in `/packages/dreamux/src/service/dispatcher-service/index.ts`: every persistence root is derived once there and handed to the owner that keeps it. | Stateless `CompletionDeliveryPolicy`, dispatcher-scoped core event bus, shared `AgentIdentityStore` / `AgentEntityCollectionStore` / `AgentNameRegistry` / `AdmissionLedger`, shared `WorktreeManager`, `ChannelService`, dispatcher `SchedulerService`, dispatcher-scope `TeammateCollection`, `TeamCollection`, `DispatcherWorkflows`, admission drain, and `DispatcherInputSourceLifecycle`. | One aggregate per dispatcher. | Depends on provider catalogs, `DispatcherStore`, the Command registry, and the MCP lease registry. It owns dispatcher-global topology and close-before-drain ordering. Core stays behind the `AgentRuntimeProvider` and `ChannelProvider` seams. |
| `DispatcherInputSourceLifecycle` | Constructed by `DispatcherService`; class lives in `/packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`, with rollback in `/packages/dreamux/src/service/dispatcher-service/input-source-start-rollback.ts`. | Preparation/start single-flight promises, the prepared Channel-instance set, started state, dispatcher agent/workspace publication, ordered live Channel publication, Workflow and scheduler start, and failed-start rollback. | One lifecycle capability per dispatcher aggregate. | Receives the aggregate's constructed collaborators once. It creates a fresh event lease before each Channel session starts and publishes an instance as live only after provider start succeeds. Failed start revokes admission and leases, drains accepted work, and sweeps materialized Team runtimes. Ordinary start leaves the dispatcher runtime dormant. |
| `DispatcherTaskDrain` | Constructed by `DispatcherService`; class lives in `/packages/dreamux/src/service/dispatcher-service/inbound-task-drain.ts`. | The dispatcher-owned admission gate for work that may create runtime, scheduler, or durable state, counting admitted work through the shared `InFlightWork`. | One gate per dispatcher aggregate. | Stop/shutdown closes admission before draining admitted work and sweeping the ownership tree. It owns no domain state; it only fences entry and completion. |
| `CompletionDeliveryPolicy` | Constructed by `DispatcherService`; implementation in `/packages/dreamux/src/service/completion-router/index.ts`. | Per-recipient FIFO delivery of an already-prepared completion fact, plus folding of the same provider completion token reported through several paths. | One reusable policy per dispatcher. | The initiating action captures a closure on the entity-owned Turn. A settled turn with no native completion token — failed or stopped — is delivered with a `null` token rather than a fabricated one, on the same recipient queue. It reads the dispatcher admission gate (`DispatcherTaskDrain.accepting`) once per requested delivery, before folding or queueing, and drops a request made behind that fence; a delivery already queued is never retracted. It owns no Turn registry, key map, or terminal cache. |
| `DispatcherCoreEventBus` | Constructed only by `DispatcherService`; implementation in `/packages/dreamux/src/service/dispatcher-core-events/`. | An in-process `EventEmitter`, a narrow internal publisher capability, and revocable read-only Channel event sources. It retains no events or domain state. | One bus per dispatcher aggregate; one source lease per live Channel session generation. | Team and identity owners publish the allowlisted state DTOs after their normal writes. Channel providers receive only the public source from `@excitedjs/dreamux-types`, never the bus, publisher, or raw listener-management surface. Listener failures are isolated; stop and failed start revoke the session generation. |
| `WorktreeManager` | Constructed by `DispatcherService`; implementation in `/packages/dreamux/src/service/worktree/manager.ts`, with workspace resolution in `/packages/dreamux/src/service/worktree/workspaces.ts`. | Worktree preparation, non-destructive dirty/unmerged cleanup assessment, and cleanup mutation; it is stateless apart from filesystem effects. | Per dispatcher helper shared by Team and TeamMate collections. | A prepared workspace records whether **this attempt** created the checkout, and only that attempt may discard it. `cleanup()` reassesses immediately before mutation, performs no ref enumeration or history walk, and removes a managed `delete-on-close` worktree with `git worktree remove <path>` — non-forced unless the caller authorized `force`, which runs `git worktree remove --force` and discards uncommitted, untracked, or unmerged work. Neither form touches the managed branch or its commits; branch/ref deletion is outside this capability. `cleanup: keep` and non-managed workspaces are terminally retained. |
| `AgentIdentityStore` | Class in `/packages/dreamux/src/service/agent/store.ts`. The dispatcher-root instance is built and cached by `Dispatchers`, which hands it to the `DispatcherService` it constructs for that dispatcher id; `DispatcherService` then injects that same instance into its own collections and services. Collections receive the shared store; they do not build their own. | Reads and writes `identity.json` for the dispatcher root agent, dispatcher TeamMates, TeamLeaders, and Team members. Identity owns lifecycle/worktree/intent facts, persisted skill sources, and one nullable `session_id` string Core stores verbatim and hands back only to the same provider; it owns no conversation projection and no per-Turn archive. | Stateless store bound to one already-resolved entity directory. | `dir` is the only path input; no persisted field takes part in choosing it. A missing file reads as `null` and an unreadable one is logged and read as `null`, but a record this version refuses to interpret raises `LegacyStateError` — every caller, including the Team read model, passes that through rather than reporting "no identity". Generated name allocation scans persisted entity directory names, and identity creation is an atomic no-clobber write. |
| `readAgentActivity` | Called by `TeammateCollection.last()` and the Team read paths; implementation in `/packages/dreamux/src/service/agent/activity.ts`. | Validates the neutral query, resolves the selected provider, delegates one bounded recent-Activity read, and projects provider-neutral rows with typed errors. | Stateless read capability over one persisted identity and the provider catalog. | It reads identity/config only, starts or materializes no runtime, performs no state write, and stores no cursor/cache/index. Provider-native record formats stay inside the provider package. |
| `AgentRuntimeStateStore` | Constructed per-entity by `AgentService` (not from the composition root); class in `/packages/dreamux/src/service/agent/runtime-state.ts`. | Bridges runtime state callbacks to the entity's `AgentIdentityStore` row: intent/status plus the provider-owned session id. | Per agent entity (dispatcher agent, TeamMate, TeamLeader, Team member). | Depends on the shared `AgentIdentityStore` and the entity's current identity snapshot. It does not persist to its own file; it writes through to `identity.json`. |
| `ChannelService` | Constructed by `DispatcherService`; class in `/packages/dreamux/src/service/channel-service/index.ts`, with its MCP delegate in `/packages/dreamux/src/service/channel-service/mcp-delegate.ts` and its read-only inventory Command in `/packages/dreamux/src/service/channel-service/commands.ts`. | The built and live `Map<channel_id, ChannelInstance>` and the session-MCP lookup keyed off it. Nothing else. | Per dispatcher. | Depends on `ChannelProviderCatalog` and channel config. There is no binding table, no route owner, and no target resolution or egress check here: a Channel decides where a message goes and says so by naming a Team, so Core neither stores that decision nor reconstructs it. An instance is published as live only after provider start succeeds. |
| `TeamCollection` | Constructed by `DispatcherService`; class in `/packages/dreamux/src/service/team/index.ts`. `read-model.ts` and `create-request.ts` are private capabilities of this aggregate; materialization (one keyed construction per team id shared by create and rebuild, the live cache, and the private scheduler handles) and closed-Team worktree reclamation are methods on this class directly, not separate files. | The `TeamStore`, the create-request lifecycle queue, one keyed construction per team id, the live cache, and the private scheduler handles. | One collection per dispatcher. | Depends on the shared identity stores, `WorktreeManager`, and dispatcher-owned admission. Creating a Team publishes its record before its object graph is finished, so a read arriving mid-create joins that one construction instead of building a second owner. `read-model.ts` projects a Team that is not materialized and never builds one; `recoverWorktreeCleanup()` finishes a closed Team's reclamation from its record alone. It creates and rebuilds `TeamService` but leaves leader/member construction and resource shutdown to that entity. |
| `TeamLeaderHandle` | Declared in `/packages/dreamux/src/service/dispatcher-service/team-leader-handle.ts`; created only by `DispatcherService.team()`. | A TeamLeader-scoped member/workflow surface plus `spawnTeamMate()` for the admin/MCP team-leader target. | Per resolved Team. | It is the only member/workflow surface returned by `DispatcherService.team()`. It does not expose the concrete `TeamService`, raw `teammates.spawn`, scheduler lifecycle, leader runtime, or a second dissolve implementation. |
| `stopTeamRuntimes` | Called during process shutdown and failed Channel start rollback; helper in `/packages/dreamux/src/service/dispatcher-service/team-runtime-stop.ts`. | Best-effort wrapper around `TeamCollection.stopAll()`. | Per shutdown or failed-start rollback attempt. | `stopAll()` lists every durable non-closed Team, canonically materializes it, and asks each `TeamService` to stop Workflows and close its normal entities. The wrapper logs errors and returns them so sibling cleanup continues; it is not a raw-runtime sweep. |
| `TeamService.createNew` | Called only by `TeamCollection`; implemented in `/packages/dreamux/src/service/team/service.ts`. | Creates the durable Team record, leader identity, leader agent, optional first turn, Team scheduler, and per-Team member collection, returning the `TeamService` itself. | One live Team entity per open Team. | Depends on the deps the collection forwards. A failure before record publication cleans only side effects this attempt created; a failure after it commits a closed record carrying the pending cleanup fact and lets the record-only cleanup path finish. It never instantiates a closed Team to clean up. |
| `TeamService.rebuild` | Called only by `TeamCollection`; implemented in `/packages/dreamux/src/service/team/service.ts`. | Rehydrates a live Team service from a stored `TeamRecord`, including leader and scheduler, returning the `TeamService` itself. | One live Team entity per cached Team. | Depends on the shared identity store for the leader probe. It must fail loud if the stored leader is missing or not a TeamLeader. |
| `TeamService` | Private constructor in `/packages/dreamux/src/service/team/service.ts`; reachable only through `createNew` and `rebuild`. Its parts are `closing.ts`, `completion-targets.ts`, `leader.ts`, `roster.ts`, and `team-summary.ts`; its constructor builds its member collection, Workflows, and scheduler directly (no separate collaborators file); its closed broadcast is the shared `ClosedFactPublisher`. | A handle onto its Team's `TransactionalStore<TeamRecord \| null>` (the committed record itself lives in `TeamStore`, one store per Team id, for the collection's life — `TeamService` holds no separate copy), the contained TeamLeader, the Team-scoped member collection, Workflows, the Team scheduler, and the dissolve it submits and then runs behind the receipt. | Per Team. | Dissolve is a submission: the receipt says accepted and nothing more. Live children are stopped and closed before the record says closed. Closing the scheduler deletes the cron store file as part of that same close pass, before the commit runs — not after — so the jobs stay gone even when the commit that follows fails and leaves the Team open; any failure before the commit lands — stopping, closing, or the commit itself — gives the reversible admissions (Workflows, scheduler) back. `worktree.cleanup_state` plus `worktree_cleanup_force` is the only restart-recovery authority — there is no persisted dissolve state machine. |
| `SchedulerService` / `SchedulerCommands` | `SchedulerService` is defined in `/packages/dreamux/src/service/scheduler/service.ts`; `SchedulerCommands` and the request/options contracts live in `/packages/dreamux/src/service/scheduler/types.ts`. The service is constructed only by the dispatcher and Team containers, each with its own `CronJobStore`. | The cron job store, timers, held-fire tokens, and the lifecycle verbs (`start` / `stop` / `deleteStoreFile`) on the private service; create/update/delete on the external command surface. | Per conversational-agent container. | Depends on an owner-supplied admission gate and scheduled-submit callback. A due fire is submitted immediately through ordinary admission — no cancellation and no idle question cross that call. A job's only action is `prompt-agent`; a persisted `spawn-teammate` action or `deliver` target is refused at the raw file boundary as old state. |
| Dispatcher-scope `TeammateCollection` | Constructed by `DispatcherService`; admin-facing mutating ops are wrapped by the `teammateOps` admission surface in `/packages/dreamux/src/service/dispatcher-service/teammate-ops.ts`. | Dispatcher-owned TeamMate entities, the shared identity store, the worktree manager, provider-backed cold reads, and the per-name live `AgentService` cache. | One collection per dispatcher with `teamScope: null`. | May create and cache ordinary TeamMate entities only. It uses `AgentServiceFactory.create()`; it must not know TeamLeader launch policy or a provider's record format. |
| Team-scoped `TeammateCollection` | Constructed by `TeamService`; class in `/packages/dreamux/src/service/agent/index.ts`, with the Team-scoped bulk close in `/packages/dreamux/src/service/agent/dissolve-members.ts`. | Team-member construction, canonical per-name materialization, exact-object cache subscriptions, roster queries, and bounded cold activity reads. | One collection per Team with `teamScope: team_id`. | May create and cache Team-member entities only. Terminal facts evict the exact instance that ended, and a closed entity is never rematerialized; only `send` may reopen a closed TeamMate, and it enters the cache only after that reopen succeeds. The collection owns no membership registry or post-close command bookkeeping. |
| `AgentServiceFactory.create` | Called for the dispatcher agent, every TeamLeader, and every TeamMate/Team member; defined in `/packages/dreamux/src/service/agent/factory.ts`. | Composes identity and options with the single `TeammateServiceDeps` contract before constructing an `AgentService`. | Factory path for every conversational agent entity. | Depends on the neutral runtime provider catalog, shared stores, optional worktree manager, and lifecycle/delivery capabilities. Runtime launch is resolved uniformly from `identity.agent_runtime -> agents[]`. |
| `createDispatcherAgent` | Called by `DispatcherInputSourceLifecycle`; defined in `/packages/dreamux/src/service/dispatcher-service/agent.ts`. | Builds the dispatcher-owned agent as a contained `AgentService` over the root dispatcher identity. | One dispatcher agent per prepared `DispatcherService`. | Depends on dispatcher config, the shared identity store, delivery policy, and the role-scoped MCP delegates from `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`. It must not construct `AgentService` directly. |
| `createTeamLeaderAgentForTeam` | `TeamService` builds its leader through `/packages/dreamux/src/service/team/leader.ts`, which reaches the shared `AgentServiceFactory`. | Assembles the Team's MCP delegates, bundled skills, and prompt policy, then builds the leader as a contained `AgentService`. | One leader per `TeamService`. | The generic factory path must remain the sole constructor. The leader lives at the Team root, beside `record.json` — never as a member row. |
| `AgentService` | Constructed only by `AgentServiceFactory`; class in `/packages/dreamux/src/service/agent/service.ts`, with raw runtime authority in `runtime-generation.ts` and Turn coordination in `turn.ts` / `admission.ts`; its retirement broadcast is the shared `ClosedFactPublisher`. | One identity, mutation admission, the process-local Workflow lock and restricted handle, a lazily started runtime, the canonical in-process Turns, one-shot outcome/delivery convergence, whether a settling Turn is still owed to its owner (`active` and not under host release), status, close single-flight, and the committed retirement fact. | Per agent entity. | It is the sole lifecycle command owner. It depends on `AgentRuntimeProviderCatalog` through the neutral runtime contract and must not import Collection internals, own a `SchedulerService`, or know Team topology or Channel sessions. `admission.ts` owns `TurnAdmission` and its stated caller-facing projections (`toSubmissionResult`, `asCompletionDeliveryResult`, `failedAdmissionReason`); a consumer reads `TurnAdmission` directly or imports the matching projection rather than repeating it. |
| `WorkflowService` / `WorkflowRun` | `DispatcherWorkflows` (`/packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`) and `TeamService` own the scoped `WorkflowService` in `/packages/dreamux/src/service/workflow-service/index.ts`; it is the only constructor of `WorkflowRun` (`run.ts`). | `WorkflowService` owns the run store, the live run map, startup record recovery, and exact-instance eviction. `WorkflowRun` owns one run: its record, journal, runner process, locked TeamMates, its terminal task, and the terminal report it still owes its initiator, which a stop clears. | One service per caller scope; one run per `run_id`. | A run states that it is durably terminal through a `settled` promise resolved after terminal persistence and delivery; the owner subscribes and evicts the exact instance. The run does not call back into its owner's collection. Startup completes a `running` record from its committed terminal journal fact or marks it `stopped`; execution and delivery do not resume. |

## Ownership Rules

- Cron ownership is on the conversational-agent container: dispatcher cron is
  built by `DispatcherService`, TeamLeader cron by `TeamService`, and
  `AgentService` carries no `SchedulerService`. The construction sites in
  `/packages/dreamux/src/service/dispatcher-service/index.ts` and
  `/packages/dreamux/src/service/team/service.ts` are the current source
  anchors for this rule.
- Every conversational agent goes through `AgentServiceFactory.create()`; `new
  AgentService(...)` is allowed only in
  `/packages/dreamux/src/service/agent/factory.ts`.
- The TeamLeader is held by `TeamService`, not by the members collection. A
  team-scoped collection admits Team members only and must reject a TeamLeader
  read-by-name; the single read-by-name chokepoint applies the same scope check,
  so a wrong-scope name resolves as "does not exist".
- `TeamCollection` owns Team registry/cache behavior; `TeamService` owns Team
  entity behavior, leader policy, and member collection scope.
- Routing is Channel-owned. Core has no binding table, no Collaboration Space
  container, and no target resolution: a Channel names a Team and Core answers.
  Core runtime and channel operations stay behind the neutral seams —
  `AgentRuntimeProvider` / `AgentRuntimeProviderCatalog` for agents and
  `ChannelProvider` / `ChannelProviderCatalog` for channels. Service objects
  assemble capabilities; they do not branch on provider internals.
- An operation is its own fence. A nullable `Promise` field *is* the state: a
  dissolve, a host stop, or a start publishes its promise before doing the work
  behind it, and a second caller joins that promise instead of starting a second
  operation. Do not add a boolean beside a task or a phase enum beside either.
- Every scope that fences admission joins the work it already admitted
  through one tracker, `/packages/dreamux/src/platform/in-flight-work.ts`:
  the dispatcher gate, a Workflow run's materializations, runner messages,
  and agent tasks, the Workflow service's run creations, and a TeamMate's
  ordinary mutations. The fence stays with the scope that decides it; the
  tracker only counts work in and out and lets a stop wait for zero. A
  Team's and a TeamMate's durable-close broadcast is likewise one class,
  `/packages/dreamux/src/platform/closed-fact.ts`; each owner builds its own
  fact beside that fact's type.
- Shared shutdown aggregation belongs in
  `/packages/dreamux/src/platform/shutdown-errors.ts`. `Server`, `Dispatchers`,
  and `DispatcherService` use it to attempt every owned cleanup stage before
  surfacing aggregate failures.
- Process-level admin request admission belongs to `Server`, while dispatcher
  aggregate factory admission belongs to `Dispatchers`. Shutdown must close both
  before the dispatcher ownership-tree sweep, otherwise an already connected
  admin client can materialize a new dispatcher after the sweep snapshot.

### Infrastructure Capability Injection Principle

Global infrastructure capabilities — logger, config, paths, provider catalogs —
must **not** be hand-sliced at call sites with ad-hoc `Pick` types or
`.bind()` adapters (e.g. the former
`new AgentIdentityStore({ warn: opts.log.warn.bind(opts.log) })`).
Instead, inject the stable capability object directly or use a named
factory/adapter owned by the capability module.

Rationale: a `Pick<DreamuxLogger, 'warn'>` + `.bind()` at each construction
site is manual adapter glue that (a) repeats at every call site, (b) obscures
the real dependency in type signatures, and (c) cements a bad implementation
when documented as intentional. Stores accept the full `DreamuxLogger` and
call only `this.log.warn(...)` internally; the discipline of "only warn from
stores" is enforced by review and convention, not by a compiler-narrowed
type at the injection boundary.

### Store Construction Patterns

Three patterns coexist. Each follows the ownership of its data; do not "unify"
them — matching construction to data scope is the point:

- **Shared from composition root.** `AgentIdentityStore` is built once per
  dispatcher root by `Dispatchers`
  (`/packages/dreamux/src/service/dispatchers/index.ts`, cached in
  `rootIdentities`) and handed to the `DispatcherService` it constructs for
  that id, rather than `DispatcherService` building a second instance over
  the same file: the collection's own `summarize()`/`status()` fallback reads
  and the live dispatcher agent's own identity writes share one committed
  value this way. The root store goes only to the dispatcher agent's own
  lifecycle (`DispatcherInputSourceLifecycle`); `DispatcherService`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts`) separately
  builds the dispatcher TeamMate collection store, with its own narrow
  core-event publisher, and hands that one to the dispatcher-scope
  `TeammateCollection`. Identity records are dispatcher-global data, so each
  store must be a single shared instance within its own scope. The publisher
  only reports allowlisted post-write facts; it does not own or persist the
  data.
- **Self-built inline by container.** `CronJobStore` is built inline by each
  scheduler owner (`DispatcherService` or `TeamService`). It is not shared
  because cron job state is per-scheduler — dispatcher cron and Team cron are
  independent files.
- **Per-entity built.** `AgentRuntimeStateStore` is built per `AgentService`
  entity (`/packages/dreamux/src/service/agent/service.ts`). It bridges
  runtime state callbacks to the entity's own identity row; sharing would break
  the per-entity identity binding. It does not persist to its own file — it
  writes through to `identity.json` via the shared `AgentIdentityStore`.

When adding a new store, ask: *who owns the data this store reads/writes?*
Match the construction pattern to the data scope, not to the nearest class.

### Honest Layering

Moving declarations only counts as layering when the resulting dependency pair
is honest. Three rejection criteria, learned from a drafted-and-overtaken
split plan:

- a types module that names the concrete service it serves and must
  type-import the service's `index.ts` while `index.ts` imports it back is a
  circle wearing a `types.ts` costume;
- a relocation that reverses an existing lower-level contract edge (the
  consumer already imports the request contract from the module you would move
  it out of) inverts ownership rather than clarifying it;
- type erasure prevents a runtime cycle but does not make the source-level
  dependency pair an honest layer — "it compiles" proves nothing here.

When a file trips the max-lines gate, find the responsibility that wants its
own owner or record a micro-refactor candidate; do not relocate declarations
to manufacture headroom.

When moving a service class, changing who constructs it, or changing ownership
scope, update this page in the same change. `.agents/scripts/check.sh`
validates every cited package source path on the domains pages, so rows cannot
drift into dead anchors silently; it does not validate prose, so a row whose
object was deleted must be removed rather than repointed at a surviving file.

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md).
