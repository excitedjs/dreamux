# Fable architecture consultation

## Scope

The operator requested a final Fable consultation after implementation and
verification. The consultation received the pre- and post-PR #350 TeamMate
behavior, the independent Workflow terminal path, both proposed races, the
approved requirement and final design, all earlier reviews, and the complete
working-tree diff from baseline
`fffc3bd337f8ce28070fb8658fc30893e71730bb`.

The questions were whether the races are real, whether they are irreducible
asynchrony or symptoms of a poor boundary, whether source-owned abandonment is
the lowest-entropy design, and whether another boundary can remove mechanisms
without losing an accepted behavior.

## Verdict

`ACCEPTABLE`. The final narrow review found no architecture blocker after the
aggregate-owned scope and stale-operation corrections described below.

The earlier changing verdicts and the withdrawn status-based Workflow proposal
remain below as the decision trail rather than as current recommendations.

## Race audit

| Race | Reachability | Classification |
| --- | --- | --- |
| A provider submission starts, teardown publishes its fence, and the admission resolves and attaches its `EntityTurn` afterwards. | Reachable. The Agent Runtime submission is a real cross-process request and can remain unresolved across teardown. | Irreducible asynchronous fact, not a state manufactured by the tests. |
| A Workflow selects completed or failed intent, then waits in multi-step finalization before delivery while a stop arrives. | Reachable. Runner stop, materialization join, TeamMate close, journaling, and store writes contain real awaits. | Not a separate race: the existing write-once first-intent arbiter already owns the outcome; finalization had failed to use that ownership. |
| A runner terminal message is received but remains queued behind an earlier runner message while stop reserves the first terminal intent. | Reachable. The runner-message tail serializes asynchronous handlers before terminal selection. | Existing first-intent ordering, not a new semantic mechanism. |

## Initial mechanism ledger

### TeamMate

- A nullable `EntityTurn` delivery closure and
  `abandonPendingDelivery()`, using existing `deliveryTask !== null` as the
  no-retraction fact.
- A coordinator sweep for Turns already attached when teardown begins.
- An attach-time eligibility predicate for provider admissions that resolve
  after the fence.
- Host-stop failure convergence while the existing `hostStop` promise remains
  published.

The sweep and predicate cover the two different times at which the same
obligation can exist. A settlement-time predicate alone is insufficient because
a failed transient host stop can clear its predicate before the Turn settles.
Replacing the two temporal applications with an epoch would add lifecycle state
and a re-arm mechanism. The consultation recommends retaining this shape.

### Workflow

- A mutable nullable copy of the terminal delivery closure.
- A Boolean result added to `reserveStop()`.
- Repeated conditional clearing in `stop()` and `closeAdmission()`.
- A finalization snapshot and two null checks, alongside the existing terminal
  delivery-committed fact.

The consultation judged this set behaviorally correct but not minimal.

## Withdrawn Workflow collapse proposal

Current source has one provable invariant: `reserveStop()` is the only writer of
a `stopped` Workflow terminal intent. Natural request and failure paths produce
only `completed` or `failed`. Therefore the persisted terminal candidate already
encodes whether stop won the first-intent race.

The proposed alternative keeps the decision at the source `WorkflowRun`, but
changes finalization to deliver only when `candidate.status !== 'stopped'`. It
removes:

- the mutable nullable delivery copy;
- the constructor assignment;
- the Boolean `reserveStop()` contract;
- both stop-entry clearing sites; and
- the delivery snapshot and duplicate null checks.

It adds one source-local terminal-status predicate and a comment recording the
invariant. Explicit stop, `stopAll()`, construction across `closeAdmission()`, a
queued-but-unselected runner result, a natural intent selected before stop, and
no retraction after delivery starts all retain their reviewed outcomes.

The consultation recommended making the invariant explicit in the type surface
or source comment so a future natural `stopped` producer cannot silently change
the rule.

## Other observations

- Collapsing the Workflow mechanism also restores margin under the existing
  `run.ts` line-count gate. The current implementation reaches that gate by
  simplifying an equivalent pre-existing guard.
- The current Workflow bookkeeping keeps the delivery closure in both `deps`
  and the mutable field while also retaining a delivery-committed Boolean. This
  is harmless today but makes the obligation less singular than the intended
  design.
- Reverting to the pre-PR #350 token gate is inferior: it suppresses deliberate
  close only accidentally and also loses independently failed or stopped facts.

## Operator recommendation

Retain the TeamMate design. Before merge, prefer collapsing the Workflow branch
to the source-local stopped-terminal invariant because it deletes mechanisms and
adds no state. The reviewed implementation remains behaviorally acceptable if
the operator instead chooses the more explicit obligation representation.

No correction is authorized by this consultation alone. Any change to the
operator-approved final design awaits an explicit operator ruling.

## Revision after complete call-site audit

The first verdict above is superseded. A separate xhigh implementation review
identified aggregate-boundary and failed-start rollback call sites that the
initial consultation had not examined. Fable independently traced those call
sites and revised the verdict to `NOT-ACCEPTABLE` for the implementation as it
stands.

### Blocking finding: aggregate teardown abandons too late

