# Data-flow ownership proposal (MiMo)

Scope: the complete inter-component data flow of core services, the two runtime
providers, and the Feishu channel, per
[the continuation requirement](../../../artifacts/data-flow-follow-up.md) and
R71 ("要做就要做到彻底，然后整个数据流这块用闭包是一个非常愚蠢的方案").
Baseline: post-PR #457 source on `refactor/data-flow-ownership-453`. This is an
independent first-round proposal; no other proposal was read.

## 0. Verdict in one page

The current data flow moves four kinds of cross-object knowledge as
function-valued construction fields: **fact publication** (`onPersisted` and
its twelve threading sites), **completion recipients** (`initiatorFor`,
`leaderCompletionInitiator`, `completionInitiator`, plus the per-turn
`deliverCompletion` closures), **admission fencing** (`admitOperation`,
`isClosing`, `accepting`, hand-composed three times inside `TeamService`'s
constructor), and **owner assembly** (`leaderMcp`, `mcp`,
`applyCreateTeamHook`, `announceTeam`, `submitScheduled`, the
`findManagedWorktreeOwner` chain). The design below replaces each with the
thing that already owns the fact or the operation: an event emitter on the
identity store tier, the owner object as the completion recipient, one
admission-gate capability both fence owners already implement, and direct
collaborator calls on objects that already exist. What remains as functions is
(1) genuine call-time input at construction seams (`AgentEntityOptions`, the
per-Team MCP surface, the cron MCP delegate's per-call owner resolution,
`scheduler.submitScheduled` as a named owner port), (2) external
protocol/library boundaries (tapable hooks, the forked-workflow runner IPC,
the channel `JsonInvoker` port), and (3) pure test seams with zero producers —
which are deleted, not kept as decoration.

Structural result: `AgentEntityCallbacks`, the `onPersisted` parameter on
`AgentIdentityStore.create/update/upsert`, `AgentRuntimeStateStore`'s
publication knowledge, the factory's per-call callback field, two hook-wrapper
closures, three fence-composition closures, four recipient-factory closures,
two MCP-supplier closures, and both provider option bags (plus
`CreateFeishuBotDeps`) disappear. Nothing user-visible changes. Exactly one
item needs an operator word (§10): the published-package API contraction.

## 1. Ownership model

Four rules decide every seam. They are the greenfield model; §2 compares it to
the existing object graph.

1. **Facts are published by their durable owner at commit time and observed by
   holders.** The module that writes `identity.json` publishes the identity
   fact; a Team's roster, the dispatcher's `teammate.state`/`team.state`
   output, and any future holder subscribe. No write-path parameter carries a
   caller's reaction down through intermediate layers.
2. **Queries and operations have an explicit authoritative owner and a direct
   collaboration boundary.** A consumer holds a reference to the object that
   answers the query or performs the operation — or to a port that owner
   implements with its own behavior — and calls it. A bound lambda over the
   owner's internals, threaded through a third object, is not a boundary.
3. **Values are fixed at construction; functions survive only for real
   call-time input or an external boundary.** A field that closes over
   construction context and forwards it (`(x) => this.f(x)`,
   `() => this.thing`) is deleted in favor of the captured thing itself.
4. **The wrapper test.** A retained function-valued seam must name a real
   consumer and show why the owner cannot provide the capability directly. A
   "port" whose only body is `(...) => captured(...)` is the banned one-method
   wrapper in new clothes and is rejected; a port whose implementers add their
   own behavior (fencing, status transitions, role derivation, persistence) is
   the codebase's existing port idiom (`TeamsPort`, `TeammateOps`,
   `SchedulerCommands`, `RestartIntentConsumer`) and is accepted.

Ownership after the change (bold = changed owner):

| Fact / capability | Owner | Reached by |
|---|---|---|
| `identity.json` and its committed transitions | agent store tier (`AgentIdentityStore`) | **emits on the scope's `AgentIdentityEvents`;** `readAgentIdentity()` for snapshots |
| Team roster + `team.state`/`teammate.state` composition (role, teamName) | `TeamService` | its emitter listener (members + leader alike) |
| dispatcher `teammate.state` composition (role `dispatcher`/`teammate`) | `DispatcherService` | its emitter listener |
| completion recipient for an owner's children | the owner object itself as `CompletionInitiator` (`TeamService`, `DispatcherAgent`, `AgentService`) | held as a value by collections / workflows / turns |
| completion transport (dedupe, FIFO, retries, scope fence) | `CompletionDeliveryPolicy` (unchanged) | held as a value; `accepting` reads the gate |
| admission fence | `DispatcherLifecycle` / `TeamService`, surfaced as one `AdmissionGate` | composed once per Team (`nestedAdmissionGates(team, dispatcher)`) and passed by value |
| sibling managed-worktree occupancy | agent store tier (pure read over the collection root) | collection-root value on the entity binding |
| role→MCP-delegate assembly | **`DispatcherMcpAssembly`** (the current `mcp-delegates.ts` given its fixed context once) | held by `DispatcherAgent` / `TeamService` |
| plugin hook objects | `DispatcherService.hooks` | hook objects passed down uniformly |
| cron fires | `SchedulerService` | `SchedulerPromptSink` port, implemented by the owner |
| workflow agent materialization | `TeammateCollection` via `WorkflowTeammateFactory` (unchanged shape) | object collaborator |

## 2. Greenfield comparison

Greenfield, from the user story (a durable owner commits facts; live entities
operate; holders observe; callers call owners): identity writes would publish a
transition stream at commit; every entity would know its completion recipient
as "my owner"; one gate object would fence every child; MCP surfaces, hook
firings, and cron submissions would be calls on named owners. Nothing in the
greenfield needs a per-write callback, a recipient factory, or a fence
lambda — the current code only has those because the per-dispatcher
`AgentServiceFactory` serves three owner shapes and the original authors
threaded behavior instead of references.

| Relationship | Current shape | Greenfield shape | Disposition |
|---|---|---|---|
| identity write → owner reaction | `onPersisted` param threaded factory → service → runtime-state → store, plus a collection-bound twin and `closeUnbuilt` special path | store tier emits on a scope-owned emitter | **replace** (operator-named EventEmitter direction) |
| turn/workflow completion → recipient | per-call closure factory (`initiatorFor`, `leaderCompletionInitiator`), per-turn `deliverCompletion` closure | owner object implements `CompletionInitiator`; policy + recipient held as values | **replace** (R18 already proved the destination is fixed for life) |
| child verb → owner fence | `admit`/`isClosing`/`accepting` closures, triple hand-composition in `TeamService` | one `AdmissionGate` value, composed once | **replace** (foundational capability; both owners already have the two methods) |
| leader/agent MCP surface | `mcp: () => …`, `leaderMcp(input) => …` closures over dispatcher internals | `DispatcherMcpAssembly` object with its fixed context | **replace** (assembly module becomes the owner it already is) |
| `createTeam`/`team` hook firing | `applyCreateTeamHook`/`announceTeam` wrappers; `teammateLaunch` passes the object | pass the hook objects uniformly | **replace** (uniform with the existing object path; R8/R52 untouched) |
| reopen workspace sibling check | `findManagedWorktreeOwner` closure ×5 sites | store-tier query over the collection root value | **replace** (the function wraps a pure identity read) |
| codex socket / claude bin | `allocateSocketPath` closure over `paths` already in deps; `resolveBinPath` called once | direct call in runtime; bin resolved in `createRuntime` like codex's | **replace** (nothing deferred survives) |
| entity role options | `AgentEntityOptions: (identity) => …` | same: options derive from the just-written identity | **retain** (real deferred computation: the identity does not exist before the write commits, and a launch-tap failure must leave the identity durable) |
| cron MCP delegate owner resolution | `scheduler: () => …`, `team: () => …` thunks | per-call resolution behind the Team's open/fence | **retain** (call-time state; value does not exist at assembly) |
| cron fire → owner's agent | `submitScheduled` closure | `SchedulerPromptSink` implemented by the owner | **replace closure, retain one port** (implementers add fence + status transition; not a wrapper) |
| feishu session → children | bags of bound session methods (`notify`/`submit`/`deliver`/`announce`/`cotClient`/`invoke`) | each child holds the collaborator that owns the capability; the session's own port for Core invoke | **replace wrappers, retain the external `JsonInvoker` seam** (§3 group F) |
| provider/bot factory options | `codexProcessFactory`, `codexClientFactory`, `restartBackoff*`, `resolveBinPath`, `sessionFactory`, `CreateFeishuBotDeps.createTransport`, `botFactory` | none — construct the real thing | **delete** (zero producers anywhere, including tests) |
| test seams (`now`, `generateRunId`, `createRunner`, `attemptTimeoutMs`, `SuffixGenerator`) | optional fields, zero suppliers | none until a test exists | **delete** (no mechanism without a named scenario; final coverage re-adds on demand) |
| tapable hooks, workflow-runner IPC, `ChannelCorePort`/`JsonInvoker`, `AgentRuntimeStateSink`/`ActivitySink` | functions | functions | **retain** (external library/protocol boundaries) |

