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
| `CoreCommandRegistry` | Built once by server wiring in `/packages/dreamux/src/server.ts` from the domain-owned definitions each module declares in its own `commands.ts`. | The one authoritative Command catalog: bounding, input validation, resolution, execution, and output validation. | Whole process. | Both adapters — the admin socket in `/packages/dreamux/src/admin/socket.ts` and a Channel's in-process `invoke` port in `/packages/dreamux/src/channel/core-port.ts` — name a Command and hand over JSON plus factual caller context. There is no per-adapter handler table, allowlist, or exposure flag. Agent MCP is NOT a Command adapter. |
| `Dispatchers` | Constructed by server wiring in `/packages/dreamux/src/server.ts`; the process collection lives in `/packages/dreamux/src/service/dispatchers/index.ts`, which constructs each `DispatcherService`. It lazily builds a **separate read-only `AgentIdentityStore`** per dispatcher root for unmaterialized summary/status probes — it does not borrow the store from a live `DispatcherService`. | A `Map<string, DispatcherService>`, restart-intent consumer, all-settled process shutdown sweep, factory-admission fence, and cached read-only root identity readers. It owns no teammate/team/channel state. | Process-global collection over dispatchers. | May depend on config, `DispatcherStore`, provider catalogs, the MCP lease registry, the Command registry, and logging. It must only hand each dispatcher id to `DispatcherService`; it must not reach into per-dispatcher internals. Shutdown closes the dispatcher factory before taking the sweep snapshot, so `get()` cannot materialize a new aggregate after process shutdown starts. |
| `DispatcherService` | Constructed only by `Dispatchers.get()`. Its constructor is the dispatcher composition root in `/packages/dreamux/src/service/dispatcher-service/index.ts`: every persistence root is derived once there and handed to the owner that keeps it. | Stateless `CompletionDeliveryPolicy`, dispatcher-scoped core event bus, shared `AgentIdentityStore` / `AgentEntityCollectionStore` / `AgentNameRegistry` / `AdmissionLedger`, shared `WorktreeManager`, `ChannelService`, dispatcher `SchedulerService`, dispatcher-scope `TeammateCollection`, `TeamCollection`, `DispatcherWorkflows`, admission drain, and `DispatcherInputSourceLifecycle`. | One aggregate per dispatcher. | Depends on provider catalogs, `DispatcherStore`, the Command registry, and the MCP lease registry. It owns dispatcher-global topology and close-before-drain ordering. Core stays behind the `AgentRuntimeProvider` and `ChannelProvider` seams. |
| `DispatcherInputSourceLifecycle` | Constructed by `DispatcherService`; class lives in `/packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts`, with rollback in `/packages/dreamux/src/service/dispatcher-service/input-source-start-rollback.ts`. | Preparation/start single-flight promises, the prepared Channel-instance set, started state, dispatcher agent/workspace publication, ordered live Channel publication, Workflow and scheduler start, and failed-start rollback. | One lifecycle capability per dispatcher aggregate. | Receives the aggregate's constructed collaborators once. It creates a fresh event lease before each Channel session starts and publishes an instance as live only after provider start succeeds. Failed start revokes admission and leases, drains accepted work, and sweeps materialized Team runtimes. Ordinary start leaves the dispatcher runtime dormant. |
| `DispatcherTaskDrain` | Constructed by `DispatcherService`; class lives in `/packages/dreamux/src/service/dispatcher-service/inbound-task-drain.ts`. | The dispatcher-owned admission gate and pending-task set for work that may create runtime, scheduler, or durable state. | One gate per dispatcher aggregate. | Stop/shutdown closes admission before draining admitted work and sweeping the ownership tree. It owns no domain state; it only fences entry and completion. |
| `CompletionDeliveryPolicy` | Constructed by `DispatcherService`; implementation in `/packages/dreamux/src/service/completion-router/index.ts`. | Per-recipient FIFO delivery of an already-prepared completion fact, plus folding of the same provider completion token reported through several paths. | One reusable policy per dispatcher. | The initiating action captures a closure on the entity-owned Turn. A settled turn with no native completion token — failed or stopped — is delivered with a `null` token rather than a fabricated one, on the same recipient queue. It owns no Turn registry, key map, or terminal cache. |
| `DispatcherCoreEventBus` | Constructed only by `DispatcherService`; implementation in `/packages/dreamux/src/service/dispatcher-core-events/`. | An in-process `EventEmitter`, a narrow internal publisher capability, and revocable read-only Channel event sources. It retains no events or domain state. | One bus per dispatcher aggregate; one source lease per live Channel session generation. | Team and identity owners publish the allowlisted state DTOs after their normal writes. Channel providers receive only the public source from `@excitedjs/dreamux-types`, never the bus, publisher, or raw listener-management surface. Listener failures are isolated; stop and failed start revoke the session generation. |
| `WorktreeManager` | Constructed by `DispatcherService`; implementation in `/packages/dreamux/src/service/worktree/manager.ts`, with workspace resolution in `/packages/dreamux/src/service/worktree/workspaces.ts`. | Worktree preparation, non-destructive dirty/unmerged cleanup assessment, and cleanup mutation; it is stateless apart from filesystem effects. | Per dispatcher helper shared by Team and TeamMate collections. | A prepared workspace records whether **this attempt** created the checkout, and only that attempt may discard it. `cleanup()` reassesses immediately before mutation, performs no ref enumeration or history walk, and removes a clean managed `delete-on-close` worktree only with non-forced `git worktree remove <path>`. It preserves the managed branch and its commits; branch/ref deletion is outside this capability. `cleanup: keep` and non-managed workspaces are terminally retained. |
| `AgentIdentityStore` | Constructed by `DispatcherService` and injected into collections; class in `/packages/dreamux/src/service/agent-entity/identity-store.ts`. `Dispatchers` builds separate read-only instances for path probes. Collections receive the shared store; they do not build their own. | Reads and writes `identity.json` for the dispatcher root agent, dispatcher TeamMates, TeamLeaders, and Team members. Identity owns lifecycle/worktree/intent facts, persisted skill sources, and one nullable provider-owned `session` object Core stores verbatim; it owns no conversation projection and no per-Turn archive. | Stateless store bound to one already-resolved entity directory. | `dir` is the only path input; no persisted field takes part in choosing it. A missing file reads as `null` and an unreadable one is logged and read as `null`, but a record this version refuses to interpret raises `LegacyStateError` — every caller, including the Team read model, passes that through rather than reporting "no identity". Generated name allocation scans persisted entity directory names, and identity creation is an atomic no-clobber write. |
| `readAgentActivity` | Called by `TeammateCollection.last()` and the Team read paths; implementation in `/packages/dreamux/src/service/agent-entity/activity-reader.ts`. | Validates the neutral query, resolves the selected provider, delegates one bounded recent-Activity read, and projects provider-neutral rows with typed errors. | Stateless read capability over one persisted identity and the provider catalog. | It reads identity/config only, starts or materializes no runtime, performs no state write, and stores no cursor/cache/index. Provider-native record formats stay inside the provider package. |
| `AgentRuntimeStateStore` | Constructed per-entity by `TeammateService` (not from the composition root); class in `/packages/dreamux/src/service/agent-entity/runtime-state.ts`. | Bridges runtime state callbacks to the entity's `AgentIdentityStore` row: intent/status plus the provider-owned session object. | Per agent entity (dispatcher agent, TeamMate, TeamLeader, Team member). | Depends on the shared `AgentIdentityStore` and the entity's current identity snapshot. It does not persist to its own file; it writes through to `identity.json`. |
| `ChannelService` | Constructed by `DispatcherService`; class in `/packages/dreamux/src/service/channel-service/index.ts`, with its MCP delegate in `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`. | The built and live `Map<channel_id, ChannelInstance>` and the session-MCP lookup keyed off it. Nothing else. | Per dispatcher. | Depends on `ChannelProviderCatalog` and channel config. There is no binding table, no route owner, and no target resolution or egress check here: a Channel decides where a message goes and says so by naming a Team, so Core neither stores that decision nor reconstructs it. An instance is published as live only after provider start succeeds. |
| `TeamCollection` | Constructed by `DispatcherService`; class in `/packages/dreamux/src/service/team-collection/index.ts`. `runtime-registry.ts`, `read-model.ts`, `worktree-cleanup.ts`, and `create-request.ts` are private capabilities of this aggregate. | The `TeamStore`, the create-request lifecycle queue, and — through `TeamRuntimeRegistry` — one keyed construction per team id shared by create and rebuild, the live cache, and the private scheduler handles. | One collection per dispatcher. | Depends on the shared identity stores, `WorktreeManager`, and dispatcher-owned admission. Creating a Team publishes its record before its object graph is finished, so a read arriving mid-create joins that one construction instead of building a second owner. `read-model.ts` projects a Team that is not materialized and never builds one; `worktree-cleanup.ts` finishes a closed Team's reclamation from its record alone. It creates and rebuilds `TeamService` but leaves leader/member construction and resource shutdown to that entity. |
| `TeamLeaderHandle` | Declared in `/packages/dreamux/src/service/dispatcher-service/team-leader-handle.ts`; created only by `DispatcherService.team()`. | A TeamLeader-scoped member/workflow surface plus `spawnTeamMate()` for the admin/MCP team-leader target. | Per resolved Team. | It is the only member/workflow surface returned by `DispatcherService.team()`. It does not expose the concrete `TeamService`, raw `teammates.spawn`, scheduler lifecycle, leader runtime, or a second dissolve implementation. |
| `stopTeamRuntimes` | Called during process shutdown and failed Channel start rollback; helper in `/packages/dreamux/src/service/dispatcher-service/team-runtime-stop.ts`. | Best-effort wrapper around `TeamCollection.stopAll()`. | Per shutdown or failed-start rollback attempt. | `stopAll()` lists every durable non-closed Team, canonically materializes it, and asks each `TeamService` to stop Workflows and close its normal entities. The wrapper logs errors and returns them so sibling cleanup continues; it is not a raw-runtime sweep. |
| `TeamService.createNew` | Called only by `TeamRuntimeRegistry`; implemented in `/packages/dreamux/src/service/team-service/index.ts`. | Creates the durable Team record, leader identity, leader agent, optional first turn, Team scheduler, per-Team member collection, and a scheduler lifecycle capability returned only to the registry. | One live Team entity per open Team. | Depends on the deps the registry forwards. A failure before record publication cleans only side effects this attempt created; a failure after it commits a closed record carrying the pending cleanup fact and lets the record-only cleanup path finish. It never instantiates a closed Team to clean up. |
| `TeamService.rebuild` | Called only by `TeamRuntimeRegistry`; implemented in `/packages/dreamux/src/service/team-service/index.ts`. | Rehydrates a live Team service from a stored `TeamRecord`, including leader, scheduler, and the owner-only scheduler lifecycle capability. | One live Team entity per cached Team. | Depends on the shared identity store for the leader probe. It must fail loud if the stored leader is missing or not a TeamLeader. |
| `TeamService` | Private constructor in `/packages/dreamux/src/service/team-service/index.ts`; reachable only through `createNew` and `rebuild`. Its parts are `closing.ts`, `collaborators.ts`, `completion-targets.ts`, `leader-agent.ts`, `roster-projection.ts`, `team-view.ts`, and `closed-fact.ts`. | Its own `TeamRecord`, the contained TeamLeader, the Team-scoped member collection, Workflows, the Team scheduler, and the dissolve it submits and then runs behind the receipt. | Per Team. | Dissolve is a submission: the receipt says accepted and nothing more. Live children are stopped and closed before the record says closed; the durable close is the transaction boundary, so the cron store file is deleted only after it and a failed commit gives the admissions back. `worktree.cleanup_state` plus `worktree_cleanup_force` is the only restart-recovery authority — there is no persisted dissolve state machine. |
| `SchedulerService` / `SchedulerCommands` | `SchedulerService` is defined in `/packages/dreamux/src/service/scheduler/service.ts`; `SchedulerCommands` and the request/options contracts live in `/packages/dreamux/src/service/scheduler/types.ts`. The service is constructed only by the dispatcher and Team containers, each with its own `CronJobStore`. | The cron job store, timers, held-fire tokens, and the lifecycle verbs (`start` / `stop` / `deleteStoreFile`) on the private service; create/update/delete on the external command surface. | Per conversational-agent container. | Depends on an owner-supplied admission gate and scheduled-submit callback. A due fire is submitted immediately through ordinary admission — no cancellation and no idle question cross that call. A job's only action is `prompt-agent`; a persisted `spawn-teammate` action or `deliver` target is refused at the raw file boundary as old state. |
| Dispatcher-scope `TeammateCollection` | Constructed by `DispatcherService`; admin-facing mutating ops are wrapped by the `teammateOps` admission surface in `/packages/dreamux/src/service/dispatcher-service/teammate-ops.ts`. | Dispatcher-owned TeamMate entities, the shared identity store, the worktree manager, provider-backed cold reads, and the per-name live `TeammateService` cache. | One collection per dispatcher with `teamScope: null`. | May create and cache ordinary TeamMate entities only. It uses `createTeammateService`; it must not know TeamLeader launch policy or a provider's record format. |
| Team-scoped `TeammateCollection` | Constructed by `TeamService`; class in `/packages/dreamux/src/service/teammate-collection/index.ts`, with the Team-scoped bulk close in `/packages/dreamux/src/service/teammate-collection/dissolve-members.ts`. | Team-member construction, canonical per-name materialization, exact-object cache subscriptions, roster queries, and bounded cold activity reads. | One collection per Team with `teamScope: team_id`. | May create and cache Team-member entities only. Terminal facts evict the exact instance that ended, and a closed entity is never rematerialized; only `send` may reopen a closed TeamMate, and it enters the cache only after that reopen succeeds. The collection owns no membership registry or post-close command bookkeeping. |
| `createTeammateService` | Called for the dispatcher agent, every TeamLeader, and every TeamMate/Team member; defined in `/packages/dreamux/src/service/teammate-service/factory.ts`. | Composes identity and options with the single `TeammateServiceDeps` contract before constructing a `TeammateService`. | Factory path for every conversational agent entity. | Depends on the neutral runtime provider catalog, shared stores, optional worktree manager, and lifecycle/delivery capabilities. Runtime launch is resolved uniformly from `identity.agent_runtime -> agents[]`. |
| `createDispatcherAgent` | Called by `DispatcherInputSourceLifecycle`; defined in `/packages/dreamux/src/service/dispatcher-service/agent.ts`. | Builds the dispatcher-owned agent as a contained `TeammateService` over the root dispatcher identity. | One dispatcher agent per prepared `DispatcherService`. | Depends on dispatcher config, the shared identity store, delivery policy, and the role-scoped MCP delegates from `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`. It must not construct `TeammateService` directly. |
| `createTeamLeaderAgentForTeam` | `TeamService` builds its leader through `/packages/dreamux/src/service/team-service/leader-agent.ts`, which reaches `createTeammateService`. | Assembles the Team's MCP delegates, bundled skills, and prompt policy, then builds the leader as a contained `TeammateService`. | One leader per `TeamService`. | The generic factory path must remain the sole constructor. The leader lives at the Team root, beside `record.json` — never as a member row. |
| `TeammateService` | Constructed only by `createTeammateService`; class in `/packages/dreamux/src/service/teammate-service/index.ts`, with raw runtime authority in `runtime-owner.ts` and Turn coordination in `turn-coordinator.ts` / `turn-recording.ts`. | One identity, mutation admission, the process-local Workflow lock and restricted handle, a lazily started runtime, the canonical in-process Turns, one-shot outcome/delivery convergence, status, close single-flight, and the committed retirement fact. | Per agent entity. | It is the sole lifecycle command owner. It depends on `AgentRuntimeProviderCatalog` through the neutral runtime contract and must not import Collection internals, own a `SchedulerService`, or know Team topology or Channel sessions. `turn-recording.ts` owns `TurnAdmission`, `InboundDeliveryResult`, and the single conversion between them; a consumer imports that converter rather than repeating it. |
| `WorkflowService` / `WorkflowRun` | `DispatcherWorkflows` (`/packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`) and `TeamService` own the scoped `WorkflowService` in `/packages/dreamux/src/service/workflow-service/index.ts`; it is the only constructor of `WorkflowRun` (`run.ts`). | `WorkflowService` owns the run store, the live run map, startup record recovery, and exact-instance eviction. `WorkflowRun` owns one run: its record, journal, runner process, locked TeamMates, and its terminal task (`run-terminal.ts`). | One service per caller scope; one run per `run_id`. | A run states that it is durably terminal through a `settled` promise resolved after terminal persistence and delivery; the owner subscribes and evicts the exact instance. The run does not call back into its owner's collection. Startup completes a `running` record from its committed terminal journal fact or marks it `stopped`; execution and delivery do not resume. |