Dispatcher stop publishes its aggregate fences synchronously, then waits for
root Workflows and Teams before it reaches direct TeamMates and the Dispatcher
Agent. Team dissolve similarly waits for Workflow convergence before reaching
members and its leader. An old Turn can settle and start delivery during either
wait; later per-entity abandonment cannot retract it.

This violates the approved fence semantics: every result still pending when
deliberate Team dissolve or host stop begins is abandoned. The window is a
normal consequence of the existing ordered shutdown and can be seconds long;
no test in the reviewed implementation settles a Turn inside that window.

### Blocking finding: resource release carries an unauthorized behavior

`TeammateService.stopForHost()` is also used by failed input-source startup
rollback. That rollback needs runtime release but is not one of the operator's
named completion-abandonment boundaries. Putting abandonment inside the shared
resource-release method therefore changes both too late on real teardown and
too broadly on rollback.

The same call-site problem exists for Workflow. Input-source startup opens
Channel and Workflow admission before scheduler startup completes. If scheduler
startup then fails, rollback closes Workflow admission and calls `stopAll()`.
The initiating Dispatcher Agent survives and the Dispatcher reopens admission,
so clearing that run's terminal delivery leaves an accepted Workflow with no
terminal answer. Failed-start rollback was not included in the operator's
explicit `workflow_stop`, Team dissolve, or host-stop ruling.

### Revised architecture recommendation

Keep the source-owned nullable obligations and first-intent causality, but move
their retirement to the aggregate lifecycle fence:

- explicit TeamMate close keeps its entity-local retirement;
- Team dissolve and Dispatcher shutdown synchronously sweep materialized
  TeamMate/leader sources and stop-winning Workflow runs when the aggregate
  teardown fence is published;
- later provider admission and Workflow construction must observe the same
  aggregate fence before acquiring a delivery obligation;
- `stopForHost()`, ordinary Workflow admission closure, and `stopAll()` retain
  only resource-release and convergence semantics when used by failed-start
  rollback; and
- reopening after a failed dissolve or failed start restores eligibility only
  for future work, never for obligations already retired at a real teardown
  boundary.

This fixes the late-delivery and over-suppression defects without reordering the
existing shutdown sequence. The exact implementation should preserve the
current Workflow first-intent check: an aggregate sweep may retire a Workflow
terminal obligation only when stop reserved the first intent, not when a
natural completed or failed intent already won.

### Withdrawal of the status-based Workflow alternative

Fable withdrew the earlier `candidate.status !== 'stopped'` proposal. It
violates the frozen rule against inferring causality from a late status, and
Workflow recovery already produces `stopped` records without flowing through
the explicit stop-finalization path. The current first-intent causality is the
correct basis; only its aggregate call boundary needs to move.

### Final recommendation

Use aggregate fence semantics, not the current "when each entity is reached"
semantics. Separate delivery retirement from reusable runtime-release methods
for both TeamMate and Workflow. This is one architectural correction for three
observed defects: teardown delivery starts too late, TeamMate rollback is
over-suppressed, and Workflow rollback loses an answer while its initiator
survives.

## Final implementation re-review

After the operator ratified aggregate-fence semantics and the correction was
implemented, Fable re-read the complete diff and revised the verdict to
`ACCEPTABLE-BUT-NOT-OPTIMAL` with one blocker. The correction successfully
retired already-materialized direct, member, and leader Turns before an earlier
Workflow teardown wait, but `TeammateService.stopForHost()` then unconditionally
installed a fresh delivery scope in its `finally` block. An operation admitted
before Dispatcher shutdown could resume after the Team sweep, restart the
released TeamLeader, and begin delivery while the Dispatcher Agent was still
alive. Fable also identified a sibling gap: aggregate sweeps saw only the
materialized snapshot, so a TeamMate or Team construction crossing the fence
could publish with a fresh local scope.

The accepted correction removes per-entity re-arm and makes the aggregate own
future eligibility. Dispatcher startup and successfully completed failed-start
rollback are the two re-arm points; failed Team dissolve may re-arm its local
scope only while no outer Dispatcher fence remains active. Collection-owned
opaque population scopes are captured before asynchronous construction and
retire stale TeamMate, Team, member, and lazy-leader services before they can
publish or submit work. No persisted phase, generation, retry, recovery, or
provider/channel behavior is added.

Fable's non-blocking proposal to replace retained-Turn sweeping with a
settlement-time predicate remains deferred. The current direct Turn operation
and captured-scope admission check preserve the already approved mechanism and
have separate load-bearing tests; changing that shape would require another
design cycle without removing a user-visible defect from this delivery.

## Final narrow architecture verification

The last correction made scope re-arm idempotent while a population is already
active. `abandon()` is now the only operation that advances the opaque epoch,
so a concurrent construction cannot become stale merely because startup was
retried. A source retired because its operation genuinely crossed an aggregate
fence can re-arm only future work after that old admission has attached; a
source swept by an active aggregate fence is never revived by that path.

Fable returned `ACCEPTABLE` with no blocker. The remaining observations are
cleanup candidates rather than delivery defects: the retained-Turn sweep and
attach-time identity check may admit a later simplification cycle, nested Team
scope ownership deserves a compact knowledge note, and the Team/Workflow source
files need a real responsibility extraction before taking more line pressure.
