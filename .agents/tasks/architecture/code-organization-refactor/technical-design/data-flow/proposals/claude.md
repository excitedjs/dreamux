# Data-flow ownership proposal (Claude)

Independent first-round proposal for the
[data-flow continuation](../../../artifacts/data-flow-follow-up.md). Baseline:
PR #457 merged into the PR #453 branch. Inputs: the continuation, the
[baseline inventory](../../../artifacts/data-flow-inventory.md),
[requirement](../../../requirement.md), [rulings](../../../rulings.md) (R43,
R57–R71), the [product catalog](/.agents/product/README.md), and current
source. Nothing here is an operator ruling; §8 lists what needs one.

## 1. Premise and method

The premise this proposal rests on, verified at source: almost every
function-valued construction seam exists for one of three reasons, and each
has a root fix that deletes the seam instead of re-typing it.

1. **Construction order is inverted.** `DispatcherService` builds children
   before the scope objects they need (the work fence lives in
   `DispatcherLifecycle`, built last; the Dispatcher Agent handle is built
   after the collections that report to it). Every `(task) =>
   this.admitOperation(task)`, `() => this.inputSources.isClosing()` and
   `() => this.dispatcherAgent.mustAgent()` is a forward reference. Fix: build
   the scope owners first and hand the objects down.
2. **A fact is published by the wrong owner.** `teammate.state` is published
   by Dispatcher and Team, so their publish methods are threaded down six hops
   (`onPersisted`) to the identity store that actually commits the fact. Fix:
   the agent module publishes its own fact; the caller that caused a commit
   gets the committed identity as the call's result; holders that keep a
   projection (only the Team roster) observe later commits on the objects
   they already hold.
3. **The seam has no consumer.** Provider/bot factories, suffix/run-id/clock
   generators, and logger factories are injected by no repository caller, or
   carry a value fixed at construction. Fix: use the value, or delete.

Method: every row of the baseline inventory plus every inline closure found
while tracing (§3) was followed producer → captures → hops → consumer, and
given one disposition: **delete**, **owner object** (the authoritative owner
itself is passed, never a new wrapper), **value** (fixed at construction),
**event** (owner publishes, holder observes), or **retain** with a named
consumer and the reason its owner cannot provide the capability directly.

## Historical boundary rationale

History checked before moving boundaries (whitepaper §4):

