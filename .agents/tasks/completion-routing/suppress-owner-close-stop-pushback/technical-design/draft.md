# Draft technical design

## Inputs

- Requirement:
  [`../requirement.md`](../requirement.md), frozen at SHA-256
  `286ec6ccc55b25753a24ce0eee7696323d8b281166da0b0990ef5241f1f7d264`.
- Source baseline: `origin/next` at
  `fffc3bd337f8ce28070fb8658fc30893e71730bb`.
- Selected workflow: TeamLeader-authored direct design with three independent
  reviewers.

This draft preserves the pre-implementation proposal and review amendments.
The operator-ratified aggregate-fence correction and Workflow bookkeeping
cleanup are authoritative only in [`final.md`](final.md).

## Decision

Make pending completion delivery abandonable at the entity Turn owner, and have
`TeammateService` exercise that capability synchronously when deliberate
teardown begins.

The lifecycle operation already owns the two facts needed to decide whether a
future Turn attachment may retain a completion delivery:

- `phase !== 'active'` means business close has begun; and
- `hostStop !== null` means this process is releasing runtime authority.

`EntityTurnCoordinator` will read those existing facts through one semantic
callback when it attaches a late provider admission. No new lifecycle phase,
persisted flag, router mode, role check, or provider-specific behavior is
introduced.

## Why this is the owning boundary

The pending obligation is created and retained by the TeamMate entity path:

1. `TeammateCollection` resolves the owner-specific recipient once and gives a
   delivery closure to `TeammateService`.
2. `EntityTurnCoordinator` attaches that closure to the admitted runtime
   submission and retains the Turn until settlement and delivery finish.
3. `EntityTurn` selects one terminal outcome and starts the closure.
4. `CompletionDeliveryPolicy` only receives work after the source Turn has
   decided to deliver it; it owns folding and recipient FIFO, not source
   lifecycle causality.

Therefore the coordinator can abandon exactly the source obligations that are
still pending. Clearing the recipient router would be both too late and too
broad: the delivery may not have reached the router yet, and one recipient
queue can contain unrelated results that remain valid. Clearing
`retainedTurns` would also be wrong because the same set proves runtime-stop
settlement and every retained Turn already has an `ensureDelivery`
continuation.

## Proposed source changes

### 1. Let an unsettled `EntityTurn` abandon only its pending delivery

In `packages/dreamux/src/service/teammate-service/turn-recording.ts`:

- make the stored delivery closure mutable inside `EntityTurn`;
- add a module-local/public-on-class operation named for the caller promise,
  such as `abandonPendingDelivery()`;
- when delivery has not started, clear the closure so later settlement remains
  observable but `ensureDelivery()` has nothing to submit;
- once `deliveryTask` exists, do nothing. A terminal outcome that already
  selected and started delivery before the lifecycle boundary is not
  retracted.

The ordinary settlement mapping does not change. An unexpected provider stop or
failure still selects `stopped` or `failed` and delivers it when no deliberate
teardown boundary abandoned that Turn.

### 2. Make `EntityTurnCoordinator` own abandonment across admission races

In `packages/dreamux/src/service/teammate-service/turn-coordinator.ts`:

- add `abandonPendingDeliveries()`, which iterates the retained Turns and asks
  each to abandon its not-yet-started delivery without removing the Turn;
- extend the existing options with a semantic predicate such as
  `acceptsCompletionDelivery()`;
- when an already-started provider admission attaches after teardown began,
  attach it with no delivery closure if that predicate is false;
- keep retaining the Turn, starting its settlement observer, and verifying its
  settlement exactly as today;
- rename `settleAndDeliverRetained()` only if needed to remove the now-false
  blanket wording. Its behavior remains: prove every retained Turn settled and
  await any delivery that had already started or remained eligible.

The predicate is required by a real race already supported by the current
admission model: `runtime.submit()` is invoked before its admission continuation
is serialized and attached. Close or host stop can begin while that admission
promise is still pending. Abandoning only the current `retainedTurns` snapshot
would miss that Turn.

### 3. Publish the lifecycle boundary before native stop

In `packages/dreamux/src/service/teammate-service/index.ts`:

- construct the coordinator's delivery predicate from the existing facts
  `phase === 'active' && hostStop === null`;
- on business close, move to `closing` and abandon pending deliveries before
  `transitionToClosed()` reaches `runtimeOwner.stopRuntime()`;
- on host stop, first publish the existing `hostStop` promise, then abandon
  pending deliveries synchronously, then let `releaseHostRuntime()` stop and
  drain as it does today;
- when a transient host stop finishes, the existing `hostStop = null` cleanup
  makes only future admissions deliverable again. Turns abandoned during the
  stop remain abandoned because their own closures were cleared;
- a racing close remains fenced by `phase === 'closing'` even after the host
  stop promise clears, so no nested suspension counter or second state machine
  is needed.

Both owner roles already enter this same service:

- a Dispatcher-owned collection resolves its Dispatcher Agent as recipient;
- a Team-owned collection resolves its TeamLeader as recipient.

Team dissolve and dispatcher/service shutdown already call
`TeammateService.stopForHost()` for materialized members. They gain the same
semantic boundary without adding policy to either aggregate or to Channel
presentation.

## Behavior preserved

- The close tool returns its current structured result.
- Runtime stop, admission drain, ordinary-mutation drain, settlement proof,
  durable close, worktree cleanup, and closed-fact publication keep their
  current order and owners.
- Independently completed, failed, or stopped Turns deliver exactly once while
  the lifecycle relationship is active.
- A delivery that started before teardown keeps the current completion-token
  folding and per-recipient FIFO behavior.
- Host stop remains distinct from business close: it writes no TeamMate closed
  state, and future work after a same-process restart can acquire a new delivery
  closure.
- AgentRuntime and ChannelProvider interfaces do not change.

## Rejected alternatives

### Filter `stopped` in the renderer or completion router

Rejected because status does not encode cause. It would hide unexpected stops
that the owner cannot infer, and it would require late policy to reconstruct a
lifecycle decision already known at the source.

### Clear `retainedTurns`

Rejected because retention also proves that native stop settled every admitted
submission, and the Turn's delivery observer has already been launched.

### Clear or cancel the recipient FIFO queue

Rejected because the queue is downstream of the pending closure and is shared
with unrelated valid completions for the same recipient. It would add
cancellation bookkeeping at the wrong owner.

### Persist a cancellation marker or add provider/channel-specific stop modes

Rejected because delivery obligations are process-local and deliberately not
replayed. The lifecycle decision and settlement are both Core-owned, so no
persisted recovery fact or provider/channel branch serves a named scenario.

## Verification plan

Use real Core owners and observable completion submissions; do not assert a
private boolean or source-text shape.

1. `EntityTurn` behavior:
   - an unexpected stopped settlement still invokes delivery once with a null
     provider token;
   - abandoning an unsettled Turn, then stopping it, settles as `stopped` and
     invokes no delivery;
   - abandoning after delivery has started does not retract that delivery.
2. Admission race:
   - begin a runtime admission, cross the lifecycle boundary before its promise
     resolves, then attach and settle it; settlement is retained but no owner
     submission occurs.
3. Explicit close through both collection ownership shapes:
   - a Dispatcher-owned TeamMate and a Team-owned member each have one pending
     Turn with a recording completion recipient;
   - model-facing collection close returns the normal structured result, the
     runtime Turn settles, and the respective Dispatcher/TeamLeader recipient
     records no completion submission.
4. Aggregate teardown:
   - a Team dissolve with a real materialized member records no member cleanup
     completion submission;
   - dispatcher/service shutdown with a real materialized direct TeamMate
     records no cleanup completion submission or failed completion input on the
     stopping owner;
   - retain the existing route/order tests proving those aggregates use
     `stopForHost()` and stop every materialized entity.
5. Preservation controls:
   - completed, failed, and unexpected stopped Turns still reach the recipient;
   - completion-token folding and recipient FIFO tests remain unchanged and
     green;
   - a future Turn admitted after a transient host stop again receives normal
     delivery.
6. Repository gates:
   - `node common/scripts/install-run-rush.js build`;
   - `node common/scripts/install-run-rush.js lint`;
   - `node common/scripts/install-run-rush.js test`;
   - `.agents/scripts/check.sh` after updating the behavior and architecture
     records.

