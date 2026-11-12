# DeepSeek proposal: inter-component data-flow ownership

Independent solution, written against the post-PR #457 source on
`refactor/data-flow-ownership-453`. No other author's proposal or reviewer
report was read. Every claim below is from source read in this session; file
and symbol references are given so a reviewer can re-check each one.

## 1. What the user story makes authoritative

R71 asks for one thing, in three words: **stop carrying an owner's private
state and operations through other objects**. Everything else in the
continuation is a boundary on how that may be done (preserve behavior, remove
the old plumbing, do not rename an indirection).

Read against source, the closure problem has exactly two shapes, and they have
different answers:

1. **A state notification travels backwards through layers.** A write commits
   in the Agent module and then calls up into whoever owns the display
   projection. `onPersisted` is the whole of this shape
   (`service/agent/service-types.ts:39`, `service/agent/store.ts:363`,
   `service/agent/runtime-state.ts:91`, `service/agent/index.ts:96`,
   `service/dispatcher-service/agent.ts:54`, `service/team/leader.ts:80`,
   `service/agent/factory.ts:34-37`). The fact has a natural owner — the module
   that committed the record — so the fact must be published there and observed
   by holders. This shape has no defensible retained form.
2. **An owner's operation is handed to a collaborator as a value.** Admission
   fences, plugin hook application, team announcement, the leader MCP
   assembly, the completion recipient, a due cron fire's submission, and — in
   the Channel package — the session's own submission/notice operations. Each
   of these has a named consumer, and most have an owner object that already
   exists; only those with no existing owner object survive as values.

The smallest coherent end-to-end change is therefore not "replace callbacks
with objects". It is:

> Move every fact to the module that owns the write, publish it on the
> dispatcher's existing live fact bus, let holders observe it, and let each
> owner be reached through the object it already is.

Two things make this a genuine ownership convergence rather than renamed
plumbing: the producer of `teammate.state` moves into the Agent module (today
no closure-free path can even know the entity's role before the first write —
see §2.1), and the closures that remain are the ones whose owner object does
not exist yet or cannot be handed down without inverting construction.

## 2. Proposed ownership model

### 2.1 One Agent-state fact, published by the Agent module

**Owner:** `service/agent/` owns `identity.json` and is the only place that
knows, atomically, whether a commit created a record or changed its status.
Today it knows that (`AgentIdentityStore.update`'s own `change` callback,
`service/agent/store.ts:196-225`, and `afterIdentityStatusChange`,
`store.ts:265`) but cannot say it, so it calls back into its owner.

**Change:** the fact is published at the commit.

- `AgentIdentityStore` is constructed with the dispatcher's live fact bus and
  the entity's role: `new AgentIdentityStore(binding, coreEvents, role)`.
  `binding` stays exactly as it is (`store.ts:80-103`).
- The module owns one pure event builder:
  `agentStateEvent(role, identity): TeammateStateEvent` (beside the identity
  types, `service/agent/identity.ts`). It produces the **unchanged public
  shape** (`@excitedjs/dreamux-types` `teammate.ts:29-41`): `role` from the
  entity's fixed construction role, `teamName` from `identity.team_id` — the
  same two facts `DispatcherService.publishAgentState`
  (`dispatcher-service/index.ts:404-421`) and `TeamService.publish`
  (`team/service.ts:907-925`) assemble today.
- The write rule stays in the store, where it is atomic, and keeps today's
  contract exactly: `create` and `upsert` publish unconditionally after a
  successful commit (`store.ts:172-180`, `store.ts:239-250`); `update`
  publishes only when the merge changed `status` (`store.ts:265-272`); a read
  never publishes.
- Read-only construction sites are untouched: `readAgentIdentity`
  (`store.ts:511`), the `AgentNameRegistry` scan (`store.ts:467-505`) and
  `AgentEntityCollectionStore.list/entity` (`store.ts:388-441`) do not write,
  so the reader path is the current `loadIdentity` body extracted as a module
  function, with no bus and no role in `AgentIdentityBinding`.

**Role becomes a stated construction input, not an option derived later.**
`role` must be known *before* `create` writes, and it is the one option that
does not depend on the identity: every materializer knows it statically
(`TeammateCollection.teammateOptions` → `teammate`,
`service/agent/index.ts:766-790`; `TeamService.leaderAgentBase` →
`team_leader`, `team/service.ts:981-993`; `DispatcherAgent.dispatcherOptions`
→ `dispatcher`, `dispatcher-service/agent.ts:113-146`). So
`AgentServiceFactory.create/open/upsert` take `role`, and
`AgentServiceFactory` composes the returned options as
`{ ...(await input.options(identity)), role }`. `TeammateServiceOptions.role`
stays (the entity still needs it for error wording and projection) but has one
producer instead of three.

**Why not "a one-method wrapper".** Nothing new is wrapped: the bus, the event
type, the role vocabulary and the status filter all already exist. What moves
is the *producer* of the fact, one layer down, to the module that owns the
write. The four owner-side hops (`AgentServiceFactory` per-call callback →
`AgentService` deps → `AgentRuntimeStateStore` → store write) disappear
entirely.

### 2.2 The Team aggregate and its roster

**Owner:** the Team owns `team.state` for its own record transitions (already
true: `TeamService.updateRecord` → `publishTeamState`,
`team/service.ts:999-1020`). The roster (`rosterMembers`, `remember`,
`summary`, `seedMembers`, `team/service.ts:147, 938-978`) exists only to make
the *member-driven* republication truthful.

`TeamStateEvent` is a published contract and documents itself as "republished
whenever the Team lifecycle changes **or a contained TeamLeader/TeamMate is
created or changes state**" (`dreamux-types/src/team.ts:224-236`), so the
member-driven republish is preserved. What changes is how the Team learns of
it.

**Holder subscribes once.** `TeamCollection` — the object that owns which Teams
exist in this process — observes the dispatcher fact bus once for its whole
lifetime, and routes each `teammate.state` carrying a `teamName` to the Team it
holds (`live`, or `starting` for a Team whose initial turn is still being
admitted, `team/index.ts:99-110, 653-661`). The Team updates its own roster and
republishes its aggregate. `TeamService.publish(identity, role)` and every
per-entity publication hop into the Team are deleted with it.

Three consequences worth stating, because they are where this design can go
wrong:

- `starting` becomes a `Map<teamId, TeamService>` instead of a `Set`
  (`team/index.ts:104-110`) purely so the router is O(1); `stopForHost`'s
  iteration is unchanged.
- The leader's `create` happens inside `TeamService.createNew`, before the
  collection holds the Team, so it can never be observed. `createNew` must
  therefore remember the leader explicitly and republish, exactly as `rebuild`
  already does for a restored leader (`team/service.ts:505-520`). This deletes
  the last reason to rely on a create-time hook and makes the two
  materialization paths identical in shape.
- The subscription belongs to the collection, whose lifetime is the
  dispatcher's, so no Team holds a lease and there is no leak path on a failed
  or discarded creation (`team/index.ts:622-661` is full of early returns).
  Per-Team subscriptions were rejected for exactly this reason: the abandoned
  paths (`createNew` → `null`, `abandonCreated` whose close write fails,
  `refuseIfClosing` throwing before `track`) would each need their own release.

### 2.3 Admission gates are objects, not arrows

Every scoped child fences its verbs on its owner's gate, and today that gate
arrives as an arrow plus a second arrow for `isClosing`:
`TeammateCollectionOptions.admitOperation/isClosing`
(`agent/index.ts:113-135`), `TeamCollectionOptions.admitOperation/isClosing`
(`team/types.ts:59-...`), `TeamServiceDeps`, `SchedulerServiceOptions.admit`
(`scheduler/index.ts:41`), `WorkflowServiceOptions.admit`
(`workflow-service/index.ts:58`), `CompletionDeliveryPolicy.deps.accepting`
(`completion-router/index.ts:59-77`), and
`ChannelService.mcpDelegates(caller, dispatch)`
(`channel-service/index.ts:318-334`). `TeamService` then repeats the same
two-fence composition three times in one constructor (`team/service.ts:233,
253, 269`) and `DispatcherService` repeats `(task) => this.admitOperation(task)`
four times.

