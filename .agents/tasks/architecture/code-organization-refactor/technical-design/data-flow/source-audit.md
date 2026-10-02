# Data-flow proposal source audit

This is the TeamLeader's source adjudication input, not the final solution.
The first proposal round remains independent. Cross-review must resolve these
facts against the continuation requirement and the complete construction
inventory; agreeing with another proposal does not settle them.

## Admission and construction

- `TeammateCollection.spawn` calls its admission dependency, but
  `createLocked` directly calls `createFreshEntity` without that gate
  (`service/agent/index.ts`, `spawn` and `createLocked`). The dispatcher
  Workflow wrapper in `service/dispatcher-service/index.ts` supplies a real
  fence. Removing it as redundant changes behavior. The asymmetric Team path
  is an existing, separately deferred product question. A transport refactor
  must account for both paths without silently changing either one.
- `DispatcherLifecycle` is constructed after the scheduler, collections,
  Workflow service, and dispatcher-agent holder. Its constructor receives all
  of them (`service/dispatcher-service/index.ts` and `lifecycle.ts`). A proposal
  that passes this lifecycle object into those earlier constructors must
  explain a concrete construction order. A gate interface alone does not
  resolve the object cycle.
- `ChannelService` is constructed before `DispatcherAgent` in the same
  constructor. The claim that the channels do not exist when that holder is
  constructed is false. Other MCP dependencies, such as the scheduler and
  Team collection, need individual tracing before changing assembly timing.
- `TeamService.admit` currently checks only the Team. Child collection,
  Workflow, and scheduler construction explicitly adds the dispatcher gate,
  while completion preparation and prepared submission call the Team gate
  alone. `CompletionDeliveryPolicy` checks dispatcher acceptance before
  queueing and explicitly retains already-queued deliveries. Folding a
  dispatcher check into every Team `admit` call therefore changes more than
  the three duplicated child-gate expressions. Preserve the entry-point
  distinction when composing gate objects.

## Persistence notification and Team projection

- `AgentServiceFactory.create` awaits `AgentIdentityStore.create` and then
  computes role options. The store publishes the committed identity before
  asynchronous launch hooks run (`service/agent/factory.ts`,
  `service/team/leader.ts`). Correction after the cross-review source check:
  a throwing or rejecting launch tap is isolated by `launchDraftTaps` and
  does not reject `composeLaunchDraft` (`plugin/hooks.ts`). The earlier audit
  incorrectly used such a tap as a reachable factory-failure trigger.
- `TeamService.createNew` publishes the starting Team, then creates its
  leader. The current callback remembers that committed leader immediately.
  `TeamCollection` does not hold this Team in `starting` until
  `createNew` returns (`service/team/service.ts`, `service/team/index.ts`).
  Routing only to `live`/`starting` and seeding the leader after successful
  factory return therefore misses the commit-time aggregate and moves the
  projection later. A factory rejection after persistence would also miss
  the roster, but a rejecting launch tap does not establish that scenario.
  Read-only restoration has a different reason to seed explicitly; it does
  not prove that delayed creation seeding is equivalent.
- `TeamCollection` is constructed before channels initialize. A collection
  observer attached in its constructor is therefore earlier than channel
  subscriptions. Nested `team.state` publication from such an observer can
  reach channels before the outer `teammate.state`. The proposed claim that
  channel listeners always register first is false. Preserve the existing
  publication order or make any proposed contract change explicit.
- `DispatcherCoreEventBus` currently distributes channel-facing facts with
  per-listener exception isolation, no replay, and no awaited delivery. Its
  `hasSources` reports channel demand. An internal state observer must not
  become display demand or accidentally inherit a channel lease's revocation
  lifetime. Reusing this bus requires a concrete explanation of these
  boundaries, not just an additional registration method
  (`service/dispatcher-core-events/index.ts`).

## Scope and evidence

- Feishu's `submit`/`deliver`/`notify` dependencies are explicitly inside this
  continuation. Being within one aggregate or having a named consumer does
  not by itself justify retaining closure-mediated access to another
  object's private operations. The final design must classify each one and
  either remove it or explain the ownership reason it must remain.
- Late creation of a value does not establish a need for a supplier closure.
  Evaluate the holder, construction order, existing owner methods, and
  dynamic lookup before retaining MCP and completion-recipient suppliers.
