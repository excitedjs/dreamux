# Service Topology

This is the source-anchored ownership map for Dreamux service-layer objects.
Read current source first when behavior matters; this page records who is
allowed to build and hold each service object so future refactors do not
rediscover issue #233 by trial and error.

## Ownership Map

| Service object | Owner / construction sites | Holds / owns | Scope | Depends on / direction |
|---|---|---|---|---|
| `Dispatchers` | Constructed by server wiring at `/packages/dreamux/src/server.ts:148`; inside the service package it is the process collection in `/packages/dreamux/src/service/dispatchers/index.ts:24`. It constructs `DispatcherService` at `/packages/dreamux/src/service/dispatchers/index.ts:66`. It holds a **separate read-only `AgentIdentityStore`** at `/packages/dreamux/src/service/dispatchers/index.ts:60` for unmaterialized summary/status probes — it does not borrow the per-dispatcher store from a live `DispatcherService`. | A `Map<string, DispatcherService>`, restart-intent consumer, process shutdown sweep, and a read-only identity reader for dispatcher-global name listing. It owns no teammate/team/channel/router state. | Process-global collection over dispatchers. | May depend on config, `DispatcherStore`, provider catalogs, and logging. It must only hand each dispatcher id to `DispatcherService`; it must not reach into per-dispatcher internals. |
| `DispatcherService` | Constructed only by `Dispatchers.get()` at `/packages/dreamux/src/service/dispatchers/index.ts:63`. Its constructor assembles the per-dispatcher graph in `/packages/dreamux/src/service/dispatcher-service/index.ts:117`. | Dispatcher agent, `CompletionRouter`, dispatcher-scope `TeammateCollection`, `TeamCollection`, shared stores, shared worktree manager, `ChannelService`, and the dispatcher scheduler. | One aggregate per dispatcher. | Depends on provider catalogs, `DispatcherStore`, channel catalog, and service collaborators. It is the allowed owner of dispatcher-global topology and orchestrates across channels, teams, and agents. Core stays behind `AgentRuntimeProvider` and `ChannelProvider` seams. |
| `CompletionRouter` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:127`. | Pending completion initiators, in-flight delivery promises, and terminal-at-most-once cache keyed by `producerName:turnId`. | Per dispatcher. | Used by teammate collections and dispatcher/team leader agents to register and settle send-initiated completions. Delivery targets implement the neutral `completionInput` surface. |
| `WorktreeManager` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:129`. | Worktree preparation and cleanup operations; it is stateless apart from filesystem effects. | Per dispatcher helper shared by team and teammate collections. | Used by `TeammateCollection` and `TeamCollection`; path derivation remains in the platform/worktree helpers, not in callers. |
| `ChannelBindingStore` | Constructed by `ChannelService` at `/packages/dreamux/src/service/channel-service/index.ts:52`; standalone preflight construction exists at `/packages/dreamux/src/service/channel-binding/store.ts:223`. | Persistent channel binding records. | Per dispatcher data, with stateless store object. | `ChannelService` consumes this store; Team services and collections do not read or mutate binding rows directly. |
| `AgentIdentityStore` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:131` and injected into collections. `Dispatchers` builds a **separate read-only instance** at `/packages/dreamux/src/service/dispatchers/index.ts:60` for path probes; it does not borrow the per-dispatcher store. Collections receive the shared store; they do not build their own. | Reads and writes `identity.json` for the dispatcher root agent, dispatcher teammates, team leaders, and team members. | Stateless store over dispatcher/team/entity paths. | Path placement is derived from identity role and `team_id`; collections do not invent paths. The dispatcher root accessor is explicit and is not part of teammate collection enumeration. |
| `AgentTurnsStore` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:132`. Collections receive the shared store; they do not build their own. | Reads and writes compact turn records. | Stateless store over dispatcher/team/entity paths. | Used by `TeammateService` and read helpers; completion routing is separate. |
| `AgentRuntimeStateStore` | Constructed per-entity by `TeammateService` (not from the composition root). Class at `/packages/dreamux/src/service/agent-entity/runtime-state.ts:13`. | Bridges runtime state callbacks (`AgentRuntimeStateCallbacks`) to the entity's `AgentIdentityStore` row. Updates `intent`, `turn_count`, `last_seen_at`, and status preview on the shared identity record. | Per agent entity (dispatcher agent, teammate, team leader, team member). | Depends on the shared `AgentIdentityStore` and the entity's current identity snapshot. It does not persist to its own file; it writes through to `identity.json`. |
| `ChannelService` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:136`. It wraps the private `ChannelSessions` helper in `/packages/dreamux/src/service/channel-service/channel-sessions.ts`. | Live `Map<channel_id, ChannelSession>`, channel-tool forwarding, target resolution, channel MCP descriptor assembly, `ChannelBindingStore`, binding summaries, bind/transfer writes, inbound binding lookup, and TeamLeader egress ownership checks. | Per dispatcher. | Depends on `ChannelProviderCatalog`, channel config, its internally owned `ChannelBindingStore`, and the core-owned channel MCP descriptor renderer in `service/channel-service/mcp-descriptors.ts`. It owns channel/binding facts only; Team route owners are flat routing data and Team lifecycle remains outside it. |
| `createDispatcherAgent` | Called by `DispatcherService` after dispatcher identity ensure; defined in `/packages/dreamux/src/service/dispatcher-service/agent.ts`. | Builds the dispatcher-owned agent as a contained `TeammateService` over the root dispatcher identity. | One dispatcher agent per prepared `DispatcherService`. | Depends on dispatcher config, shared identity/turn stores, router, and static MCP descriptors. It must not construct `TeammateService` directly. |
| Dispatcher `SchedulerService` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:146`. | Dispatcher cron timers and durable cron jobs via `CronJobStore` built at `/packages/dreamux/src/service/dispatcher-service/index.ts:148`. | One scheduler for the dispatcher conversational agent. | It submits scheduled input to the dispatcher agent. Scheduler construction belongs to the container, not to `TeammateService`. |
| Dispatcher-scope `TeammateCollection` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:158`. | Dispatcher-owned teammate entities, shared identity/turn stores, worktree manager, and per-name live `TeammateService` cache. | One collection per dispatcher with `teamScope: null`. | May create/cache ordinary `teammate` entities only. It uses `createTeammateService`; it must not know team-leader launch policy. |
| `TeamCollection` | Constructed by `DispatcherService` at `/packages/dreamux/src/service/dispatcher-service/index.ts:172`. | Team store, worktree manager, create/rebuild cache for `TeamService`, open-Team route-owner facts, and in-flight create/rebuild dedupe. | One collection per dispatcher. | Depends on shared stores and dispatcher-owned launch primitives. It creates/rebuilds `TeamService` but does not build leaders or team-member agents itself. |
| `TeamService.createNew` | Called by `TeamCollection.doCreate()` at `/packages/dreamux/src/service/team-collection/index.ts:137`; constructs `TeamService` at `/packages/dreamux/src/service/team-service/index.ts:151`; allocates leader name at `/packages/dreamux/src/service/team-service/index.ts:152`; builds leader through `buildLeader()` at `/packages/dreamux/src/service/team-service/index.ts:200`. | Creates the durable team record, leader identity, leader agent, optional first turn, team scheduler, and per-team member collection. | One live team entity per open team. | Depends on `TeamServiceDeps` forwarded by `TeamCollection`. It owns team-root leader policy and team-member collection scope. |
| `TeamService.rebuild` | Called by `TeamCollection.serviceFor()` at `/packages/dreamux/src/service/team-collection/index.ts:223`; constructs `TeamService` at `/packages/dreamux/src/service/team-service/index.ts:220`; rebuilds leader through `buildLeader()` at `/packages/dreamux/src/service/team-service/index.ts:232`. | Rehydrates a live team service from a stored `TeamRecord`, including leader and scheduler. | One live team entity per cached team. | Depends on the shared identity store for the leader probe. It must fail loud if the stored leader is missing or not `team_leader`. |
| `TeamService` | Private constructor in `/packages/dreamux/src/service/team-service/index.ts:119`; only reachable through `createNew` and `rebuild`. It constructs the team-scoped members collection at `/packages/dreamux/src/service/team-service/index.ts:121` and the team scheduler at `/packages/dreamux/src/service/team-service/index.ts:134`. | Own team record, contained team leader `TeammateService`, team-scoped `TeammateCollection`, scheduler, leader settle captures, and shared workspace behavior. | Per team. | Depends on `TeamCollection`-provided stores, router, worktree manager, and MCP descriptor builders. It is the owner of `team_leader` policy and must not expose concrete collection lifecycle methods through the public admin surface. |
| Team `SchedulerService` | Constructed by `TeamService` at `/packages/dreamux/src/service/team-service/index.ts:134`, using `CronJobStore` at `/packages/dreamux/src/service/team-service/index.ts:136`. | Team leader cron timers and durable team cron jobs. | One scheduler for the team leader conversational agent. | It submits scheduled input to the team leader. Scheduler construction belongs to `TeamService`, not the generic teammate entity. |
| Team-scoped `TeammateCollection` | Constructed by `TeamService` at `/packages/dreamux/src/service/team-service/index.ts:121`. | Team-member entities, shared identity/turn stores, worktree manager, router registration, and per-name live `TeammateService` cache. | One collection per team with `teamScope: team_id`. | It may create/cache `team_member` entities only. `assertInCollection` excludes `team_leader` at `/packages/dreamux/src/service/teammate-collection/index.ts:440`. |
| `createTeamLeaderAgent` | Called by `TeamService.buildLeader()`; defined in `/packages/dreamux/src/service/team-service/leader-agent.ts`; calls `createTeammateService`. | Builds the team leader as a contained `TeammateService` with flat `mcpServers` and `disableFeatures` options. | One leader per `TeamService`. | Depends on team-owned options and shared stores. It must use the factory and must not construct `TeammateService` directly. |
| `createTeammateService` | Called for dispatcher agent, team leader, and member/ordinary teammates; defined in `/packages/dreamux/src/service/teammate-service/factory.ts`. | Normalizes dependencies before constructing a `TeammateService`. | Factory path for every conversational agent entity. | Depends on neutral runtime provider catalog, stores, optional worktree manager, and routing callbacks. Runtime launch is resolved uniformly from `identity.agent_runtime -> agents[]`. |
| `TeammateService` | Constructed only by `createTeammateService` at `/packages/dreamux/src/service/teammate-service/factory.ts:63`; class lives in `/packages/dreamux/src/service/teammate-service/index.ts`. | One identity, lazily started runtime, current launch resolution, submission/turn recording, status/last/close behavior, channel input, scheduled input, and completion input. | Per agent entity: dispatcher agent, dispatcher teammate, team leader, or team member. | Depends on `AgentRuntimeProviderCatalog` through the neutral `AgentRuntimeProvider` interface. It must not own `SchedulerService`, team topology, or channel sessions. |
| `SchedulerService` | Class defined in `/packages/dreamux/src/service/scheduler/service.ts:62`; constructed only by dispatcher/team containers at `/packages/dreamux/src/service/dispatcher-service/index.ts:146` and `/packages/dreamux/src/service/team-service/index.ts:134`. | Cron job store, timers, held-fire tokens, stop waiters, and run/update/delete behavior. | Per conversational-agent container. | Depends on an owner-provided runtime getter and scheduled-submit callback. It is a cron capability owned by containers, not generic agent state. |

## Ownership Rules

- Cron ownership is on the conversational-agent container: dispatcher cron is
  built by `DispatcherService`, team-leader cron is built by `TeamService`, and
  `TeammateService` carries no `SchedulerService`. Enforced by
  `/packages/dreamux/tests/architecture-ownership-gate.test.ts`.
- Every conversational agent goes through `createTeammateService`; `new
  TeammateService(...)` is allowed only in
  `/packages/dreamux/src/service/teammate-service/factory.ts:63`. Enforced by
  `/packages/dreamux/tests/architecture-ownership-gate.test.ts`.
- The team leader is held by `TeamService`, not by the members collection.
  `TeammateCollection.assertInCollection` admits dispatcher `teammate` or team
  `team_member` only, and a team-scoped collection must reject a `team_leader`
  read-by-name. Enforced by
  `/packages/dreamux/tests/architecture-ownership-gate.test.ts`.
- `TeamCollection` owns team registry/cache behavior; `TeamService` owns team
  entity behavior, leader policy, and member collection scope. Enforced by the
  topology source anchors here plus the ownership-gate tests.
- Channel binding creation, lookup, summaries, transfer-back, and TeamLeader egress checks are owned by `ChannelService`; `TeamService`, `TeamMateService`, and `TeamCollection` do not own binding-store access. Core runtime and channel operations stay behind neutral seams:
  `AgentRuntimeProvider` / `AgentRuntimeProviderCatalog` for agents and
  `ChannelProvider` / `ChannelProviderCatalog` for channels. Service objects
  assemble capabilities; they do not branch on provider internals.

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

- **Shared from composition root.** `AgentIdentityStore` and `AgentTurnsStore`
  are built once by `DispatcherService`
  (`/packages/dreamux/src/service/dispatcher-service/index.ts:131`) and
  injected into all collections and services. Identity and turn records are
  dispatcher-global data, so the store must be a single shared instance.
  `Dispatchers` builds its own separate read-only `AgentIdentityStore`
  (`/packages/dreamux/src/service/dispatchers/index.ts:60`) for unmaterialized
  summary/status probes without waking a `DispatcherService`.
- **Self-built inline by container.** `CronJobStore` is built inline by each
  scheduler owner (`DispatcherService` at `dispatcher-service/index.ts:148`,
  `TeamService` at `team-service/index.ts:137`). It is not shared because cron
  job state is per-scheduler (dispatcher cron vs. team cron are independent).
- **Per-entity built.** `AgentRuntimeStateStore` is built per `TeammateService`
  entity (`/packages/dreamux/src/service/teammate-service/index.ts:153`). It
  bridges runtime state callbacks to the entity's own identity row; sharing
  would break the per-entity identity binding. It does not persist to its own
  file — it writes through to `identity.json` via the shared `AgentIdentityStore`.

When adding a new store, ask: *who owns the data this store reads/writes?*
Match the construction pattern to the data scope, not to the nearest class.

### Source vs. Intent in This Document

Code is current behavior. This KB distinguishes three layers:

- **Current source facts** — what the code does today (e.g. "`AgentIdentityStore`
  constructor takes `DreamuxLogger`").
- **Architectural intent** — the target shape the code is moving toward or
  holding (e.g. "identity/turn stores are shared from the composition root,
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
the cited file paths so this page cannot drift into dead anchors silently.