**Change:** declare one structural gate — `{ admit<T>(task): Promise<T>;
isClosing(): boolean }` in `service/admission.ts` — and pass the **real gate
owner**: `DispatcherLifecycle` (`dispatcher-service/lifecycle.ts:99-110,116`)
for dispatcher-scoped children, `TeamService`
(`team/service.ts:580-592`) for Team-scoped children. The composition moves
into the owner's own `admit`: the Team's `admit` checks itself and then asks
its gate. Call sites shrink to one field and the duplicated fences are gone.

This is not a one-method wrapper: the values passed are existing aggregates
with their own lifecycles, and the child declares the narrow structural view
it needs (the pattern `TeamMateMcpDispatcherScope` already uses,
`agent/mcp.ts:75-88`).

### 2.4 Plugin hooks are passed as hooks

`teammateLaunch` is already passed as the real hook object
(`team/types.ts:81-89`), while its two siblings are wrapped in arrows
(`dispatcher-service/index.ts:258-270`):
`applyCreateTeamHook: (params) => this.hooks.createTeam.promise(params)` and
`announceTeam: (team, ctx) => this.hooks.team.call(team, ctx)`.

**Change:** pass `hooks.createTeam` and `hooks.team` themselves (they are
`AsyncSeriesWaterfallHook`/`SyncHook` instances already wrapped by
`waterfallTaps`/`isolatedTaps`, `plugin/hooks.ts:515-571`). The collection's
*policy* about when to fire them (replay guard, `rebuild` never firing create)
stays where it is (`team/index.ts:157-201`, `dispatcher-service/index.ts:150-186`).

### 2.5 Value-producing factories that stay

Three seams produce a value from facts that genuinely do not exist earlier,
and none of them is a state notification or an owner operation:

- `AgentEntityOptions = (identity) => Promise<...>`, plus `open`'s `align` and
  `upsert`'s `reconcile` (`agent/factory.ts:43-46`). The identity does not
  exist before the write, and the first write must stay before option
  computation (a plugin launch-tap failure must leave the identity durable —
  `dispatcher-service/agent.ts:96-112`).
- `leaderMcp({teamId, leaderName})` (`team/types.ts:90-99`): the leader name is
  allocated inside `createNew` (`team/service.ts:378-384`), after the Team
  collection is constructed, and the delegates are dispatcher-owned.
- `DispatcherAgentOptions.mcp` (`dispatcher-service/agent.ts:41-49`): the
  delegates close over the live `ChannelService`, which exists by the time
  `build()` runs but not when `DispatcherService` constructs the holder.

These stay as functions, and §7 states why for each.

### 2.6 Provider-internal closures over values already carried

Two package-internal deps fields close over values the same deps object already
holds:

- `CodexRuntimeDeps.allocateSocketPath` (`codex/src/runtime-deps.ts:33`) is
  built in `provider.ts:141-142` from `paths`, and consumed at
  `runtime.ts:220`. Delete the field; the runtime already holds `deps.paths`
  and calls `allocateCodexSocketPath(deps.paths.runtimeSocketDirs(), id)`
  itself. Same directories, same fresh random name per start.
- `ClaudeCodeRuntimeDeps.resolveBinPath` (`claude-code/src/runtime-deps.ts:21`)
  is called exactly once, in the runtime constructor
  (`claude-code/src/runtime.ts:84`). Replace the field with `binPath: string`,
  computed in `createRuntime` (`provider.ts:104-116`).

Both are package-internal (`CodexRuntimeDeps` is explicitly not the public
options type, `codex/src/runtime-deps.ts:12-20`), so neither is a public API
change.

## 3. Producer / consumer inventory

Disposition legend: **P** = publish a fact from its owner (§2.1-2.2),
**O** = pass the existing owner object (§2.3-2.4), **V** = package-internal
value (§2.6), **D** = delete as dead, **R** = retained, justified in §7.

### 3.1 Core state publication (`onPersisted` family) — all **P**

| Field | Producer today | Consumers today | Disposition |
| --- | --- | --- | --- |
| `TeammateServiceDeps.onPersisted` (`agent/service-types.ts:39`) | `AgentServiceFactory` per call | `AgentIdentityStore` create/update/upsert; `AgentEntityCollectionStore.closeUnbuilt` | deleted; the store publishes |
| `AgentEntityCallbacks.onPersisted` (`agent/factory.ts:34-37`) | collection / Team / DispatcherAgent | store writes | deleted |
| `AgentRuntimeStateStore` ctor `onPersisted` (`agent/runtime-state.ts:91`) | `AgentService` (`service.ts:139`) | every identity update | deleted with the store's own bus+role |
| `AgentIdentityStore.create/update/upsert` `onPersisted?` + `afterIdentityStatusChange` (`store.ts:168,196,240,265`) | per-call | owner projection | replaced by the store's own `agentStateEvent` publish |
| `AgentEntityCollectionStore.onPersisted` (`store.ts:363-380`) | `TeammateCollection` | `closeUnbuilt` | replaced by the bus + the collection's member role |
| `TeammateCollectionOptions.onPersisted` (`agent/index.ts:90-96`) | DispatcherService / TeamService | forwarded to the store | replaced by `coreEvents` (publisher) |
| `TeamLeaderOpenDeps.onPersisted` (`team/leader.ts:80`) | `TeamService.leaderAgentBase` | leader identity writes | deleted |
| `DispatcherAgentOptions.onPersisted` (`dispatcher-service/agent.ts:54`) | `DispatcherService` (`index.ts:317-319`) | dispatcher-root writes | deleted |
| `DispatcherService.publishAgentState` (`index.ts:404-421`) | — | channel bus | deleted; the entity publishes the same event |
| `TeamService.publish(identity, role)` + roster (`team/service.ts:907-945`) | member/leader writes | roster + `team.state` | replaced by the collection router (§2.2) |
| `TeamService.seedMembers`/`remember`/`summary` + `TeammateCollection.memberStatuses` (`team/service.ts:953-978`, `agent/index.ts:381-390`) | materialization | roster | kept, now fed by the subscription plus the explicit leader seed in both materialization paths |

### 3.2 Owner operations handed down — **O** unless noted

