# Technical solution: fence completion delivery at the recipient's scope

## Problem

A settled TeamMate turn always ran its completion-delivery closure, and a
Workflow run always delivered its terminal report. When the owner itself ended
the work — a `close`, a `workflow_stop`, a Team dissolve, a host stop — the owner
was told about the stop it had asked for, and during a dissolve or a shutdown
those reports raced into a recipient that was already stopping, surfacing as
failed COT cards. The requirement is in [requirement.md](../requirement.md).

## Where the fact lives

"Is this report still wanted" is a fact about the recipient's scope, not about
the producer. The architecture already says so at Team scope:
`TeamLeaderCompletionTargets` runs a member's delivery inside
`TeamService.admit()`, and a dissolving Team refuses it with `TeamClosedError`;
`TeammateService.enterOrdinaryMutation` refuses while the entity is not
`active` or is under host release. The baseline omitted the same reading in two
places — the dispatcher scope had no gate at all, and an entity's own turns never
consulted the entity's fence — and the Workflow run kept no notion of whether it
still owed its terminal report. This change adds those three reads and nothing
else.

## Design

One rule, read at three fences, always at the moment delivery would start:

1. **Entity fence** — `TeammateService` states
   `owesCompletion = phase === 'active' && hostStop === null` to its
   `EntityTurnCoordinator`, which hands the predicate to every `EntityTurn`.
   When a turn settles, `startDeliveryIfReady` reads it once. A negative answer
   releases the delivery closure for good, so a later `ensureDelivery()` cannot
   revive the report; a delivery already under way is never retracted. Both
   facts the predicate reads are published before the native stop
   (`closeAuthorized` sets `phase = 'closing'`; `stopForHost` sets `hostStop`),
   so a turn admitted ahead of the fence reads it when it settles, and one
   admitted behind it finds the runtime already stopped. `releaseHostRuntime`
   now collects a failed native stop instead of throwing past the drain: an
   admission in flight when the fence went up must still attach while
   `hostStop` is set, or its turn would settle later, fence gone, and report a
   stop nobody is left to read.

2. **Dispatcher fence** — `CompletionDeliveryPolicy` takes a required
   `accepting` predicate and reads it at the top of `deliverRuntime`, before
   token folding and before queueing. `DispatcherService` wires it to
   `DispatcherTaskDrain.accepting`, the dispatcher's own admission gate:
   `stop()`, `beginShutdown()`, and failed-start rollback already close it
   synchronously, and a successful rollback reopens it. A delivery queued before
   the gate closed runs to completion; a request behind it is logged at `info`
   and dropped. Reading it before folding means a token already folded is not a
   way past the gate. No in-process stop→start path exists today (`start` runs
   once per `DispatcherService`); a future restart feature would have to reopen
   the gate, which is one line next to where it reopens after rollback.

3. **Workflow fence** — `WorkflowRun` keeps the terminal report it still owes
   as a nullable `deliverTerminal`, initialised from its deps. The terminal's
   `closeAdmission(status)` callback is reached exactly once, when the first
   terminal intent is reserved; `stopped` is reserved only by `reserveStop()`,
   so `closeAdmission('stopped')` clears the report. A completed or failed
   intent that won first keeps it; `finalize()` delivers whatever is still
   owed and clears it. A delivery already under way can never be behind a
   `stopped` reservation, because finalize runs only after an intent exists, so
   no-retraction is structural. `terminalDeliveryCommitted` is gone: the
   nullable report is the single stored fact.

Team scope needs no change. Members' deliveries to the leader are already
refused by `TeamService.admit()` once a dissolve is published, and the leader
is stopped through `stopForHost`, so its own turns read the entity fence.

### What each teardown path does now

| Path | Fence read | Result |
| --- | --- | --- |
| Owner `close` (model tool or admin) | `phase = 'closing'` before the native stop | the turn settles `stopped`, reads `owesCompletion = false`, drops its closure |
| Host stop / restart | `DispatcherTaskDrain` closed at `stop()`; `hostStop` set per entity | everything settling behind the gate is dropped at the policy; each entity's own turns drop at settlement |
| Failed-start rollback | `DispatcherTaskDrain` closed at rollback start, reopened on success | same as host stop for the window; entities report again afterwards |
| Team dissolve | `TeamService` dissolve fence; leader `stopForHost` | members → leader refused by `admit()`; leader's stopped turn drops; a leader turn that completes naturally before the dissolve reaches it is delivered |
| `workflow_stop` / `stopAll()` | `closeAdmission('stopped')` clears `deliverTerminal` | record and journal converge to `stopped`; no push |
| Independent failure or stop | no fence up | delivered once, `null` token, as before |

### Entropy accounting

