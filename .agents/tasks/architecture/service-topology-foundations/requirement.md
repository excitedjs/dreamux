# Backfilled decision records: service topology foundation records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## service-architecture-refactor

## Service Architecture Refactor (Collection + Service Model)

- **Status:** Accepted for the Collection + Service topology; completion routing
  and TeamMate lifecycle ownership are superseded by
  [entity-owned TeamMate lifecycle and object Turns](/.agents/tasks/architecture/service-topology-foundations/requirement.md#entity-owned-teammate-lifecycle-and-object-turns)
- **Date:** 2026-06-16 (delivery + reliability model finalized 2026-06-17)
- **Affects:** `dispatcher-service/` entire module (renamed to `service/`), `platform/paths.ts`, `admin/methods.ts`, state directory layout
- **PR / Issue:** #233
- **Related:** issue #209 follow-up; refines `dispatcher-local-aggregate.md`

### Context

The `dispatcher-service/` object model evolved across multiple iterations and carries several structural problems:

1. **Blurred responsibility boundaries.** `TeamMateAgentService` and `TeamManager` are process-wide god objects mixing collection operations, entity operations, storage access, and runtime management.
2. **Inconsistent naming.** Some are called Service, some Manager, some Store — names don't reflect actual responsibilities.
3. **No entity objects.** Teammates and teams have no corresponding entity objects; all operations live on manager/service classes, separating data from behavior.
4. **Asymmetric layering.** The Team side has a collection + single-entity split (`TeamManager` / `TeamService`), while the Teammate side has one monolithic Service.
5. **Redundant `LiveTeammateRegistry`.** A global registry of live runtimes is unnecessary when each teammate can manage its own runtime.
6. **No unified agent model.** Dispatcher runtime and team leader are conceptually the same thing — an entity with an agent runtime — but implemented as two completely separate code paths.
7. **Delivery logic is duplicated.** Completion delivery to dispatcher runtime and to team leader follow the same pattern but are coded separately.

### Decision

Restructure the service layer around a **Collection + Service pattern**, and
unify agent runtime lifecycle management through a shared `TeammateService`
entity. The dispatcher *has* an agent (not *is* an agent); the team *has* a
leader agent.

> **Current decision:** The Collection + Service topology remains accepted.
> The `CompletionRouter` registry, `producerName:turnId` keys, settle callbacks,
> Collection-owned close/release behavior, and runtime-only shutdown sweeps in
> this historical record no longer describe current behavior. Completion
> initiators are captured by closure on entity-owned object Turns, and
> `TeammateService` owns the lifecycle command path. The sections below through
> the rollout plan preserve the original issue #233 design history; use the
> current note above, the current-state references, and the superseding
> entity-owned lifecycle decision for present behavior.

#### Symmetric Collection + Service Pattern

Both Team and Teammate follow the same two-level pattern:

| Level | Team side | Teammate side | Responsibility |
|---|---|---|---|
| Collection | `TeamCollection` | `TeammateCollection` | Holds store, create/list/get, factory methods, event emission |
| Entity | `TeamService` | `TeammateService` | Holds its own record/identity, domain operations, runtime lifecycle |

No inheritance between collections or entities. Differences (dispatcher-owned vs team-owned) are expressed through constructor injection of configuration, not subclassing.

#### Shared Agent Runtime Entity (has-a, not is-a)

`TeammateService` is a named agent entity with:

- an identity record
- an optional runtime (lazily started)
- a turns archive
- a `completionInput(envelope)` inbox (so it can be a delivery target) and
  per-turn registration with the router on `send`/`spawn` (so it can be a
  delivery source)

Dispatcher and team leader *contain* a `TeammateService` for their agent runtime needs, rather than *being* one. This avoids forcing dispatcher-specific concepts (channels, bindings, restart intent) into the teammate abstraction.

#### Completion Delivery (per-turn, in-memory registration)

Delivery is mediated by one per-dispatcher **`CompletionRouter`**. No entity
holds a reference to its delivery target — that is what breaks the
construction-time dependency cycle the review flagged. The router is constructed
first and injected; it holds no topology.

The model is **per-turn registration, entirely in-memory (never persisted):**

- A delivery-initiating action — `send` / `spawn` (and team-create-with-prompt)
  — registers an association `completionKey → initiator` with the router, where
  `completionKey` is `producerName:turnId`. The `initiator` is the caller (the
  dispatcher agent, or a team leader), known synchronously at call time from the
  caller principal.
- When that turn settles, the router takes the turn result, calls
  `initiator.completionInput(envelope)`, then clears the association.
- The key must include the **producer name**, not bare `turnId`: `turnId` is
  assigned per runtime and is **not** unique across a dispatcher's teammates,
  while the router is a single per-dispatcher instance — bare `turnId` would
  cross-wire two teammates' in-flight turns. This relies on teammate names
  staying **dispatcher-global**: `allocateName` (`teammate/service.ts`) checks
  the candidate against *all* of the dispatcher's identities regardless of team,
  so `producerName:turnId` is collision-free; the refactor must preserve this
  even as records move under `team/<team>/`. Keying by the per-turn id still
  makes steer correct with no extra logic:
  - multiple `send`s merged by the Agent Runtime into one turn (one `turnId`) →
    one registration → delivered **once**;
  - turns the model opens separately (no steer merge) → distinct `turnId`s →
    delivered per turn.
- Gating is intrinsic: only `send`/`spawn` register, so only send-initiated
  turns deliver. Channel inbound and remote-control turns never register →
  recorded but not pushed. Delivery therefore does **not** consult `turn_origin`.

`turn_origin` (`channel | dispatcher | team_leader`) stays a **persisted** field
serving `last` / `history` provenance only; it is fully decoupled from delivery.

**Settle-time concurrency.** When a turn settles, recording the settled turn and
routing the delivery are two independent lines run with `Promise.allSettled` —
the durable record is never gated by, or lost to, delivery. The submit row is
written at `send`; the settled row (with the result) at settle.

**At-most-once delivery.** A duplicate delivery is worse than a missed one (it
re-triggers the target's turn), so delivery is at-most-once. The idempotency +
retry policy lives in the `CompletionRouter` (the delivery service), **not** in
`TeammateService.completionInput` or the runtime — the router is the single
delivery chokepoint and applies one policy to every target (dispatcher and
leader alike); `completionInput` stays a thin forward into the runtime. The
router keeps a **terminal cache** of completion keys (`name:turnId`) that have
reached *any* terminal outcome — not only delivered ones — so a duplicate settle
never re-attempts. Policy:

- key already terminal, or an in-flight attempt for the same key → skip / coalesce;
- delivered (`accepted`) → record terminal;
- target not running / `unsupported` → drop **and record terminal** (no replay
  queue — a queued replay would surface later as a duplicate); the consumer falls
  back to `last` / pull;
- explicit `failed` (definitely not delivered) → bounded retry, then on
  exhaustion drop **and record terminal**;
- thrown error (ambiguous — may already have delivered) → drop **and record
  terminal**, do **not** retry.

Recording *every* terminal outcome (not only `accepted`) is the fix for the
current `DispatcherCompletionDelivery`, which remembers only on `accepted` and
would re-attempt on a duplicate settle after a drop.

Losing the in-memory registration on restart is therefore acceptable and even
preferred: we would rather miss than risk a post-restart duplicate; `last` is
the durable line. This is **not a new regression** — the current path has the
same property: a one-time `onTurnSettled` callback bound at runtime start does
not re-fire for turns that settled across a restart.

**Ordering invariant (trust principle).** The model relies on the runtime
returning a turn's `turnId` *before* that turn's settle callback fires
(`channelInput` returns on steer acceptance, well before the model produces
output). This is made an explicit `AgentRuntime` contract invariant with a
provider test; no pending-registration machinery is built. A genuinely null
`turnId` means there is nothing to deliver.

**Naming:** the registered target is the `deliverTarget` / `initiator` (a
dispatcher or leader). Do not conflate it with `CompletionEnvelope.source`,
which names the *producer* of the completion (the teammate).

#### Store Co-location

Stores are co-located with their owning collection, not floating as global singletons:

- `IdentityStore` + `TurnsStore` → inside each `TeammateCollection` instance (one
  per scope: the dispatcher-scope collection + each team's collection). They are
  stateless path-derivers, so per-instance copies share nothing but code.
- `TeamStore` → inside `TeamCollection`
- `ChannelBindingStore` and `WorktreeManager` → **one shared instance per
  dispatcher**, created by `DispatcherService` and injected into both the
  `TeamCollection` and every `TeammateCollection` (one store beats two);
  `WorktreeManager` is constrained to the dispatcher's cwd.

#### Target Class Diagram

```mermaid
classDiagram
    class Server {
        +getDispatcher(id) DispatcherService
    }
    class DispatcherCollection {
        +get(id) DispatcherService
        +startAllEnabled()
        +shutdown()
        +summarize()
    }
    class DispatcherService {
        +id
        +agent: TeammateService
        +teammates: TeammateCollection
        +teams: TeamCollection
        +channels: Map~string, ChannelSession~
        +bindings: ChannelBindingStore
        +start()
        +stop()
        +status()
        +invokeChannelTool()
        +routeChannelInput()
    }
    class TeamCollection {
        +create() TeamService
        +list() TeamService[]
        +get(id) TeamService
        -store: TeamStore
        -worktrees: WorktreeManager
    }
    class TeamService {
        +id
        +leader: TeammateService
        +members() TeammateService[]
        +record: TeamRecord
        +dissolve()
        +status()
        +bindChannel()
        +deliverToLeader()
        +sharedWorkspace()
    }
    class TeammateCollection {
        +spawn() TeammateService
        +list() TeammateService[]
        +get(name) TeammateService
        +last(name, query)
        -identityStore: AgentIdentityStore
        -worktrees: WorktreeManager
    }
    class TeammateService {
        +name
        +identity: TeamMateIdentity
        +runtime: AgentRuntime|null
        +send(prompt)
        +close(note)
        +status()
        +completionInput(envelope)
    }
    class ChannelBindingStore
    class TeamStore
    class AgentIdentityStore
    class WorktreeManager
    class CompletionDeliveryPolicy {
        +deliver(initiator, completion)
    }
    Server --> DispatcherCollection
    DispatcherCollection --> DispatcherService
    DispatcherService o-- TeammateService : has an agent
    DispatcherService o-- TeammateCollection : owns dispatcher-scope teammates
    DispatcherService o-- TeamCollection : owns teams
    DispatcherService o-- ChannelBindingStore
    TeamCollection o-- TeamService : get-or-rebuild (cached by team_id)
    TeamCollection o-- TeamStore
    TeamService o-- TeammateService : has a leader
    TeamService o-- TeammateCollection : owns members (team_id scope)
    TeammateCollection o-- TeammateService
    TeammateCollection o-- AgentIdentityStore
    TeammateCollection o-- WorktreeManager
    DispatcherService o-- CompletionDeliveryPolicy
    TeammateService ..> CompletionDeliveryPolicy : captured closure
```

#### State Directory Layout

The later
[entity-owned lifecycle decision](/.agents/tasks/architecture/service-topology-foundations/requirement.md#entity-owned-teammate-lifecycle-and-object-turns)
keeps the symmetric entity hierarchy but removes Dreamux Turn archives, rolling
conversation summaries, and the completion-router registry. Current
per-dispatcher state is:

```
state/<dispatcher-id>/
  identity.json            # dispatcher agent identity + runtime session association
  status.json              # dispatcher status — AUTHORITATIVE for rebuild/creation
  access.json              # access control
  chat-bots.json           # peer bot awareness
  channel-bindings.json    # channel bindings
  teammate/                # dispatcher-owned teammates
    <name>/
      identity.json        # identity/lifecycle/worktree/session facts
  team/
    <team-name>/           # one directory per team
      identity.json        # the team leader's identity/session facts
      record.json          # team record (members, bound channel, …)
      teammate/            # team-owned members
        <name>/
          identity.json
```

The layout is **fully symmetric**: every agent entity owns one `identity.json`,
and every agent that owns sub-teammates has a `teammate/<name>/` subdir beside
it. The directory tree mirrors the object model exactly — the dispatcher
agent's identity sits at the dispatcher root with a `teammate/` collection
beside it, and the team leader's identity sits at the team root with its own
member collection. A current-layout `turn.jsonl` left by an older release is
inert residue: Dreamux never creates, reads, validates, repairs, migrates, or
automatically deletes it.

`status.json` stays the **authoritative** dispatcher state for rebuild/creation.
The dispatcher agent's `identity.json` lives at the dispatcher *root* (not under
`teammate/`), so teammate read chokepoints never enumerate it. Likewise the team
leader lives at the team root, so listing a team's members scans only
`team/<team>/teammate/<name>/` and never includes the leader. The structure
itself enforces visibility.

#### Overall Hierarchy

```
Server (process-level · composition root)
  └── DispatcherCollection (process-level · thin collection + factory)
        └── DispatcherService (per-dispatcher)
              ├── dispatcher: TeammateService     # the dispatcher's own agent
              ├── teammates: TeammateCollection   # dispatcher-owned teammates
              ├── teams: TeamCollection           # team collection
              └── channelBindings: ChannelBindingStore
```

```
TeamCollection (per-dispatcher · get-or-rebuild factory, cached by team_id)
  └── TeamService (per-team · cached when live, rebuilt from disk otherwise)
        ├── teammates: TeammateCollection   # the team OWNS its members' collection (team_id scope)
        │     └── leader + members: TeammateService (live runtime cache)
        └── record: TeamRecord              # authoritative in-memory; all mutations route through here
```

**One `TeammateCollection` per scope — per team, plus one for the dispatcher.**
Each `TeammateCollection` is constructed with a fixed `teamScope: string | null`
(`null` = the dispatcher's own teammates; a `team_id` = that team's leader +
members). The scope is baked in, not threaded per call: `spawn` / `send` / `list`
/ `status` / `history` / `last` / `close` drop their `teamId` parameter and the
collection supplies its own scope to the (unchanged) stores and read model. This
is the intended encapsulation — a team *owns* its members, dissolve drops the
whole collection — and it is what the original design specified; a single shared
collection discriminated only by a `team_id` argument was an implementation
deviation and is rejected.

**Ownership / caching — the factory pattern (load-bearing).** `TeamService`
**owns** its per-team `TeammateCollection`; the collection is constructed by, and
held on, the `TeamService`. `TeamService` itself is obtained through a
*get-or-rebuild factory*: `TeamCollection.get(team_id)` returns the cached live
`TeamService` if one exists, else rebuilds it from the persisted `TeamRecord`
(its `TeammateCollection` then rebuilds member/leader entities from disk on access,
each runtime lazily resumed from `session_id` on the next `send` / channel inbound).
This is the **same factory every other level already uses** — `Dispatchers.get`
caches `DispatcherService`, `TeammateCollection.entityFor` caches `TeammateService`;
the former fresh-per-`get` `TeamService` was the odd one out and is conformed to
the pattern. It is safe because **the live in-memory cache and the host process
share one lifetime**: every Agent Runtime is a child of the dreamux process tree,
so a live runtime can never exist without its cache (host down ⇒ children dead),
and after a restart the whole tree rebuilds lazily from disk — the existing
revive-on-channel-inbound path for a team leader. This is the **universal
entity-materialization rule**, with no special-cased level: a `DispatcherService`
is rebuilt from its `status.json`, a `TeamService` from its team record, a
`TeammateService` from its `identity.json` — every level is the same
get-the-live-instance-or-rebuild-from-persisted-state factory, and the live cache
at each level is purely a within-process performance/identity cache, never the
source of truth.

What fresh-per-`get` used to buy (a held record never goes stale after dissolve)
is preserved by two invariants instead: (1) **every `TeamRecord` mutation routes
through the cached `TeamService`**, so its in-memory record stays authoritative;
(2) **`dissolve` evicts the team's cache entry** (after stopping its runtimes), so
a later `get` rebuilds from disk and reads `status: closed`. The dispatcher's own
(`teamScope: null`) collection is owned by `DispatcherService` the same way.

**Shared per-dispatcher singletons stay shared.** Every `TeammateCollection`
(dispatcher + per-team) is wired with the *same* per-dispatcher `CompletionRouter`,
`WorktreeManager`, and `initiatorFor` resolver. `TeamCollection` forwards these
into each `TeamService` it builds, which hands them to the team's collection. The
stores
(`IdentityStore` / `TurnsStore` / `TeammateReadModel`) are stateless path-derivers
(no in-memory cross-team index), so each collection holds its own instances; the
physical directory layout already partitions them by scope.

**Names stay dispatcher-global; the router key is unchanged.** `allocateName`
checks the candidate against `IdentityStore.listAllNames(dispatcherId)` — a blind
on-disk scan across *all* scopes (dispatcher teammates, every team's leader +
members) — regardless of which scope's collection allocates it. So
`producerName` is unique across the whole dispatcher and the `CompletionRouter`
key stays `producerName:turnId` with **no** `team_id` component. Team-local names
(which would require a `team_id:producerName:turnId` key) are deliberately **not**
introduced: no requirement asks for them, and adding scope to the router key is
complexity the per-team split does not need. This is an explicit decision, not an
oversight — see the delivery section's dispatcher-global-name invariant.

**Delivery topology stays in one place.** `initiatorFor(producer)` is resolved by
`DispatcherService` (a `team_member` → its team's leader `TeammateService`; a
dispatcher teammate or a leader → the dispatcher agent) and injected into every
collection. The per-team collections do not re-derive topology; they call the
single injected resolver, so the `CompletionRouter` remains the only topology-free
delivery chokepoint.

#### Module / Directory Layout (`src/service/`)

The top-level `src/dispatcher-service/` directory is **deleted**; the whole module
moves under `src/service/`. Rule: **one service class per file or directory; a
file holds at most one service class.** A class with helper functions gets a
directory whose `index.ts` is the class and whose siblings are its helpers
(`src/service/team-service/index.ts` = `TeamService`, helpers beside it). Shared
helpers used by more than one service get their own neutral directory. The
existing `team/service.ts` (which holds *two* classes, `TeamCollection` +
`TeamService`) is split.

```
src/service/
  index.ts                       # package-internal barrel (Dispatchers, DispatcherService, TeamService, ChannelToolAuthorizationError)
  dispatcher-workspace.ts        # issue #182 dispatcher-cwd policy (shared: server preflight, dispatcher service, doctor, worktree layer)
  dispatchers/
    index.ts                     # Dispatchers (process-level collection + factory)
  dispatcher-service/            # the per-dispatcher aggregate + its agent-side parts
    index.ts                     # DispatcherService
    agent.ts                     # createDispatcherAgent factory
    base-prompt.ts
    channel-sessions.ts          # ChannelSessions
    channel-tool-auth.ts
    mcp-descriptors.ts
    runnable-channel.ts
    errors.ts                    # ChannelToolAuthorizationError
  team-collection/
    index.ts                     # TeamCollection
    store.ts                     # TeamStore
    types.ts
    mcp-config.ts
  team-service/
    index.ts                     # TeamService (+ TeamChannelContext seam + view helpers)
  teammate-collection/
    index.ts                     # TeammateCollection
    identity-store.ts            # IdentityStore   (stores the collection owns)
    turns-store.ts               # TurnsStore
    read-model.ts                # TeammateReadModel
    name-allocator.ts
    runtime-state.ts
    agent-config.ts
    mcp-config.ts
    types.ts                     # teammate domain types (shared by service + read-model)
  teammate-service/
    index.ts                     # TeammateService
    turn-recording.ts            # settle/turn capture helper
  completion-router/
    index.ts                     # CompletionRouter
  worktree/                      # shared by team-collection + teammate-collection
    manager.ts                   # WorktreeManager
    paths.ts
    workspaces.ts
  channel-binding/
    store.ts                     # ChannelBindingStore
  legacy-state.ts                # shared legacy-state detection (fail-loud)
```

The names above (`dispatcher-service/`, `team-collection/`, …) follow the user's
`team-service/index.ts` convention and can be renamed without affecting the
design; only the one-class-per-file rule and the deletion of the top-level
`dispatcher-service/` are load-bearing. Cross-cutting helpers (`worktree/`,
`channel-binding/`, `legacy-state.ts`, `dispatcher-workspace.ts`) live at the
`service/` root because no single service owns them — e.g. the dispatcher-cwd
policy is consumed by `server.ts` startup, the dispatcher service, `dreamux
doctor`, and the `worktree/` layer, so the `worktree/` helper must not reach up
into `dispatcher-service/` for it. The restructure is a **pure mechanical move** (`git mv`
+ import-path fixups + a `tsc` green gate), done as a separate commit *after* the
per-team semantic change so the two diffs stay reviewable.

#### Lifecycle Management

No IOC container. Constructor injection + factory functions:

- **Process-level** (created at startup, destroyed at exit): config, logger, provider catalogs, `DispatcherCollection`
- **Per-dispatcher** (lazy-created on first `get()`, cached): `DispatcherService`, `TeammateCollection` (dispatcher scope), `TeamCollection`, `ChannelBindingStore`, `WorktreeManager`
- **Per-team** (lazy-created on first `get()`, cached): `TeamService`, `TeammateCollection` (team scope)
- **Per-teammate** (created by `get()`, cached): `TeammateService`; runtime starts lazily on send/spawn

#### Admin / MCP Protocol

Admin socket methods and parameters can change freely — all consumers are within the dreamux codebase (MCP shims, CLI commands, doctor). Optimize for clean architecture, not backward compatibility.

#### Global Operations & Shutdown

`LiveTeamMateRegistry` is removed; there is no process-wide flat index of live
runtimes. Global operations — `stopAll` (server shutdown) and `doctor` — are
CLI- / server-lifecycle-level capabilities, **not** exposed on the MCP surface,
so they are infrequent and need no O(1) index. They traverse the **live cache**
on demand: `DispatcherService` stops its own (`teamScope: null`)
`TeammateCollection`, then asks `TeamCollection` to stop each *currently
materialized* `TeamService` — each stops its own `TeammateCollection` (members)
and leader. Only cached `TeamService`s are swept: a team never accessed this
process run holds no live runtime (live cache ≡ process lifetime), so `stopAll`
must **not** read the durable store to rebuild-and-stop, and must not lazily start
a not-yet-running runtime. Stop order is preserved: all teammate runtimes (direct
+ team members + leaders) before the dispatcher agent. A per-dispatcher flat live
index was rejected — it would force threading the index down through every
collection's create/close path, which the cache traversal
(`TeammateCollection.stopAll()` + `TeamCollection.stopAll()` over cached teams)
avoids.

Shutdown is best-effort and assumes no new `spawn`/`send` during teardown; a
`shuttingDown` flag on `DispatcherService` that rejects new lifecycle calls
closes the traversal-window race.

### Consequences

- `TeamManager` is removed; its responsibilities split between `TeamCollection` and `TeamService`.
- `TeamMateAgentService` is split into `TeammateCollection` + `TeammateService` entities.
- `LiveTeamMateRegistry` is removed (in Phase 1); each `TeammateService` manages its own runtime and global ops traverse the trees.
- Runtime lifecycle logic is shared via `TeammateService` entity (used by dispatcher, team leader, and regular teammates).
- `DispatcherService` has-a `TeammateService` for its agent runtime (not is-a).
- Completion delivery uses a per-dispatcher, per-turn in-memory `CompletionRouter` (register on `send`/`spawn`, deliver to the initiator on settle, then clear), decoupled from the persisted `turn_origin`. No entity references its delivery target, which breaks the construction cycle.
- State directory layout changes; old layouts fail-loud with a rebuild hint (0.x policy, no migration).
- Admin method signatures change to match the new service shape.
- Collections are no longer process-wide singletons: each dispatcher owns one
  dispatcher-scope `TeammateCollection` plus one `TeammateCollection` per team
  (owned by that team's `TeamService`), all within the per-dispatcher
  `DispatcherService` aggregate. The shared stores (`WorktreeManager`,
  `ChannelBindingStore`) are one-per-dispatcher, injected into both collections.

### Rollout Plan

Five phases, ordered for implementation. Phases 1-3 restructure the code without
changing behavior; phases 4-5 introduce the shared agent model. This is **not** a
production rollback plan: the refactor does not merge to a stable branch until
tests pass, so there is no upgrade/back-compat or lossless-rollback constraint —
old state layouts fail loud and the accepted recovery is delete-config-and-reinstall
(0.x policy). A Rush change ships at merge time for the changelog only.

#### Phase 1: Collection + Service layering & naming alignment

Establish the Collection + Service pattern; eliminate `TeamManager`.

- Introduce `TeamCollection` (split out of `TeamManager`)
- Introduce `TeammateCollection` (split out of `TeamMateAgentService`)
- `TeamService` entity-ify (holds its own record)
- `TeammateService` entity-ify (holds its own identity)
- Remove `TeamManager` (responsibilities migrate to TeamCollection + TeamService)
- Rename `TeamMateAgentService` → `TeammateCollection`
- Update admin method call paths
- Extract `CompletionRouter` as a standalone, tested module
- Remove `LiveTeamMateRegistry` — each `TeammateService` owns its runtime; its name-lookup use is obviated by the per-turn router, and global ops traverse the trees instead

#### Phase 2: Store co-location & directory restructure

Move stores into their collections; reorganize state directories.

- `TeamStore` → inside `TeamCollection`
- `TeamMateIdentityStore` / `TeamMateTurnsStore` → inside `TeammateCollection`
- `ChannelBindingStore` → inside `DispatcherService`
- Restructure state directories (per new layout)
- Add legacy state detection (fail-loud, no migration)
- Update `paths.ts`

#### Phase 3: Ownership sinking

Collections go from process-level to per-dispatcher.

- `TeammateCollection` becomes per-scope (no longer a process-wide singleton):
  one dispatcher-scope instance + one per team
- `TeamCollection` becomes per-dispatcher
- `WorktreeManager` becomes per-dispatcher (cwd-constrained)
- `ChannelBindingStore` becomes per-dispatcher
- Add concurrency guards (startingPromise / `dedupe` pattern) on the **async**
  lazy creation points — those with an `await` between the cache check and the
  cache set (`DispatcherService.start`, `TeamCollection.get` / `create`).
  `Dispatchers.get` is **synchronous** (no await between check and set), so the
  single-threaded event loop cannot interleave two calls and it needs no guard —
  adding one would be dead code, not a missing invariant.

#### Phase 4: Team leader → TeammateService

Team leader explicitly uses `TeammateService` entity (medium risk — leader is already a special teammate).

- Team leader creation flows through the same `TeammateService` entity as regular members
- Unify leader turn recording with teammate turn recording
- Team leader delivery flows through the same `CompletionRouter`: a dispatcher→leader `send` (and a create that supplies an explicit `prompt`) registers `leaderName:turnId → dispatcher`, and a leader→member `send` registers `memberName:turnId → leader` (a prompt-less create fires no first turn, so it registers nothing)

#### Phase 5: Dispatcher agent → TeammateService

Dispatcher's agent runtime uses `TeammateService` entity (highest risk, last).

- `DispatcherService.agent` becomes a `TeammateService` instance
- Shared runtime lifecycle logic lives in `TeammateService`
- Unified completion delivery path
- (`LiveTeamMateRegistry` already removed in Phase 1)
- `DispatcherRuntimeService` → removed; responsibilities split as below

| `DispatcherRuntimeService` responsibility | Lands in |
|---|---|
| agent runtime lifecycle (start/resume/stop) | `TeammateService` |
| channel sessions (`Map<channel_id, ChannelSession>`) | `DispatcherService` |
| restart-intent injection | `DispatcherService` (post `agent.start()` hook) |
| dispatcher role MCP descriptor assembly | `DispatcherService` (injected mcpServers factory) |
| completion delivery | `CompletionRouter` |

The channel-session-after-runtime-start ordering (slot registered before session
start) must be preserved across the split.

---

## entity-owned-teammate-lifecycle-and-object-turns

## Entity-owned TeamMate lifecycle and object Turns

- **Status:** Accepted and implemented; the object-turn settlement clause is
  superseded by [provider-completion-token-routing](/.agents/tasks/completion-routing/adopt-completion-token-routing/accepted-decision.md),
  and the no-Channel-turn-events clause is superseded by
  [feishu-cot-conversation-display](/.agents/tasks/channel/feishu-cot-conversation-cards/accepted-decision.md)
- **Date:** 2026-08-16
- **Affects:** `@excitedjs/dreamux-types`,
  `@excitedjs/agent-runtime-codex`,
  `@excitedjs/agent-runtime-claude-code`,
  `/packages/dreamux/src/service/agent-entity/`,
  `/packages/dreamux/src/service/teammate-service/`,
  `/packages/dreamux/src/service/teammate-collection/`,
  `/packages/dreamux/src/service/workflow-service/`,
  Team dissolve, dispatcher shutdown, and completion delivery
- **PR / Issue:** [Issue #337](https://github.com/excitedjs/dreamux/issues/337);
  [development task](/.agents/tasks/workflow/unified-teammate-lifecycle/README.md)

### Context

Workflow-created agents were durable TeamMates but did not use one TeamMate
lifecycle. Workflow borrowed Collection-owned ownership tokens and bulk release
verbs, while shutdown had separate runtime sweeps. Completion routing also
reconstructed process-local relationships from provider or host Turn ids through
a dispatcher-wide registry.

Those shapes gave observers and containers command responsibility for an entity
they did not own. They also made close ordering depend on callbacks and lookup
maps, so a never-settling Turn, a late provider admission, or a cold cache could
leave Workflow, Team dissolve, or server shutdown reporting success before the
durable TeamMate lifecycle converged.

### Decision

`TeammateService` is the sole owner of one TeamMate's mutation admission, lock,
runtime authority, in-process Turn objects, terminal outcome/delivery, close
single-flight, and committed retirement fact.

- `TeammateService.lock()` returns one restricted handle. Workflow holds that
  handle, submits and closes through it, and unlocks only after the matching
  terminal journal and Workflow record commit.
- `close()` never unlocks. A closed locked entity stays cached and cannot reopen.
  Unlock retires a durably closed entity and publishes the post-commit close fact;
  `TeammateCollection` reacts only by removing its own exact cached reference.
- `TeammateCollection` owns scoped construction, canonical per-name
  materialization, cache subscription, roster queries, and reads. It owns no
  close algorithm, membership registry, bulk release, or runtime shutdown sweep.
- Team dissolve and process shutdown materialize every durable non-closed entity
  and invoke the same entity close contract. They stop Workflows before ordinary
  writers and close entities before draining work that can depend on closure.

One accepted logical input is represented by one `RuntimeTurn` object from the
provider and one `Turn` object owned by the entity.

- Folds return the exact same object. Workflow retains the object directly.
- The first terminal outcome is snapshotted and wins one object-owned latch.
- Dreamux persists no Turn archive or rolling conversation projection. Public
  service receipts, Workflow records, and identity state carry no Turn id merely
  to reconstruct an in-process relationship. The later display-only Channel
  event surface carries a process-local turn id solely for presentation
  correlation.
- Completion delivery is a closure captured by the initiating action. It runs
  after the outcome latch wins through one stateless, deadline-bounded policy.
  Only provider-proven pre-admission failure may retry; ambiguous or
  post-admission failure is terminal.
- Provider-native ids remain private implementation details inside provider
  packages.
- The selected runtime checkpoint persists the provider-native session id plus
  an optional opaque transcript locator. `last` delegates a bounded cold read to
  the selected provider without materializing an entity, starting a runtime, or
  storing transcript content/cursors in Dreamux.

The neutral runtime contract therefore distinguishes `failed` from `ambiguous`
admission and requires `AgentRuntime.stop()` to fence new input synchronously and
drain every already-started admission before resolving. A stopped runtime cannot
later return a newly accepted `RuntimeTurn`.

### Consequences

- Workflow stop is a truthful terminal barrier: runner termination,
  materialization join, member close, Agent result convergence, terminal journal
  and record persistence, unlock, and bounded terminal delivery complete before
  success returns.
- `teammate_close`, Workflow stop, Team dissolve, and server shutdown share one
  TeamMate close meaning. There is no raw-runtime success path.
- Cold-cache shutdown is intentionally allowed to perform canonical
  materialization before close. Collection materialization is a query/factory
  capability; lifecycle callers still issue entity commands.
- Existing per-entity `turn.jsonl` files are inert residue from an older
  implementation. Dreamux never creates, opens, stats, lists, validates,
  repairs, migrates, warns about, or automatically deletes them; their
  condition cannot block startup, reads, lifecycle operations, Workflow, Team
  dissolve, or shutdown.
- `identity.json` remains identity/lifecycle/runtime-session state and contains
  no `turn_count`, `last_seen_at`, or prompt/assistant previews. Existing copies
  of those keys are ignored and disappear on a later ordinary rewrite.
- Direct TeamMate `spawn` and `send` receipts expose the validated native
  transcript path when a runtime session association exists. Other public
  surfaces, logs, and events do not. `last` returns provider-neutral bounded
  message/tool blocks and opaque pagination cursors from the native transcript.
- External Agent Runtime providers must implement object Turns, conservative
  admission classification, stop-time admission convergence, and the neutral
  cold transcript read contract.
- Architecture gates prohibit the removed ownership verbs, service receipt Turn
  ids, reverse lookup registries, and runtime-only shutdown paths. The only
  Channel Turn event exception is the live, display-only conversation surface
  recorded in
  [Feishu COT conversation display](/.agents/tasks/channel/feishu-cot-conversation-cards/accepted-decision.md).

### Alternatives Considered

- **Collection-owned claims, command adapters, or Workflow ports.** Rejected:
  they split one entity fact across extra roles and keep an observer or
  bookkeeping owner in the command path.
- **Provider or host Turn ids plus lookup maps.** Rejected: every required
  relationship is process-local and can be retained directly by object or
  closure. Native ids are still free to exist inside a provider adapter.
- **Runtime-only shutdown sweeps.** Rejected: runtime termination without
  terminal Turn and durable identity convergence is not successful TeamMate
  close.
- **Grace periods, replay, durable cross-daemon leases, or a general JSONL repair
  engine.** Rejected for this decision: they solve different recovery problems
  and are not required for owner-correct lifecycle convergence.

---

## json-document-store

## Shared base store for versioned JSON documents

- **Status:** Accepted (design); implementation pending
- **Date:** 2026-06-24
- **Affects:** `/packages/dreamux/src/state/`,
  `/packages/dreamux/src/service/channel-binding/`,
  `/packages/dreamux/src/service/team-collection/`,
  `/packages/dreamux/src/service/teammate-collection/`,
  `/packages/dreamux/src/platform/`; any new durable single-document store
- **PR / Issue:** surfaced by the scheduled-tasks design
  ([archived scheduled-tasks proposal](/.agents/archive/proposals/scheduled-tasks.md))

### Context

Adding a `cron-jobs.json` store for scheduled tasks would have been the fifth
copy of the same persistence pattern. Every durable single-document store in
core re-implements it by hand: `readFile` → `isNotFound ⇒ default` →
`JSON.parse` → `version` envelope check → field validation → write =
`mkdir -p` + serialize + (atomic) write + trailing newline.

The duplication has already produced a latent inconsistency: `DispatcherStore`
writes **non-atomically** (`state/dispatcher-store.ts` uses plain `writeFile`),
leaving a torn-write window the other three stores avoid via
`writeFileAtomic`. The corrupt/version policy also drifts per store (warn +
rebuild vs `LegacyStateError` fail-loud). This is exactly the "stitch each case
by hand" glue the repo `CLAUDE.md` "Architecture Discipline" rule targets:
prefer a capability over a re-solved special case.

### Decision

Extract a neutral base — `JsonDocumentStore<TDoc>` in
`/packages/dreamux/src/platform/` (next to `atomic-write.ts` and `fs-errors.ts`,
the existing infra home) — that owns the single versioned-JSON-document
read/write contract, and build new stores on it. Shape:

```ts
class JsonDocumentStore<TDoc> {
  constructor(opts: {
    version: number;
    parse(raw: unknown, ctx: { path: string }): TDoc; // validate; throw on bad shape
    empty(): TDoc;                                     // value when file is absent
    corruptPolicy?: 'fail-loud' | 'warn-rebuild';      // default 'fail-loud'
  });
  read(path: string): Promise<TDoc>;
  write(path: string, doc: TDoc): Promise<void>; // mkdir -p → writeFileAtomic → pretty JSON + "\n" + mode 0600
  assertCurrent(path: string): Promise<void>;    // startup/doctor fail-loud probe
}
```

- The **path stays caller-supplied** (argument), so `platform/paths.ts` remains
  the sole path builder and the base never names a path or a provider field — it
  is pure runtime-neutral infrastructure (principle, not shape).
- Each concrete store keeps its domain methods (`bind`/`resolve`/`list`/…) and
  supplies `version` + `parse` + `empty`.

**Scope boundary (what the base does NOT absorb):**
- The append-only JSONL log (`teammate-collection/turns-store.ts`) — different
  access pattern (append, skip-corrupt-line, streaming read).
- Directory-of-entities blind-scan *listing* (`identity-store.ts`) — only the
  per-document read/write is unified; the dir scan stays in the concrete store.

**Sequencing:** introduce `JsonDocumentStore` carrying `CronJobStore` first;
migrate the four existing stores (`DispatcherStore`, `ChannelBindingStore`,
`TeamStore`, `TeamMateIdentityStore`) onto it in a separate
behavior-preserving PR so the feature and the cross-cutting refactor review
apart. The migration also fixes the non-atomic `DispatcherStore` write.

### Consequences

- **Enforcement / guards:** the base should ship with an executable contract
  test (round-trip, missing-file ⇒ empty, malformed ⇒ policy) mirroring the
  `no-sync-io-gate.test.ts` style. Migrations are behavior-preserving and must
  keep each store's existing version/policy semantics.
- **0.x no-migration policy holds:** `corruptPolicy: 'fail-loud'` is the default
  to match the repo's "old state fails loud, never migrated" rule; a store that
  intentionally rebuilds (recovery state, e.g. dispatcher status) opts into
  `'warn-rebuild'` explicitly.
- **Foot-gun:** the base unifies *mechanism*, not *schema*. Each store still
  owns its `version` and validation; bumping a store's schema is still that
  store's concern and still needs its own fail-loud/rebuild handling.
- **Refactor-robust scoping:** the base is keyed on a behavior (single versioned
  JSON document), not on the current set of stores, so new stores adopt it
  without touching the base.

### Alternatives considered

- **Copy the pattern a fifth time for cron.** Rejected — it is the glue the
  discipline rule forbids and would entrench the atomic-write inconsistency.
- **Base-first big-bang refactor of all stores before cron.** Rejected for
  sequencing only — larger blast radius on settled code; do it as a follow-up
  behavior-preserving PR instead.

### Since this was recorded (2026-09-01)

Implemented: `/packages/dreamux/src/platform/json-document-store.ts` exists and the scheduler store builds on it (`/packages/dreamux/src/service/scheduler/store.ts`). The record's Affects path `src/state/` is now `src/platform/`.