| Field | Disposition |
| --- | --- |
| `TeammateCollectionOptions.admitOperation` / `isClosing` (`agent/index.ts:113-135`) | **O** → `DispatcherLifecycle` gate |
| `TeamCollectionOptions.admitOperation` / `isClosing` (`team/types.ts:66-105`) | **O** |
| `TeamServiceDeps.admitOperation` / `isClosing` (`team/service.ts:94-101`) | **O**; the three repeated two-fence arrows (`:233,:253,:269`) collapse into `TeamService.admit` |
| `SchedulerServiceOptions.admit` (`scheduler/index.ts:41`) | **O** |
| `WorkflowServiceOptions.admit` (`workflow-service/index.ts:58`) | **O** |
| `CompletionDeliveryPolicy.deps.accepting` (`completion-router/index.ts:59-77`) | **O** (the dispatcher gate's `isClosing`) |
| `ChannelService.mcpDelegates(caller, dispatch)` (`channel-service/index.ts:318`) and `dispatcher-service/mcp-delegates.ts:47,72,83` | **O** |
| `TeamCollectionOptions.applyCreateTeamHook` (`team/types.ts:77`) | **O** → the `createTeam` hook object |
| `TeamCollectionOptions.announceTeam` (`team/types.ts:100`) | **O** → the `team` hook object |
| `DispatcherService.workflowService_.teammates.createLocked` wrapper (`index.ts:296-300`) | **D**: `_teammates` is already fenced by its own `admitOperation`, so the wrapper is a second fence over the same gate; `TeamService` passes its collection directly (`team/service.ts:250`) |
| `SchedulerServiceOptions.submitScheduled` (`scheduler/index.ts:44-52`) | **R**: a due fire's submission is the owner's own policy (source tag, recipient that may not exist yet) |
| `WorkflowServiceOptions.completionInitiator` (`workflow-service/index.ts:53`) and `TeammateCollectionOptions.initiatorFor` (`agent/index.ts:131-139`) | **R**: late-bound recipient, fixed for the entity's life (R18); §7 |
| `TeamService.leaderCompletionInitiator`'s arrow into the collection (`team/service.ts:219`) | **R**: the recipient composes the Team's own dissolve fence and supplies the stable `recipientKey` (`:1069-1105`), so it is the Team's capability, not a pass-through |
| `TeamLeaderOpenDeps.leaderMcp` (`team/leader.ts:78`) / `TeamCollectionOptions.leaderMcp` (`team/types.ts:90-99`) | **R** (§2.5) |
| `DispatcherAgentOptions.mcp` (`dispatcher-service/agent.ts:41-49`) | **R** (§2.5) |
| `TeamMateMcpScope.team` / `scheduler` suppliers (`agent/mcp.ts:105`, `scheduler/mcp.ts:64`, `dispatcher-service/mcp-delegates.ts:79-90`) | **R**: resolved per call on purpose; a captured handle answers for a closed Team |
| `ServerOptions.runtimeSocketSweep` (`server.ts:80-89`) | **R**: one host capability, invoked once, injected by the CLI and omitted by embedded servers |
| `ServerOptions.channelLoggerFactory` / `workflowLoggerFactory` and their forwarders (`server.ts:69-78`, `dispatchers/index.ts:42-43`, `dispatcher-service/index.ts:81-83`) | **R**: process composition supplies a scoped logger |
| `RestartIntentConsumer` `runControl`/`warn` (`dispatcher-service/restart-intent.ts:108,168`) | **R**: process-control boundary |
| `WorkflowServiceOptions.createRunner/runnerEntryPath/generateRunId/now`, `WorkflowRunDeps.createRunner/now` (`workflow-service/index.ts:55-67`, `run.ts:57-66`), `SchedulerServiceOptions.now`, `AdminSocketOptions.chmodFn/isPidAlive`, `TransactionalStoreOptions.load/encode`, `EnsureOwnerOnlyDirOptions.getuid`, `ExecDirProbe` | **R**: deterministic/OS test seams |
| `AgentRuntimePathContext.cacheDir/logsDir/runtimeSocketDirs`, `AgentRuntimeCreateContext.activity/state`, `CodexAgentRuntimeProviderOptions.codexProcessFactory/codexClientFactory`, `ClaudeCodeAgentRuntimeProviderOptions.sessionFactory/generateSessionId/resolveBinPath` | **R**: the neutral provider seam and its published embedder options |
| `CodexRuntimeDeps.allocateSocketPath`, `ClaudeCodeRuntimeDeps.resolveBinPath` | **V** |
| `CreateFeishuBotDeps.createTransport` (`feishu-channel/src/bot.ts:115-121`) | **D**: no production or test caller, not exported from the package barrel (`feishu-channel/src/index.ts`); `createFeishuBot` keeps only its options parameter |

### 3.3 Feishu package internals — **R**

The session constructs one aggregate of collaborators and hands three of them
its own operations: `submit` (`feishu-provisioning.ts:55-58`,
`feishu-document-comments.ts:94-98`), `deliver`
(`session/card-actions.ts:104-110`) and `notify`
(`routing/operations.ts:72-84`), plus `AskUserRegistryOptions.onExpire`
(`ask-user/registry.ts:231`) and the slash-command context's
`bindChannel`/`resolveChatName` (`session/session.ts:433-460`).

These are intra-aggregate capability injections, not cross-module ownership:
each child is constructed by the session, owns no independent lifecycle, and
every consumer is named. They are retained for this pass. §10 records the one
scope question this raises.

## 4. Fact semantics: initial state, listener lifetime, record-only close

- **Initial state.** A `teammate.state` is published at the commit and is never
  replayed. A holder that attaches after a commit does not see it — unchanged
  from today, where the owner's closure is bound before construction and the
  bus drops facts with no subscriber (`dispatcher-core-events/index.ts:120-140`).
  Concretely: channel sessions attach during `ChannelService.initialize`
  before any Agent is built (`lifecycle.ts:150-200`), and the Team router's
  subscription is held by a collection that exists before any Team does
  (`dispatcher-service/index.ts:262-300`).
- **Listener lifetime.** Channel sources keep their existing lease
  (`createSource`/`ScopedChannelEventSourceLease.revoke`,
  `dispatcher-core-events/index.ts:54-104`) and are revoked at
  `ChannelService.closeAll`. The Team router's subscription lives exactly as
  long as the collection, which is the dispatcher's lifetime; there is no
  per-Team lease to release.
- **Display demand.** The bus gains one distinction: the Team router must not
  make `hasSources()` true, or the conversation projection would start
  building and redacting input/activity events for a dispatcher with no
  Channel attached (`conversation-projection.ts:88,96`). `observe(subscriber)`
  is the core-holder registration and does not count; `createSource` keeps
  counting. `createSource`'s parameter is renamed `subscriberId` (it is only
  ever a log field, `index.ts:141-152`).
- **Ordering.** Today a Team publishes `teammate.state` and then `team.state`
  from one callback. Under the router, the Team's aggregate publication is
  nested inside the delivery of the member's fact, so a Channel observes
  `team.state` first iff it was registered after the router. It never is:
  channel sources register during `initialize`, before any Team materializes,
  and the bus iterates its registry in insertion order. The only in-repo
  consumer of `team.state` reacts to `status === 'closed'`
  (`cot/adapter.ts:501-506`, `session/session.ts:283`), and `teammate.state`
  has no in-repo consumer at all; this is recorded in the ledger rather than
  defended with machinery.
- **Record-only close** (`AgentEntityCollectionStore.closeUnbuilt`,
  `store.ts:413-417`, called for a Team member a dissolve never built,
  `agent/index.ts:567-590`). It writes through a member store, so it publishes
  by exactly the same rule as any other commit, with no materialized Agent and
  no extra path. Today it needs the collection's own `onPersisted` threaded
  into a bare store (`store.ts:355-380`); that note disappears.
- **Creation before a live Agent exists.** `AgentIdentityStore.create` is the
  first write of a new entity and publishes before `AgentService` exists —
  which is why the role must be a construction input (§2.1) and why the fact
  cannot be published by the entity.

## 5. Greenfield comparison

Built from zero, with the same product story, the model would be:

- one dispatcher-scoped live fact stream, already the shape
  `DispatcherCoreEventBus` has;
- Agent identity writes publishing `teammate.state` where the write commits;
- Team aggregates published by the Team from its own record, with the roster
  kept by observing member facts;
- each scope's gate being the scope object itself, with composition inside the
  owner's `admit`;
- hooks, recipients and MCP surfaces reached as objects where an object
  exists, and as values only where the value is produced later than the holder.

The current code is already 80% of that: the bus, the hooks, the gates, the
recipient keys and the per-scope collections all exist. Diffed against the
greenfield model, the *inversions* are precisely:

1. state publication travels owner-ward through four layers (§2.1),
2. the Team roster is updated by a callback into the Team instead of by a fact
   the holder observes (§2.2),
3. gates and hooks are arrows over objects that exist (§2.3-2.4),
4. two provider deps close over values their own deps already carry (§2.6),
5. `_teammates.createLocked` is double-fenced (§3.2).

No greenfield design would introduce a per-entity event object, a publisher
registry, a subscriber table or a wrapper per callback, and this proposal does
not either.

## 6. Changes by file (the end-to-end change)