- `FeishuBot.cot` is copied from the constructed transport, whose factory
  returns `cot: createFeishuCotClient(client)`; it is not initialized by
  `start`. The production COT supplier does not need late lookup merely to
  wait for bot startup (`feishu-channel/src/bot.ts`,
  `feishu-transport/src/transport/feishu.ts`).
- `createFeishuCoreCommands((command, payload) => session.invoke(...))` is
  internal forwarding to the session even though the eventual invoker is an
  external neutral protocol. Distinguish this intermediate wrapper from the
  `ChannelCorePort` contract when deciding what must remain.
- `FeishuProvisioning.inFlight` contains the entire `guarded` operation,
  including the first submission. Messages that find that entry wait for it
  before `deliverAfterRun` reads the current binding and submits. Returning
  only a provisioned Team from this operation, then submitting outside it,
  releases these waiters earlier. Keep the same owned concurrency boundary
  when moving delivery orchestration. Also, `guarded` uses `await this.run`
  inside its `try`; `run` returns the submission promise, so a rejection from
  that first submit is currently caught there. A claim that the first submit
  is outside this catch is false (`feishu-channel/src/feishu-provisioning.ts`).
- `Server.start` opens the admin socket before starting dispatchers. A
  dispatcher member spawn currently resolves its completion recipient after
  constructing the member but before submitting its turn. That resolution
  calls `DispatcherAgent.mustAgent`, so an unprepared owner fails at this
  point and triggers failed-creation cleanup. A stable recipient object that
  postpones this read until completion delivery changes that path. The same
  lookup timing must be accounted for on send and Workflow run creation;
  changing it is not required merely to remove a supplier closure.
  Workflow has an additional startup gate: it begins with `accepting = false`
  and opens only after the dispatcher Agent is built
  (`workflow-service/index.ts`, `dispatcher-service/lifecycle.ts`). Thus the
  ordinary startup-window Workflow request is rejected before its recipient
  lookup; a proposed behavior difference there needs another reachable path.
- A proposed `CompletionInitiator.ensureReady` must preserve which owner was
  actually checked. The current dispatcher supplier calls `mustAgent`; the
  Team supplier merely creates its fenced recipient and does not check Team
  availability until preparation/submission. Giving a new Team readiness
  method an `assertOpen` body adds a check that the supplier did not perform.
  Earlier child admission can be separated from recipient resolution by
  awaited materialization; it does not prove a later check redundant.
- The CLI does supply `channelLoggerFactory`, `workflowLoggerFactory`, and
  `runtimeSocketSweep` in `packages/dreamux/src/cli/server.ts`. They are not
  unused seams. A replacement must preserve both their CLI behavior and the
  server defaults; any contraction of this public construction API needs a
  separate accounting from deleting a field with no repository supplier.
- The command composition path is another construction-time callback chain,
  regardless of whether its type name ends in `Options`:
  `Server.commandHost` closes over server fields for four lookups, then
  `server/command-catalog.ts` builds resolver closures and passes them to
  domain command factories. The domain `execute` handlers are actual command
  callbacks; the intermediate host/resolver bags are a separate ownership
  question. Classify this whole path explicitly, including the construction
  cycle in which `CoreCommandPort` needs a catalog that resolves dispatchers
  and `Dispatchers` receives that same port. A claimed complete sweep cannot
  omit these callbacks simply because they are not called `Deps`.
- Export status is evidence of an API shape, not of a caller. Name actual
  repository consumers separately from unverified outside consumers. Any
  proposed public API contraction must be explicit and reflected in change
  notes; do not invent an outside requirement to preserve dormant seams.
- The current package tests supply none of `codexProcessFactory`,
  `codexClientFactory`, `sessionFactory`, `generateSessionId`, or `botFactory`.
  In particular, the claim that current Feishu session tests supply
  `botFactory` is unsupported: all current TypeScript occurrences are its
  provider/session declaration, forwarding, and consumption. Historical
  tests and comments are not present consumers. This repository search says
  nothing about outside callers.
- The continuation explicitly forbids deleting tests to conceal regressions.
  Deleting a test because the new wiring makes it fail is not authorized by
  R43. Report a concrete incompatibility before deciding how it relates to
  final parent coverage. No current failure has been established merely by
  predicting one in a proposal.

Paths in this audit are relative to `packages/dreamux/src` unless a package
or task artifact is named explicitly.