Removed relative to PR #389 (never merged): `CompletionDeliveryScope` and its
four instances, `abandonPendingDelivery` sweeps in `TeammateService`,
`TeammateCollection`, `TeamService`, and `DispatcherService`, construction-time
`observeConstruction` / `onConstructed` / `retireIfStale`, `rearm*` after
rollback and failed dissolve, `TeamCompletionDelivery` with `aggregateAbandoned`,
and `reserveStop(): boolean` plumbing.

Added relative to `next`: one required predicate on the policy, one getter on
the task drain, one predicate on the coordinator and the turn, one nullable
field on the Workflow run. Every addition is a read of a fact the scope already
published for another reason.

The fence reads pushed `TeammateService` and `WorkflowRun` past the 700-line
lint gate. The gate exists to force a refactor, not a split (operator,
2026-09-08: "700 行就是为了卡架构重构的"), so it is met by removing mechanics
the service layer had copied rather than by moving code between files:

- `service/closed-fact.ts` (`ClosedFactPublisher<Fact>`) is the one
  durable-close broadcast. It replaces `team-service/closed-fact.ts`
  (`TeamClosedPublisher`, on `next` since #350) and the identical listener
  loop `TeammateService` carried inline. Each owner builds its own fact beside
  that fact's type (`teamClosedFact`, `teammateClosedFact`); the one
  `ClosedSubscription` type replaces two identical interfaces.
- `service/in-flight-work.ts` (`InFlightWork`: `enter`, `track`, `drain`,
  `idle`) is the one tracker for work a scope admitted and must join before it
  stops. It replaces the `Set<Promise>` plus `while (size > 0) allSettled`
  loop in `DispatcherTaskDrain`, three copies in `WorkflowRun`
  (materializations, runner messages, agent tasks), the set in
  `WorkflowService.runCreations`, and the counter plus idle-waiter set in
  `TeammateService`. The fence stays with each scope; the tracker refuses
  nothing. The extra `await Promise.resolve()` after `WorkflowRun` joined its
  materializations (#338, no recorded scenario) goes with the loop; the
  Workflow stop race tests are the ordering evidence.
- The terminal completion fact stays inline in `WorkflowRun.finalize()` as on
  `next`; the dead `deferred()` helper in `run-support.ts` is deleted, and
  so is `DispatcherTaskDrain.trackAccepted`, which #317 added for the durable
  Team dissolve and whose only caller #350 removed.

Cleanup trail, not done here: the serialized-tail idiom
(`tail = tail.then(task, task)`) is copied in `WorkflowRun.mutate`,
`WorkflowRun.runnerMessageTail`, `EntityTurnCoordinator.enqueueAdmissionContinuation`
(with `drainAdmissions` as its idle wait), and `AgentRuntimeStateStore.enqueue`,
beside the keyed `KeyedAsyncQueue` in `service/serial-queue.ts`. One unkeyed
sibling there would absorb all four; it touches the state-write lease re-check
and the admission line, so it is a change of its own.

## Verification

- `packages/dreamux/tests/teammate-completion-lifecycle.test.ts` (ported
  unchanged in substance from PR #389, two test names updated): model and admin
  close for both owner roles, Team dissolve with members and with an active
  Workflow, a failed host stop with a late admission, shutdown then restart,
  completions settling behind the dispatcher gate during a long Workflow
  teardown, an admitted task restarting a released leader under the gate, and
  host shutdown of an active dispatcher Workflow. All observe actual owner
  runtime submissions through `ControlledRuntimeProvider`.
- `entity-turn.test.ts`: the baseline "delivers a close-induced stopped
  settlement" contract is replaced knowingly by "settles a turn its owner no
  longer wants reported, and never reports it" (including that the decision
  sticks after the owner becomes active again); "delivers an independently
  stopped settlement" keeps the PR #149 rule; "does not retract a delivery that
  already started"; a coordinator case for a late-attached turn.
- `completion-router.test.ts`: a delivery queued before the gate closed still
  runs; one requested behind it is dropped without touching the recipient.
- `workflow-service.test.ts`: stop delivers nothing; completed/failed intents
  that win before stop or `stopAll()` keep one delivery; a started delivery is
  not retracted; a run created across the `closeAdmission` fence stops without
  delivery.
- Gates: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
  `.agents/scripts/check.sh`, `git diff --check`.

## Superseded design

[PR #389](https://github.com/excitedjs/dreamux/pull/389) implemented the same
requirement producer-side: each aggregate held a `CompletionDeliveryScope`
epoch, teardown swept every owned entity to retire its pending closure,
construction that crossed the fence had to inherit the retired epoch, and every
path that could bring a scope back had to re-arm it. That placement is why the
change grew into what the operator called “各处的堵漏”: once the fact lives on
the producer, aggregate teardown must be propagated to a population that is
dynamic — mid-construction, lazily started, revived by an admitted task — and
every gap in that propagation is a new special case. Placing the fact on the
recipient's scope, which already publishes its fence for admission, needs no
propagation at all. The review trail for the superseded design lives on PR #389.
