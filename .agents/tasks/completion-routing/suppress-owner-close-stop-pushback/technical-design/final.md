# Drop lifecycle-stop completion pushback

## Outcome

When deliberate teardown begins, permanently abandon each source-owned
completion obligation that has not started: an `EntityTurn` delivery on
TeamMate close or host stop, and a `WorkflowRun` terminal delivery when stop
wins that run's first-terminal-intent race. Turn settlement and Workflow
terminal persistence still converge. This applies uniformly to explicit
TeamMate close, explicit `workflow_stop`, Team dissolve, and host shutdown or
restart, plus failed-start rollback, for both TeamLeader and Dispatcher
recipients. Team dissolve and Dispatcher shutdown publish the retirement at
their outer synchronous fence, before any contained resource convergence.

The implementation stays in Core. It does not filter a rendered `stopped`
message, cancel a recipient queue, branch on owner role, or change an Agent
Runtime or Channel provider contract.

The frozen requirement is
[`../requirement.md`](../requirement.md), SHA-256
`286ec6ccc55b25753a24ce0eee7696323d8b281166da0b0990ef5241f1f7d264`.
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

Workflow terminal delivery has separate history. PR #313 introduced the
Workflow completion producer, PR #338 put the current unconditional
`WorkflowRun.finalize()` delivery in place, and PR #350 later added the explicit
test that `workflow.stop()` delivers `stopped`. PR #350 is therefore the direct
origin of the TeamMate regression, but not the original source of Workflow
terminal pushback.

## Product behavior

| Scenario | Completion delivery after this change |
| --- | --- |
| A Dispatcher closes its direct TeamMate | Pending delivery to the Dispatcher is abandoned. |
| A TeamLeader closes a Team member | Pending delivery to the TeamLeader is abandoned. |
| A Team dissolves | Pending member-to-leader and leader-to-Dispatcher delivery is abandoned. |
| The Dispatcher host shuts down or restarts | Pending delivery from every existing or concurrently constructing TeamMate or TeamLeader is abandoned. |
| An Agent invokes `workflow_stop` while the run has no terminal intent | The run converges to `stopped`, the normal receipt returns, and pending Workflow terminal delivery is abandoned. |
| Team dissolve or host stop calls `WorkflowService.stopAll()` | A stop intent that wins abandons the Workflow terminal delivery to the stopping TeamLeader or Dispatcher. |
| A partially opened Dispatcher or Team start fails and rolls back | Pending TeamMate delivery and stop-winning Workflow terminal delivery are abandoned; stopped work is not recovered or replayed. |
| A turn independently completes, fails, or stops while its lifecycle relationship remains active | Delivery remains exactly once, with the existing completion token or `null` token semantics. |
| A Workflow completed or failed intent wins before stop | Its natural terminal delivery remains exactly once, even if finalization has not reached delivery yet. |
| Delivery already started before teardown | It is not retracted and keeps the existing folding and recipient FIFO behavior. |

The third row is an explicit complexity decision. A TeamLeader that self-dissolves
can therefore leave a still-running Dispatcher without the answer to the current
Team task. The operator delegated this edge to code-complexity judgment on
2026-09-07. Keeping it would require a new causal mode distinguishing who
initiated dissolve and threading that distinction through `TeamClosing` and
`TeammateService`. Because the result was declared non-important, the final
solution chooses the lower-entropy uniform teardown rule and requires no caller
mode or role exception.

A runner terminal message still queued when the scope fence reserves `stopped`
has not selected a natural intent. Stop wins through the existing first-intent
rule and the resulting stopped run has no delivery. Preserving an unprocessed
message would require a second causal ordering mechanism, contrary to the
uniform boundary the operator approved.

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

`WorkflowService` separately captures the initiating Agent and supplies a
terminal delivery closure to `WorkflowRun`. The run already owns its terminal
intent, persistence, and one finalization, so it also owns whether that pending
closure remains owed. `CompletionDeliveryPolicy` remains downstream and sees
only terminal facts whose source chose to deliver.

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
- add a semantic completion-delivery-scope option supplied by the owning
  `TeammateService`;
- capture that opaque scope before starting provider admission, then retain a
  late-attached Turn with a `null` delivery closure unless the captured scope is
  still the current non-null scope;