What the greenfield does *not* buy and this proposal therefore does not do: no
global event bus between the sides (the emitter is scope-owned, one holder, no
filtering); no event replay or subscription registry (initial state is an
ordinary read); no new wrapper classes around single lambdas; no change to the
`createLocked` admission asymmetry (explicitly deferred in the previous
follow-up).

## 3. Producer/consumer inventory

Every function-valued construction seam found in the sweep, grouped by
disposition. "Captures" lists what the function smuggles across the seam.

### A. Fact publication — replaced by `AgentIdentityEvents`

| Seam (sites) | Producer → consumer (captures) | Capability | Disposition |
|---|---|---|---|
| `TeammateServiceDeps.onPersisted` (`service-types.ts`) | Team/Dispatcher/Collection → `AgentService` → `AgentRuntimeStateStore` → `AgentIdentityStore` (owner's publish method) | notify owner of create/upsert/status-change | delete; store tier emits |
| `AgentIdentityStore.create/update/upsert(..., onPersisted)` + `afterIdentityStatusChange` (`store.ts`) | same chain (4 layers of forwarding) | same | delete parameter; filter stays inside the store as the emit condition |
| `AgentEntityCollectionStore.onPersisted` + `closeUnbuilt` threading (`store.ts`) | TeammateCollection → transient member stores | publish record-only close | delete field; the store binding carries the emitter |
| `AgentEntityCallbacks` + factory `create/open/upsert` callback fields (`factory.ts`) | caller → factory → build() | same | delete the type entirely |
| `TeammateCollectionOptions.onPersisted` (`agent/index.ts`, 3 wrapper arrows) | owner → collection → store | same | replaced by `events` value |
| `TeamLeaderOpenDeps.onPersisted` + `leaderAgentBase()` arrow (`team/leader.ts`, `team/service.ts`) | TeamService → leader factory call | same | replaced by `events` value |
| `DispatcherAgentOptions.onPersisted` + `onDispatcherAgentPersisted` (`dispatcher-service/`) | DispatcherService → agent upsert | same | replaced by `events` value |

### B. Completion routing — recipient becomes the owner object; destination becomes values

| Seam | Producer → consumer (captures) | Capability | Disposition |
|---|---|---|---|
| `TeammateCollectionOptions.initiatorFor` | owner → collection → per-submission closure → turn | where this collection's completions land | `completionRecipient: CompletionInitiator` value (owner passes itself) |
| `TeamCollectionOptions.leaderCompletionInitiator` | DispatcherService → TeamCollection/TeamService | where a TeamLeader's completions land | `leaderCompletionRecipient: CompletionInitiator` (= `dispatcherAgent`) value |
| `TeamService.leaderCompletionInitiator()` factory | TeamService (admit fence + unavailable→unsupported mapping + `leaderRecipientKey`) | the Team's leader as recipient | `TeamService implements CompletionInitiator` (same body, one method + `recipientKey` field) |
| `WorkflowServiceOptions.completionInitiator` | owner → service → run-create capture | run's terminal recipient | value (`this` / `dispatcherAgent`); run holds it |
| `WorkflowRunDeps.deliverTerminal` | WorkflowService → run (policy + initiator) | report the run's terminal fact | run holds `completionDelivery` + `completionInitiator` values and calls `deliver(initiator, fact)` under its existing owed check |
| `TurnCompletionDelivery` / `deliveryClosure` + `AgentService.send`'s `resolveCompletionDelivery` | collection/team → turn (policy + recipient) | deliver one settled turn | turn holds its owner (`EntityTurnOwner`: owed + deliver); `AgentService` binds the policy (dispatcher-shared, like `admissions`) and each submission carries `deliverCompletionTo?: CompletionInitiator` as a value |
| `TeamService.submitToLeader`'s inline `(completion, fact) => …deliverRuntime(...)` | same | same | same |
| `CompletionDeliveryPolicy.deps.accepting` | DispatcherService (`() => !this.inputSources.isClosing()`) | read the dispatcher fence per delivery | policy holds the `AdmissionGate` and reads `gate.isClosing()` |

Rationale: R18's open item already proved one recipient per entity for life
and one `initiatorFor` definition per owner; the factories exist only to defer
what is already fixed, and the per-turn closures only to re-bind it.

### C. Admission fencing — one `AdmissionGate` capability

| Seam | Producer → consumer (captures) | Capability | Disposition |
|---|---|---|---|
| `TeammateCollectionOptions.admitOperation` / `isClosing` | dispatcher: `admitOperation`+`isClosing`; team: hand-composed `(task) => this.admit(() => deps.admitOperation(task))` and `() => this.isClosing() \|\| deps.isClosing()` | fence every verb and every construction | `gate: AdmissionGate` value; Team's composition is `nestedAdmissionGates(this, deps.gate)` |
| `TeamCollectionOptions.admitOperation` / `isClosing` | DispatcherService arrows | same | same |
| `WorkflowServiceOptions.admit`, `SchedulerServiceOptions.admit` | owner arrows (team: composed) | same | same |
| `channels.mcpDelegates(caller, (task) => dispatcher.admitOperation(task))` / `runForLeader` arrows in `mcp-delegates.ts` | dispatcher | fence a channel tool call | the assembly holds the gate; the one `runForLeader` call stays (it enters the Team by name — a real per-call operation of `TeamsPort`) |

`AdmissionGate` is two methods — `admit<T>(task)`, `isClosing(): boolean` —
structurally already implemented by `DispatcherLifecycle` and `TeamService`.
The combinator (a ~15-line `nestedAdmissionGates` beside
`platform/in-flight-work.ts`) replaces the three copy-pasted composition
closures in `TeamService`'s constructor and re-states the "outer fence first"
order in one place. This is the whitepaper's capability-over-special-case rule
applied to the fence every child already documents it takes "at construction".

### D. Owner assembly (MCP, hooks, cron, occupancy)

| Seam | Producer → consumer (captures) | Capability | Disposition |
|---|---|---|---|
| `DispatcherAgentOptions.mcp: () => TeammateAgentMcp` | DispatcherService (leases, adminSocket, `this`, channels) | the dispatcher agent's tool surface | value after reordering construction (dispatcherAgent after `_teams`); or `mcpAssembly.forDispatcherAgent()` if delegate internals still need call-time reads |
| `TeamLeaderOpenDeps.leaderMcp(input) => TeammateAgentMcp` | same, + teamId/leaderName | a leader's tool surface | `mcpAssembly: DispatcherMcpAssembly` collaborator; `teamLeaderOptions` calls `mcpAssembly.forTeamLeader({teamId, leaderName})` (leaderName is genuine call-time input — the identity write allocates it) |
| `createCronMcpDelegate({ scheduler: () => … })`, `createTeamMateMcpDelegate({ team: () => … })` | `mcp-delegates.ts` (wraps `TeamsPort`/`scheduler` getter) | resolve the owner per tool call | **retain** the thunks (call-time: a Team's scheduler/leaderScope live behind the Team's own open+fence); delete the dispatcher-case's `async () => input.dispatcher.scheduler` in favor of a resolved value only if the two shapes can merge without a discriminant — otherwise retain both as one shape |
| `TeamCollectionOptions.applyCreateTeamHook` / `announceTeam` | DispatcherService arrows over `this.hooks.createTeam` / `this.hooks.team` | fire the plugin hooks | pass the hook objects (as `teammateLaunch` already is); the collection/service fire `hook.promise`/`hook.call` themselves |
| `findManagedWorktreeOwner` (+ 3 self-wrapping arrows in `agent/index.ts`, `workspaces.ts` optional param) | TeammateCollection (scans its own store) → factory → service → runtime-generation → reopen recovery | refuse a managed path a sibling owns | store-tier function over a `collectionRoot` binding value; the spawn-site call uses the same function |
| `SchedulerServiceOptions.submitScheduled` | owner (agent / `submitToLeader`) | deliver a due prompt | `SchedulerPromptSink` port in `scheduler/types.ts`; `TeamService` implements via its existing `submitToLeader` entry (fence + `starting`→`running`), `DispatcherService` via `submitToAgent` |
| `WorkflowTeammateFactory` (object) + dispatcher's fenced wrapper | owner → workflow run | materialize locked agents | **retain as-is**; the wrapper's fence asymmetry is the deferred `createLocked` finding, out of scope |
| `AgentEntityOptions: (identity) => …` | caller's role-prompt composition over the just-written identity | role options | **retain** (see §2) |

### E. Provider / channel construction seams — deleted (no producer)

| Seam | Evidence | Disposition |
|---|---|---|
| `CodexAgentRuntimeProviderOptions.codexProcessFactory/codexClientFactory/restartBackoffBaseMs/restartBackoffMaxMs` (package-root exports) | only `plugin.ts` calls `createCodexAgentRuntimeProvider()` with no options; no test constructs a provider or runtime | delete the options type and the `CodexRuntimeDeps` passthroughs; `CodexProcess`/`CodexWsClient` construct directly; backoff defaults live in the supervisor |
| `ClaudeCodeAgentRuntimeProviderOptions.resolveBinPath/sessionFactory` | same | delete; resolve the bin in `createRuntime` (mirrors codex's `codexBinPath`), construct `createDefaultClaudeCodeSession` directly |
| `CodexRuntimeDeps.allocateSocketPath` | closes over `paths`, which `deps.paths` already carries | delete; `runtime.ts` calls `allocateCodexSocketPath(this.deps.paths.runtimeSocketDirs(), id)` |
| `CreateFeishuBotDeps.createTransport` | no production or test caller (the logger test's comment explicitly declines the spy) | delete the whole `deps` parameter |
| `FeishuChannelSessionOptions.botFactory` ("inject a fake bot (tests)") | no test supplies it | delete |
| `WorkflowServiceOptions.createRunner/generateRunId/now`, `SchedulerServiceOptions.now`, `CompletionDeliveryPolicy.attemptTimeoutMs`, `SuffixGenerator`/`nameSuffixGenerator`/`agentNameSuffixGenerator`/`generateSuffix` | zero suppliers in src or tests | delete; the final coverage stage reintroduces any seam a real test needs |

### F. Feishu session parent-method closures — pattern + rule

`FeishuChannelSession`'s constructor hands its children bags of its own bound
methods (`notify`, `submit`, `deliver`, `invoke`, `onExpire`, `bindChannel`,
`track`) and of collaborator methods (`announce: (input) => this.bindings.announceProvisioned(input)`,
`cotClient: () => this.bot.cot`). Apply the wrapper test per field:

- **Wraps an available collaborator** → pass the collaborator:
  `announce` → `provisioning` holds `bindings`; `cotClient` → the `bot.cot`
  value (verify the transport getter is stable at construction; if it is
  lazily created, that laziness is the transport's own and the session passes
  `this.bot` instead of a thunk).
- **Parent's own orchestration the child legitimately needs** (send a card,
  submit a turn, settle an ask) → pass the session as a small named port
  implementing those verbs, or the specific owner (`outbound` for cards,
  `commands` for Core submissions) where one owner suffices; one port object
  beats six bound arrows.
- **External port arrival at `initialize()`** (`createFeishuCoreCommands((c, p) => this.invoke(c, p))`)
  → retain: the `JsonInvoker` is the `ChannelCorePort` protocol boundary and
  the invoker genuinely does not exist at construction.

This is the same shape R57 already ruled on for core ("closures into the
parent's private state"), applied inside the channel package.

## 4. Identity events: initial state, listener lifetime, record-only paths

Shape: `service/agent/identity-events.ts` declares `AgentIdentityEvents` — a
typed emitter with `publishIdentity(identity)` and `onIdentity(listener)` —
created by the scope owner and held for its life.

- **Who creates and who subscribes.** `TeamService` creates one emitter in its
  constructor, passes it to its `TeammateCollection` (→
  `AgentEntityCollectionStore` → member store bindings) and to
  `leaderAgentBase()` (→ factory → leader store binding), and subscribes once.
  `DispatcherService` does the same for `dispatcherAgent` and its own
  `TeammateCollection`. One holder per emitter; the emitter dies with the
  owner (a rebuilt Team is a new object with a new emitter; no stale writer
  holds the old one — stores are bound per materialization).
- **Who publishes.** The store tier, immediately after a committed write:
  `create`/`upsert` always; `update` only when the merge changed `status` —
  the existing `afterIdentityStatusChange` filter, now expressed as the emit
  condition rather than a callback adapter. `AgentRuntimeStateStore` and
  `AgentService` learn nothing about publication (the leased sink keeps its
  write authority; session-only publishes do not emit, exactly as today).
  Emission is synchronous after commit and a listener throw propagates into
  the writer — the same fail-loud semantics as today's hook, no defensive
  catch.
- **Initial state.** The stream is transition-only with no replay. A holder
  seeds from ordinary reads at materialization — `TeamService.seedMembers()`
  and the explicit `remember(leader)` after `openTeamLeader` — and the
  constructor subscribes before any write can flow through the emitter, so the
  create/upsert fact (which fires inside the write, as today) is observed. The
  dispatcher has no roster to seed; it only forwards.
- **Role derivation.** The fact is an identity; the role and team name are the
  holder's own knowledge. The listener derives role from ownership exactly as
  the comments already claim: `id.name === mustRecord().leader_name` →
  `team_leader` else `teammate`; the dispatcher agent name → `dispatcher` else
  `teammate`. Names are dispatcher-global and the leader name is record-held,
  so the derivation cannot collide. Today's per-call role argument
  (`publish(identity, 'teammate')` / `'team_leader'`) disappears.
- **Record-only paths.** `closeUnbuilt` writes through the collection store's
  binding, which carries the emitter: the closed identity emits exactly as a
  live close does, and the Team's roster/aggregate move without any entity
  ever existing. `AgentNameRegistry`/`readAgentIdentity` stay read-only and
  emit nothing. `settleTeamWorktreeCleanup` writes the Team record (not an
  identity) and keeps today's behavior (no aggregate republish after close).
- **What the listener does** is exactly today's `TeamService.publish` /
  `DispatcherService.publishAgentState`: roster `remember`, then
  `teammate.state`, then the `team.state` aggregate republish timed by
  `identity.updated_at`. No ordering changes beyond what commit-adjacent
  emission already implies (the create fact fires inside `store.create`, as
  the hook does today, so `rebuild`'s "seed members before creating a fresh
  leader" ordering requirement is preserved unchanged).

## 5. Completion routing: initiation, stop, finalization

Traced end to end under the new shape (all behavior preserved):

- **Initiation.** A submission that should report to a Core-side recipient
  carries `deliverCompletionTo: <owner as CompletionInitiator>` — a value the
  caller already holds (`this` for a Team's members, `dispatcherAgent` for
  TeamLeader turns and dispatcher members). `AgentService.attachSubmission`
  builds the turn with its owner plus the policy (bound on the service at
  factory construction, dispatcher-shared like `admissions`) plus that
  recipient. `WorkflowService.createRun` captures the initiator value once per
  run — the same "fixed at creation" the closure encoded.
- **Settlement.** The turn asks its `EntityTurnOwner` ("is this still news" =
  today's `owed` predicate; "deliver" = `policy.deliverRuntime(recipient, token, fact)`).
  Dedupe-on-token, per-recipient FIFO (`recipientTails`, keyed on
  `recipientKey` — the frozen field each owner now carries directly), the
  `failed`-only retry loop, and the attempt timeout all live in
  `CompletionDeliveryPolicy` untouched.
- **Stop.** A run stopped by its owner clears its delivery obligation exactly
  as `deliverTerminal = null` does today; an entity closing or under host stop
  reports `false` from its owner's owed check. Suppression semantics ("a
  settled turn is reported unless its owner ended it") are unmoved.
- **Finalization.** `WorkflowRun.finalize` delivers the terminal fact through
  the held policy+initiator under its existing owed check, then nulls its
  obligation. Team-unavailable mapping (`isTeamUnavailable` →
  `unsupported`) moves into `TeamService.prepareCompletion` unchanged.

## 6. Changes / removals / retained seams (summary)

**Removed concepts** (each is a deletion, not a move): the `onPersisted`
callback and its whole threading (6 option fields, 3 store parameters, 1
adapter function, 1 factory callback type); `initiatorFor` /
`leaderCompletionInitiator` / `completionInitiator` factories (4);
`TurnCompletionDelivery` / `deliverTerminal` / `resolveCompletionDelivery`
closures (5); `admit`/`isClosing`/`accepting` closures (8, incl. the triple
composition); `applyCreateTeamHook`/`announceTeam` wrappers (2);
`leaderMcp`/`mcp` supplier closures (2); `findManagedWorktreeOwner` + 3
self-wrappers; `allocateSocketPath`; `resolveBinPath`; both provider option
bags; `CreateFeishuBotDeps`; `botFactory`; 5 unused test seams; the feishu
session's bound-method arrows (as enumerated in §3F).

**Added concepts** (paid for by R71 and by the removals above):
`AgentIdentityEvents` (the operator's named EventEmitter direction);
`AdmissionGate` + `nestedAdmissionGates` (one capability replacing three
parallel function fields per bag across six bags); `CompletionInitiator`
implemented by owners (existing interface, no new type);
`DispatcherMcpAssembly` (the existing `mcp-delegates.ts` with its fixed
context); `SchedulerPromptSink` (one port with two real implementers);
`EntityTurnOwner` (the existing parent-child relation made explicit).
Everything else is reference/value substitution.

**Retained function seams, with named consumer and reason** (wrapper test):
`AgentEntityOptions` (factory build step; depends on the just-committed
identity — cannot be fixed earlier); cron/team MCP delegate thunks (each tool
call; owner resolution is behind the Team's open+fence — call-time state);
`WorkflowTeammateFactory` + dispatcher wrapper (the deferred `createLocked`
item); `SchedulerPromptSink` as a port (fire path; implementers add their own
fence/status behavior); `SuffixGenerator`-free name allocation keeps its
internal default; feishu `createFeishuCoreCommands` invoker and
`bot.start(routes)` route bags (protocol boundaries); tapable hooks (R8/R48);
`channelLoggerFactory`/`workflowLoggerFactory` (wiring-layer per-id logger
construction, one hop from `server.ts`); `RestartIntentConsumer`, `ConfigReader`,
catalogs, `WorktreeManager`, `McpLeaseRegistry`, `AdmissionLedger`,
`ConversationProjection`, `AgentRuntimeStateSink`/`ActivitySink` (already
objects — unchanged).

## 7. Preservation and feature-loss ledger

| Boundary (from the continuation) | Preserved by |
|---|---|
| create/upsert publication, incl. before a live Agent exists | store-tier emit on create/upsert, same commit-adjacent timing |
| status-change filtering on updates | emit condition = today's filter, inside the store |
| closing an unmaterialized member | `closeUnbuilt` writes through the emitter-bound store |
| Team roster / dispatcher projections, `team.state` aggregate | same listener bodies (`publish` / `publishAgentState`), role derived from ownership |
| live sibling-worktree queries | same fresh-per-call query, now store-tier over the collection root |
| role-specific MCP / launch behavior | same `mcp-delegates.ts` decisions and the same launch hooks, reached through the assembly object and hook objects |
| per-owner completion recipients | owner-as-recipient values; R18 invariants (one recipient per life, token dedupe, FIFO) untouched |
| admission / shutdown / dissolve semantics | the same fences and composition order, now one gate; `createLocked` asymmetry explicitly untouched (deferred) |
| worktree authority | unchanged (`WorktreeManager`, record ownership, `settleTeamWorktreeCleanup`) |
| completion suppression and retry | `CompletionDeliveryPolicy` body untouched |
| non-blocking inbound #63 | untouched (no change under `codex-live`'s path) |
| restart-time resource allocation | untouched (`DispatcherAgent` lazy activation, `RestartIntentConsumer`, provider-side socket/bin resolution only move within their packages) |
| neutral runtime/channel boundaries | core still speaks only `AgentRuntimeProvider`/`ChannelProvider`; the removed seams are package-internal or provider-construction options |

Feature-loss ledger: **empty** — no user-visible or model-visible behavior is
removed or narrowed. The deletions in §3E are dead construction seams; the
removal of their exported types is an API contraction (§8), not a capability
loss. Deferred product questions (the previous follow-up's list, including the
`createLocked` fencing gap and config-shape error codes) are not touched.

## 8. Public API implications

Recorded explicitly, distinguishing in-repo evidence from outsider risk:

- `@excitedjs/agent-runtime-codex` (0.x) and
  `@excitedjs/agent-runtime-claude-code` (0.x): deleting
  `CodexAgentRuntimeProviderOptions` /
  `ClaudeCodeAgentRuntimeProviderOptions` removes package-root exports. No
  in-repo supplier exists (their plugins call the factories bare; no test
  constructs a provider). These packages exist to be Dreamux's providers; an
  out-of-repo embedder could in principle pass the options — the export docs
  name "embedders, tests". Change note: plain `minor` (0.x rule), described as
  an API contraction; no `BREAKING:`/`Rebuild:` (nothing persisted changes,
  nothing blocks upgrade). **Marked for the operator** (§10).
- `@excitedjs/feishu-channel` (past 1.0, Dreamux-internal per root CLAUDE.md):
  `CreateFeishuBotDeps` is not on the package root; `botFactory` is on
  `FeishuChannelSessionOptions` (provider-internal). Type `minor` with a plain
  note per the Dreamux-internal rule.
- `@excitedjs/dreamux-types`: **no change.** `CompletionInitiator`,
  `AgentRuntimeStateSink`, hook shapes, and the channel event catalog are
  untouched.
- `@excitedjs/dreamux`: no Command, MCP tool, CLI, or persisted-file change;
  ordinary change note only. `AgentIdentityEvents`/`AdmissionGate` are
  package-internal.
- No rush change file needs `BREAKING:`: no loader becomes unable to read an
  existing file and no path moves.

## 9. Boundaries, trade-offs, verification

- **Boundary discipline.** All of this lives inside `packages/dreamux/src` and
  the provider/channel packages' internals. The dependency-cruiser layering
  (store → service → collection) holds: `AgentIdentityEvents` is declared in
  the agent store tier; `CompletionInitiator` moves to owner implementation
  without new cross-tier imports (the interface stays in
  `completion-router/`); `SchedulerPromptSink` lives in `scheduler/types.ts`.
  `TeamService` never imports `dispatcher-service`.
- **Trade-offs accepted.** (1) The scope emitter is a value threaded into
  store bindings — the per-call field remains on factory input, but it is a
  durable capability value (like `location`), not behavior. (2) Role
  derivation by leader name is a tiny re-derivation the owner already owns;
  the alternative (two emitters per scope) buys nothing. (3) The dispatcher's
  cron-delegate thunk stays a thunk for shape uniformity with the Team case.
  (4) One new platform primitive (`nestedAdmissionGates`) and two small named
  types in exchange for ~25 deleted function fields.
- **Rejected alternatives.** A dispatcher-wide identity event bus with
  per-owner filtering (the banned "global bus between the same original
  sides"); per-entity emitters that make the create fact require owner-side
  re-publish; one-method wrapper classes over the existing lambdas; keeping
  `onPersisted` "but as an interface".
- **Verification plan** (R43: no new tests in this child PR). Four Rush gates
  plus `typecheck:tests`; report — do not repair — any existing-test
  incompatibility (expected: none touch these seams; `plugin-hooks.test.ts`,
  `workflow-runner.test.ts`, `codex-live.test.ts` and the feishu logger test
  read none of the deleted fields; the logger test's comment referencing
  `deps.createTransport` is updated). Structural deletion account: every
  removed field/type listed in §6 with its consuming call sites rewritten to
  the owning collaborator. Knowledge delta: `service/CLAUDE.md` (fence
  composition and publication paragraphs), `service-topology.md` /
  `dispatcher-orchestration.md` where they describe `onPersisted` and the
  completion recipient factories, `provider-runtime.md` for the provider
  option removals, and the maintenance skill only if a state/config shape
  moves (it does not). Independent heterogeneous review against §7.

## 10. Decisions left to the operator

Only one, marked as a product/contract decision rather than a routine
implementation detail:

1. **Provider package API contraction (§8).** Deleting
   `CodexAgentRuntimeProviderOptions` / `ClaudeCodeAgentRuntimeProviderOptions`
   is justified by zero in-repo consumers, but "no in-repo consumer" is not
   proof about outsiders. Recommendation: delete (the options are dead
   decoration on packages whose only real consumer is Dreamux; the final
   coverage stage can reintroduce a seam when a test earns it). Consequence of
   keeping: the two option bags remain as untyped-dead public surface and the
   "no mechanism without a scenario" rule is waived for them by name.

Everything else in this proposal is routine implementation within the
preservation boundaries of the continuation requirement.

---

# Cross-review and revised position (round 2)

Inputs: the Claude and DeepSeek proposals (both now carrying their own round-2
sections), the TeamLeader [source audit](../source-audit.md) including its
extension (provisioning `inFlight`/first-submit, startup-window recipient
timing, real CLI logger/sweep suppliers, the
`Server.commandHost` → `command-catalog` → domain-resolver chain), and every
disputed claim re-checked at source. §1–§10 above stand as the independent
first round; where this section differs, **this section governs**.

## R1. Source-audit adjudication (every objection resolved)

| Audit fact | Resolution |
| --- | --- |
| `createLocked` skips `admitOperation`; the dispatcher Workflow wrapper is the only fence on that path; the Team path is deferred | **Accepted.** The wrapper is retained verbatim (first-round position confirmed). DeepSeek's deletion ("already fenced by its own `admitOperation`") is factually wrong: `agent/index.ts` `createLocked` calls `createFreshEntity` directly — `spawn`/`send`/`close` cross the fence, `createLocked` does not. Removing the wrapper would silently decide the deferred `createLocked` question. |
| `DispatcherLifecycle` is constructed last; a gate interface alone does not resolve the cycle | **Accepted as a defect of my first round** (which named no working order). Fixed in R4: the fence's state is created first by `DispatcherService` and `DispatcherLifecycle` receives the owner view (Claude's shape). |
| `ChannelService` is built before `DispatcherAgent`; the "channels don't exist yet" claim is false | **Accepted.** The real late facts are the collections/scheduler at MCP **assembly** time, which stays at `build()`. Construction order in R4 reflects this. |
| `TeamService.admit` is Team-only at completion prep / prepared submit / interrupt; folding the dispatcher gate in changes behavior (#391: queued deliveries are never retracted) | **Accepted as a defect of my first round** (uniform `nestedAdmissionGates(this, deps.gate)` would have gated those entries). Fixed in R4: children get the composed fence; the recipient/leader entries keep the Team-only check. |
| Launch hook can reject after persistence; `abandonCreated` publishes the closed Team with the remembered leader; seeding after factory return loses the failure-path roster | **Accepted.** The revised events design (R5) keeps the roster update at create-commit time (before `leaderLaunch` runs) on every path; DeepSeek's "seed after `createTeamLeaderAgentForTeam` returns" loses it and is rejected on this fact. |
| A collection-attached bus observer nests `team.state` inside `teammate.state` delivery and inverts the order channels see | **Accepted.** Internal observers do not ride `DispatcherCoreEventBus`; DeepSeek's `observe()` router is rejected on this fact (its "It never is [registered after the router]" reads registration against team materialization, not against the router itself — the collection is constructed before `ChannelService.initialize`). |
| `FeishuBot.cot` is fixed at transport construction, not at `start` | **Accepted.** `cotClient: () => this.bot.cot` is pure deferral of a fixed value → value at construction (Claude's fix; my first round left it as "verify"). |
| `createFeishuCoreCommands((c,p) => session.invoke(...))` is internal forwarding; only the `JsonInvoker` is the protocol boundary | **Accepted as a defect of my first round** (I retained the whole seam as "external port"). The wrapper dies; the late `JsonInvoker` moves into `FeishuCoreCommands`, its only reader. |
| `FeishuProvisioning.inFlight` spans the whole `guarded` run **including the first submit**; waiters queue behind it; a first-submit rejection is caught by `guarded` (the comment claiming otherwise is wrong) | **Accepted.** Claude's round-1 inversion (provisioning returns the Team; the caller submits outside the guard) is rejected: it releases waiters early and moves the submit out of the catch. The submit step stays inside the same guarded span, supplied as a call-scoped operation (R8). |
| Startup-window recipient: spawn/send resolve `mustAgent()` after member construction; Workflow is shielded by `accepting = false` until the agent is built | **Accepted.** The lookup timing is preserved, not changed (R6): one submission-time readiness read replaces the supplier's invocation point. DeepSeek's retained supplier is unnecessary; Claude's accepted timing change is avoidable. |
| CLI **does** supply `channelLoggerFactory`/`workflowLoggerFactory`/`runtimeSocketSweep` (`cli/server.ts`) | **Accepted.** They are not dead seams; replacing them is a public construction-API contraction with separate accounting (R10), not dead-seam deletion. |
| The command composition path (`Server.commandHost` → `command-catalog` resolvers → domain `commands.ts`) is in scope; the cycle (catalog resolves dispatchers, `Dispatchers` takes the port) must be classified | **Accepted — this path was omitted from all three first rounds, mine included.** Classified in R9. |
| Tests supply none of the provider factories / `botFactory` / `generateSessionId`; DeepSeek's "botFactory has real test consumers" is unsupported | **Accepted.** DeepSeek's public-API retention rests on that false premise; the contraction is recorded explicitly (R10). |
| Deleting tests to conceal a regression is not authorized; report incompatibilities first | **Accepted.** R11 lists the check; no deletion is pre-authorized. |

## R2. The other proposals: what survives, what does not

**From Claude — accepted (verified at source):** the `WorkFence` /
`OwnedWorkFence` / `createWorkFence` shape and the fence state move out of
`DispatcherLifecycle`; the concrete construction order (fence first,
`DispatcherAgent` before the collections, lifecycle last); the Team-only
`assertOpen` distinction; owner-as-`CompletionInitiator`, `recipientKey`
deletion, policy bound in the factory, per-submission recipient values,
`WorkflowRun.owedRecipient`; the two-phase factory (`UnbuiltAgent`) replacing
`options`/`align`/`closeUnbuilt` threading; role as a stated construction
input; the store-owned `committed` emitter with the factory's first-listener
`teammate.state` publication and holder relays (see R5 — I withdraw my
scope-emitter); the Team owning its leader's tools with `ChannelMcpSource`
crossing the layer; delegate suppliers collapsed to values;
`TeamsPort.leaderScope`/`runForLeader`/`TeamCollection.admit(teamId)` /
`TeamService.leaderScope`/`TeamLeaderHandle` deleted with their last consumer;
the scheduler stating `SCHEDULED_SOURCE` and submitting through the existing
`submitInput` contract (no new interface); hook objects; the collection-root
worktree query; `allocateSocketPath`/`resolveBinPath` derivation; the
test-seam rule ("survives only with a current consumer"); Feishu `notify` →
`FeishuOutbound`, `announce` → `bindings`, `onExpire` → registry event,
slash-context → `bindings`/`bot`; the `RuntimeStateFence` and
`TransactionalStore` retentions.

**From Claude — rejected or corrected:**

1. The Feishu provisioning inversion (return the Team; submit outside
   `guarded`) — withdrawn by their own round-2 correction #1 and rejected here
   on the audit facts; the call-scoped-operation form (R8) preserves the
   `inFlight` span and the catch.
2. The startup-window change as an operator item — avoidable; R6 preserves the
   timing, so no operator decision arises. (Residual disagreement, named in
   R12.)
3. Their ledger row "the submit must stay outside its catch, as today" —
   false; today it is inside.
4. Their `DispatcherAgent implements submitInput` forwarding needs an R58
   check (their own correction #7): retained only as the stable lazy handle's
   verb — callers cannot hold the `AgentService` — not as an aggregate
   pass-through.

**From DeepSeek — accepted:** the pure fact builder (`teammate.state` is a
function of a stated `role` and the identity) and the role-input discipline;
the `CreateFeishuBotDeps` deletion; the two provider-deps derivations.

**From DeepSeek — rejected, with source:**

1. The bus-reuse router (`observe()`, `team.state` routed from the bus):
   ordering inversion (audit), plus the failure-path roster loss for a leader
   whose launch hook rejects.
2. Deleting the dispatcher `createLocked` wrapper: wrong premise (R1).
3. Retaining `initiatorFor`/`completionInitiator`, `leaderMcp`/`mcp`,
   `submitScheduled`: "late creation" and "owner policy" are not reasons —
   the audit states late creation alone does not justify a supplier; the
   source tag is the producer's provenance; the MCP values are computable at
   build from the identity.
4. Retaining all test seams and `botFactory` ("real test consumers"): no
   current supplier (audit + re-verified).
5. Blanket-retaining the Feishu session injections as "intra-aggregate":
   the continuation explicitly includes the Feishu channel, and the audit
   states a named consumer alone does not justify closure-mediated access to
   another object's private operations.
6. `start`/`observe` registry changes on `DispatcherCoreEventBus`:
   unnecessary once internal observers do not ride the bus (R5).

## R3. Entropy ledger of the revised shape

**Disappears (mechanisms, not lines):** `onPersisted` across 8 option/dep
fields, 3 store parameters, `afterIdentityStatusChange`, `AgentEntityCallbacks`,
`publishAgentState`/`onDispatcherAgentPersisted`, the Team `publish(identity,
role)` composer; `options`/`align`/`closeUnbuilt` threading; 4 recipient
suppliers + `recipientKey`/`leaderRecipientKey` + `TurnCompletionDelivery` +
2 × `resolveCompletionDelivery` + `deliverTerminal` + the `owed` closure (into
the owner); 8 `admit`/`isClosing`/`accepting` closures + the 3 duplicated
composition lambdas + `DispatcherService.admitOperation` pass-through; 2 hook
wrappers; 3 `leaderMcp`/`mcp` carriers + 3 delegate resolve-back suppliers;
`findManagedWorktreeOwner` + 3 self-wrappers; `allocateSocketPath`;
`resolveBinPath`; provider option bags + deps copies; `CreateFeishuBotDeps`;
2 × `botFactory`; the unused test seams (~12 fields); Feishu session
method-arrows (`notify`, `submit`, `deliver`, `announce`, `cotClient`,
`invoke`, `onExpire`, `bindChannel`, `resolveChatName`, `delivery: this`);
logger factories + 5 forwarders; `runtimeSocketSweep`; `TeamsPort.leaderScope`
/ `runForLeader` / `TeamCollection.admit(teamId)` / `TeamService.leaderScope`
/ `TeamLeaderHandle`.

**Added (each paid by the rows above):** `WorkFence`/`OwnedWorkFence` +
`createWorkFence` (state **moved** out of `DispatcherLifecycle`, not created;
one name replaces eight closures); `EventEmitter` on `AgentIdentityStore`,
`AgentService`, `TeammateCollection` (three tiny typed relays);
`teammateStateEvent(role, identity)` (one pure builder replaces two
composers); `role` + `coreEvents` as factory inputs;
`UnbuiltAgent` (names the already-real committed-but-unbuilt state);
`CompletionInitiator.ensureReady` (one method; see R6);
`ChannelMcpSource` (implemented by `ChannelService` as-is); one Feishu
delivery owner implementing the existing `FeishuInboundDelivery`; `fileLogs`
and `sweepRuntimeSockets` booleans.

**Net shape change:** the downward behavior-threading of owner state
disappears entirely; facts flow up from the committing object through
holders-of-children relays; the only new names name states and capabilities
that already exist.

## R4. Revised design: fences and construction order

- `platform/work-fence.ts`: `WorkFence { admit<T>(task); isClosing() }` and
  `OwnedWorkFence extends WorkFence { assertOpen(); close(release);
  drain() }` from `createWorkFence()` — the state `DispatcherLifecycle` holds
  today (`closed`, `admittedWork`, the `admit`/`isClosing`/`assertAvailable`
  bodies, the permanent-`closed` + retryable-release invariant). Name avoids
  "admission", already meaning `AdmissionLedger`/`TurnAdmission`/
  `RuntimeAdmission`.
- **Construction order** (the audit's cycle, resolved): `fence` →
  `completionDelivery` policy (reads the fence) → core events → worktrees →
  names → `AgentServiceFactory` → `channels` (holds the fence) →
  `DispatcherAgent` → `scheduler` → `teammates` → `teams` → `workflows` →
  `DispatcherLifecycle` (owner view of the fence; same inputs as today plus
  the fence). `DispatcherAgent.build()` still runs at start, so MCP assembly
  reads the collections after they exist.
- `TeamService implements WorkFence`: `admit` = own check then
  `deps.fence.admit` (the dispatcher's); `isClosing` = own or parent.
  Children (`TeammateCollection`, `WorkflowService`, `SchedulerService`,
  the Team-scoped completion policy reads) receive `fence: TeamService`
  itself — the three duplicated lambdas die with no combinator primitive.
- **Entry-point distinction preserved (audit):** the leader completion
  recipient's `prepareCompletion`/`submit`, `submitInput`, and
  `interruptLeader` keep the **Team-only** check (`assertOpen()`); they never
  fold in the dispatcher gate. `dissolve` stays ungated at the Team (join);
  it crosses the dispatcher fence at its collection entry, as today. The
  dispatcher Workflow's `createLocked` wrapper is retained untouched
  (deferred question).
- No `nestedAdmissionGates` primitive (first-round item withdrawn): the
  composition lives in `TeamService`'s own `admit`/`isClosing`, which is its
  existing body.

## R5. Revised design: identity facts and events

Adopting the store-owned emitter (Claude's transport) over my first-round
scope-emitter, with these verified properties:

- `AgentIdentityStore` emits `committed` after `create`/`upsert` (always) and
  `update` (status-change filter, evaluated on the committed `previous` in the
  same `TransactionalStore` after-commit step). The store is the object that
  commits; holders observe what they hold. **My scope-emitter is withdrawn**:
  threading a holder-created emitter through the same option chains is
  `onPersisted` with a subscribe method — the downward plumbing shape
  survives, which fails the continuation's "must remove the old plumbing".
- `role` is a stated construction input on `create`/`open`/`upsert`
  (`teammate` / `team_leader` / `dispatcher` — every materializer knows it
  statically). One pure builder `teammateStateEvent(role, identity)` in the
  agent module replaces both owner-side composers. Role is never re-derived
  from names (first-round item withdrawn).
- `AgentServiceFactory` (which binds every store) attaches the
  `teammate.state` publisher — its first listener — onto each binding before
  the first read or write; it holds `coreEvents` once. `DispatcherService`
  subscribes to nothing.
- `AgentService` relays its store's `committed` as `state`; `TeammateCollection`
  relays each member's `state` as `member` and emits `unbuilt.identity` at
  create-resolve and `closeAtRest`'s return in `destroy`; `TeamService`
  subscribes to its collection's `member` (roster + `team.state`) and handles
  its leader directly: create-branch seed on `unbuilt.identity` **before
  `leaderLaunch` runs**, open-branch silent `remember`, then the leader's
  `state` relay after `build`. Every hop observes its own child.
- **Two-phase factory:** `create`/`upsert` resolve to, `open` to-or-null, an
  `UnbuiltAgent` (private store + stated `role`; `identity`, `build(options,
  siblings)`, `closeAtRest(note)`). This deletes `options`, `align`, and the
  `closeUnbuilt` threading. `upsert`'s `reconcile` stays (inside the store's
  read-modify-write). R63 holds: no store reaches a parent.
- **Internal observers never touch `DispatcherCoreEventBus`** (audit
  boundaries on `hasSources`/lease revocation): the factory's publisher is an
  ordinary writer like today's `publishAgentState`; the roster rides relays.

Event ordering, initial state, listener lifetime, record-only and failure
paths (each checked against today):

1. **Order:** the factory publisher is listener #1, so `teammate.state` is
   fully delivered to the bus before any relay can publish `team.state` —
   today's order (`publish` does `teammate.state` then `team.state`). The
   nested aggregate publish sits after the outer fact, never inside its bus
   dispatch to channels.
2. **Initial state:** transition-only, no replay. `seedMembers()` precedes a
   fresh leader's create (unchanged); a restored leader is remembered
   silently (no commit, no event). The create commit is observed through
   `unbuilt.identity` in the same call, before options/launch hooks.
3. **Listener lifetime:** store+publisher+relay collected with the entity;
   collection relay with the collection; `TeamService`'s subscription with
   the Team (a discarded creation drops all three — no unsubscribe bookkeeping
   on the abandonment paths). No emitter outlives a subscriber.
4. **Record-only close:** `UnbuiltAgent.closeAtRest` commits `closed` (a
   status change → `teammate.state` from the factory listener) and returns the
   identity; the collection emits `member` → roster + `team.state`. Same two
   facts in the same order as `closeUnbuilt` + the old hook.
5. **Failure-path roster:** a leader/member whose launch hook rejects is
   already remembered at create-resolve, so `abandonCreated`'s closed Team
   publishes the same aggregate as today. Review check: never move the seed
   past `build`.
6. **Creation before a live Agent / dispatcher upsert / `settleTeamWorktreeCleanup`:** unchanged (the last is record-only, no event).
7. The one accepted timing delta: the roster/aggregate projection runs on the
   create call's continuation instead of inside the after-commit hook — with
   only microtasks between the two bus facts; no I/O interleaves them.

## R6. Revised design: completion recipients, timing, and gates

- `TeamService` and `DispatcherAgent` implement the existing
  `CompletionInitiator`; `AgentService` already does. `recipientKey` and
  `leaderRecipientKey` are deleted (recipients are stable objects; the policy
  keys on the object).
- The factory binds `CompletionDeliveryPolicy` once (like `AdmissionLedger`).
  Submissions carry `completionRecipient?: CompletionInitiator` — a value,
  never a resolver. `EntityTurn` holds its `EntityTurnOwner` (the
  `AgentService`) plus the per-submission recipient; the `owed` predicate
  becomes the owner's `turnReportOwed()` (first-round closure item dissolved
  into the owner reference). `WorkflowRun` holds `policy` +
  `owedRecipient: CompletionInitiator | null`.
- **Lookup timing preserved (audit):** `CompletionInitiator` gains
  `ensureReady(): void`, called where `initiatorFor()` is invoked today —
  before the member's first submission in `spawn`/`send`, and at Workflow run
  creation. `DispatcherAgent.ensureReady` is `mustAgent()` (the exact current
  throw, so the failed-creation cleanup path is byte-identical);
  `TeamService.ensureReady` is its `assertOpen()` — a redundant read of the
  same fence its own admit already crossed, the codebase's accepted
  double-fence pattern. Workflow's `accepting = false` gate already shields
  its window. An eager throw cannot exist without an eager call; this is
  today's check given a name, not compensating machinery.
- **Gates:** the recipient's `prepareCompletion`/`submit` keep the Team-only
  fence and the `isTeamUnavailable → unsupported` mapping; the policy's
  `accepting` reads the dispatcher fence before queueing and still never
  retracts a queued delivery (#391). R18's dedupe/FIFO/retry rules untouched.

## R7. Revised design: MCP assembly and lifetime

- **The Team owns its leader's tools.** `teamLeaderMcpDelegates` moves into
  `service/team/`, binding the Team's own children (`teammates`,
  `workflows`, `scheduler` — each already self-fenced), the Team's `dissolve`
  under the dispatcher fence (join preserved), and `channels.mcpDelegates`
  through `ChannelMcpSource { mcpDelegates(caller, fence) }`
  (`service/mcp/types.ts`, implemented by `ChannelService` — the one
  cross-layer input; `service-team` sits below the orchestration layer).
  `TeamCollectionOptions.leaderTools = { leases, adminSocketPath, channels }`
  are values; the `TeammateAgentMcp` is computed from the identity at build.
  My first-round `DispatcherMcpAssembly` is withdrawn: it is `leaderMcp`
  renamed to a method (same captures, same consumer).
- `DispatcherAgent` receives its tool inputs as objects and calls
  `dispatcherAgentMcpDelegates` in `dispatcherOptions()` (assembly timing
  unchanged, at `build()`).
- Delegate suppliers collapse to values: `createCronMcpDelegate({ scheduler:
  SchedulerCommands })`, `TeamMateMcpScope.team` → `{ teammates, workflows }`.
  "Per-call resolution" is not a reason: a Team's scheduler/leaderScope live
  behind the Team's own fence, and the bound `TeamService` refuses exactly
  when the id would resolve to nothing.
- Deleted with their last consumer: `TeamsPort.leaderScope`, `runForLeader`,
  `TeamCollection.admit(teamId, …)`, `TeamService.leaderScope()`,
  `TeamLeaderHandle` (readers re-checked: only the leader MCP delegate and
  the team module itself). `TeamsPort.scheduler(teamId)` stays (admin cron).
- **Lifetime checks:** leader tools live exactly as long as the `TeamService`
  that holds the leader (a closed Team is never rebuilt; `TeamCollection`
  evicts on `service.closed`); MCP leases die with the runtime stop inside
  `destroyChildren`, so no delegate outlives its authority; dispatcher-agent
  tools are assembled at `build()` when every collaborator exists; the
  `RoleDelegateDispatcher` structural type stays (no `index.ts` back-import).
  Residual delta (recorded): a post-close tool call gets the Team fence's
  `TeamClosedError` instead of the collection's closed-Team answer — same
  error type, different message.

## R8. Revised design: scheduler, hooks, Feishu

- **Scheduler:** the scheduler states its provenance
  (`{ source: SCHEDULED_SOURCE, text, sourceId }`) and submits through the
  existing `submitInput(TeammateSubmitInput)` contract. `DispatcherAgent`
  implements it as the stable lazy handle's verb (R58-checked: callers cannot
  hold the `AgentService`); `TeamService.submitToLeader` is renamed
  `submitInput`, keeping the `initiator` input and the `starting → running`
  transition. `SchedulerPromptSink` withdrawn (a new name over two existing
  closure bodies).
- **Hooks:** `TeamCollectionOptions.hooks: Pick<Dispatcher['hooks'],
  'teammateLaunch' | 'createTeam' | 'team'>`; the collection fires
  `hook.promise`/`hook.call` itself. All three proposals agree.
- **Feishu (classified, not "in principle"):**
  - `cotClient` → the `FeishuCotClient` value (fixed at transport
    construction — audit); `cot.start(isLive)` → the `lifecycle` value at
    construction (verify at implementation that no adapter entry runs before
    `initialize`; round-2 checks name `handle`/`beginInboundSubmission`/
    `onRouteClaimed`).
  - `announce` → the `bindings` object; `notify` (topic-root skip + tracked
    send) → `FeishuOutbound`; `bindChannel` → `bindings`; `resolveChatName` →
    `bot`; `AskUserRegistryOptions.onExpire` → an `expire` event observed by
    `FeishuCardActions` (which already holds registry, bot, settlement).
  - `createFeishuCoreCommands(invoke)` wrapper dies: the late `JsonInvoker`
    moves into `FeishuCoreCommands` (its only reader), set at `initialize`,
    rejecting before that as today. The `JsonInvoker`/`ChannelCorePort`
    contract itself is retained (protocol boundary).
  - `submit`/`deliver`/`delivery: this` → one delivery owner implementing the
    existing `FeishuInboundDelivery` (+ `submit`), which owns provisioning
    and receives the inbound pipeline. **Provisioning concurrency
    preserved:** `FeishuProvisioning.provision(input, submit)` takes the
    session's submit step as a **call-scoped operation** inside its existing
    `guarded` span — `inFlight` still holds the whole run including the first
    submit (waiters still queue, then `deliverAfterRun` reads the binding),
    and a first-submit rejection still surfaces as `unsubmitted` through
    `guarded`'s catch. The round-1 inversion (submit outside the guard) is
    rejected; the comment in `guarded` claiming the catch covers only
    pre-submit failures is not behavior authority.
  - `toolSession()` / extension tool invokes / `bot.start(routes)` route
    registration: external boundaries (extension API, transport protocol) —
    retained; the session-method closures inside `inboundRoutes()` route
    through the delivery owner like everything else.
  - `CreateFeishuBotDeps`, both `botFactory`s → deleted (no supplier).

## R9. The command composition path (previously omitted by all three)

- **Domain `execute` handlers** in each `commands.ts`: the Command contract
  itself (process-resolved, invoked per call) — retained as ordinary command
  callbacks.
- **Per-invocation resolvers** (`(context) => dispatcher(context).teams`,
  `workflows`, `channels`, `dispatcher`): retained. Their target is caller
  context — commands are resolved once per process and must not close over
  one dispatcher; this is the same call-time owner resolution as the former
  MCP thunks, with a real per-call varying target.
- **`CoreCommandHost`** (`server/command-host.ts`): the composition-tier
  narrow port that keeps domain modules off the composition tier — retained
  as the port. Its `commandHost()` object literal is wiring; making `Server`
  implement the port directly is a routine style choice (either is fine).
- **Per-domain resolver bags** (`dispatcherCommands({ summarize: … })` and
  friends): retained. They are the layering adapters from the host port to
  each domain's narrower structural view (the narrower type is what keeps
  `service/*` from importing composition tier), and they carry one real piece
  of policy (`mustDispatcherConfig`'s not-found handling, resolved once in
  the catalog). Trivial double-arrows may flatten where the host already
  satisfies the narrower type unchanged — routine.
- **The construction cycle** (catalog needs a host that resolves `Dispatchers`;
  `Dispatchers` takes the command port): broken today by the host reading the
  late-assigned `dispatchers_` field per invocation. **Retained and
  documented** as the cycle-break: the registry must precede `Dispatchers`
  (which takes the port), and the host's lookups are per-call by contract —
  unlike the completion handle, the value here is never fixable at
  construction. No setter, no holder object, no promise field.

## R10. Explicit public API implications (with separate accounting)

| Package (version) | Surface | Change | Accounting class | Note |
| --- | --- | --- | --- | --- |
| `@excitedjs/agent-runtime-codex` (0.6.0) | `CodexAgentRuntimeProviderOptions` root export | remove `codexProcessFactory`, `codexClientFactory`, `restartBackoff*` | **dead seam** (no src/test supplier) | `minor`, plain note |
| `@excitedjs/agent-runtime-claude-code` (0.7.0) | `ClaudeCodeAgentRuntimeProviderOptions` root export | remove `resolveBinPath`, `sessionFactory`, `generateSessionId` | **dead seam** | `minor`, plain note |
| `@excitedjs/feishu-channel` (6.2.0, Dreamux-internal) | `CreateFeishuChannelProviderOptions.botFactory` root export | remove | **dead seam** | `minor`, plain note |
| `@excitedjs/feishu-channel` | `CreateFeishuBotDeps`, `FeishuChannelSessionOptions.botFactory` (internal) | remove | dead seam | `minor`, plain note |
| `@excitedjs/dreamux` (0.25.0) | `ServerOptions`: `channelLoggerFactory`/`workflowLoggerFactory`/`runtimeSocketSweep` → `fileLogs`/`sweepRuntimeSockets` | replace function options with values/booleans | **real-supplier contraction** (CLI supplies all three; behavior preserved: file-backed loggers and the sweep for `dreamux serve`, in-memory loggers and no sweep otherwise) | `minor`, plain note — its own row, never mixed with the dead-seam deletions |
| `@excitedjs/dreamux-types` | — | none | — | `CompletionInitiator` gains `ensureReady` — internal to `@excitedjs/dreamux` (the interface lives in `service/completion-router`), not a types-package change |

Nothing persisted changes; nothing blocks an upgrade; no `BREAKING:` /
`Rebuild:`. The absence of repository suppliers is evidence about this
repository only — outside consumers of the two provider packages' options are
unknown, which is why the contractions are one explicit operator item (R12)
rather than a silent cleanup.

## R11. Preservation and feature-loss ledger (revised)

| Boundary | Preserved by | Review failure to check |
| --- | --- | --- |
| create/upsert publication, status-change filter, commit timing | store-owned `committed` rule + factory first-listener publisher | filter on a snapshot instead of committed `previous`; a binding without the publisher |
| failure-path roster + early aggregate | create-resolve seed before launch hooks (R5.5) | seed moved past `build` |
| `teammate.state` before `team.state` | publisher is listener #1 (R5.1) | an observer on the bus re-nesting |
| record-only `closeUnbuilt` | `closeAtRest` → collection `member` (R5.4) | a path that builds an entity to close it |
| entry-point gate distinction (#391, dissolve join) | R4 `assertOpen` split | dispatcher gate folded into the recipient; `dissolve` gated |
| startup-window spawn/send failure path | `ensureReady` at the old `initiatorFor` call sites (R6) | the readiness read dropped as "redundant" |
| completion suppression/retry/FIFO | policy body untouched; `owed` on the owner | retraction of queued deliveries |
| leader tools + fence order | R7 (Team-first composition; only the error text differs) | tools re-resolving the Team by id |
| sibling worktree occupancy | store-tier query over the collection root | owner-root entities given a siblings root |
| provisioning concurrency + `unsubmitted` | submit inside `guarded` as a call-scoped operation (R8) | waiters released before the first submit; submit moved out of the catch |
| #63 non-blocking inbound | untouched (`TurnManager` submission); review the diff anyway | — |
| deferred product questions | untouched: `createLocked` admission, live `last`/activity config, COT anchor-on-first-binding, etc. | any change to them is out of scope |

First-round claim "feature-loss ledger: empty" is corrected: the ledger was
empty only because the startup-window delta was missed; it is now preserved
rather than ledgered, and the residual deltas are the two recorded message/
timing nits (R7 error text; R5.7 one-continuation projection timing) — neither
is a user-visible capability change.

## R12. Residual disagreement, and the one operator decision

**Remaining material disagreement (named, not papered over):** whether the
startup-window readiness check is kept (this proposal: R6 `ensureReady`,
behavior-identical) or accepted as a behavior change with an operator item
(Claude round 1 §8.1). The audit supports keeping it ("changing it is not
required merely to remove a supplier closure"); if the adjudicator prefers a
one-method `CompletionInitiator`, the fallback is the timing change — spawn/
send in the admin-socket window succeed and the completion is dropped at
delivery instead of the submission failing and the member being closed —
which is then an operator item. Secondary: Claude treats the `ServerOptions`
logger/sweep replacement as its own operator item; this proposal treats it as
routine-with-accounting (behavior-preserving, in-repo-only supplier) and folds
it into the single API item below so the operator answers once.

**Genuinely required operator decision (one):** the public construction-API
contractions in R10 — provider option bags, both `botFactory` exports, and
(optionally folded in) the `ServerOptions` logger/sweep shape. Recommendation:
contract them now (no repository supplier for the dead seams; the
`ServerOptions` change is behavior-preserving and its only supplier is our
CLI). The alternative keeps dormant public surface whose only justification
would be an unverified outside consumer.

**Routine implementation choices (no operator needed):** naming
(`WorkFence`), construction order, emitter placement and relay shape,
`UnbuiltAgent`'s exact members, the Feishu delivery-owner class name,
flattening trivial resolver arrows, `Server` implementing `CoreCommandHost`
directly or via the literal.

**Already-authorized scope (no decision):** the Feishu session internals are
explicitly inside this continuation and proceed; the deferred product
questions (`createLocked` admission, live `last`/activity config, COT
first-binding anchor, pairing-token persistence, plugin `config` block) stay
deferred and untouched; R43 continues to govern tests (no new/repaired tests;
report incompatibilities — expected watch list: `package-boundary-guards`
construction-text pins, `feishu-bot-logger`'s `createTransport` comment,
`runtime-state-fence` and `os`/`run-dir-hardening` pins of retained seams).