- `3b3a61e3` (#455) folded the standalone `DispatcherTaskDrain` into
  `DispatcherLifecycle`. The fold removed the double gate
  (`run` + `assertNotShuttingDown`) and `openAdmission` (no in-process
  restart); it did not remove the closures, which already existed on the
  standalone drain (`accepting: () => this.admittedTasks.accepting`,
  `admitOperation: (task) => this.admitOperation(task)` at `3b3a61e3^`). §2.A
  keeps both of the fold's removals and changes only where the fence object
  lives and how children receive it.
- `71316ab9` (#391) introduced reading the dispatcher fence in
  `CompletionDeliveryPolicy` and never retracting a queued delivery. §2.B
  keeps both rules.
- `2ed5f5ea` (#350), `3b3a61e3` (#455), `9c119d08` (#457) introduced and
  narrowed `onPersisted`; #455/#457's stated rationale
  (`service-types.ts`: "each a different owner — so the caller … passes its
  own publish hook") is superseded by R71 ("onPersisted 这种状态同步为啥不能用
  eventEmitter 来做呢？").
- `leaderMcp` dates from the first TeamLeader tool wiring (`c88ec2e2`,
  `c32cca44` #317) and survived #380, #390, #455 and #457 on the premise
  recorded at `TeamCollectionOptions.leaderMcp`: "every object those servers
  reach … is dispatcher-owned, so the dispatcher assembles them". Every leader
  tool except the Channel ones reaches a Team-owned object, so §2.E moves
  their assembly to the Team and keeps only the Channel delegates crossing the
  layer, through the ChannelService object.

## 2. Ownership model (greenfield vs current)

The greenfield object graph, per owner cluster. Each cluster states what the
current graph does and the change.

### A. Work fence: the closing scope owns it

- **Greenfield.** A scope that can close owns one fence object; every child it
  builds receives that object. A nested scope's fence composes its parent's.
- **Current.** The Dispatcher fence (`closed` + `admittedWork`) sits inside
  `DispatcherLifecycle`, built last, so these closures forward to it:
  `TeammateCollectionOptions.admitOperation/isClosing`,
  `TeamCollectionOptions.admitOperation/isClosing` (forwarded unchanged into
  `TeamServiceDeps`), `WorkflowServiceOptions.admit`,
  `SchedulerServiceOptions.admit`, `CompletionDeliveryPolicy.accepting`,
  `ChannelService.initialize/start(assertAvailable)`,
  `channels.mcpDelegates(caller, dispatch)`, and the pass-through
  `DispatcherService.admitOperation` (R58 forbids that shape). `TeamService`
  composes three identical lambdas `(task) => this.admit(() =>
  deps.admitOperation(task))` plus `() => this.isClosing() ||
  deps.isClosing()`.
- **Change.** `platform/work-fence.ts` declares the holder view
  `interface WorkFence { admit; isClosing }` and the owner view
  `interface OwnedWorkFence extends WorkFence { assertOpen; close; drain }`,
  created by `createWorkFence(refusalMessage)` — the same holder/owner split
  `FeishuLifecycle`/`OwnedFeishuLifecycle` already uses. It holds exactly the
  state moved out of `DispatcherLifecycle` (`closed`, `admittedWork`, and the
  bodies of `admit`, `isClosing`, `assertAvailable`) — no new state, no
  reopen. `DispatcherService` creates it first; `DispatcherLifecycle` receives
  the owner view and calls `close()`/`drain()`/`assertOpen()`.
  `TeamService implements WorkFence`: `admit` = own check then
  `deps.fence.admit(task)`, `isClosing` = own or parent — the exact
  composition the three lambdas express today. Children receive `fence:
  WorkFence` (the Dispatcher's, or the TeamService itself). The name avoids
  "admission", which already means dedupe (`AdmissionLedger`), a turn outcome
  (`TurnAdmission`) and a provider answer (`RuntimeAdmission`); "work fence"
  is the term `TeamService.admit` already documents itself with.
- **Team-only uses keep the Team-only check.** `TeamService`'s leader
  completion recipient, `submitInput` (formerly `submitToLeader`) and
  `interruptLeader` are always reached inside dispatcher admission already or
  must not be refused by it (a queued leader completion is never retracted,
  #391). They use a private `assertOpen()` (the current `admit` body without
  a task). `dissolve` stays ungated so a second submission still joins.
- **Deferred asymmetry retained.** The Dispatcher Workflow's
  `teammates: { createLocked: … admitOperation(…) }` wrapper stays. Removing
  it means gating `createLocked` in the collection, which also changes the
  Team path — the deferred item "Workflow `createLocked` bypasses collection
  admission". §8 item 3.

### B. Completion recipients: the owner is the recipient object

- **Greenfield.** Whoever owns a producer names one stable recipient object;
  the dispatcher-scoped delivery policy is bound once where entities are
  built; a submission carries whom to tell, not how.
- **Current.** Three suppliers (`TeammateCollectionOptions.initiatorFor`,
  `TeamCollectionOptions/TeamServiceDeps.leaderCompletionInitiator`,
  `WorkflowServiceOptions.completionInitiator`) defer `mustAgent()` or build a
  fresh fenced object per call with a separate `leaderRecipientKey`. Delivery
  travels as closures: `TurnCompletionDelivery` in every submission,
  `AgentService.send({ resolveCompletionDelivery })`, and
  `WorkflowRunDeps.deliverTerminal` (whose nulling is the "still owed" state).
- **Change.**
  - `DispatcherAgent implements CompletionInitiator` — the stable handle
    over the lazily built dispatcher `AgentService` (built at start, after
    channels; it cannot exist at construction). `TeamService implements
    CompletionInitiator` with the Team-only check, replacing
    `leaderCompletionInitiator()` and `leaderRecipientKey`. Both objects are
    stable, so `CompletionInitiator.recipientKey` is deleted and the policy
    keys on the recipient object.
  - `AgentServiceFactory` binds the dispatcher's `CompletionDeliveryPolicy`
    once, like `AdmissionLedger`. Submissions carry `completionRecipient?:
    CompletionInitiator`; `EntityTurn` calls `policy.deliverRuntime(recipient,
    token, fact)`. `TurnCompletionDelivery`, `resolveCompletionDelivery` and
    `TeammateCollection.resolveCompletionDelivery` are deleted.
  - Collections take `completionRecipient: CompletionInitiator` (Dispatcher:
    `DispatcherAgent`; Team: the `TeamService`). `TeamCollection` takes
    `dispatcherRecipient` (the `DispatcherAgent`).
  - `WorkflowService` takes `completionRecipient` and the policy; `WorkflowRun`
    holds `policy` and `owedRecipient: CompletionInitiator | null` — the same
    nullable-owed state `deliverTerminal` encodes today.
  - Concrete construction order. Today: policy, core events, worktrees,
    names, factory, channels, scheduler, teammates, teams, Workflow,
    `DispatcherAgent`, lifecycle. Proposed: fence, policy, core events,
    worktrees, names, factory, channels, `DispatcherAgent`, scheduler,
    teammates, teams, Workflow, lifecycle. Only the fence (new position, no
    inputs) and `DispatcherAgent` move; `DispatcherLifecycle` stays last with
    its current inputs plus the fence. `DispatcherAgent.build()` still runs
    at start, when every collaborator exists.

### C. Identity facts: the agent module publishes; the caller gets the result

- **Greenfield.** The module that commits an identity publishes its lifecycle
  fact once. A caller that caused a commit receives the committed identity as
  that call's result; a holder that keeps a projection observes later commits
  on the object it holds.
- **Current.** `onPersisted` is created by `DispatcherService`
  (`publishAgentState`) and `TeamService` (`publish`), passed through
  `DispatcherAgentOptions`, `TeamLeaderOpenDeps`, `TeammateCollectionOptions`,
  `AgentEntityCollectionStore` (a stored field whose doc claims a consumer
  that no longer exists: only `closeUnbuilt` reads it), `AgentEntityCallbacks`,
  `TeammateServiceDeps`, `AgentRuntimeStateStore`'s third constructor
  argument, and every `AgentIdentityStore.create/update/upsert` call, where
  `afterIdentityStatusChange` adapts it. Both publishers emit the same
  `teammate.state` (role from the owner, `teamName` = `identity.team_id`); the
  Team additionally keeps its roster and republishes `team.state`.
- **Change.**
  1. `AgentIdentityStore` is an `EventEmitter<{ committed: [identity] }>`
     emitting after `create` and `upsert` (always) and after `update` only when
     the committed `previous.status` differs — the existing filter, evaluated
     in the same `TransactionalStore` after-commit hook.
  2. `AgentServiceFactory` receives the dispatcher `coreEvents` publisher once.
     Its private `bind(location, role)` attaches one listener that publishes
     `teammate.state` with the caller-stated `role` (a required plain input of
     `create`/`open`/`upsert`) before the store is read or written, so it is
     always the store's first listener. `DispatcherService.publishAgentState`,
     `DispatcherAgentOptions.onPersisted` and the `teammate.state` half of
     `TeamService.publish` are deleted; the Dispatcher subscribes to nothing.
  3. The factory's entries stop taking callbacks and return the committed
     entity before role options exist. `create`/`upsert` resolve to, and
     `open` resolves to or `null`, an `UnbuiltAgent`: an agent-module class
     holding the bound store and the stated `role` privately (`build` sets
     `options.role` from it, so callers state the role once), and exposing
     `identity`,
     `build(options, siblings): AgentService`, and `closeAtRest(note):
     Promise<AgentEntityIdentity>` (today's `closeUnbuilt` body, moved off
     `AgentEntityCollectionStore`). The caller that caused a commit learns it
     from the result, before any launch hook runs, and computes its role
     options itself. This deletes `AgentEntityCallbacks`, the `options:
     (identity) => …` callback and the `align` predicate (the Team compares
     `unbuilt.identity` itself and drops a misaligned one, which was only
     read). `upsert`'s `reconcile` stays: it runs inside the store's
     read-modify-write. R63 holds: no caller receives a store.
  4. `AgentService` is an `EventEmitter<{ state: [identity] }>` relaying its
     own store's `committed`, attached in its constructor — after the
     factory's publisher. `TeammateCollection` is an `EventEmitter<{ member:
     [identity] }>`: it emits `unbuilt.identity` as soon as `create` resolves
     (before `teammateLaunch` runs), relays each built entity's `state`
     (attached synchronously after `build`, before anything can start it),
     and emits the identity `closeAtRest` returns in `destroy`.
  5. `TeamService` subscribes to its own collection's `member` in its
     constructor. It handles its leader directly, because it is the caller:
     on the create branch it runs `remember` + `publishTeamState` on
     `unbuilt.identity` before `leaderLaunch` runs (what `onPersisted` does
     today); on the open branch it remembers silently; after `build` it
     subscribes to the leader's `state`. `leader.ts` splits to match:
     `createTeamLeader`/`adoptTeamLeaderIfAligned` return the `UnbuiltAgent`,
     `buildTeamLeader` runs `teamLeaderOptions` and builds, and
     `openTeamLeader`'s open-or-create choice moves into `rebuild`, which
     needs to know which branch ran. `remember`, `publishTeamState` and
     `seedMembers` stay as they are.
- Initial state, listener lifetime, publication order and every record-only
  path are in §4.

### D. Scheduled prompts: the producer states its provenance

- **Current.** `SchedulerServiceOptions.submitScheduled` is a closure on both
  sides translating a fire into the owner's submission with
  `SCHEDULED_SOURCE`.
- **Change.** The scheduler is the producer of scheduled inputs, so it builds
  `{ source: SCHEDULED_SOURCE, text, sourceId }` itself and submits to `target:
  { submitInput(input: TeammateSubmitInput): Promise<TurnAdmission> }` — the
  entity input contract `AgentService` already implements. `DispatcherAgent`
  implements `submitInput` (the same lazily built handle as §2.B; it also
  replaces `DispatcherService.submitToAgent`'s `mustAgent().submitInput`), and
  `TeamService.submitToLeader` is renamed `submitInput`. No new interface name
  is introduced.

### E. Role tools: the role's owner assembles them

- **Current.** `DispatcherAgentOptions.mcp` is a supplier capturing the
  aggregate (`dispatcher: this`) and `channels`. Today everything the
  dispatcher delegates read already exists when `DispatcherAgent` is
  constructed, except the fence inside `DispatcherLifecycle`, which is built
  last. `leaderMcp` travels
  Dispatcher → `TeamCollectionOptions` → `TeamServiceDeps` →
  `TeamLeaderOpenDeps` (a callback through a third layer). Leader delegates
  then resolve their own Team back by id through suppliers
  (`team: () => teams.leaderScope(teamId)`,
  `scheduler: () => teams.scheduler(teamId)`,
  `channels.mcpDelegates(caller, (task) => teams.runForLeader(teamId, task))`).
  The cron supplier's stated reason ("a Dispatcher's scheduler is created with
  its agent") is false: both schedulers exist before any runtime launches.
- **Change.**
  - `DispatcherAgent` receives its tool inputs as objects: `mcpLeases`,
    `adminSocketPath`, `channels`, and the `RoleDelegateDispatcher` (the
    `DispatcherService` it already reaches today through the closure; the
    structural type exists to avoid the `index.ts` import cycle). It calls
    `dispatcherAgentMcpDelegates` inside `dispatcherOptions()`, where it
    calls the `mcp` supplier today, so assembly timing does not change (at
    `build()`, when the scheduler, both collections and Workflow exist).
    The aggregate reference exists today inside the closure. §2.B's reorder,
    which builds `DispatcherAgent` before the collections so that it can be
    their completion recipient, is what makes it necessary rather than
    incidental. It becomes an explicit field, read only at `build()`.
  - The Team owns its leader's tools. `teamLeaderMcpDelegates` moves into the
    team module and binds directly to the `TeamService`'s own children
    (`teammates`, `workflows`, `scheduler`, each self-fenced with the Team
    `WorkFence`), the Team's own `dissolve` under the dispatcher fence
    (preserving join), and `channels.mcpDelegates(caller, team)` with the
    Team as `WorkFence`. The only cross-layer input is the channel source:
    `service/mcp/types.ts` declares `ChannelMcpSource { mcpDelegates(caller,
    fence) }`, implemented by `ChannelService` itself (no adapter object),
    because `service-team` sits below `service-orchestration` in
    `.dependency-cruiser.cjs`. `TeamCollectionOptions.leaderTools = { leases,
    adminSocketPath, channels }` are values; `TeamService` computes the
    leader's `TeammateAgentMcp` (it knows `leaderName` before create/open) and
    hands the value to `TeamLeaderOpenDeps.mcp`.
  - `createCronMcpDelegate` takes `scheduler: SchedulerCommands`;
    `TeamMateMcpScope`'s `team` supplier becomes the value `{ teammates,
    workflows }`; the leader-only `createTeamMcpDelegate` variant takes the
    Team's `dissolve` and the dispatcher fence.
  - Deleted with their last consumer: `TeamsPort.leaderScope`,
    `TeamsPort.runForLeader`, `TeamCollection.admit(teamId, …)`,
    `TeamService.leaderScope()`, and `TeamLeaderHandle` if nothing else reads
    it. `TeamsPort.scheduler(teamId)` stays (admin cron commands).

### F. Plugin hooks: pass the hook objects

`applyCreateTeamHook: (p) => this.hooks.createTeam.promise(p)` and
`announceTeam: (t, c) => this.hooks.team.call(t, c)` wrap objects that already
exist and are already passed that way for `teammateLaunch`.
`TeamCollectionOptions.hooks: Pick<Dispatcher['hooks'], 'teammateLaunch' |
'createTeam' | 'team'>` replaces all three fields. Failure isolation stays in
`waterfallTaps`/`isolatedTaps`, where it already is.

### G. Process composition: values instead of deferred factories

`ServerOptions.channelLoggerFactory`/`workflowLoggerFactory` travel Server →
`Dispatchers` → `DispatcherService` → `ChannelService` only to defer a
`dispatcherId` known at construction; the only non-default producer is the
CLI, which picks file-backed loggers. Replace them with `ServerOptions.fileLogs:
boolean`: `Dispatchers` builds each dispatcher's channel and Workflow logger
with `createLogger` and the existing `platform/paths.ts` builders and passes
the loggers as values. `runtimeSocketSweep: () => sweepRuntimeSocketDirs()` is
likewise replaced by `ServerOptions.sweepRuntimeSockets: boolean`, with
`Server` calling `platform/runtime-sockets.ts` itself.

### H. Feishu session: one delivery owner, collaborators built in order

The session constructor builds collaborators and passes its own methods back
into them. Changes:

- `cotClient: () => this.bot.cot` becomes the value `cot: FeishuCotClient |
  undefined`: `FeishuTransport.cot` is `readonly` and `bot` is built first.
- `cot.start(() => this.lifecycle.isLive())` is deleted: the lifecycle is
  created on the constructor's first line, so the adapter receives `lifecycle`
  at construction. No adapter entry point is reachable before `initialize`
  (verify at implementation; §6).
- `announce: (i) => this.bindings.announceProvisioned(i)` becomes the
  `bindings` object.
- `notify: (t, c, r) => this.notify(t, c, r)`: the topic-root skip and the
  tracked send move into `FeishuOutbound` (which already owns
  `sendNotification`, the lifecycle and the log fields); bindings hold
  `outbound`. `FeishuChannelSession.notify/sendNotification` are deleted.
- `submit`/`deliver`/`command`: one class implementing the existing
  `FeishuInboundDelivery` contract (plus `submit`) owns them and owns
  `FeishuProvisioning`; provisioning returns the Team to submit to (or its
  `unsubmitted` outcome) instead of calling `submit`, which breaks the only
  cycle. `FeishuDocumentComments` and `FeishuCardActions` hold that object;
  the inbound pipeline receives it instead of `delivery: this`.
- `createFeishuCoreCommands((c, p) => this.invoke(c, p))`: the Core port
  arrives at `initialize`, so a late value is inherent. The session's
  `invoker` field moves into `FeishuCoreCommands`, its only reader, which
  receives the port's `JsonInvoker` object at `initialize` and rejects
  before it as today.
- Slash-command context: `bindChannel` becomes the `bindings` object;
  `resolveChatName` becomes the `bot` (the consumer calls the optional method).
- `AskUserRegistryOptions.onExpire` becomes an `expire` event on the registry,
  observed by `FeishuCardActions` (which already holds the registry, `bot` and
  the settlement path); `expireAskUserQuestion` moves there.
- `CreateFeishuBotDeps.createTransport` (no caller, no export) and the
  `botFactory` option on the provider and session (no repository caller; the
  provider option is a root export) are deleted — §7, §8.

### I. Runtime providers

- Codex `allocateSocketPath` closes over `paths`, which `CodexRuntimeDeps`
  already carries: the runtime calls `allocateCodexSocketPath(
  this.paths.runtimeSocketDirs(), id)` itself.
- Claude `resolveBinPath` is called once in the constructor with an identity
  default and no supplier: the runtime reads `config.bin`.
- `codexProcessFactory`, `codexClientFactory`, `sessionFactory`,
  `generateSessionId`: no repository producer, none in the deleted-test
  ledger, none in tests before PR #455. Delete from the public options and
  the internal deps (§7/§8 decides the public half).
- `RuntimeStateFence` (`dreamux-utils`) keeps `terminate`/`log`. Its
  contract is to start native teardown exactly once, and to report the
  outcome through `terminated()`, which `stop()` consults. Both runtimes
  share that contract. Turning `terminate` into a published `fenced` fact
  would copy the once-only guard and the retained teardown promise into
  each runtime. It would also change a contract
  `dreamux-utils/tests/runtime-state-fence.test.ts` pins today. So the
  callback is configuration of a helper its runtime holds exclusively, like
  `TransactionalStore`'s `load`/`encode`.

## 3. Seam inventory and disposition

Rows are grouped by cluster. "Hops" counts objects a value passes through
between producer and consumer.

| Seam | Producer → consumer (hops) | Capability | Disposition |
| --- | --- | --- | --- |
| `TeammateServiceDeps.onPersisted`, `AgentEntityCallbacks.onPersisted`, `TeammateCollectionOptions.onPersisted`, `TeamLeaderOpenDeps.onPersisted`, `DispatcherAgentOptions.onPersisted`, `AgentEntityCollectionStore.onPersisted`, `AgentRuntimeStateStore` ctor arg, `AgentIdentityStore.create/update/upsert(…, onPersisted)` | Dispatcher/Team → identity store (up to 6) | publish `teammate.state`; Team roster | event + return value (§2.C) |
| `TeammateServiceDeps.findManagedWorktreeOwner`, `AgentEntityCallbacks.findManagedWorktreeOwner`, `reprepareDeletedManagedWorktree`/`assertManagedWorktreeAvailable` fn params | collection private method → factory → service → generation → worktree fn (4) | sibling managed-path occupancy | owner object: the query only lists the collection root, so it moves to `AgentEntityCollectionStore.findManagedWorktreeOwner`; the collection passes its store as `siblings` to `UnbuiltAgent.build`; owner-root agents pass `null` |
| `TeammateCollectionOptions.admitOperation/isClosing`, `TeamCollectionOptions.admitOperation/isClosing`, `TeamServiceDeps` copies, `WorkflowServiceOptions.admit`, `SchedulerServiceOptions.admit`, TeamService's 3 composition lambdas | Dispatcher/Team → children (1–2) | admission fence | owner object `WorkFence` (§2.A) |
| `CompletionDeliveryPolicy.accepting` | Dispatcher → policy (1) | dispatcher fence read | owner object `WorkFence` |
| `ChannelService.initialize/start(assertAvailable)` | lifecycle → ChannelService (1) | fence check between sessions | owner object: ChannelService holds the fence |
| `channels.mcpDelegates(caller, dispatch)` | role assembly → channel delegate (2) | fence per caller | owner object `WorkFence` |
| `DispatcherService.admitOperation`, `RoleDelegateDispatcher.admitOperation` | pass-through | — | delete; `fence` field |
| `TeammateCollectionOptions.initiatorFor`, `TeamCollectionOptions.leaderCompletionInitiator`, `TeamServiceDeps` copy, `WorkflowServiceOptions.completionInitiator` | Dispatcher/Team → collections/workflow (1–2) | completion recipient | owner object `CompletionInitiator` (§2.B) |
| `TurnCompletionDelivery`, `TeammateSubmitInput.deliverCompletion`, `AgentService.send({ resolveCompletionDelivery })` | collection/Team → turn (2) | deliver a settled turn | value: `completionRecipient` + policy bound in factory |
| `WorkflowRunDeps.deliverTerminal` | WorkflowService → run (1) | deliver terminal report | value: `policy` + `owedRecipient` |
| `CompletionInitiator.recipientKey`, `TeamService.leaderRecipientKey` | Team → policy | stable recipient identity | delete (recipients are stable objects) |
| `SchedulerServiceOptions.submitScheduled` | Dispatcher/Team → scheduler (1) | submit a fire | owner object: `submitInput` target (§2.D) |
| Dispatcher Workflow `teammates: { createLocked }` wrapper | Dispatcher → Workflow (1) | admission around `createLocked` | **retain**: removal decides the deferred `createLocked` admission item (§8 item 3) |
| `DispatcherAgentOptions.mcp` | Dispatcher → DispatcherAgent (1) | role tools | owner assembles from objects (§2.E) |
| `TeamCollectionOptions.leaderMcp`, `TeamServiceDeps.leaderMcp`, `TeamLeaderOpenDeps.leaderMcp` | Dispatcher → leader options (3) | leader tools | Team assembles; `ChannelMcpSource` object + values (§2.E) |
| `TeamMateMcpScope.team`, `createCronMcpDelegate.scheduler` suppliers | role assembly → delegate (1) | reach own scope per call | value: the owner's self-fenced objects |
| `TeamCollectionOptions.applyCreateTeamHook`, `.announceTeam`, `TeamServiceDeps.announceTeam` | Dispatcher → Team (1–2) | fire plugin hooks | owner object: the hook objects (§2.F) |
| `TeamCollectionOptions.nameSuffixGenerator/agentNameSuffixGenerator`, `TeammateCollectionOptions.suffixGenerator`, `TeamServiceDeps` copy | none supplies | deterministic names (test seam) | delete |
| `WorkflowServiceOptions.createRunner/runnerEntryPath/generateRunId/now`, `WorkflowRunDeps.createRunner/now`, `SchedulerServiceOptions.now` | none supplies | test seams | delete; `WorkflowRun` builds `ForkedWorkflowRunner` itself |
| `ServerOptions.channelLoggerFactory/workflowLoggerFactory`, `DispatchersOptions`/`DispatcherServiceOptions`/`ChannelServiceOptions` copies | CLI → ChannelService (4) | per-dispatcher logger | value (§2.G) |
| `ServerOptions.runtimeSocketSweep` | CLI → Server (1) | sweep crash orphans | value `sweepRuntimeSockets` |
| `NotifyResumedRestartOptions.runControl` | CLI → one call | the restart to wrap in marker write/rollback | **retain**: call-scoped operation, not stored; `service/` may not import `daemon/` |
| `AgentEntityOptions` (`options: (identity) => …`), `open.align` | caller → one factory call | role options; ownership check | delete: the caller computes and compares on `UnbuiltAgent.identity` (§2.C) |
| `upsert.reconcile` | Dispatcher → one factory call | compatibility policy inside the store's read-modify-write | **retain**: call-scoped, never stored |
| `LockedTeammate` handle methods, `PreparedCompletionDelivery.submit`, `TeamRecordHandle`, `ScopedChannelEventSourceLease.revoke`, `FeishuInboundWorkContext`, `TeamMateMcpDispatcherScope.workspace` | object-returning capabilities; the Dispatcher's own `workspace()` method | capability bound to a token/lease/record; dispatcher cwd policy | **retain**: these are objects or an owner's own method, the closures are their method bodies |
| `CodexRuntimeDeps.allocateSocketPath` | provider → runtime (1) | socket placement | value: derive from `paths` |
| `CodexAgentRuntimeProviderOptions.codexProcessFactory/codexClientFactory`, `CodexRuntimeDeps` copies | none supplies | test/embedder seams | delete (public half: §8) |
| `ClaudeCodeAgentRuntimeProviderOptions.resolveBinPath/sessionFactory/generateSessionId`, `ClaudeCodeRuntimeDeps` copies | none supplies | test/embedder seams | delete (public half: §8) |
| `RuntimeStateFenceOptions.terminate/log` | runtime → its own shared helper (1) | teardown exactly once; outcome for `stop()` | **retain** (§2.I): shared once-only contract, pinned by `runtime-state-fence.test.ts` |
| `TurnManagerOptions.log` | runtime → helper | log forwarding | value: the runtime's `DreamuxLogger` (child fields) |
| `TurnSubscriptionOptions.on*`, `ClaudeCodeStreamRpcOptions.onRemoteControlUrl/onProtocolEvent/reapOnTimeout/log` | native RPC → runtime | protocol event registration | **retain**: external protocol boundary; claude RPC tests consume them |
| `AgentRuntimeCreateContext.activity`, `AgentRuntimePathContext.cacheDir/logsDir/runtimeSocketDirs`, `ProtocolEventContext.activitySink`, `*RuntimeDeps.activitySink` | Core → provider (neutral contract) | lease-fenced sink; host paths | **retain**: `dreamux-types` public provider contract. Candidate: `activity` as a `{ publish }` object like `state` — a public contract change, not this pass |
| `FeishuCotAdapterOptions.cotClient`, `FeishuCotIoOptions.cotClient` | session → adapter → io (2) | optional COT client | value (§2.H) |
| `FeishuCotAdapter.start(isLive)` | session → adapter | liveness | owner object: `lifecycle` at construction |
| `FeishuBindingOperationsOptions.notify` | session → bindings | binding notice send | owner move to `FeishuOutbound` |
| `FeishuProvisioningOptions.submit/announce`, `FeishuDocumentCommentsOptions.submit`, `FeishuCardActionsOptions.deliver`, pipeline `delivery: this` | session → collaborators | submit/deliver | owner object: the delivery owner (§2.H) |
| `createFeishuCoreCommands(invoke)` | session → commands | late Core port | value arriving at `initialize`, held by its only reader |
| `CommandContext.bindChannel/resolveChatName` | session → slash commands (per call) | bind; chat name | owner objects `bindings`, `bot` |
| `AskUserRegistryOptions.onExpire` | session → registry | expiry timer fact | event observed by `FeishuCardActions` |
| `AskUserRegistryOptions.newRequestId`, `FeishuInboundWorkOptions.now`, `FeishuBoundedOperationOptions.now` | none supplies | test seams | delete |
| `FeishuCotClientOptions.now`, `EnsureOwnerOnlyDirOptions.getuid`, `AdminSocketOptions.isPidAlive`, `LegacyAdminServerCheckOptions.isPidAlive` | tests supply | deterministic test seams | **retain**: current tests consume them |
| `AdminSocketOptions.chmodFn`, `DaemonInstallOptions.execDirProbe`, `RunOnboardOptions.execDirProbe` (and its environment copy), the `importModule` option of the provider, agent-runtime, channel and plugin loaders, `ProviderContractContext.fail` | none / loader-local | test seams; loader-local failure sink | delete the options no caller supplies; `fail` is call-scoped, retain |
| `FeishuBoundedOperationOptions.operation/beforeStart/onLateValue` | caller → one bounded operation | the operation and its late-value policy | **retain**: call-scoped local operation |
| `CreateFeishuBotDeps.createTransport` | none | — | delete |
| `CreateFeishuChannelProviderOptions.botFactory`, `FeishuChannelSessionOptions.botFactory` | none supplies | fake bot seam | delete (public half: §8) |
| `TransactionalStoreOptions.load/encode`, `RunMcpServerOptions.log`, `DreamuxMcpShimOptions.log` | owner → its own utility | persistence codec; stdio log sink | **retain**: library-style local configuration of an object the owner exclusively holds |

## 4. Events: owners, initial state, lifetime, record-only paths

| Emitter (owner of the fact) | Subscriber | Attached | Initial state | Lifetime |
| --- | --- | --- | --- | --- |
| `AgentIdentityStore` `committed` | factory's `teammate.state` publisher | in `bind`, before the store's first read or write | a create/upsert commit is emitted after the listener exists; `open` commits nothing and emits nothing (unchanged) | store and listener are collected together; no unsubscribe |
| `AgentIdentityStore` `committed` | its `AgentService` (relay to `state`) | `AgentService` constructor, after the publisher | the builder already holds `unbuilt.identity` | same object lifetime |
| `AgentService` `state` | its `TeammateCollection` (relay to `member`); `TeamService` for the leader | synchronously after `build` returns, before anything can start it | the caller already handled `unbuilt.identity` (§2.C) | listener held by the entity; dropped with it on eviction |
| `TeammateCollection` `member` | its `TeamService` | Team constructor, which builds the collection; nothing reaches the collection earlier | `seedMembers()` on rebuild, empty on create | same lifetime as the Team; a Team discarded on a taken name drops both |
| `AskUserRegistry` `expire` | `FeishuCardActions` | construction | none (timers only) | session lifetime |

No emitter outlives its subscriber and no subscriber holds a longer-lived
emitter, so nothing accumulates per entity and nothing replays.

**Publication order is unchanged.** The factory's publisher is every store's
first listener, and every projection is derived after it: from the create
call's result, or from a relay attached later. So `teammate.state` for a
commit reaches channels before any `team.state` derived from the same commit,
as `TeamService.publish` orders them today. The team observer attached in the
`TeamService` constructor (before channels initialize) cannot invert this,
because it listens to the collection, never to a store.

**The core-event bus is not used internally.** Internal observers are plain
`EventEmitter` listeners on the owning objects. They never register as a
channel source, so `DispatcherCoreEventBus.hasSources` display demand and
lease revocation are untouched. `EventEmitter` adds no exception isolation and
none is needed: the listener bodies are today's callback bodies (a roster map
update and the bus's own isolated `publish`), so no failure mode is added or
removed.

Record-only and failure paths, each compared with today:

1. **Closing an unmaterialized member** (`TeammateCollection.destroy`):
   `factory.open(location, 'teammate')` then `unbuilt.closeAtRest(note)`
   writes `closed` (a status change) → `teammate.state`; the collection emits
   the returned identity as `member` → roster + `team.state`. Same two events
   in the same order.
2. **Creation before a live Agent exists** (spawn, `createLocked`, leader
   create, dispatcher upsert): `teammate.state` at commit, as today.
   `team.state` for a new member or leader is published when `create`
   resolves, before `teammateLaunch`/`leaderLaunch` runs. So a launch hook
   that rejects after persistence still leaves the member or leader in the
   roster, and in the closed Team's final `team.state` when the leader's hook
   rejected inside `createNew` — as today. The only timing difference: the
   projection runs on the create call's continuation instead of inside the
   after-commit hook (ledger row 2).
3. **Abandoned Team creation after the record is published:** record writes
   publish `team.state` through `updateRecord` as today. A built leader closed
   by `destroyChildren` closes through its own store → `teammate.state` +
   leader `state` → roster + `team.state`. A leader whose launch hook
   rejected is an `UnbuiltAgent` that `abandonCreated` does not close — as
   today, where it is "not this attempt's to close". Whether it should be
   closed is not decided here.
4. **Rebuild:** `seedMembers()` first. If an aligned leader opens, there is no
   commit and no event, and the Team remembers it silently, as today. If it is
   missing or misaligned, the create branch commits (`teammate.state`), and
   the Team, knowing it took that branch, remembers it and publishes
   `team.state`, as today.
5. **Dispatcher upsert:** `teammate.state` at commit; `DispatcherAgent`
   computes its options and builds. Nothing else observes it, as today.
6. **Recovery `settleTeamWorktreeCleanup`:** record-only, no Team, no event —
   unchanged.

## 5. Accounting: removals, additions, retained seams

**Removed concepts and plumbing** (fields, params and methods, not lines;
each is a §3 row): every `onPersisted` carrier plus
`afterIdentityStatusChange`, `publishAgentState` and
`onDispatcherAgentPersisted`; every `findManagedWorktreeOwner` carrier and
function param; every admission closure and the
`DispatcherService.admitOperation` pass-through; the four recipient
suppliers, `recipientKey`, `leaderRecipientKey`, `TurnCompletionDelivery`,
both `resolveCompletionDelivery`s and `deliverTerminal`; both
`submitScheduled` closures; `mcp`, the three `leaderMcp` carriers and the
three delegate suppliers; `TeamsPort.leaderScope`, `TeamsPort.runForLeader`,
`TeamCollection.admit(teamId)`, `TeamService.leaderScope`;
`applyCreateTeamHook` and both `announceTeam`s; the unused suffix, runner,
run-id and clock seams in core; the logger-factory carriers and
`runtimeSocketSweep`; `allocateSocketPath`, `resolveBinPath`, the five
provider factory options and their deps copies;
in Feishu, both `cotClient`s, `cot.start`, `notify`, `announce`, the three
`submit`/`deliver` closures and `delivery: this`, the session's
`notify`/`sendNotification`/`invoke`, `onExpire`, `createTransport`, both
`botFactory`s, and the unused Feishu seams.

**Added, each paid by the removals above:**

| Addition | Pays for |
| --- | --- |
| `WorkFence`/`OwnedWorkFence` (state moved, not created) | every admission closure; the pass-through |
| `EventEmitter` on `AgentIdentityStore`, `AgentService`, `TeammateCollection` | the six-hop `onPersisted` chain and two duplicate `teammate.state` publishers |
| `role` input and `coreEvents` on `AgentServiceFactory` | the owner-side publishers |
| `UnbuiltAgent` (the factory's two-phase result; holds the store the factory already binds) | `AgentEntityCallbacks`, the `options` and `align` callbacks, `AgentEntityCollectionStore.closeUnbuilt` and its `onPersisted` field, `TeamLeaderOpenDeps.onPersisted` |
| `ChannelMcpSource` (implemented by `ChannelService` as is) | the three-hop `leaderMcp` closure and two resolve-back suppliers |
| A Feishu delivery class implementing the existing `FeishuInboundDelivery` | four session closures and the provisioning↔session cycle |
| `fileLogs`, `sweepRuntimeSockets` booleans | three function options and five forwarding fields |

**Retained function-valued seams:** the Dispatcher Workflow `createLocked`
wrapper (deferred product item); call-scoped operations (`runControl`,
`upsert`'s `reconcile`, `createFreshEntity`'s private `beforePublish`,
bounded-operation callbacks,
`admit(task)`/`track(work)` style task arguments); external protocol and
neutral-contract registrations (§3); `RuntimeStateFence`'s once-only
teardown configuration and the store codecs (§2.I); test seams that current
tests consume.

**Test-seam rule.** An injection seam survives only with a current consumer.
A seam no source or test supplies, and that the
[deleted tests ledger](../../../artifacts/deleted-tests.md) does not name, is
deleted. Restored coverage then drives the real owner, not a reinstated seam.

## 6. Preservation and feature-loss ledger

| Boundary | Capability retained | Failure to check in review |
| --- | --- | --- |
| Identity store → `teammate.state` | create/upsert always, update on status change, after commit, incl. before the entity and record-only close | filter evaluated on a snapshot instead of the committed `previous`; a write through a store bound without the listener (only the factory binds) |
| Collection/leader → `team.state` | roster seeded before a fresh leader; restored leader silent; a committed member or leader is in the roster before its launch hook runs, so a hook rejection keeps today's roster and the abandoned Team's final aggregate; `teammate.state` still precedes `team.state`. Timing moves from inside the after-commit hook to the create call's continuation | remembering after `build` instead of after `create` (loses the failure-path roster); a relay attached after the entity can start (reopen path) misses `closed → starting` |
| Work fence | Team children: Team check then dispatcher admit; leader completions and `dissolve` not dispatcher-gated; permanent fence, retryable release | composing the dispatcher fence into the leader recipient drops queued completions (#391); gating `dissolve` breaks join |
| Leader tools | fence order now Team first, then dispatcher (was dispatcher, then Team); bound to the leader's own `TeamService` instead of re-resolving the id per call — the leader and its tools live exactly as long as that Team, and a closed Team is never rebuilt, so the id resolves to the same object or to nothing | only the error class differs when both scopes are closing, or for a call after the Team closed (Team fence refusal instead of the collection's closed-Team answer) |
| Completion recipients | per-owner recipients; per-recipient ordering; token fold; `accepting` read before queueing | `mustAgent()` moves from submission to delivery (§8 item 1) |
| Worktree occupancy | fresh sibling query on spawn and on reopen of a deleted managed checkout | owner-root agents must get `siblings: null` (they never take managed worktrees) |
| Dispatcher construction order | as listed in §2.B | `DispatcherAgent` must not read the collections before `build()` |
| Feishu COT | anchor before invoke, retire/release, liveness before `initialize` | adapter entry points reachable before `initialize` would now see a live lifecycle |
| Feishu provisioning | create → bind → announce → submit order; `unsubmitted` for every pre-submit failure; wait-then-submit for a message during a run | the submit moving out of `guarded` must stay outside its catch, as today |
| Issue #63 | non-blocking inbound submission | none of these changes touches `TurnManager` submission; review the diff for it anyway |

Deferred product questions stay untouched, in particular `createLocked`
admission and live `last`/activity config resolution.

## 7. Public API implications

Repository consumers were searched in `packages/*/src`, `packages/*/tests`,
`plugins`, and the pre-PR #455 tests; none supply the options below. That
proves nothing about outside consumers, for which the repository holds no
evidence.

| Package (version) | Surface | Change | Change note |
| --- | --- | --- | --- |
| `@excitedjs/agent-runtime-codex` (0.6.0) | `CodexAgentRuntimeProviderOptions` root export | remove `codexProcessFactory`, `codexClientFactory` | `minor`, plain note |
| `@excitedjs/agent-runtime-claude-code` (0.7.0) | `ClaudeCodeAgentRuntimeProviderOptions` root export | remove `resolveBinPath`, `sessionFactory`, `generateSessionId` | `minor`, plain note |
| `@excitedjs/feishu-channel` (6.2.0, Dreamux-internal) | `CreateFeishuChannelProviderOptions` root export | remove `botFactory` | `minor`, plain note |
| `@excitedjs/dreamux` (0.25.0) | `ServerOptions` (package `main` is `dist/server.js`) | replace three function options with two booleans | `minor`, plain note |

None of these touches a config or persisted file, so none is `BREAKING:`.
`team.state.teammates` has no Feishu consumer but is a `dreamux-types` event
field and stays. No `dreamux-types` contract changes.

## 8. Decisions for the operator

1. **Startup-window spawn.** Today a Dispatcher-owned `spawn`/`send` admitted
   before `DispatcherAgent.build()` (the admin socket opens before dispatchers
   start) fails with "agent is not prepared" because the recipient is resolved
   at submission (for `spawn`, after the member was created, which is then
   closed). With the recipient object it succeeds and resolves the agent at
   delivery. If the agent is still missing then, the policy's existing
   rejected-preparation branch logs and drops that completion. A dispatcher
   whose start failed is closed, so `accepting` drops it before that. Recommendation: accept; the refusal is incidental to closure
   timing and appears in no product statement.
2. **Public option contraction** (§7 rows 1–3). Recommendation: remove; the
   neutral provider contract is `AgentRuntimeProvider`, embedders build
   providers through the plugin factory, and an unused injection surface is
   exactly what R71 targets. The alternative keeps the public options, and
   with them the internal deps copies that carry them to the runtime:
   seams retained without a repository consumer.
3. **Workflow `createLocked` admission** (deferred item). Not decided here; the
   Dispatcher wrapper remains until it is.

Everything else is routine implementation detail chosen above.

## 9. Knowledge, change notes, verification

- KB in the same change: `service-topology.md` (construction order, fence,
  recipients, events), `dispatcher-orchestration.md`,
  `packages/dreamux/src/service/CLAUDE.md` (lines ~80–100, ~160–180, ~270 state
  the superseded rationale), `channel.md` (Feishu delivery owner), and
  `provider-runtime.md` (provider options). No config or persisted-state
  change, so no `dreamux-maintenance` reference changes.
- Rush change files per §7.
- Gates: build, lint (dependency-cruiser layer rules included), test,
  `typecheck:tests`, and `.agents/scripts/check.sh`. No test references the
  removed fields today (only a comment in `feishu-bot-logger.test.ts` names
  `createTransport`); `package-boundary-guards.test.ts` pins construction call
  text for `createFeishuChannelProvider(` and `new FeishuChannelSession`,
  which this proposal keeps. R43 applies: report, do not repair, any test the
  change breaks.
- Coverage restoration notes for the parent task (not this PR, R43): the
  ledgered abandoned-creation case injected a `leaderMcp` failure, a seam
  this proposal deletes. A rejecting `leaderLaunch` tap reaches the same
  `abandonCreated` path through a real owner, and also covers the
  failure-path roster in §4 path 2. No current Feishu test injects a bot
  (`public-api.test.ts` asserts no fake-bot factory is exported), so
  deleting `botFactory` removes no present coverage path.
- Implementation order inside the one child PR: A (fence) and B (recipients)
  first, since the construction reorder unlocks C–E; then C, D, E, F, G; then
  Feishu (H) and providers (I), which are independent.
- Structural review checks every retained function-valued seam against §3 and
  asserts no new object literal of closures replaces a removed field.

## 10. Cross-review and revised position (round 2)

Inputs: the MiMo and DeepSeek proposals, the TeamLeader
[source audit](../source-audit.md) including its extension (provisioning
`inFlight`, startup-window recipient timing, CLI suppliers, the command
composition path), and current source re-read for every disputed claim.
Paths are relative to `packages/dreamux/src` unless a package is named.
§1–§9 stay as submitted; where this section differs, it governs.

### 10.1 Corrections to my first round

| # | First-round claim | Source | Correction |
| --- | --- | --- | --- |
| 1 | §2.H: provisioning returns the Team; the delivery owner submits | `feishu-provisioning.ts:101–116`: `inFlight` holds `guarded(input)`; `run` (`:161–201`) ends in `return this.opts.submit(...)`; waiters run `deliverAfterRun` after the whole run | Withdrawn. Returning early would release waiters before the first message is submitted, so a second message to a new topic could reach the leader first. The first submit stays inside `run` (10.5 H). |
| 2 | §6: the submit "must stay outside its catch, as today" | `guarded` (`:128–146`) awaits `run` inside `try`; a rejected first submit becomes `unsubmitted` | False; retracted. Preserved as it is. |
| 3 | §2.H: COT liveness "verify at implementation" | `cot/adapter.ts`: `isLive` is unset until `start` (`:118`), which the session calls in `initialize` (`session.ts:272`); `guardLive` returns its fallback while unset (`:230`); `close()` returns early when never started (`:193`). Entry points: `handle` (subscription created in `initialize`), `beginInboundSubmission` (submit, after `start`), `onRouteClaimed` (bindings, reached by slash commands and tools after `start`) | Verified: nothing reaches the adapter before `initialize`. With `lifecycle` injected at construction, `close()` on a never-initialized session runs its body over empty state instead of returning early. No observable difference. |
| 4 | §8 item 1: a startup-window behavior change, recommended for acceptance | `mustDispatcherConfig` checks only that the id is configured (`server/command-host.ts:63–80`). `Dispatchers.get` materializes any configured id, because `accepting` is `true` from construction (`dispatchers/index.ts:76,111–124`). `start()` starts only enabled dispatchers, one at a time (`:172–188`). `DispatcherLifecycle.admit` checks only `closed` (`lifecycle.ts:99–102`), and `dispatcherAgent.build()` runs after channel build/initialize (`:183–192`) | Wider than I stated. A dispatcher's service can exist while its agent is unbuilt in three cases: its own `doStart` before `build()`, a later dispatcher in the sequential loop, and a configured but disabled dispatcher. The last case is permanent. A stable recipient would let `teammate.spawn` there succeed and drop every completion forever; today it fails at submission and cleans up. §8 item 1 is superseded: 10.5 B keeps today's timing with no compensating machinery, so this is no longer an operator decision. |
| 5 | §2.G: booleans treated as a routine §7 row | `cli/server.ts:77–81` supplies all three; defaults are `createLogger({ name: 'channel/<id>' })`, the dispatcher's own log for Workflow, and no sweep | These have a real supplier, so replacing them is a public construction-API contraction. It is now its own operator item (10.10), separate from deleting seams nobody supplies. |
| 6 | Omitted seams | `agent/turn.ts:81` `owed: () => boolean`; `Server.commandHost()` + `server/command-catalog.ts`; Feishu `toolSession()`, `extensionTool().invoke`, `inboundRoutes()`; `RestartIntentConsumer.load({ warn })` | Classified in 10.5 and 10.6. |
| 7 | `DispatcherAgent` implements `CompletionInitiator`/`submitInput`, with no R58 discussion | R58: "Methods that only forward to an owned object are deleted" | Addressed in 10.5 B. |
| 8 | §4 paths 2–3, §6 row 2, §9: a rejecting launch hook after the identity commit keeps the roster and leaves an unbuilt leader; a rejecting `leaderLaunch` tap restores the ledgered abandoned-creation coverage | `plugin/hooks.ts:456–497`: `launchDraftTaps` catches every tap failure and reports it as skipped; `:505`: `composeLaunchDraft`'s `hook.promise()` "never rejects". The audit makes the same correction | Withdrawn. No reachable post-commit, pre-return rejection of `factory.create` is established; today's only one is the test-injected `leaderMcp` failure, a seam this design deletes. `UnbuiltAgent` is still justified: it keeps the projection before the launch hook, which can await plugin I/O. It does not rest on a failure path. Coverage restoration for `abandonCreated` must use a real owner failure: a `startCreated` step (a non-`submitted` initial prompt, or the `running` write), or the leader identity write inside `createNew`'s `try`. |

### 10.2 MiMo: accepted and rejected

**Accepted:**
- Owner objects as completion recipients.
- The delivery policy bound once, with a recipient value on each submission.
- The Workflow run's nullable owed state kept.
- `TeamService.admit` stays Team-only for leader completion and leader submission, and the dispatcher gate is composed only for children. This is the audit's entry-point distinction; my §2.A reaches the same split through a private `assertOpen`.
- Hook objects; a collection-root worktree query; provider deps derived from values already carried.
- The retained `createLocked` wrapper; no global bus.
- MiMo's `EntityTurnOwner` correctly treats the turn's `owed` predicate as owner state. I had missed that predicate.

**Rejected:**
1. **`AgentIdentityEvents` created by each scope owner and threaded into store bindings** (MiMo §4, and §9 trade-off 1: "the per-call field remains on factory input").
   - The object travels owner → collection options → collection store → factory call → store binding, and its only subscriber is the owner that created it.
   - That is `onPersisted` with a subscribe method: the same producer, the same single consumer, and the same downward direction (two hops shorter). This is the requirement's banned "wrap the callback in an object".
   - An emitter belongs to the object that commits the fact, and holders observe it. Holders do not create it and hand it down.
   - What MiMo keeps exactly is commit-time timing for creation. My revision keeps commit-time timing for every status change and moves only the creation `team.state` by one continuation (10.5 C).
2. **Role derived in the listener from `leader_name` or the dispatcher name.** Each materializer already states the role (`teammateOptions` → `teammate`, `teamLeaderOptions` → `team_leader`, `dispatcherOptions` → `dispatcher`). Re-deriving a fact its owner states is the "state re-derived in core" glue that CLAUDE.md forbids.
3. **`DispatcherMcpAssembly.forTeamLeader({ teamId, leaderName })`.**
   - It has the same producer, the same captures (leases, admin socket, the aggregate, channels) and the same consumer as `leaderMcp`. It only turns the closure into a method.
   - It also keeps the loop that resolves the Team back by id.
4. **Keeping the `team`/`scheduler` MCP thunks because "a captured handle answers for a closed Team".**
   - `TeamCollection` evicts only on `service.closed` (`team/index.ts:803`); a stopped Team is not evicted (`:576`); a closed Team is never rebuilt (R62).
   - A leader's tools are built with that leader, and the `TeamService` holds its leader for its whole life.
   - So "whichever Team currently holds that id" is always the same object or none, and a call after close is refused by that Team's own fence. Only the error text can differ.
5. **`SchedulerPromptSink`.** It is a new interface whose two implementations are today's two closure bodies. The existing entity contract `submitInput(TeammateSubmitInput)` fits once the scheduler states its own `SCHEDULED_SOURCE`.
6. **No workable construction order.**
   - MiMo passes `DispatcherLifecycle` as `AdmissionGate` into children that are built before it.
   - It says "dispatcherAgent after `_teams`" but also passes `dispatcherAgent` as a value into `TeamCollection`.
   - Neither gives a construction order that works. The audit's cycle objection stands.
7. **The `nestedAdmissionGates` combinator.** It adds a primitive that builds an object of closures over two gates. `TeamService` already owns that composition and can implement the child view itself.
8. **"Feature-loss ledger: empty", with a stable dispatcher recipient.** MiMo's owner-as-recipient moves the recipient read from submission to delivery. Per 10.1 #4, a member spawned into an unbuilt dispatcher (during startup, or a disabled one) would then run and have its completions dropped, instead of failing at submission. MiMo neither ledgers this nor needs it: the owner query in 10.5 B removes the supplier and keeps the timing.
9. **Feishu is handled only in principle.**
   - "Pass the session as a small named port" recreates the session-as-callback.
   - `toolSession()`, provisioning concurrency and COT initialization are not classified.
   - `botFactory` is called "provider-internal", but `CreateFeishuChannelProviderOptions` is a package-root type export (`feishu-channel/src/index.ts:26`, `provider.ts:46`).
10. **Extra public contraction outside scope.** MiMo also deletes the numeric `restartBackoffBaseMs`/`restartBackoffMaxMs` and `attemptTimeoutMs`. These are not function-valued, and the requirement does not ask for them.
11. **The command composition path is omitted.**

### 10.3 DeepSeek: accepted and rejected

**Accepted:**
- The agent module publishes `teammate.state` at commit, and role is a stated factory input. This matches my §2.C.2.
  - DeepSeek passes `coreEvents` and `role` into the store directly; I have the factory attach a publisher listener at bind. I keep mine so `AgentIdentityStore` stays persistence-only and emits one `committed` fact that both the publisher and the entity relay read. Either is a routine choice.
- Hook objects; `allocateSocketPath`/`resolveBinPath` as values; deleting `CreateFeishuBotDeps`.
- `teammate.state` has no in-repo consumer (the COT adapter handles `teammate.input`, `teammate.activity` and `team.state`). It is still a published contract, so it is preserved.

**Rejected:**
1. **Team roster fed by a `TeamCollection` subscription on `DispatcherCoreEventBus`, routed to `live`/`starting` Teams.**
   - A leader created inside `createNew` is not tracked until `createNew` returns. The early aggregate is lost.
   - Seeding after return moves the projection behind the `leaderLaunch` hook, which can await plugin I/O (`agent/factory.ts:113–116`). This is a timing change, not a lost roster: 10.1 #8 shows no reachable rejection in that window.
   - `TeamCollection` is built in the `DispatcherService` constructor, before `channels.initialize` registers channel sources, and the bus delivers in insertion order. So a nested `team.state` would reach channels before the outer `teammate.state`.
   - DeepSeek §4 says channel sources "register … before any Team materializes". That is true, but it is not the registration that matters here.
   - The design also adds an `observe` registration kind, a `hasSources` exception, a log-field rename, and a filter-by-`teamName` router. That puts a bus between the same two original sides.
2. **Deleting the Dispatcher Workflow `createLocked` wrapper as a double fence.** `TeammateCollection.createLocked` calls `createFreshEntity` without `admitOperation` (`agent/index.ts:252–265`). The wrapper is the only fence, so removing it silently decides a deferred item.
3. **Retaining `initiatorFor`, `completionInitiator`, `leaderCompletionInitiator`, `leaderMcp` and `mcp` as "late".**
   - The stated premise is false: `ChannelService` is built at `dispatcher-service/index.ts:208`, `DispatcherAgent` at `:309`.
   - Late creation alone is not a reason to keep a supplier (audit).
4. **Feishu `submit`/`deliver`/`notify`/`onExpire`/slash context retained as "intra-aggregate".** The continuation names them as in scope. Being in one aggregate with a named consumer is not an ownership reason.
5. **"`botFactory` has real test consumers".** No test supplies it, and `public-api.test.ts` asserts that no fake-bot factory is exported.
6. **"Existing tests that assert the old wiring … are deleted".** R43 forbids this, and no current test references any seam this revision removes (10.9).
7. **Test and OS seams retained with no supplier** (`createRunner`, `generateRunId`, `now`, `chmodFn`, `ExecDirProbe`, `importModule`). Export or optional status is not a consumer.
8. **Folding the dispatcher check into every `TeamService.admit` call** (DeepSeek §2.3).
   - Leader completion preparation and prepared submission call `this.admit` (`team/service.ts:1080`, `:1090`).
   - With the dispatcher check folded in, a dispatcher close would reject them with an error that `isTeamUnavailable` does not map. Queued leader completions would then be dropped, against #391's "never retracted".
9. **The command composition path is omitted.**

### 10.4 Entropy comparison

| | Plumbing removed | Concepts added | Function seams retained without a sufficient reason |
| --- | --- | --- | --- |
| Claude (revised) | `onPersisted` chain and adapter; 4 recipient suppliers, per-turn delivery closures, `recipientKey`; every admission closure and the pass-through; both `submitScheduled`; `mcp`, 3 `leaderMcp` carriers, 3 resolve-back suppliers, 4 port methods; hook wrappers; turn `owed`; provider seams with no supplier; about 15 Feishu session closures; the 4-closure command host and 7 catalog resolver closures; logger/sweep factory carriers | `WorkFence` (moved state); emitters on 3 existing owners; `UnbuiltAgent`; a `role` input; `ChannelMcpSource`; owner query views, `owesCompletion()` on `AgentService` and `completionRecipient()` on `DispatcherAgent`/`TeamService` (methods on existing owners, not new objects); `FeishuTeamSubmitter` and `FeishuInboundRouter` (bodies moved out of the session); 2 booleans; `Dispatchers.addressed`/`configured` (moved) | none (10.6) |
| MiMo | `onPersisted` threading (store parameter, callbacks), recipient factories, fence closures, hook wrappers, provider options | `AgentIdentityEvents` (threaded), `AdmissionGate` plus combinator, `DispatcherMcpAssembly`, `SchedulerPromptSink`, `EntityTurnOwner` | leader MCP (as a method), MCP thunks, logger factories, most Feishu closures, the whole command path |
| DeepSeek | `onPersisted` chain, gate and hook arrows, 2 provider deps, `CreateFeishuBotDeps` | bus `observe` kind, a `teamName` router, the gate type | recipient suppliers, `submitScheduled`, `leaderMcp`, `mcp`, MCP thunks, logger factories, sweep, provider options, `botFactory`, all Feishu closures, the command path. It also deletes a real fence. |

### 10.5 Revised design

**A. Work fence.** Same as §2.A, including the `WorkFence`/`OwnedWorkFence` rename. The construction order is listed in §2.B. Every entry point:

| Entry point | Gate today | Gate after |
| --- | --- | --- |
| Team children: teammates, Workflows, scheduler (`team/service.ts:233,253,269`) | Team, then dispatcher (three lambdas) | the `TeamService` as `WorkFence`: Team, then dispatcher |
| `team.submit`/`team.interrupt` (`team/index.ts:449–469`) | dispatcher in the collection, then Team | unchanged: dispatcher in the collection, then Team-only `assertOpen` |
| leader completion prepare and submit (`:1080`, `:1090`) | Team only | Team only (`assertOpen`) |
| Team cron fire | composed admit, then Team again in `submitToLeader` | composed fence, then Team-only `assertOpen` |
| leader Channel tools (`runForLeader`, `:520`) | dispatcher, then Team | unchanged: dispatcher fence, then the Team's own `assertOpen`, the same shape as `team.submit` |
| leader `dissolve` tool | dispatcher, through `TeamCollection.dissolve` | dispatcher fence around the Team's own `dissolve`; the Team leaves it ungated so a repeat joins |
| delivery policy | `accepting()` read before queueing | `fence.isClosing()` read before queueing |
| `ChannelService.initialize`/`start` | `assertAvailable` closure | holds the fence |

**B. Completion recipients.**
This supersedes §2.B's stable dispatcher recipient and §8 item 1 (10.1 #4). Today's timing is preserved exactly, so there is no product decision here.

- **Owner query.**
  - `completion-router/index.ts` declares a view next to `CompletionInitiator`: `{ completionRecipient(): CompletionInitiator }`.
  - `DispatcherAgent` implements it by returning `mustAgent()`. The built `AgentService` stays the recipient, as today. `mustAgent()` throws "agent is not prepared" at the same moment it does today.
  - `TeamService` implements `CompletionInitiator` itself, with the Team-only check, and its query returns `this`. Today's Team supplier never throws at submission, so this timing is unchanged too.
- **Who calls it, and when.** Each producer holds the owner object as a value (§2.B builds `DispatcherAgent` before its consumers) and calls the query at exactly the point today's supplier runs:
  - `TeammateCollection.spawnAdmitted`: after `createFreshEntity`, inside the `try` that cleans up a failed creation (`agent/index.ts:234–248`).
  - `sendResolved`: after the reopen, immediately before `entity.send`. Today `AgentService.send` runs the supplier before anything else (`agent/service.ts:216–229`), so `send`'s `resolveCompletionDelivery` parameter is deleted; the collection passes the recipient.
  - `WorkflowService.createRun`: after `accepting`, before the record write (`workflow-service/index.ts:145`).
  - `TeamService.startCreated` (dispatcher delivery): before the initial prompt.
  - `TeamCollection` for `team.submit` with dispatcher delivery: the same point `initiatorFor` runs today.
  - A collection with no recipient today (Workflow agents) holds `null`.
- **What disappears.** `initiatorFor`, `completionInitiator`, `leaderCompletionInitiator`, the Team's per-call `{ recipientKey, prepareCompletion }` literal, and with it `recipientKey`, because `TeamService` is now a stable key. Also `resolveCompletionDelivery` and `TurnCompletionDelivery`.
- **It is the same shape as 10.5 J.** The authoritative owner answers a fact that cannot be fixed at construction, and the holder holds the owner directly. It is not a new object wrapping an old closure. My earlier sentence ruling out the one-method form contradicted J and is withdrawn.
- **R58.** `DispatcherAgent.completionRecipient()`'s body is `mustAgent()` only because the view has two implementers. `mustAgent()` stays for its other callers: `DispatcherAgent` itself (`dispatcher-service/agent.ts:165`) and `DispatcherService`'s interrupt (`dispatcher-service/index.ts:399`).
- **`DispatcherAgent.submitInput`** (`mustAgent().submitInput(input)`) is the scheduler's and `submitToAgent`'s target. It resolves at call time, which is identical to today's inline `mustAgent().submitInput`. `DispatcherService.submitToAgent` becomes `fence.admit(() => dispatcherAgent.submitInput(input))`.

**C. Identity facts.** Same as §2.C: store `committed`, a factory publisher attached at `bind`, `UnbuiltAgent`, `AgentService` `state`, `TeammateCollection` `member`, and the Team's direct handling of its leader. Timing and order:

| Commit | `teammate.state` | Team projection and `team.state` |
| --- | --- | --- |
| member create (`spawn`, `createLocked`) | inside the after-commit hook (factory publisher) | when `create` resolves, before `teammateLaunch` (today: inside the hook) |
| leader create (`createNew`, `rebuild` create branch) | inside the after-commit hook | when `create` resolves, before `leaderLaunch` |
| any status update (runtime, close, reopen) | inside the after-commit hook | the same synchronous emit chain, store → `AgentService` → collection → Team (unchanged) |
| record-only close (`destroy`) | inside the after-commit hook | when `closeAtRest` resolves |
| `open`/restore | none | silent `remember` in `rebuild` (unchanged) |
| dispatcher upsert | inside the after-commit hook | none (unchanged) |

- The factory publisher is every store's first listener, so `teammate.state` still precedes any `team.state` derived from the same commit.
- Internal listeners never touch `DispatcherCoreEventBus`, so channel-registration order and `hasSources` do not matter to them.
- **Failure paths after commit.**
  - Launch hooks cannot reject (10.1 #8).
  - A `startCreated` failure reaches `abandonCreated` with a built leader. That leader closes through its own store, and the same emit chain publishes the final `team.state`, as today.
  - A failed identity write commits nothing, so no event is published, as today.

**D. Scheduler.** Same as §2.D. The target is `DispatcherAgent` or `TeamService` through `submitInput`.

**E. Role tools.** Same as §2.E, with the lifetime evidence from 10.2 item 4.

**F. Hooks.** Same as §2.F.

**G. Process composition.**
1. **Logger factories and socket sweep.** `fileLogs` and `sweepRuntimeSockets` replace them. `Dispatchers` builds `createLogger({ name: 'channel/<id>', filePath })` when `fileLogs` is set, and otherwise today's default. The Workflow logger uses `workflowLogPath` when `fileLogs` is set, and otherwise the dispatcher log. `Server` calls `sweepRuntimeSocketDirs()` when `sweepRuntimeSockets` is set. The CLI's behavior and the defaults are both preserved. This is public (operator decision 2).
2. **`RestartIntentConsumer.load({ warn })`.** Pass the server `DreamuxLogger` as a value instead of `(message) => this.log.warn(message)`.
3. **Command composition.**
   - **The cycle is real.**
     - `CoreCommandPort` (`server.ts:181`) needs a registry.
     - The registry resolves `Dispatchers`, which `start()` builds (`:221`) because `restartIntent` and `homePathPrefixes` are loaded asynchronously there.
     - `Dispatchers` carries the same port down to `ChannelService.initialize` (`channel-service/index.ts:199–213`), because one admitted registry serves both `admin.sock` and in-process Channel invocations.
     - So one late edge is irreducible. It stays on the one object that already holds it: the `Server`'s own `dispatchers` accessor, which throws "server has not started" before `start()`, the same failure the host closures give today.
   - **Deleted:**
     - `commandHost()` and its four closures (`:192–203`). `Server implements CoreCommandHost`, narrowed to `{ readonly dispatchers; readonly config; readonly mcpLeases }`. The last two become read-only public fields, an additive change.
     - `mustDispatcher` and `mustDispatcherConfig`, which move to their owner as `Dispatchers.addressed(context)` and `Dispatchers.configured(id)`. `Dispatchers` already owns the id→service map and reads config in `summarize`.
     - The catalog's resolver closures:
       - `dispatcherCommands`' four-field bag;
       - the three `(context) => dispatcher(context).x` narrowings for channel, team and Workflow;
       - the shared `dispatcher` resolver passed to `teammateCommands`/`schedulerCommands`.
   - Each domain factory takes the host, typed as the view it reads. For example, Team takes `{ readonly dispatchers: { addressed(context): { readonly teams: TeamsPort } } }`; `dispatcherCommands` reads `Dispatchers` from its own module.
   - The cost is that domain views name two levels through the host. I accept that over closures that re-express the same lookup.
   - The Commands' own `parse`/`execute` are the Command contract and are retained.

**H. Feishu.** The session keeps composition and the lifecycle; each operation moves to its owner. Construction order: lifecycle, ask-user registry, bot, targeting, stores, access, routing, outbound, COT adapter (`cot` value, `lifecycle`), commands, bindings (outbound), submitter, provisioning, doc comments, router, card actions.
- **`FeishuTeamSubmitter`** takes the session's `submit` body: the liveness check, the COT anchor claim, the Core Command, and `retire`/`release`. Provisioning, doc comments and the router each hold the object.
- **`FeishuProvisioning`** holds the submitter and `bindings` (replacing `announce`). `run` still ends by returning `submitter.submit(...)`. So:
  - `inFlight` still spans the first submission;
  - waiters still wait for it before `deliverAfterRun`;
  - `guarded` still turns a rejected first submit into `unsubmitted`.
  - Concurrency is unchanged.
- **`FeishuInboundRouter`** implements the existing `FeishuInboundDelivery` contract (`deliver`, `command`). It holds routing, the submitter, provisioning, bindings, commands and `bot`.
  - The pipeline receives it in place of `delivery: this` (`session.ts:762`).
  - Card actions hold it in place of the `deliver` closure.
  - The slash context gets the `bindings` and `bot` objects.
- **`notify`** moves to `FeishuOutbound` (topic-root skip plus tracked send); bindings hold `outbound`.
- **COT.** The adapter receives `cot` as a value and `lifecycle` at construction. `start(isLive)` and the nullable `isLive` are deleted (10.1 #3).
- **Core commands.** The session's `invoker` field and the `(c, p) => this.invoke(c, p)` closure (`:219`) are deleted. `FeishuCoreCommands` holds the `JsonInvoker` it receives at `initialize`. The `ChannelCorePort` contract hands the port over at `initialize`, so one late field is inherent; it now lives with its only reader.
- **Ask-user.** `onExpire` becomes an `expire` event on the registry. `askUserQuestion` and `expireAskUserQuestion` move to `FeishuCardActions`, which already holds the registry, `outbound`, `bot` and the settlement path.
- **Tools.** `toolSession()`'s object of forwarding closures (`:503`) becomes one `FeishuToolSession` value of owner objects, built once: `outbound`, the chat-bots store, card actions for ask-user, `bindings`, `routing`, `docComments`, the logger and `channelId`. Tools map their own results.
  - The `extensionTool().invoke` wrapper (`:544`) is deleted. `tools/session-mcp.ts` already applies `session.fencedToolCall` to built-in tools and now applies it to extension tools too.
- **Retained:** `inboundRoutes()` passed to `bot.start` (transport event registration; each handler is a lifecycle fence plus an owner call).
- **Deleted:** `botFactory` (public half: operator decision 1) and `createTransport`.

**I. Providers.** Same as §2.I: `RuntimeStateFence` is retained, and only the options with no supplier are deleted.

**J. Turn delivery.**
- New signature: `EntityTurn(runtime, producerName, role, recipient, policy, owner)`.
- `owner` is the `AgentService` itself, typed by the one query the turn reads: `{ owesCompletion(): boolean }`.
  - The view is declared in `turn.ts` because `tsPreCompilationDeps: true` counts a type-only import of `service.ts` as a cycle.
  - No wrapper object holds the captured state. `phase` and `hostStop` stay private to the owner.
- Delivery is `policy.deliverRuntime(recipient, completion, fact)`, and it is read at the same synchronous point in `settle`.
- `TurnCompletionDelivery` and both `resolveCompletionDelivery` paths are deleted.

### 10.6 Retained function-valued seams (exact reasons)

| Seam | Consumer | Why the owner cannot provide it as an object or value |
| --- | --- | --- |
| Dispatcher Workflow `createLocked` wrapper | Workflow agent materialization | Removing it decides the deferred `createLocked` admission item |
| `upsert.reconcile` | `AgentIdentityStore.upsert` | Runs inside the store's read-modify-write, against the existing identity |
| `RuntimeStateFenceOptions.terminate`/`log` | both runtimes | Shared once-only teardown whose outcome `stop()` reads; converting it copies the guard into each runtime; pinned by `runtime-state-fence.test.ts` |
| `TransactionalStoreOptions.load`/`encode` | the owning store | A codec for a store its owner holds exclusively |
| Codex `TurnSubscriptionOptions.on*`; Claude RPC `onRemoteControlUrl`/`onProtocolEvent`/`reapOnTimeout`/`log` | native protocol streams | Protocol event registration |
| `AgentRuntimeCreateContext.activity`, `AgentRuntimePathContext.*`, `activitySink` | providers | The `dreamux-types` neutral contract; changing it is a separate public decision |
| Feishu `inboundRoutes()` → `bot.start` | the transport's event dispatch | External event registration |
| `FeishuBoundedOperationOptions.operation`/`beforeStart`/`onLateValue` | one bounded call | Call-scoped operation and its late-value policy |
| `NotifyResumedRestartOptions.runControl`; `ProviderContractContext.fail` | one call | Call-scoped; `service/` may not import `daemon/` |
| Command `parse`/`execute`; local task arguments (`admit(task)`, `track(work)`, `settleWithinDeadline(op)`) | registry; the call | Callback contract of the call itself |
| `FeishuCotClientOptions.now`, `EnsureOwnerOnlyDirOptions.getuid`, `AdminSocketOptions.isPidAlive`, `LegacyAdminServerCheckOptions.isPidAlive` | current tests | Deterministic seams with present suppliers |
| `RunMcpServerOptions.log`, `DreamuxMcpShimOptions.log` | stdio MCP processes | The sink must stay off stdout; local configuration |

Every other row in the inventory and in §3 is deleted, made a value, or made an owner object. That includes the rows added in 10.5 G, H and J.

### 10.7 Behavior deltas

1. Creation `team.state` is published one continuation later: still after `teammate.state` and before the launch hook. `team.state` has no in-repo consumer other than the Feishu `closed` reaction. This is routine.
2. A leader-tool call after its Team closed is refused by the Team fence instead of receiving the collection's closed-Team answer; only the error text differs.
3. Unchanged:
   - completion-recipient timing, including unbuilt dispatchers;
   - every gate's entry-point order;
   - provisioning concurrency;
   - COT initialization;
   - #391 queued-delivery retention;
   - the `createLocked` asymmetry;
   - #63.

### 10.8 Public API

| Package | Change | Repository evidence | Note |
| --- | --- | --- | --- |
| `@excitedjs/agent-runtime-codex` 0.6.0 | remove `codexProcessFactory`, `codexClientFactory`; the numeric backoff options stay | no supplier | `minor`, plain |
| `@excitedjs/agent-runtime-claude-code` 0.7.0 | remove `resolveBinPath`, `sessionFactory`, `generateSessionId` | no supplier | `minor`, plain |
| `@excitedjs/feishu-channel` 6.2.0 | remove `CreateFeishuChannelProviderOptions.botFactory` | no supplier | `minor`, plain |
| `@excitedjs/dreamux` 0.25.0 | `ServerOptions`: 3 function options → 2 booleans | the CLI supplies all 3; its behavior and the defaults are preserved. Lost: an embedder injecting arbitrary per-dispatcher loggers or its own sweep | `minor`, plain |
| `@excitedjs/dreamux` | `Server` gains read-only `config` and `mcpLeases` | additive | none needed |

None of these touches `dreamux-types`, `dreamux-utils`, or any persisted or config file, so none is `BREAKING:`. None of this is evidence about callers outside the repository.

### 10.9 Test impact (R43)

A grep over `packages/*/tests` and `packages/*/*/tests` finds no reference to any seam this revision removes or reshapes. That covers `onPersisted`, `admitOperation`, the recipient suppliers, `leaderMcp`, the hook wrappers, `submitScheduled`, the logger factories and sweep, `allocateSocketPath`, `resolveCompletionDelivery`, `closeUnbuilt`, `cotClient`, `onExpire`, `commandHost`/`CoreCommandHost`/`createCoreCommandRegistry`/`mustDispatcher`, `toolSession`, `extensionTool`, `EntityTurn`, `RestartIntentConsumer`, and constructors of the reshaped classes. `package-boundary-guards.test.ts` only forbids core from constructing `FeishuChannelSession`. `runtime-state-fence.test.ts` pins the retained fence. No test incompatibility is predicted. Any that appears is reported, not repaired.

### 10.10 Remaining disagreements and decisions

**Material disagreements that remain:**
- **With MiMo, on who owns the emitter.**
  - MiMo: a scope-owned emitter threaded down to the stores. It keeps exact creation timing but keeps the downward transport.
  - Mine: the owner that commits publishes, holders observe, and the caller of a commit gets the result. There is no downward transport, at the cost of `UnbuiltAgent` and one continuation for creation `team.state`.
  - The requirement text ("published by their owning module and observed by holders"; no wrapper object between the same sides) favors mine.
- **With MiMo**, on the stable dispatcher recipient. It changes behavior for unbuilt dispatchers, and the change is not needed (10.2 #8, 10.5 B).
- **With MiMo and DeepSeek**, on keeping the logger and sweep factories. This is decision 2.
- **With DeepSeek**, on the provider options and `botFactory`. This is decision 1.

The Feishu scope, the MCP thunks, the `createLocked` fence and the bus reuse are settled by source and the continuation, as shown above.

**Genuine operator decisions** (both are public API contractions; neither changes product behavior):
1. **Contracting public options with no repository supplier:** the codex/claude provider factory options and feishu `botFactory`. Recommendation: remove.
2. **Contracting `ServerOptions` from functions to booleans.** It has a real CLI supplier; the CLI's behavior and the defaults are preserved. Recommendation: replace.

**Not decided here** (deferred product items; this design preserves current behavior for each):
- `createLocked` admission.
- Found during the source check, and not touched by this design: whether admin Commands addressed to a configured but disabled dispatcher should be refused. Today `mustDispatcherConfig` accepts any configured id, and `Dispatchers.get` materializes a service that never starts.
- The unbuilt-leader question left open in §4 path 3 is withdrawn: 10.1 #8 shows it has no reachable scenario.

**Routine implementation choices:**
- Emitter mechanics, class names and exact construction order.
- The publisher as a listener rather than a store field.
- The two-level command host views.
- The Feishu submitter/router split.

**Already authorized** (R71 and the continuation): the Feishu session closures, the command composition path, the turn's `owed`, and every core seam above.