- rename `settleAndDeliverRetained()` to `convergeRetainedTurns()` and keep its
  real promise: prove retained Turns settled, then await only delivery that was
  already started or remained eligible.

The sweep and the attach-time predicate cover different populations of the same
obligation:

1. the sweep permanently abandons Turns already retained at the boundary;
2. the captured-scope check prevents an admission started before the boundary
   but attached afterwards from acquiring a new obligation.

A predicate read only at settlement is not equivalent. If native stop fails or
an aggregate dissolve is refused and future work is re-enabled, an abandoned
Turn may remain unsettled after the live eligibility flag changes back. The
opaque scope identity makes the admission-time decision permanent across that
re-arm without becoming a persisted lifecycle phase. It exists only because the
operator selected aggregate fence semantics together with future reuse after a
failed boundary; a Boolean would allow a pre-fence admission to attach after the
Boolean is reset. Retained Turns still use the direct operation rather than
consulting the scope again at settlement.

### 3. Publish aggregate and entity lifecycle fences synchronously

In `packages/dreamux/src/service/teammate-service/index.ts`, own one opaque,
process-local completion-delivery scope. A non-null identity means new
admissions may acquire an obligation. `abandonPendingCompletionDelivery()`
sets it to `null` and sweeps retained Turns synchronously. Re-arming installs a
fresh identity rather than restoring the old one, so an admission captured
before the fence remains ineligible even if it attaches after future work is
enabled. This is neither persisted state nor a new entity phase.

For business close, make `turns.abandonPendingDeliveries()` the first synchronous
operation inside the deduplicated `transitionToClosed()`, before
`runtimeOwner.stopRuntime()`. The only active-to-closing transition flows from
`closeAuthorized()` directly into this method, so this one insertion covers the
model-facing and admin close paths and the close phase remains a fence if native
stop fails.

For host release, assign the existing `hostStop` promise first, invoke the same
abandon operation, and only then run `releaseHostRuntime()`. Keep `hostStop`
published through admission and Turn convergence even if native stop rejects:

1. collect a `runtimeOwner.stopRuntime()` failure rather than returning early;
2. still drain admission continuations;
3. still wait for ordinary mutations;
4. still run `convergeRetainedTurns()`;
5. throw the original failure, or the existing aggregate shape when convergence
   adds another failure;
6. clear `hostStop` in the existing outer `finally` after those steps, without
   re-arming delivery while the owning aggregate fence remains raised.

This failure path is required by a reachable race: a provider submission may be
started before host stop but attach only after `runtime.stop()` rejects. Draining
while the abandoned scope remains published makes that attachment receive a
`null` delivery closure. The owning Dispatcher startup or failed-start rollback
success later installs a fresh scope for future work; each old Turn remains
permanently detached.

The current per-entity stop is too late for an aggregate. Therefore:

- `TeamService.dissolve()` publishes retirement for its current and concurrently
  constructing members and leader synchronously with the existing
  `dissolveTask` fence, before the asynchronous workspace assessment, Workflow
  stop, scheduler stop, or runtime convergence begins;
- `DispatcherService.stop()` and `beginShutdown()` synchronously retire direct
  TeamMate delivery and delivery from every current or concurrently constructing
  Team's members and leader beside their existing admission fences, before
  `doStop()` awaits Workflows or Teams; and
- each owning collection captures an opaque population scope before asynchronous
  materialization, retires a service built from a stale scope before publishing
  or submitting it, and sweeps current, reopening, and already-constructed
  in-flight services at the fence. Collection and Team wrappers do not infer
  owner role or manipulate Turn state themselves.

If a Team dissolve fails and its admission fence is lowered, it asks each
surviving source to install a fresh scope. A nested aggregate-fence fact prevents
that local re-arm from overriding a concurrent Dispatcher teardown. Old retained
Turns stay abandoned and old provider admissions carry the superseded scope;
only later work becomes eligible. Dispatcher startup and successful failed-start
rollback re-arm future work explicitly, after resource release has converged.
Failed-start rollback deliberately retains the same abandonment behavior: the
operator chose the lower-complexity rule that work accepted during a partially
opened start is stopped without recovery, replay, or terminal completion
pushback.

