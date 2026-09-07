# Drop lifecycle-stop completion pushback

## Outcome

When deliberate teardown begins for a `TeammateService`, permanently abandon
every completion delivery that has not started, while retaining the Turn until
runtime settlement has converged. This applies uniformly to explicit TeamMate
close, Team dissolve, and host shutdown or restart, for both TeamLeader and
Dispatcher recipients.

The implementation stays in Core. It does not filter a rendered `stopped`
message, cancel a recipient queue, branch on owner role, or change an Agent
Runtime or Channel provider contract.

The frozen requirement is
[`../requirement.md`](../requirement.md), SHA-256
`d2b40d9b10451621d9c04463df29b8f0ad701f3163bb8f9276f1e7a2221e3961`.
The source baseline and current `origin/next` are
`fffc3bd337f8ce28070fb8658fc30893e71730bb`.

## Root cause and history

PR #149 introduced ordinary reverse completion delivery for completed, failed,
and stopped TeamMate turns. That general rule remains correct: an independently
failed or stopped turn is news its owner cannot infer.

PR #338 consolidated close and host release around the same stop, admission
drain, settlement, and delivery sequence. PR #350 then made the blanket rule
explicit in `EntityTurn`: every selected outcome, including a close-induced
`stopped` outcome, immediately starts the stored delivery closure. That is the
direct origin of the current regression. PR #380 only added the explanatory
automated-notification wording; it did not create the delivery.

The repair therefore changes the source obligation established by PR #350 at a
known lifecycle boundary. It does not weaken PR #149's ordinary failed/stopped
delivery or infer teardown from terminal status.

## Product behavior

| Scenario | Completion delivery after this change |
| --- | --- |
| A Dispatcher closes its direct TeamMate | Pending delivery to the Dispatcher is abandoned. |
| A TeamLeader closes a Team member | Pending delivery to the TeamLeader is abandoned. |
| A Team dissolves | Pending member-to-leader and leader-to-Dispatcher delivery is abandoned. |
| The Dispatcher host shuts down or restarts | Pending delivery from every materialized TeamMate or TeamLeader is abandoned. |
| A turn independently completes, fails, or stops while its lifecycle relationship remains active | Delivery remains exactly once, with the existing completion token or `null` token semantics. |
| Delivery already started before teardown | It is not retracted and keeps the existing folding and recipient FIFO behavior. |

The third row is an explicit complexity decision. A TeamLeader that self-dissolves
can therefore leave a still-running Dispatcher without the answer to the current
Team task. The operator delegated this edge to code-complexity judgment on
2026-09-07. Keeping it would require a new causal mode distinguishing who
initiated dissolve and threading that distinction through `TeamClosing` and
`TeammateService`. Because the result was declared non-important, the final
solution chooses the lower-entropy uniform teardown rule and requires no caller
mode or role exception.

Workflow-run terminal delivery is separate: `WorkflowService` calls
`CompletionDeliveryPolicy` directly, so this change does not suppress or alter
Workflow completion semantics.

## Owning boundary

`TeammateCollection.resolveCompletionDelivery()` resolves the owner-derived
recipient and supplies a closure to `TeammateService`. The service passes it
through `EntityTurnCoordinator`, which retains the admitted Turn, and
`EntityTurn` selects the single terminal outcome and starts delivery.

That makes the source Turn the owner of whether its not-yet-started obligation
still exists. `CompletionDeliveryPolicy` is downstream: it owns token folding and
per-recipient FIFO only after a Turn has chosen to deliver. Clearing that queue
would be too late and could remove unrelated valid completions. Clearing
`retainedTurns` would discard the settlement proof needed after runtime stop.

## Source changes

### 1. Make an `EntityTurn` delivery permanently abandonable

In `packages/dreamux/src/service/teammate-service/turn-recording.ts`:

- make `deliveryClosure` mutable inside `EntityTurn`;
- add `public abandonPendingDelivery(): void`;
- clear the closure only while `deliveryTask === null`;
- keep the selected outcome, provider completion token, `settled`, and retention
  behavior unchanged;
- rewrite the blanket "Every settled turn is reported" comment to state that a
  selected outcome is delivered only while the source relationship still owes
  it.