| File | Change |
| --- | --- |
| `service/admission.ts` *(new)* | `AdmissionGate` structural type; add to the `service-primitives` layer list in `packages/dreamux/.dependency-cruiser.cjs` |
| `service/dispatcher-core-events/index.ts` | `observe(subscriber)` registration (does not count as display demand); `createSource(subscriberId)` rename; registry entry carries the kind |
| `service/agent/identity.ts` | add `agentStateEvent(role, identity)` |
| `service/agent/store.ts` | `AgentIdentityStore(binding, coreEvents, role)` publishes on commit; extract the read-only loader for `readAgentIdentity`; `AgentEntityCollectionStore` takes `coreEvents` + member role instead of `onPersisted` |
| `service/agent/runtime-state.ts` | drop the ctor `onPersisted`; the bound store publishes |
| `service/agent/factory.ts` | fixed `coreEvents`; `create/open/upsert` take `role`; drop `AgentEntityCallbacks.onPersisted`; compose `options` with `role` |
| `service/agent/service-types.ts` | `TeammateServiceDeps.onPersisted` → `coreEvents` |
| `service/agent/index.ts` | drop `onPersisted`/`isClosing` arrows for the gate; `role` constant for members; `closeUnbuilt` unchanged in behavior |
| `service/dispatcher-service/index.ts` | drop `publishAgentState` and `onDispatcherAgentPersisted`; pass the gate object; pass the `createTeam`/`team` hooks; drop the `createLocked` wrapper |
| `service/dispatcher-service/agent.ts` | drop `onPersisted`; `role` moves to the factory call |
| `service/dispatcher-service/mcp-delegates.ts` | gate object instead of `dispatch` arrows |
| `service/completion-router/index.ts` | `accepting` arrow → the gate object |
| `service/scheduler/index.ts`, `service/workflow-service/index.ts`, `run.ts` | `admit` → the gate object; `deliverTerminal` unchanged (a run's own owed fact) |
| `service/team/types.ts`, `leader.ts`, `service.ts`, `index.ts` | drop all four `onPersisted` hops, the `applyCreateTeamHook`/`announceTeam` arrows, and `admitOperation`/`isClosing`; add the gate, the hook objects, the one `admit` composition, the explicit leader seed in `createNew`, and the `live`/`starting` router |
| `agent-runtime/codex/src/{runtime-deps,provider,runtime}.ts` | delete `allocateSocketPath` |
| `agent-runtime/claude-code/src/{runtime-deps,provider,runtime}.ts` | `resolveBinPath` → `binPath` |
| `channel/feishu-channel/src/bot.ts`, `session/session.ts` | delete `CreateFeishuBotDeps` and `createFeishuBot`'s `deps` parameter |
| `.agents/domains/*`, package `CLAUDE.md`s | update the owning KB entry for each moved boundary (bus subscription, admission gate, agent module publication) |

No persisted shape, config field, command, MCP tool or CLI surface changes.
R43 still governs: no new tests, no repaired tests; the existing tests that
assert the old wiring (owner publication, `allocateSocketPath`, hook arrows,
`CreateFeishuBotDeps`) fail and are deleted with their contract logged in the
task's deleted-tests ledger.

## 7. Retained function-valued seams, with the reason

Each entry names the consumer and why the owner cannot hand over an object.

1. **`initiatorFor` / `completionInitiator`.** Consumer: the completion router
   delivering a settled turn (`agent/index.ts:980-990`,
   `workflow-service/index.ts:145,177-178`). The recipient Agent is created
   after the consumer (the dispatcher root is built at start,
   `lifecycle.ts:196-200`; a Team's leader after its collection) and is fixed
   for the consumer's life (R18). Every alternative is worse: an interface
   around it is a one-method wrapper, and a forwarding method on the holder is
   the pass-through R58 deletes. Accepted cost: this seam keeps two
   nullary functions in the two owner bags.
2. **`SchedulerServiceOptions.submitScheduled`.** Consumer: a due cron fire
   (`scheduler/index.ts:44-52`). The submission carries owner policy (source
   tag) and a late-bound recipient; the scheduler cannot perform it itself.
3. **`leaderMcp` / `DispatcherAgentOptions.mcp`.** Consumers: one leader's
   runtime construction (`team/leader.ts:96-120`) and the dispatcher Agent's
   (`dispatcher-service/agent.ts:146`). Both are value-producing factories for
   facts that do not exist at holder construction (§2.5).
4. **`options`/`align`/`reconcile` on `AgentServiceFactory`.** Values computed
   from the identity the write just produced; not owner state.
5. **`ServerOptions.runtimeSocketSweep`, logger factories, `runControl`,
   runner/`now`/`generateRunId`/`chmodFn`/`isPidAlive`/`load`/`encode`/`getuid`,
   `ExecDirProbe`, `importModule`, provider factories, `botFactory`.** Process,
   OS, filesystem or published embedder seams, never ownership.
6. **MCP `team`/`scheduler` suppliers.** Deliberately per-call lookups
   (`agent/mcp.ts:100-108`); a captured handle would answer for a closed Team.
7. **Feishu intra-aggregate injections.** §3.3.
8. **`WorkflowRunDeps.deliverTerminal`.** The run's own owed fact, bound once
   at construction (`run.ts:116,177-178`), not owner state threaded down.
9. **`AgentRuntimeCreateContext.activity/state`.** The neutral provider seam;
    the sinks are generation-scoped leases that must travel
    (`runtime-generation.ts:236-320`).

## 8. Preservation and feature-loss ledger

| Capability | Where it is preserved | Failure mode to check |
| --- | --- | --- |
| Post-commit publication, create/upsert unconditional, update only on status change | store-owned publish rule (§2.1) | a publish before/after the commit lands; a no-op update that publishes |
| Publication for an entity with no live Agent (creation) and for `closeUnbuilt` | §4 | role unavailable at create time; the record-only path losing its publish |
| Team roster (published `teammates`) and `team.state` on lifecycle change | §2.2 router + explicit leader seed | a leader or member missing right after create/rebuild; a roster that stops updating after a Team is tracked |
| Dispatcher/Team projections and per-owner completion recipients | unchanged recipients; `recipientKey` stability preserved (`team/service.ts:1069-1105`) | a completion delivered to the wrong owner; dedupe keyed differently |
| Admission and shutdown/dissolve fences, two-pass runtime sweep | gate semantics unchanged; only transport changes | a child fenced on one scope only; composition order inverted |
| Live sibling-worktree query | `findManagedWorktreeOwner` retained | a deleted managed worktree re-prepared into a path a sibling owns |
| Role-specific MCP/launch behavior and plugin hooks (R8, R48, R52) | hook objects passed; dispatcher-owned factories | a tap firing for a replay; `created` hook resurrecting |
| Non-blocking inbound (#63) and completion retry (R40) | untouched | added serialization in the provider seam |
| Feishu routing/access/session behavior | untouched beyond `createFeishuBot`'s dead parameter | the transport losing its injected logger (`feishu-bot-logger.test.ts`) |

Known, accepted, and recorded rather than defended: (a) the nested ordering
between a member fact and the Team aggregate (§4); (b) the display-demand
short-circuit is preserved by `observe` not counting toward `hasSources()`;
(c) the roster entry for a freshly created leader now comes from the explicit
seed in `createNew` instead of from the create hook, so the *number* of
published events is unchanged but their trigger inside the Team differs.

## 9. Public API implications

- **`@excitedjs/dreamux-types`: no change.** `TeammateStateEvent`,
  `TeamStateEvent` and `ChannelCoreEvent` keep their shapes; only who
  constructs them moves. `TeammateStateEvent.role` still comes from the owning
  materializer, stated as a construction input.
- **`@excitedjs/dreamux`: internal only.** `TeammateServiceDeps`,
  `TeammateCollectionOptions`, `TeamCollectionOptions`, `AgentServiceFactory`,
  `DispatcherCoreEventBus`, `SchedulerServiceOptions` are not exported from
  the package barrel; `DispatcherServiceOptions` keeps every published field
  (it gains no field).
- **`@excitedjs/agent-runtime-codex` / `-claude-code`: no change.**
  `CodexRuntimeDeps`/`ClaudeCodeRuntimeDeps` are package-internal
  (`codex/src/runtime-deps.ts:12-20`, `claude-code/src/runtime-deps.ts:1-20`).
  The published options (`codexProcessFactory`, `codexClientFactory`,
  `restartBackoff*`, `resolveBinPath`, `sessionFactory`, `generateSessionId`)
  stay, but the evidence is recorded: **no in-repository caller supplies
  them**, and their status as exports is not evidence of a requirement. A
  contraction of any of them is an operator decision, and this proposal
  recommends leaving it out of this pass because it changes published
  embedder contracts.
- **`@excitedjs/feishu-channel`: one internal contraction.**
  `CreateFeishuBotDeps` and `createFeishuBot`'s second parameter are deleted;
  neither is exported from the package barrel, and no caller exists. The
  published `CreateFeishuChannelProviderOptions.botFactory` (with
  `FeishuChannelSessionOptions.botFactory`, a test seam) stays: it is a
  published option, has real test consumers in this repository, and removing
  it would be a contract change.
- **`@excitedjs/dreamux-plugin-bootstrap`: untouched.**
- **Log field rename.** `DispatcherCoreEventBus`'s listener-failure log field
  `channel_id` becomes `subscriber` (`dispatcher-core-events/index.ts:141-152`),
  because a core holder can now be a subscriber. This is a log-shape change;
  no operator-facing surface reads it.

## 10. Verification of this design, and the decisions left

How the design is falsified (for the implementation review, not this round's
code):

- every `onPersisted` occurrence is gone: `rg -n onPersisted packages/dreamux/src`
  returns nothing outside an updated KB entry;
- every `teammate.state` literal is constructed in exactly one module;
- `dependency-cruiser` stays at `error` with the one new layer entry, and no
  new cycle appears;
- `.agents/scripts/check.sh`, plus `rush build`, `rush lint`, `rush test` and
  `rush typecheck:tests` on the branch;
- behavior probes named in §8, especially create-time publication, the
  record-only close, and a completion delivered to a leader after a member
  settles.

Two items are put to the TeamLeader rather than decided here:

1. **Scope of the Channel sweep** (not a product decision). The Feishu
   session's `submit`/`deliver`/`notify` injections are the same *shape* as the
   core defects but inside one aggregate with named consumers and no second
   owner. The convergence available is to invert them (the child returns the
   submission plan, the session performs it), which moves control flow on
   three real paths. Recommendation: keep the channel internal seams in this
   pass and schedule the inversion separately if the operator wants the same
   treatment there.
2. **`teammate.state` has no in-repo consumer.** It is published for every
   Agent and today nothing reads it (the COT adapter handles
   `teammate.input`, `teammate.activity` and `team.state` only,
   `cot/adapter.ts:132-149`). This proposal preserves it because it is a
   published channel contract. If the operator wants `ChannelCoreEvent`
   contracted, that is a product decision for a later round and not part of
   this ownership change.

No product behavior decision is required by the recommended change as
specified above.

---

# Cross-review round and revised position (appended 2026-09-29)

## 11. Purpose, inputs, and method of this round

The first-round proposal above is preserved unchanged. This appendix is the
single cross-review round. It re-checked every claim in
[source-audit.md](../source-audit.md) — including the second batch (Feishu
provisioning concurrency, startup-window recipient timing, the CLI's real
logger/sweep suppliers, and the command composition path) — against source,
read the Claude and MiMo proposals, and revises my position. Entries name the
source fact that changed my mind.

What this round is not: no new proposal, no second review round, no
implementation. The requirement, the rulings, and the authorized scope are
unchanged; every disputed fact below was re-derived from current source, and
the audit was treated as checkable evidence rather than as authority. §12
records what I accept and withdraw, §13 what I reject in the other two
proposals, §14 the resulting single design, §15 the dimensions
(ordering, failure and record-only paths, recipient timing and gates, MCP
lifetime, Feishu concurrency and initialization), §16 the public API, §17 what
was already authorized, §18 the one material disagreement, and §19 the only
operator decisions.

## 12. Accepted objections (source-verified; these change my proposal)

### 12.1 `createLocked` is not fenced — my deletion was wrong

`spawn`, `send`, `close`, `memberStatuses`, `status`, `history` and `last`
cross `this.opts.admitOperation` (`agent/index.ts:228,277,364,387,408,419,448`);
`createLocked` does not and calls `createFreshEntity` directly
(`agent/index.ts:252-262`). The dispatcher's
`teammates: { createLocked: (i, o) => this.admitOperation(() => this._teammates.createLocked(i, o)) }`
(`dispatcher-service/index.ts:296-300`) is therefore the **only** fence on a
dispatcher-scoped workflow agent. My §3.2 row marking it redundant (**D**) is
withdrawn: it is retained, and the Team-side asymmetry (a Team's
`WorkflowService` receives its collection directly, `team/service.ts:246-252`)
is the already-deferred `createLocked`-admission product item, not something
this pass may change.

### 12.2 The fence cannot be `DispatcherLifecycle`, and Team `admit` stays Team-only

Concrete order in `DispatcherService`'s constructor: `completionDelivery`
(:169) → `coreEvents` (:175) → `worktrees` (:180) → `agentServiceFactory`
(:200) → `channels` (:208) → `scheduler_` (:218) → `_teammates` (:231) →
`_teams` (:250) → `workflowService_` (:294) → `dispatcherAgent` (:309) →
`DispatcherLifecycle` (:327). The lifecycle is built **last** and receives the
collections, so no earlier child can be given it; the audit is right that an
interface alone does not resolve that cycle.

The entry points also differ, and the difference is load-bearing: the Team's
three children get the composed Team-then-dispatcher fence
(`team/service.ts:233,253,269`), while `TeamService.admit` is Team-only
(`team/service.ts:580-592`) and is what the leader-completion recipient
(`:1069-1090`) and `interruptLeader` (`:875`) use. `CompletionDeliveryPolicy`
reads dispatcher acceptance before queueing and never retracts a queued
delivery (`completion-router/index.ts:110-130`). Folding the dispatcher fence
into `TeamService.admit` — my §2.3 — would newly refuse leader completions
during a dispatcher stop. Withdrawn.

**Revised.** One fence value is created first, with a holder view
(`admit`/`isClosing`) and an owner view (`assertOpen`/`close`/`drain`); the
holder view goes to every dispatcher-scoped child, the owner view to
`DispatcherLifecycle` in its present position. `TeamService` implements the
holder view with today's body and hands its children one nested composition
built once (Team then dispatcher), replacing the three copied lambdas. The
fence module belongs in `platform/`, so my §6 row claiming a new
`service-primitives` entry for it is dropped.

### 12.3 The dispatcher agent's MCP supplier: my stated reason was false

`channels` is constructed at `dispatcher-service/index.ts:208`, before the
`DispatcherAgent` holder (:309), so "the channels do not exist yet" is wrong.
An eager value is also wrong: `ChannelService.mcpDelegates` evaluates
`sessionMcp: this.sessionMcp(channelConfig.id)` at assembly time
(`channel-service/index.ts:326-334`) and `entries` is empty until `build()`
(`:150-176`), so assembling before the channel build would freeze
`sessionMcp: null` and silently drop every session-backed channel tool.

**Revised.** Keep the timing (assembly at `build()`), delete the supplier:
`DispatcherAgent` receives the objects the assembly needs (`mcpLeases`,
`adminSocketPath`, `channels`, and the dispatcher's structural view) and calls
`dispatcherAgentMcpDelegates` inside `dispatcherOptions()`, where it calls
`this.opts.mcp()` today (`dispatcher-service/agent.ts:113-146`). The import
cycle the structural view avoids (`mcp-delegates.ts:23-40`) is unchanged.

### 12.4 My bus-router for the Team roster is withdrawn

Three source facts kill it. (a) `TeamCollection` is constructed at
`dispatcher-service/index.ts:250`, while channel sources register later, in
`ChannelService.initialize` inside `DispatcherLifecycle.doStart` — so a
collaborator registered by the collection precedes every channel source and a
nested `team.state` from its handler would reach channels before the outer
`teammate.state`. My §4 ordering claim was false. (b) `hasSources` is channel
display demand (`conversation-projection.ts:88,96`) and channel leases carry
the channel's revocation lifetime (`channel-service/index.ts:373-375`); an
internal observer must join neither. (c) Routing only to `live`/`starting`
cannot see the leader's create commit, which happens inside
`TeamService.createNew` before `TeamCollection.createTeam` registers the Team
(`team/index.ts:636-661`), so the failure-path roster and the intermediate
aggregate the requirement names would be lost.

**Revised.** No internal subscriber on the dispatcher's channel bus. Each
scope owner owns one identity event channel created first in its own
construction; the store bound to that channel publishes at commit; the owner
subscribes in its own constructor, always before any store of its scope is
bound or written. The listener bodies are today's `publishAgentState` and
`TeamService.publish` verbatim.

### 12.5 The failure-path premise, and the startup window

The audit's premise is that a launch hook "can reject after persistence and
before the factory returns an Agent". I checked: `launchDraftTaps` wraps every
tap and every plugin-added interceptor, catching throws and rejections and
reporting them (`plugin/hooks.ts:330-360`), so a throwing
`launch`/`leaderLaunch`/`teammateLaunch` tap does not reject
`AgentServiceFactory.create`. The window is real — the commit precedes
`options(identity)` (`agent/factory.ts:104-140`) — but no reachable rejection
inside it could be established. Recorded as a resolved factual point; the
commit-adjacent design is chosen because it is insensitive to the window
either way, whereas Claude's post-`create` roster update is sensitive to it.

The **startup window is a separate, reachable behavior path** and I now mark
it: `Server.start` opens the admin socket before starting dispatchers
(`server.ts:252-264`), and three entry points resolve the recipient *before*
they submit — `spawn`/`send` through `resolveCompletionDelivery` →
`initiatorFor` → `DispatcherAgent.mustAgent()` (`agent/index.ts:980-990`), and
Workflow run creation through `completionInitiator()` (`workflow-service/index.ts:145`).
Today an unprepared dispatcher agent makes those calls throw. A stable
recipient value postpones the read to delivery, so they succeed and only the
completion is dropped by the policy's existing rejected-preparation branch.
The audit says this change "is not required merely to remove a supplier
closure"; it is therefore listed as an own-standing behavior change (§19), not
as part of the closure cleanup.

### 12.6 Completion recipients: accept owner objects; carry the recipient as a value

R18's open item establishes that a producer's recipient never varies per
submission, and the audit's rule — later creation does not by itself justify a
supplier — applies to `initiatorFor`, `leaderCompletionInitiator` and
`completionInitiator`. Accepted: `TeamService implements CompletionInitiator`
with its present body (fence, unavailable mapping and stable key are real
policy, not a forward), `DispatcherAgent implements CompletionInitiator`, both
travel as values on the submission, and `CompletionDeliveryPolicy` is bound
once by `AgentServiceFactory` beside `AdmissionLedger`. `TurnCompletionDelivery`,
`AgentService.send`'s `resolveCompletionDelivery`, the collection's own
`resolveCompletionDelivery`, `WorkflowRunDeps.deliverTerminal` and
`recipientKey` all go.

The one forwarding method this introduces — `DispatcherAgent.prepareCompletion`
because the dispatcher Agent is built at start — is named and accepted against
R58 for a stated reason: the alternative is not an object but the closure this
change deletes, and the closure form additionally forces a per-turn delivery
function (`TurnCompletionDelivery`) through three objects. It is the same
holder the code already treats as the stable answer (`mustAgent()`).

### 12.7 `findManagedWorktreeOwner`: accept the store-tier query

The query is a pure read over the collection root (`agent/index.ts:806-822`
calls `this.store.list()`), reached through five carriers and three
self-wrapping arrows. Accepted: the sibling store answers it, the collection
passes that store into the entity construction, and an owner-root entity
(dispatcher root, TeamLeader) passes `null` — matching today, where both are
constructed without the callback (`dispatcher-service/agent.ts:88-112`,
`team/leader.ts:150-175`) and neither can hold a managed worktree.

### 12.8 Feishu is in scope, and the provisioning concurrency boundary decides its shape

My first round classified the Feishu arrows as intra-aggregate and retained
them; the audit is explicit that they are inside the continuation, so that
call is withdrawn. The second batch of evidence also rules out Claude's
"provisioning returns the Team to submit to" shape:

- `provisionForInbound` stores the whole `guarded(input)` promise in
  `inFlight`, and a later message waits on it before `deliverAfterRun`
  (`feishu-provisioning.ts:96-116`). Returning only a provisioned Team
  releases those waiters before the first submission settles.
- `guarded` does `return await this.run(input)` inside its `try`
  (`feishu-provisioning.ts:128-143`) and `run` ends with
  `return this.opts.submit(...)` (`:200,215`), so a rejection from the first
  submission *is* caught today and becomes `unsubmitted`. Claude's ledger row
  claiming the submit sits outside that catch is false, and moving the submit
  out of the guarded operation would change that outcome.

The ownership fix that keeps both properties is a two-way split, not one
object:

- **`FeishuSubmitter`** (or an equivalent named collaborator) owns `submit`: the
  liveness check, the COT anchor claim, `commands.teamSubmit`/`dispatcherSubmit`
  and the no-admission classification (`session/session.ts:400-433`), built
  from `lifecycle`, `cot` and `commands`.
- **A delivery collaborator implementing the existing `FeishuInboundDelivery`**
  (`inbound/pipeline.ts:64,89`) owns `deliver` (routing plan, the provision
  branch, the stale-route fallback, `:467-503`) and `command`; it holds
  `provisioning`, `routing`, `bindings` and the submitter.

`FeishuProvisioning` holds the **submitter**, not the delivery object, so
`delivery → provisioning → submitter` has no cycle and the submission stays
inside `guarded` and inside `inFlight`. `FeishuDocumentComments` holds the
submitter; `FeishuCardActions` and the inbound pipeline hold the delivery
collaborator (`session.ts:762` becomes the object). The remaining arrows in
the same family collapse to values or existing objects: `cotClient` becomes
`bot.cot`, whose client the transport factory already created
(`feishu-transport/src/transport/feishu.ts:554`); `announce` becomes the
`bindings` object; `notify`/`sendNotification` move into `FeishuOutbound`,
which already owns the transport and the lifecycle; the slash-command context
takes `bindings` and `bot`; `onExpire` becomes a registry event observed by the
card-action owner. `createFeishuCoreCommands((c, p) => this.invoke(c, p))`
stops being an arrow to the session: the late `JsonInvoker` — which genuinely
arrives at `initialize` — is held by the commands object, its only reader,
which keeps today's refusal before that point.

Verified that nothing else needs the session's copies: the only callers of
`session.submit`/`deliver`/`command` are the deleted arrows
(`session.ts:236,245,259`), the session's own `deliver` body (`:477,487,498`),
the pipeline's `delivery` handle (`:762`) and the card-action `deliver`
(`session/card-actions.ts:341`). No pass-through method on the session is
needed.

### 12.9 The CLI's logger and sweep suppliers are real; keep the API, delete the forwarding

`cli/server.ts:77-81` supplies all three, so they are not dormant seams and
Claude's `fileLogs`/`sweepRuntimeSockets` booleans would contract a published
construction API (`ServerOptions`; the package's `main` is `dist/server.js`)
with a live in-repo consumer. Withdrawn on my side is only the *forwarding*:
`channelLoggerFactory`/`workflowLoggerFactory` travel Server →
`service/dispatchers/index.ts` (`:45-46,68-71,87-88,234-235`) →
`service/dispatcher-service/index.ts` (`:99-100,174,212,282`) →
`service/channel-service/index.ts` (`:68,157`) purely to defer a `dispatcherId` that
`Dispatchers.dispatcherOptions(id)` already holds at materialization
(`dispatchers/index.ts`). Resolve both there and pass logger **values** down:
the CLI's file loggers, their paths, their laziness (a dispatcher's loggers are
created when that dispatcher materializes) and the defaults
(`workflowLog = workflowLogger ?? dispatcher log`) all stay as they are, and
the forwarded function fields and their private copies disappear.
`runtimeSocketSweep` is already one hop and stays exactly as it is.

### 12.10 The omitted command composition path

My first round did not cover it; the audit is right that a complete sweep must.
The path is: `Server.commandHost()` returns an object literal whose four
lookups are arrows over `this.dispatchers_`
(`server.ts:192-205`) → `new CoreCommandPort(createCoreCommandRegistry(host))`
(`:181-183`) → `server/command-catalog.ts` derives
`dispatcher = (context) => mustDispatcher(host, context)` and per-domain
resolver arrows (`(context) => dispatcher(context).teams`, etc.,
`command-catalog.ts:45-70`) → each domain's `xCommands` factory → the domain
`execute` handlers, which are real Command implementations.

Classification, with the cycle stated:

- The **`execute` handlers and the per-domain factories** are the command
  implementations themselves, reached by name through one registry; nothing
  about them is a closure seam. Retained.
- The **per-context resolvers** (`(context) => dispatcher(context).teams`) are
  call-time narrowing of the caller's stated `dispatcher_id` — the invocation
  context is a genuine per-call input (`server/command-host.ts:57-72`).
  Retained.
- The **host lookups** are late-bound lookups of the dispatcher collection,
  and they are load-bearing: `CoreCommandPort` must exist before `Dispatchers`
  is constructed in `Server.start()` (`server.ts:214-231`) because
  `Dispatchers` receives that port and hands it to every `ChannelService`, while
  the registry's own host must resolve dispatchers *by id* out of that same
  collection. The current break — accessors reading `this.dispatchers_`, which
  throws "server has not started" before then (`server.ts:136-146`) — is the
  only break available without moving `createCoreCommandRegistry` out of its
  composition tier (it imports every domain's `commands.js`, so it cannot move
  earlier). Retained, with the reason stated here rather than omitted.
- The **removable part** is the re-wrap layer: `dispatcherCommands({ summarize:
  () => host.summarize(), dispatcherRuntimeStatus: (id) =>
  host.dispatcherRuntimeStatus(id), ... })` duplicates host methods that need
  no adaptation (the fourth, `mustDispatcherConfig(host, id)`, adds the
  not-found policy and stays). Those two arrows collapse to direct references;
  `dispatcher` stays because it is the shared resolution policy.

### 12.11 Test evidence: my §6 sentence was over-claimed

No current test references `onPersisted`, `admitOperation`, `initiatorFor`,
`leaderMcp`, `submitScheduled`, `deliverTerminal`, `CompletionDeliveryPolicy`,
`allocateSocketPath`, `resolveBinPath` or `createTransport`; the only mentions
of `deps.createTransport` and `botFactory` are a comment
(`feishu-channel/tests/feishu-bot-logger.test.ts:6`) and a doc claim
(`bot.ts:30-33`), not consumers. Predicting a failure is not evidence, so my §6
sentence is replaced: at implementation, a seam a current test actually
supplies is not deleted, and any test a concrete change breaks is reported with
its contract before it is deleted under R43.

Verified current consumers that must stay:
`LegacyAdminServerCheckOptions.isPidAlive` (`tests/run-dir-hardening.test.ts:105`),
`AdminSocketOptions.isPidAlive`, `EnsureOwnerOnlyDirOptions.getuid`.
Verified dead seams (no source or test supplier anywhere):
`SuffixGenerator`/`nameSuffixGenerator`/`agentNameSuffixGenerator`
(`team/types.ts:105-106`, forwarded `team/service.ts:220,266`),
`WorkflowServiceOptions.createRunner/generateRunId/now`,
`CompletionDeliveryPolicy.attemptTimeoutMs`, `AskUserRegistryOptions.newRequestId`.

## 13. Rejected arguments, with reasons

**R1 — Claude's `UnbuiltAgent` two-phase factory (rejected).** It adds a class,
splits every factory entry into "resolve" + "build", relays through
`AgentService` and `TeammateCollection`, and moves the Team roster update off
the commit. The scope-owned identity channel reaches the same deletions — six
`onPersisted` carriers, the factory callback type, the store parameter,
`afterIdentityStatusChange` — with one small value where a callback was and no
new class. Per the whitepaper, it is a bigger compensator than what it
replaces.

**R2 — deleting `options(identity)` and `align` (rejected).** `options` is the
factory's own build step over the just-committed identity; `align` is a
one-call ownership predicate. Both are call-scoped values, and both survive
without the two-phase restructure. `reconcile` stays for the same reason in all
three proposals.

**R3 — moving the TeamLeader's MCP assembly into the Team (rejected for this
pass; the one material disagreement, §18).** It deletes four real forwarding
surfaces (`TeamsPort.leaderScope`, `TeamsPort.runForLeader`,
`TeamCollection.admit(teamId)`, `TeamService.leaderScope`) but requires a new
`ChannelMcpSource` type, moving `createTeamMcpDelegate` out of the
`service-team` collection tier so `TeamService` may import it (the
`service-team-core-not-to-collection` rule forbids today's placement), and it
changes which fence refuses first for a leader's channel tool call (today
dispatcher then Team, `team/index.ts:520-522`). Adopted instead: one assembly
object holding the assembly's fixed context, with `{teamId, leaderName}` as its
call input, replacing `leaderMcp`'s three carriers and `DispatcherAgentOptions.mcp`.

**R4 — deriving `role` from names in the listener (MiMo, rejected).** The
identity vocabulary keeps role out of the record (`agent/identity.ts:41-55`).
The fact carries the role its store binding was created for, so no listener
re-derives anything and both listener bodies stay verbatim.

**R5 — "return the plan" for Feishu provisioning (Claude, rejected).** §12.8:
it releases `inFlight` waiters before the first submission settles and moves a
submit rejection out of `guarded`'s catch.

**R6 — contracting `ServerOptions`' logger and sweep functions (Claude,
rejected).** The CLI supplies all three (`cli/server.ts:77-81`); the audit asks
for separate accounting for a contraction with a real consumer. Resolving the
loggers where the id is known (§12.9) removes the forwarding without touching
the API.

**R7 — the test-seam sweep as written (rejected as over-broad).** §12.11 gives
the per-seam evidence.

## 14. The one coherent revised design

This table supersedes the corresponding rows of §2 and §3; every other §3 row
stands as written, with 12.1-12.11 applied.

| Concern | Owner | Mechanism |
| --- | --- | --- |
| an Agent's committed identity | `service/agent/` (the committing module) | a scope-owned identity event channel; the store bound with `{channel, role}` publishes at commit under the existing create/upsert-always, update-on-status-change filter; the scope owner subscribes once in its own constructor and keeps today's body |
| dispatcher `teammate.state` | `DispatcherService` | its own subscription to its own channel |
| Team roster and `team.state` | `TeamService` | its own subscription; `seedMembers` and the explicit leader remember stay |
| completion recipient | the owner object (`TeamService`, `DispatcherAgent`) implementing `CompletionInitiator` | travels as a value on the submission; the policy is bound once by `AgentServiceFactory` |
| work fence | one fence value created first | holder view to dispatcher-scoped children; owner view to `DispatcherLifecycle`; the Team keeps its Team-only `admit` and one nested child fence; the dispatcher `createLocked` wrapper stays |
| role tools | the dispatcher's assembly, at `build()` | `DispatcherAgent` receives its inputs as objects; the leader's surface comes from the assembly object with `{teamId, leaderName}` |
| plugin hooks | `DispatcherService.hooks` | `createTeam`/`team` objects passed as `teammateLaunch` already is |
| cron fires | `SchedulerService` states its own provenance | submits to a `submitInput` target the owner implements; the Team's entry is `submitInput`, the dispatcher's is `DispatcherAgent` |
| sibling occupancy | the agent store tier | query over the collection-root store value |
| provider internals | each provider package | socket from `paths`; bin resolved in `createRuntime` |
| Feishu submission and delivery | a submitter collaborator + a delivery collaborator implementing `FeishuInboundDelivery` | provisioning holds the submitter (boundary preserved); notice send moves to `FeishuOutbound`; `bindings`, `bot`, `bot.cot` passed as objects/values |
| per-dispatcher loggers | `Dispatchers.dispatcherOptions(id)` | the CLI's factories are called where the id is known; values travel down |

**Concrete construction order, dispatcher.** fence → completion policy (holds
the fence) → core events → worktrees → names → `AgentServiceFactory` →
`channels` → `DispatcherAgent` (holder only; its Agent is still built at start
by `DispatcherLifecycle.doStart`) → `scheduler_` (cron target =
`DispatcherAgent`) → `TeammateCollection` (fence, the dispatcher's identity
channel, recipient = `DispatcherAgent`) → `TeamCollection` (same, plus the hook
objects, the assembly inputs, and `DispatcherAgent` as the leader recipient) →
dispatcher `WorkflowService` (fence, recipient, the retained `createLocked`
wrapper) → `DispatcherLifecycle` (owner fence view plus exactly today's
collaborators). `DispatcherAgent` moves ahead of the collections because it is
now their recipient; everything it needs at construction (the channel service,
the factory, the leases, the socket path and the dispatcher's structural view)
already exists at that point, and its assembly still runs at `build()`.

**Concrete construction order, Team.** identity channel → member collection
(nested child fence, recipient = `this`) → workflow (nested child fence,
recipient = `this`) → scheduler (nested child fence, target = `this`) → leader
store binding over the same identity channel. `TeamService.admit` keeps its
Team-only body.

**Entropy accounting.**

| Removed | Count |
| --- | --- |
| `onPersisted` carriers (options fields, factory callback type, store parameter, three store call arguments, `afterIdentityStatusChange`) | 12 |
| admission closures (carriers plus the three duplicated Team compositions) | 9 |
| recipient suppliers and delivery closures (`initiatorFor`, `leaderCompletionInitiator`, `completionInitiator`, `TurnCompletionDelivery`, `resolveCompletionDelivery` ×2, `deliverTerminal`, `recipientKey`, `leaderRecipientKey`) | 9 |
| MCP assembly closures (`mcp`, `leaderMcp` ×3) | 4 |
| hook wrappers (`applyCreateTeamHook`, `announceTeam` ×2) | 3 |
| `submitScheduled` ×2, `findManagedWorktreeOwner` carriers plus three arrows, `allocateSocketPath`, `resolveBinPath` | 8 |
| logger-factory forwarding fields and the two catalog re-wrap arrows | 8 |
| Feishu arrows (`submit` ×2, `deliver`, `notify`, `announce`, `cotClient`, `invoke`, the command-context arrows) plus the two dead seams | 10 |

| Added | Paid for by |
| --- | --- |
| one fence value with a holder/owner split (state moved, not created) | 9 admission closures |
| one identity event channel per scope | 12 publication carriers |
| `role` as a factory call input | the owner-side publishers |
| one nested-admission composition | 3 duplicated compositions |
| one MCP assembly object with its fixed context | 4 assembly closures |
| `CompletionInitiator` implemented by two existing owners | 9 recipient/delivery carriers |
| two Feishu collaborators (submitter, delivery) replacing the cycle | 10 Feishu arrows |

No addition introduces a noun the operator has not already used, and no
addition is a one-method wrapper over one of the removed closures: the fence,
the assembly and the two Feishu collaborators are existing owner objects or
objects whose methods carry today's bodies.

## 15. Verification of the dimensions this review was asked to cover

**Event ordering.** The scope owner's subscription is attached in its own
constructor, before the first store of that scope is bound, so every commit is
observed exactly where today's callback runs — inside the store's after-commit
step — and `teammate.state` still precedes the `team.state` derived from the
same commit, because one listener body emits them in that order
(`team/service.ts:907-945`). No shared registry is involved, so the audit's
nested-delivery ordering hazard cannot arise.

**Failure and record-only paths.**

| Path | Today | Revised |
| --- | --- | --- |
| `closeUnbuilt` for an unbuilt member | collection hook publishes through the member store (`store.ts:413-417`) | the member store's binding carries the Team's channel; same fact, no hook |
| creation before a live Agent (spawn, `createLocked`, leader create, dispatcher upsert) | callback fires at commit, before options/launch run | identical step |
| a leader create that later abandons the Team | the committed leader is in the roster, so the closed aggregate lists it | identical: the commit fired before any later failure |
| a member closed by `closeAfterFailedCreation` | commit then close, roster twice | identical |
| rebuild with a restored leader | `open` writes nothing; the Team remembers explicitly (`team/service.ts:512-520`) | unchanged |
| recovery `settleTeamWorktreeCleanup` | record-only, no identity write, no event | unchanged |

**Completion recipient timing and gates.** Delivery-time preparation and the
dispatcher acceptance check keep their order: `CompletionDeliveryPolicy` reads
acceptance before folding or queueing and never retracts a queued delivery
(`completion-router/index.ts:110-130`); the Team's recipient keeps its
Team-only fence and its `unsupported` mapping, so a queued leader completion is
still not refused by a dispatcher stop. The changed entry points are the three
in §12.5, listed for the operator.

**MCP lifetime and assembly.** Assembly must run after `channels.build()`
because `sessionMcp` is snapshotted then (`channel-service/index.ts:333`);
`DispatcherLifecycle.doStart` already builds and initializes channels before
calling `DispatcherAgent.build()` (`lifecycle.ts:150-200`). One mint per
runtime generation, released before native teardown, is untouched
(`mcp/leases.ts`, `runtime-generation.ts:236-320`). With R3 rejected, the
leader's per-call Team lookups stay lookups, so no stale Team handle is
captured, and the assembly object holds only dispatcher-lifetime
collaborators.

**Feishu provisioning concurrency and initialization.** `inFlight` still
holds the whole guarded operation including the first submission;
`deliverAfterRun` still waits on it and re-reads the current binding; the
create→bind→announce→submit order, the `unsubmitted` outcomes and the
first-submit rejection path are unchanged (§12.8). Initialization is unchanged:
the commands object holds the late `JsonInvoker` and refuses before
`initialize`, as the session's field does today; the COT anchor claim stays
inside `submit`, now the submitter's.

**Startup window.** Named in §12.5 and put to the operator in §19.

## 16. Public API implications of the revised design

Compared with §9:

- **`ServerOptions` of `@excitedjs/dreamux` is no longer contracted.** The
  CLI is a real consumer of all three functions; §12.9 removes the forwarding
  only. No `minor` note is needed for `@excitedjs/dreamux` beyond the ordinary
  note for the internal option changes.
- **`@excitedjs/agent-runtime-codex` / `-claude-code`**: deletion of the two
  published provider option bags is proposed; plain `minor` note, no
  `BREAKING:`/`Rebuild:` because no persisted file or config shape changes.
- **`@excitedjs/feishu-channel`**: `CreateFeishuBotDeps` (not exported) is
  deleted; `CreateFeishuChannelProviderOptions.botFactory` is proposed for
  deletion on the same evidence (no in-repo consumer; the doc claim in
  `bot.ts:30-33` is false today). Plain `minor` note; Dreamux-internal
  package.
- **`@excitedjs/dreamux-types`: no change** — event shapes, provider
  contracts and persisted formats are untouched.
- Mechanical, reported not silent: the stale comment at
  `feishu-channel/tests/feishu-bot-logger.test.ts:6`.

## 17. Already authorized scope, and routine choices

The continuation's development approval (R69/R71) covers the architecture
work itself: the fence split and its `platform/` placement, the scope-owned
identity channel, the assembly object, the store-tier occupancy query, the
Feishu submitter/delivery split, the catalog re-wrap collapse, and the logger
forwarding removal are routine implementation choices inside it, with §15 as
their acceptance checks. The deferred product items stay deferred:
`createLocked` admission asymmetry, live `last`/activity config resolution,
and the rest of the previous follow-up's list are not decided here.

## 18. Remaining material disagreement

One, recorded rather than smoothed over: **who assembles a TeamLeader's MCP
surface** (§13 R3). Claude moves it into the Team and deletes four forwarding
surfaces, at the cost of one structural interface, one dependency-tier file
move and one admission-order change; MiMo and I keep it in the dispatcher's
assembly object with `{teamId, leaderName}` as its call input. Both preserve
behavior; they differ in how much of the Team's own surface the dispatcher
still reaches. It is a routine design choice with no product decision inside
it, and the TeamLeader owns it.

## 19. Required operator decisions, and what is not one

Only two items need the operator; everything else in this appendix is either
routine implementation inside the authority R69/R71 already granted (§17) or
a recorded factual resolution (§12).

1. **Published provider and channel option contraction** (contract decision).
   Deleting `CodexAgentRuntimeProviderOptions`,
   `ClaudeCodeAgentRuntimeProviderOptions` and Feishu's `botFactory` is
   supported by zero in-repo consumers, and the audit separates export status
   from caller evidence. Recommendation: delete, with the change notes in §16
   — one story for both packages rather than two. The alternative keeps them
   as named dormant surface, which waives "no mechanism without a named
   scenario" for them by name.
2. **Startup-window recipient timing** (observable behavior). Today an
   unprepared dispatcher agent makes a dispatcher-scoped `spawn`, a `send`
   reopen, and a Workflow run creation fail; carrying the recipient as a value
   makes them succeed, with only the completion dropped by the policy's
   existing rejected-preparation branch. Recommendation: accept, and put the
   three paths in the deferred final coverage work. The alternative — an
   explicit readiness read at those three sites — preserves an incidental
   failure with new machinery, and the audit states that changing this timing
   is not required by the closure cleanup, so either way it is an explicit
   choice rather than a side effect.