If a provider admission never resolves, host release continues to wait as it does
today. This change adds no timeout, retry, or recovery controller.

### 4. Abandon Workflow delivery only when stop wins the terminal intent

In `packages/dreamux/src/service/workflow-service/run-terminal.ts`, make
`reserveStop()` return whether it installed the existing `stopped` intent. Its
current synchronous guard — no prior intent and durable status still `running`
— remains the sole arbiter. No new phase or causality flag is introduced.

In `packages/dreamux/src/service/workflow-service/run.ts`:

- destructure the constructor-supplied `deliverTerminal` closure out of the
  retained dependency object and store it only once, as the run's mutable,
  nullable pending obligation;
- have both `stop()` and `closeAdmission()` ask `reserveStop()` first and clear
  that closure only when the reservation succeeds;
- still join the existing retryable terminal task, so stop receipts, runner and
  TeamMate cleanup, journal writes, record writes, and unlock ordering are
  unchanged;
- remove `terminalDeliveryCommitted`; in `finalize()`, synchronously snapshot
  the closure, invoke it only when non-null, and clear the stored closure only
  after that invocation succeeds. A rejected invocation leaves the same closure
  pending for the terminal task's existing retry. Once invocation starts, the
  local snapshot is the no-retraction fact;
- keep natural completed and failed delivery on the existing
  `CompletionDeliveryPolicy.deliver()` null-token path.

Both entry points are load-bearing. `WorkflowService.closeAdmission()` reaches
runs already in its map before `stopAll()`, while `createRun()` calls
`run.closeAdmission()` when construction crosses a scope fence before the run
was visible. Explicit `WorkflowService.stop()` reaches `run.stop()` directly.
The two populations are disjoint; a caller mode would add entropy without
changing their shared stop semantics.

The stop-winner condition closes the reviewed natural-result race. If a
completed or failed intent is already selected while `finalize()` awaits earlier
steps, `reserveStop()` returns false and the closure remains. If only a runner
message is queued, the stop fence can reserve first exactly as it does today.
The nullable closure is now the single stored obligation: non-null means still
owed, while null means either deliberately abandoned or successfully delivered,
which no later behavior needs to distinguish.

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
  turns and naturally deliverable Workflow terminal facts.

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
9. Invert both existing stopped-Workflow delivery assertions in
   `packages/dreamux/tests/workflow-service.test.ts` (the durably-terminal late
   runner-message case and the accepted-turn convergence case). Stop still
   converges and returns `stopped`, but records no terminal delivery. Keep the
   natural-failure delivery test unchanged.
10. Add `WorkflowService.stopAll()` delivery-absence coverage and a deterministic
    create-versus-`closeAdmission()` race proving a stopped record and no owner
    completion.
11. Hold natural completed and failed intents inside finalization, invoke
    explicit stop and `stopAll()`, then prove the natural status and exactly-one
    owner delivery remain. Separately prove delivery already invoked is not
    retracted.
12. Exercise real owner submissions for an active Team-scoped Workflow during
    Team dissolve and an active Dispatcher-scoped Workflow during host stop.
    Both terminal records converge without a Workflow completion input reaching
    the stopping TeamLeader or Dispatcher.
13. Add correction-specific aggregate-fence main-path coverage: hold an earlier
    teardown stage open and settle a pending TeamMate after the outer fence but
    before its `stopForHost()` turn; separately let an already-admitted task
    restart a TeamLeader after its first host-release sweep. Neither path may
    start an owner completion submission.

The operator selected “只测主路径” during implementation-review ratification.
The correction therefore does not add the three extra review-suggested matrices
for retained completed/failed settlement, a runner terminal message already
queued behind a blocked tail, or same-Service re-arm. Existing coverage for
natural Workflow intent, delayed admission, no retraction, and future delivery
remains; only the aggregate-fence main-path coverage above is newly required.

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
- the `EntityTurn` and Workflow terminal source comments; and
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
  host stop is active receives no source completion delivery. New work after
  host stop is eligible again.

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

### Workflow-stop amendment review

- **Accepted from lifecycle and verification reviews:** abandonment must be
  conditional on stop winning the existing first-terminal-intent race. A
  previously selected completed or failed intent keeps delivery throughout the
  multi-await finalization window.