`deliveryTask !== null` is the existing fact that delivery has started. No
second flag, cancellation token, or downstream retraction protocol is added.

### 2. Cover both sides of the admission race in `EntityTurnCoordinator`

In `packages/dreamux/src/service/teammate-service/turn-coordinator.ts`:

- add `abandonPendingDeliveries()`, which iterates retained Turns and calls
  `abandonPendingDelivery()` without removing them;
- add the semantic option `acceptsCompletionDelivery: () => boolean`;
- when a provider admission resolves and attaches after teardown began, retain
  the Turn with a `null` delivery closure when the predicate is false;
- rename `settleAndDeliverRetained()` to `convergeRetainedTurns()` and keep its
  real promise: prove retained Turns settled, then await only delivery that was
  already started or remained eligible.

The sweep and the attach-time predicate cover different populations of the same
obligation:

1. the sweep permanently abandons Turns already retained at the boundary;
2. the predicate prevents an admission started before the boundary but attached
   afterwards from acquiring a new obligation.

A predicate read only at settlement is not equivalent. If native stop fails,
`hostStop` can eventually clear while an abandoned Turn remains unsettled; a
later settlement would then observe an active service and leak the completion.
An epoch or generation could make that decision permanent, but would add a new
lifecycle state solely to replace the direct Turn operation. The two temporal
applications above use only facts and objects the service already owns.

### 3. Publish and exercise the lifecycle boundary before native stop

In `packages/dreamux/src/service/teammate-service/index.ts`, construct the
coordinator predicate from the existing facts:

```ts
this.phase === 'active' && this.hostStop === null
```

No persisted marker or new lifecycle phase is introduced.

For business close, make `turns.abandonPendingDeliveries()` the first synchronous
operation inside the deduplicated `transitionToClosed()`, before
`runtimeOwner.stopRuntime()`. The only active-to-closing transition flows from
`closeAuthorized()` directly into this method, so this one insertion covers the
model-facing and admin close paths and the close phase remains a fence if native
stop fails.

For host release, assign the existing `hostStop` promise first, synchronously
abandon retained deliveries, and only then run `releaseHostRuntime()`. Keep
`hostStop` published through admission and Turn convergence even if native stop
rejects:

1. collect a `runtimeOwner.stopRuntime()` failure rather than returning early;
2. still drain admission continuations;
3. still wait for ordinary mutations;
4. still run `convergeRetainedTurns()`;
5. throw the original failure, or the existing aggregate shape when convergence
   adds another failure;
6. clear `hostStop` only in the existing outer `finally` after those steps.

This failure path is required by a reachable race: a provider submission may be
started before host stop but attach only after `runtime.stop()` rejects. Draining
while `hostStop` remains published makes that attachment receive a `null`
delivery closure. Once the transient host stop clears, only future admissions can
receive delivery; each abandoned Turn remains permanently detached.

If a provider admission never resolves, host release continues to wait as it does
today. This change adds no timeout, retry, or recovery controller.

## Unchanged boundaries

- `CompletionDeliveryPolicy`, the completion renderer, and recipient queues are
  unchanged.
- `AgentRuntimeProvider`, `ChannelProvider`, public command/MCP shapes, and
  provider implementations are unchanged.
- Runtime stop, admission ordering, durable TeamMate close, worktree cleanup,
  and closed-fact publication keep their existing owners.
- No config, persisted state, version, migration, rebuild, or compatibility
  mechanism is added.
- Notification text remains available for independently deliverable stopped
  turns.

## Verification

Behavior tests must observe real delivery closures or owner submissions, not a
private flag.

1. Invert the existing
   `packages/dreamux/tests/entity-turn.test.ts` close-induced-stopped test: it
   encodes PR #350's superseded blanket rule. Prove an abandoned Turn still
   settles `stopped` but delivers nothing, and add the no-retraction case after
   delivery starts.
2. Keep `packages/dreamux/tests/completion-delivery.test.ts` unchanged and green.
   Its null-token failed/stopped cases are the retained PR #149 contract.
3. Add coordinator admission-race coverage: start provider admission, cross the
   lifecycle boundary before attachment, then resolve and settle it; the Turn is
   retained and no delivery occurs.