Live provider or Feishu validation is not required for acceptance: the causal
boundary, both completion recipients, and the absence of owner submissions are
observable through the real Core composition with fake runtimes.

## Documentation and release surface

- Update `.agents/product/README.md` so background completion delivery states
  the deliberate-teardown exception instead of implying every pending result is
  delivered.
- Update `.agents/domains/dispatcher-orchestration.md` from “Every settled turn
  is reported” to the precise active-lifecycle invariant and record the
  source-owned abandonment boundary.
- Add the normal Rush change file for `@excitedjs/dreamux` describing the
  user-visible bug fix. No persisted schema, config, migration, rebuild, or
  compatibility change is involved.

## Expected entropy delta

Added: one Turn operation and one coordinator predicate/capability.

Removed: the blanket concept that every settlement must become a completion
submission even when the owner deliberately destroyed the relationship; the
resulting need for renderer, role, aggregate, or provider exceptions.

The final model remains one lifecycle decision at the TeamMate entity, one
settlement owner at the Turn coordinator, and one downstream delivery policy for
only the completions the source still owes.

## Workflow-stop amendment — 2026-09-08

PR #389 review exposed a second source-owned delivery obligation. The operator
asked “你这个回推处理Workflow的Stop逻辑了吗？” and, after the TeamLeader explained
the current path and recommended extending the uniform stop rule, replied “继续”.

### Current path and defect

`WorkflowService.stop()` and `WorkflowService.stopAll()` both reach
`WorkflowRun.stop()`. The run converges its runner, locked TeamMates, agent
results, journal, and durable terminal record, then unconditionally calls the
captured `deliverTerminal` closure. Consequently both explicit `workflow_stop`
and aggregate cleanup deliver a stopped Workflow completion to the initiating
Agent. `WorkflowRunTerminal.suppressDelivery` is unrelated: it stops per-agent
results from being sent back into an aborting runner, not terminal delivery to
the Workflow owner.

### Proposed owner and mechanism

Keep the decision at `WorkflowRun`, which already owns the captured terminal
delivery closure and the one terminal finalization. Store that closure as a
mutable pending obligation. Make `WorkflowRunTerminal.reserveStop()` report
whether it won the existing first-intent race. Both `WorkflowRun.stop()` and
`WorkflowRun.closeAdmission()` synchronously abandon the closure only when that
reservation succeeds, then join or continue the same terminal task. The second
entry point covers existing runs and the create-versus-scope-stop race, because
`WorkflowService` calls `closeAdmission()` before `stopAll()` and also calls it
on a run created after service admission closes.

During finalization, snapshot and invoke the closure only when it is still owed.
Once invocation begins, a later stop cannot retract its promise. A completed or
failed intent selected before stop makes `reserveStop()` return false, so its
delivery remains owed through the multi-await finalization window. A runner
terminal message only queued behind the scope fence has not selected an intent;
the stop intent wins under the existing ordering and its delivery is abandoned.
No second queue-inspection or causal state is added.

This adds no stop mode, caller-role branch, downstream queue cancellation, or
persisted fact. Explicit stop and aggregate cleanup intentionally share the same
rule, matching the operator-approved TeamMate boundary and avoiding a causal
discriminant that no consumer needs.

### Verification amendment

- invert the existing `workflow.stop` delivery assertion: stop still waits for
  accepted work and persists `stopped`, but the owner records no terminal
  completion;
- prove `WorkflowService.stopAll()` also produces no terminal completion;
- prove a natural completed and failed intent selected before stop still deliver
  exactly once even when finalization has not reached owner delivery;
- prove a delivery already invoked before stop is not retracted;
- unconditionally cover the create-versus-close-admission race and assert one
  stopped durable record with no owner completion;
- add real-owner observation for Team dissolve and host stop with active
  Workflows;
- explicitly invert `workflow-service.test.ts`'s two stopped-delivery assertions
  and keep its natural-failure delivery test unchanged;
- update product, architecture, service-local, maintenance, task, Issue, and Rush
  change-note text from TeamMate-only teardown to the two source-owned
  obligations.