- **Adjudicated from the boundary review:** a runner terminal message only
  queued when `closeAdmission()` reserves stop has not selected an intent. The
  existing stop intent wins and delivery is abandoned. This is the current
  ordering fact, not a new mode; the amended requirement states the visible
  consequence explicitly.
- **Accepted from all reviews:** invert both load-bearing stopped-Workflow
  assertions, retain the natural-failure assertion, and require delivery-level
  coverage for `stopAll()`, create-versus-close-admission, Team dissolve, and
  host stop.
- **Accepted:** supersede every earlier Workflow exclusion in the final design,
  product/architecture/package/maintenance knowledge, public Issue, and Rush
  change note.
- **Accepted:** keep the TeamMate and Workflow nullable obligations independent.
  They have different owners and temporal shapes; introducing a shared helper
  would add indirection without removing either mechanism.

### Implementation-review ratification

- **Accepted and operator-ratified:** publish Team dissolve and Dispatcher
  shutdown retirement at the outer synchronous fence. The operator selected
  “采用栅栏语义 (Recommended)”.
- **Superseded as blockers by an explicit product decision:** failed-start
  rollback continues to abandon pending TeamMate and Workflow completion. After
  the scenario and relative implementation cost were explained, the operator
  selected “确认丢弃 (Recommended)”. This is now a named teardown boundary rather
  than an accidental expansion of `stopForHost()` or `closeAdmission()`.
- **Accepted with narrowed verification:** the operator selected “只测主路径”.
  Add the aggregate-fence regression, but not the three additional edge-case
  matrices proposed by implementation review.
- **Accepted:** synchronize requirement, product, final design, artifact hashes,
  and task state. The operator selected “同步更正 (Recommended)”.
- **Accepted as in-scope cleanup:** remove the duplicate Workflow terminal-
  delivery storage and committed Boolean while preserving first-intent,
  delivery-failure retry, and no-retraction semantics. After the bookkeeping was
  explained, the operator selected “本次重构”.
- **Rejected:** do not replace explicit stop causality with a predicate on a
  late `stopped` status. Fable withdrew that proposal after the recovery path
  proved `stopped` has another producer.

No unresolved ownership, architecture, behavior, migration, or verification
choice remains.

### Final architecture re-review correction

- **Accepted:** per-entity `stopForHost()` must not re-arm completion delivery.
  It cannot know whether release is transient or one step inside an aggregate
  teardown. Re-arm moved to successful Dispatcher startup or failed-start
  rollback completion; failed Team dissolve retains its local re-arm only while
  no outer Dispatcher fence is active.
- **Accepted:** an aggregate snapshot of materialized services is insufficient.
  A `spawn`, `send`, Team construction, member construction, or lazy leader
  construction that crosses the fence must inherit the retired population
  scope before it can publish or submit work.
- **Accepted as verification:** deterministic main-path tests exercise both a
  settlement delayed behind an earlier teardown stage and an already-admitted
  task that restarts a released TeamLeader while the aggregate fence remains
  raised.

## Entropy delta and residual risk

Added for TeamMate: one public-on-class Turn operation, one coordinator sweep,
opaque process-local entity and population scope identities, and narrow
aggregate pass-throughs that publish them at the true teardown fence. The
population scope removes the false assumption that an aggregate snapshot sees
every construction already admitted before the fence. Re-arm is owned by the
aggregate that can distinguish restart from teardown, with one nested Team fact
preventing a failed dissolve from overriding an outer Dispatcher fence. Added for Workflow:
one mutable nullable closure, two stop-boundary calls sharing `reserveStop()`'s
Boolean result, and one finalize snapshot/check. The Workflow cleanup removes
the duplicate closure reference and committed Boolean, leaving the nullable
closure as the single stored obligation. These are two source owners applying
one product rule without a shared indirection. No new entity, persisted fact,
caller mode, provider branch, recovery controller, or downstream cancellation
exists.

Removed: the blanket concept that every settled Turn or terminal Workflow must
become a model input even after its delivery relationship was deliberately
destroyed, plus the need for role, renderer, router, or provider exceptions.

An already-started delivery may still fail if its recipient stops immediately
after the boundary. This is the accepted no-retraction limit, not a guarantee
that every shutdown is free of all historical delivery failures.