4. Add a separate host-stop failure case: admission is unresolved,
   `runtime.stop()` rejects, the admission later attaches and settles, host stop
   reports the failure, and the owner records no completion submission.
5. Exercise model-facing close through Dispatcher-owned and Team-owned
   collections. The structured close result remains normal and the actual
   Dispatcher or TeamLeader recipient receives no completion input. Direct admin
   close uses the same boundary.
6. Exercise Team dissolve with materialized members and a leader completion
   recipient. Neither member cleanup into the leader nor the leader's pending
   Team result into the Dispatcher is submitted.
7. Exercise Dispatcher shutdown/restart with materialized direct TeamMates and
   Teams. No cleanup completion reaches a stopping owner, and a new Turn after a
   successful transient host stop delivers normally.
8. Preserve the completion-token folding, per-recipient FIFO, completed, failed,
   and independent stopped-delivery tests unchanged.

Run the repository gates:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
.agents/scripts/check.sh
```

Live Agent Runtime or Feishu validation is not required for acceptance because
the causal boundary and both recipient shapes are observable through real Core
composition with controlled runtimes.

## Documentation and release

Update every live blanket invariant rather than leaving competing authorities:

- both background-completion statements in `.agents/product/README.md`;
- the detailed delivery flow and the repeated invariant in
  `.agents/domains/dispatcher-orchestration.md`;
- `packages/dreamux/src/service/CLAUDE.md`;
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md`;
- the `EntityTurn` source comment; and
- this task's current-state record.

Add a patch Rush change file for `@excitedjs/dreamux`. This is a user-visible bug
fix without an incompatible public or persisted contract, so it is not a 0.x
breaking/minor change and needs no `BREAKING:`, `Review:`, or `Rebuild:` note.

## Review adjudication

Three independent reviewers examined the draft against the same frozen
requirement and source baseline.

### Lifecycle review

- **Accepted:** native stop failure can clear `hostStop` before a delayed
  admission attaches. The final design makes host release collect that failure,
  converge admissions and retained Turns under the same published boundary, then
  rethrow it. A dedicated regression test is required.
- **Accepted:** add the source-local and detailed architecture documentation, and
  the mandatory `typecheck:tests` gate.

### Verification review

- **Accepted:** explicitly name the requirement-driven inversion of
  `entity-turn.test.ts` and keep the PR #149
  `completion-delivery.test.ts` contract unchanged.
- **Accepted:** place close abandonment inside `transitionToClosed()` before
  native stop, make `abandonPendingDelivery()` public, and make the convergence
  rename mandatory.
- **Accepted as documented behavior:** a locked submission that attaches while
  host stop is active receives no source completion delivery; Workflow-run
  terminal delivery remains outside this path. New work after host stop is
  eligible again.

### Boundary review

- **Rejected, with failure evidence:** a settlement-time predicate alone does
  not permanently abandon an unsettled Turn once a failed transient host stop
  clears. A new lifecycle generation would solve that but adds more state. The
  final design retains the direct Turn abandonment plus the attach-time gate and
  explains their two distinct race populations.
- **Accepted and decided by the operator's complexity delegation:** a
  TeamLeader self-dissolve also drops its pending answer to the Dispatcher. The
  consequence is now explicit; no causal mode or role exception is added.
- **Accepted:** expand the documentation set to every live invariant plus the
  maintenance troubleshooting reference and source comment.
- **Accepted:** add `typecheck:tests` and explicitly justify the load-bearing
  test inversion.

No unresolved ownership, architecture, behavior, migration, or verification
choice remains.

## Entropy delta and residual risk

Added: one public-on-class Turn operation, one coordinator sweep, and one
attach-time semantic predicate. The sweep and predicate are the two necessary
temporal applications of one abandonment rule; no new entity, phase, generation,
persisted fact, caller mode, provider branch, or downstream cancellation exists.

Removed: the blanket concept that every settled Turn must become a model input
even after its delivery relationship was deliberately destroyed, plus the need
for role, renderer, router, or provider exceptions.

An already-started delivery may still fail if its recipient stops immediately
after the boundary. This is the accepted no-retraction limit, not a guarantee
that every shutdown is free of all historical delivery failures.