## Ownership Rules

- Cron ownership is on the conversational-agent container: dispatcher cron is
  built by `DispatcherService`, TeamLeader cron by `TeamService`, and
  `TeammateService` carries no `SchedulerService`. The construction sites in
  `/packages/dreamux/src/service/dispatcher-service/index.ts` and
  `/packages/dreamux/src/service/team-service/index.ts` are the current source
  anchors for this rule.
- Every conversational agent goes through `createTeammateService`; `new
  TeammateService(...)` is allowed only in
  `/packages/dreamux/src/service/teammate-service/factory.ts`.
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
- Shared shutdown aggregation belongs in
  `/packages/dreamux/src/service/shutdown-errors.ts`. `Server`, `Dispatchers`,
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

- **Shared from composition root.** `AgentIdentityStore` and the collection
  store are built once by `DispatcherService`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts`) with their
  narrow core-event publisher and injected into all collections and services.
  Identity records are dispatcher-global data, so the store must be a single
  shared instance. The publisher only reports allowlisted post-write facts; it
  does not own or persist the data. `Dispatchers` builds its own separate
  read-only `AgentIdentityStore` per dispatcher root
  (`/packages/dreamux/src/service/dispatchers/index.ts`) for unmaterialized
  summary/status probes without waking a `DispatcherService`.
- **Self-built inline by container.** `CronJobStore` is built inline by each
  scheduler owner (`DispatcherService` or `TeamService`). It is not shared
  because cron job state is per-scheduler — dispatcher cron and Team cron are
  independent files.
- **Per-entity built.** `AgentRuntimeStateStore` is built per `TeammateService`
  entity (`/packages/dreamux/src/service/teammate-service/index.ts`). It bridges
  runtime state callbacks to the entity's own identity row; sharing would break
  the per-entity identity binding. It does not persist to its own file — it
  writes through to `identity.json` via the shared `AgentIdentityStore`.

When adding a new store, ask: *who owns the data this store reads/writes?*
Match the construction pattern to the data scope, not to the nearest class.

### Source vs. Intent in This Document

Code is current behavior. This KB distinguishes three layers:

- **Current source facts** — what the code does today (e.g. "`AgentIdentityStore`
  constructor takes `DreamuxLogger`").
- **Architectural intent** — the target shape the code is moving toward or
  holding (e.g. "the identity store is shared from the composition root,
  not self-built by each collection").
- **Known debt / review heuristics** — things that work but should not be
  copied (e.g. "do not hand-slice infrastructure capabilities at call sites;
  inject the stable object or use a named factory").

When code and this document disagree, read the source first — then update the
document if the code moved intentionally, or fix the code if it drifted.

## Update Rules

When moving a service class, changing who constructs it, or changing ownership
scope, update this file in the same change and keep every cited
package source path resolvable. `.agents/scripts/check.sh` validates
the cited file paths so this page cannot drift into dead anchors silently. It
does not validate prose, so a row whose object was deleted must be removed
rather than repointed at a surviving file.
