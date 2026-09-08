# Verification review — suppress owner close/stop pushback

Seat: `tm-verification-review-i5j9` · Reviewed draft:
`technical-design/draft.md` · Requirement frozen at SHA-256
`d2b40d9b10451621d9c04463df29b8f0ad701f3163bb8f9276f1e7a2221e3961`.

## Verdict

The draft's central decision is **correct and evidence-backed**: make the pending
completion delivery abandonable at the `EntityTurn`, and exercise it at the
deliberate-teardown boundary rather than filtering a late `stopped` status. I
verified every load-bearing factual claim against source and found them accurate.
The change boundary is the right one, the mechanism is minimal, and the admission
race the draft names is real and is closed by the proposed predicate.

This is **not a blocker-free pass** as written. Two findings need the TeamLeader
to amend the draft before it is authoritative: (1) the verification plan must
name the existing test that asserts the regression and state explicitly that its
inversion is requirement-driven, and (2) the close-abandonment insertion point is
stated imprecisely relative to where `phase = 'closing'` actually flips.

## Premise under test

The draft rests on one sentence: *"a deliberate lifecycle teardown is the exact
moment after which a still-pending completion is no longer owed, and that moment
is already encoded by `phase !== 'active'` (business close) and
`hostStop !== null` (host authority release), so the entity Turn can retire its
own pending delivery without a new flag or a downstream filter."*

That premise survives. I checked each leg against the code.

## Findings

### F1 — High: verification plan omits the load-bearing-test inversion

**Evidence.** `packages/dreamux/tests/entity-turn.test.ts:35` is named
`'delivers a close-induced stopped settlement with no native token'` and asserts
exactly the behavior this task removes — its comment reads *"that it was stopped
is news only"*, the rationale PR #350 introduced and the requirement now
reverses. Separately, `packages/dreamux/tests/completion-delivery.test.ts:206-222`
(`'delivers a stopped outcome that carries no native token'` and the `failed`
sibling) tests `CompletionDeliveryPolicy.deliverRuntime` directly and encodes the
PR #149 rule that the requirement names as a **locked contract** ("the general
rule from PR #149 remains").

**Problem.** The draft's verification plan (items 1 and 5) describes the new
`EntityTurn` behavior and lists "preservation controls", but never names either
test file. An implementer who "just makes the suite green" will edit
`entity-turn.test.ts:35` and could, under time pressure, also touch
`completion-delivery.test.ts` to quiet a spurious coupling. Under the repo's own
rule — *"when a diff edits a test's assertions, 'the tests pass' is circular"* —
the review must be able to tell a requirement-driven inversion from a weakened
contract. The draft currently gives that distinction nothing to anchor on.

**Required action.** Add to the verification plan two named lines:
- `entity-turn.test.ts:35` (close-induced stopped delivers) **inverts**: its new
  form asserts that a deliberately-abandoned turn settles `stopped` with **no**
  delivery. Justify the inversion by citing PR #350 as the regression origin —
  this test encodes the bug, not a locked contract.
- `completion-delivery.test.ts` (null-token failed/stopped still reach the
  recipient) **stays green unchanged** — it is the PR #149 locked contract and
  its subject (`CompletionDeliveryPolicy`) is deliberately untouched by this
  change.

### F2 — Medium: close-abandonment insertion point is imprecise

**Evidence.** `index.ts:555` flips `phase = 'closing'` inside `closeAuthorized`,
**outside** the `@deduplicate`d `transitionToClosed` (`index.ts:559`), whose first
await is `runtimeOwner.stopRuntime()` (`index.ts:564`). The draft says "move to
`closing` and abandon pending deliveries before `transitionToClosed()` reaches
`runtimeOwner.stopRuntime()`", which is satisfied by two different placements
with different consequences: (a) inside `transitionToClosed`, before `stopRuntime`,
or (b) in `closeAuthorized`, between line 555 and the `transitionToClosed` call.
(a) is inside the once-deduplicated body; (b) is not, so two concurrent `close`
calls would abandon twice (harmless but unnecessary) while the dedupe only
protects the stop.

**Also worth stating (it is an invariant that makes the design safe, not a
defect).** `markClosing()` (`runtime-owner.ts:274`) can only fire when
`callbacks.isActive()` is already false, i.e. only after `phase` has left
`'active'`; and the *only* active→closing transition is `closeAuthorized:555`,
which is always immediately followed by `transitionToClosed`. So there is no
close path that reaches `'closing'` and skips the abandonment — as long as the
abandonment is placed on the `transitionToClosed` path (or the line-555 path),
not on `markClosing`.

**Required action.** Pin the exact insertion site to `transitionToClosed`, before
`stopRuntime()`, and add the one-line rationale that active→closing is only ever
reached through `closeAuthorized`→`transitionToClosed`, so that site covers all
business-close entry points (model-facing `close`, admin close, locked
`closeAuthorized`, and the `abandonCreation`/`closeLeaderForDissolve` leader
close, which all funnel through `TeammateService.close`).

### F3 — Low: name the operation `public`, and do not make the rename optional

**Evidence.** `EntityTurnCoordinator` lives in `turn-coordinator.ts`; `EntityTurn`
in `turn-recording.ts`. A "module-local" `abandonPendingDelivery()` would not be
visible across that file boundary — it must be a `public` method on the exported
`EntityTurn` class (its fields `deliveryClosure`/`deliveryTask` are already
`private`, so exposing one method leaks nothing). The draft says "module-local
/public-on-class", which is hedging between two things; only the latter works.

Second, the draft says rename `settleAndDeliverRetained()` "only if needed". It is
needed: the name now overstates, and two owners it feeds are the explicit targets
of this change — the invariant `"Every settled turn is reported"` in
`packages/dreamux/src/service/CLAUDE.md` and (per the draft's own doc section)
`dispatcher-orchestration.md`. A method name and a KB invariant that both state
the removed rule are part of the same change, not optional cleanup.

**Required action.** State `abandonPendingDelivery(): void` as public on
`EntityTurn`; treat the `settleAndDeliverRetained` rename (e.g.
`settleAndDeliverEligibleRetained` / `convergeRetained`) and the KB invariant
rewrite as part of the implementation, not a maybe.

## Verified-correct claims (for the record)

These the draft got right; the implementation should not be talked out of them.

- **Ownership.** The pending obligation is created, retained, and settled entirely
  inside `EntityTurnCoordinator`/`EntityTurn` (`turn-coordinator.ts:103-117`,
  `turn-recording.ts:132-173`). Clearing `retainedTurns` would forfeit the
  settlement proof in `settleAndDeliverRetained` (`turn-coordinator.ts:84-89`);
  clearing the recipient queue (`completion-router/index.ts:62-63`) is both too
  late (delivery may not have reached it) and too broad (the queue is shared with
  unrelated valid completions). The source-owned abandonment is the correct owner.
- **The admission race is real.** `submitRuntimeTurn` invokes `operation()` (i.e.
  `runtime.submit({text})`) synchronously before `enqueueAdmissionContinuation`
  runs and before `attachSubmission` creates the turn
  (`turn-coordinator.ts:46-63`). A synchronous sweep of `retainedTurns` alone
  would miss a turn whose admission is still pending when teardown begins, so the
  attach-time predicate is necessary, not defensive.
- **The predicate is minimal and derives from existing facts.** `phase`
  (`index.ts:71`) and `hostStop` (`index.ts:86`) are already the two teardown
  facts; `acceptsCompletionDelivery = phase === 'active' && hostStop === null`
  introduces no new boolean, matching the whitepaper's "derive from facts that
  already exist". `stopForHost` publishes `hostStop` before `releaseHostRuntime`
  and clears it only in the `finally` (`index.ts:398-408`), so `hostStop !== null`
  is exactly "releasing authority" for the whole stop span.
- **The predicate is reliably false during the drain window.** In both close
  (`transitionToClosed`) and host stop (`releaseHostRuntime`), `drainAdmissions`
  runs *before* the flag that gates the predicate is cleared (`phase` stays
  `'closing'` until the durable close at `index.ts:584`; `hostStop` stays set
  until `stopForHost`'s `finally`). Any admission attaching during that window
  therefore observes the predicate as false, which is what closes the race the
  sweep alone cannot. This is a stronger guarantee than the draft's prose states,
  and the implementation should rely on it.
- **Both owner roles share one path, role-agnostic.** Dispatcher-scoped and
  Team-scoped recipients resolve through the same `EntityTurnCoordinator` and
  `deliverCompletion` closure (`teammate-collection/index.ts:661-669`,
  `team-service/completion-targets.ts:33-63`); no role branch is needed, and the
  draft adds none.
- **Dissolve/restart reach the same boundary.** `stopAllForDissolve` →
  `member.stopForHost()` (`teammate-collection/index.ts:353-356`) and the host
  sweep both enter `stopForHost`; leader close for dissolve enters `close`
  (`dissolve-members.ts:37-41`). So the two abandonment sites (close + host stop)
  cover all three operator-reported paths without policy in the Team aggregate or
  Channel presentation.

## End-to-end behavior check

For each acceptance criterion, the design produces the required observable:

- **TeamLeader/Dispatcher close** → `close` → `transitionToClosed` abandons the
  member's pending closure before `stopRuntime`; the turn still settles `stopped`,
  `settleAndDeliverRetained` still proves it settled, but `ensureDelivery` has an
  empty closure and submits nothing. Close returns its unchanged structured
  result. ✓
- **Team dissolve** → `member.stopForHost()` abandons member→leader deliveries
  before any leader stop, and the later `member.close()` abandons idempotently;
  no member cleanup submission reaches a stopping/stopped leader. ✓
- **Host restart** → the `hostStop` predicate plus the `stopForHost` sweep abandon
  direct-TeamMate deliveries into the Dispatcher before the sweep stops it. ✓
- **Independent stop still delivers** → a turn that settles `stopped` with no
  teardown boundary retains its closure and delivers exactly once. ✓
- **Completed/failed retain delivery while active** → guarded by
  `deliveryTask !== null` doing nothing, and by the predicate only flipping at
  the boundary, not at ordinary settlement. ✓

One narrow case the draft should state as intended (not fix): a **locked Workflow
submission** (`submitLocked`, `index.ts:487-500`) does not consult `hostStop`, so
a Workflow turn admitted during host stop attaches with no delivery closure. That
is arguably correct — its recipient is stopping too — but it is a behavior change
for that path and should be acknowledged in the draft, not left implicit. The
same is true of the dissolve stop→close window: after `member.stopForHost()`
returns (`hostStop` cleared, `phase` still `'active'`) a *new* input can acquire a
fresh closure before `closeAllForDissolve` runs. That is not a defect (those are
new inputs, not results "pending at the boundary"), but the draft's "abandon
every pending result" phrasing should be scoped to "pending at the boundary" to
avoid a reviewer later misreading it.

## Residual risks (accepted, not blockers)

- **Delivery already in flight is not retracted.** `deliveryTask !== null` means
  `deliverRuntime` was already called and the fact is enqueued on the recipient's
  FIFO tail; the router's own retry/drop logic then decides its fate. This matches
  the operator's "already completed submission is not retracted". No change.
- **No new persisted state / config / provider branch** is introduced, so no
  changelog `BREAKING:`/`Rebuild:` surface is triggered; the draft's doc/release
  section is correct to record only a user-visible bug fix change file.
- **`completion-renderer.ts` and its test are untouched**: the `stopped` text
  remains for independently-stopped turns that still deliver, satisfying the
  non-goal "no change to the text of notifications that remain deliverable".

## Conclusion

Approve the decision and the mechanism. Before the draft is authoritative, the
TeamLeader should fold in F1 (name the test inversion and the locked contract)
and F2 (pin the close-abandonment site to `transitionToClosed`); F3 (public
method, non-optional rename) is small but should be resolved in the same edit.
No change to the chosen boundary or to the two-fact predicate is warranted.

---

# 2026-09-08 Workflow-stop amendment review

Seat: `tm-verification-review-i5j9` · Reviewed the Workflow-stop amendment at the
end of `technical-design/draft.md` (SHA-256
`9b732820d647c5ef4ae8b9d0d92c5fdd7253bfb37f36e43f6598459dc4c10d44`) against the
amended requirement (SHA-256
`0f34ff8be04b6a42c363db28246c7c9763918a63ff4650af46f9be81068d6ea9`) and current
source on the `dreamux/dreamux-codex-team` branch.

## Verdict

The amendment's **scope and owner are correct**: extend the same source-obligation
rule to `WorkflowRun`, whose captured `deliverTerminal` closure is the exact
Workflow analog of `EntityTurn`'s delivery closure, and abandon it at deliberate
stop. Explicit `workflow_stop`, `stopAll()`, and the create-versus-closeAdmission
race are all correctly identified, and the `suppressDelivery`/terminal-delivery
distinction is accurate.

The mechanism as worded, however, **over-abandons**: it nulls the closure at the
`stop()`/`closeAdmission()` entry point, before `WorkflowRunTerminal.reserveStop()`
checks whether the run has already selected a natural terminal. This drops a
naturally-completed or failed run's delivery when a stop races it — a direct
violation of acceptance criterion "A Workflow that naturally completes or fails
while its scope remains active keeps exactly one terminal completion delivery."
That is the one finding the TeamLeader must resolve before the amendment is
authoritative; the rest are verification-plan tightening.

## Verified source claims (accurate)

- **`WorkflowRun.finalize()` always delivers.** `run.ts:629-650` invokes
  `deps.deliverTerminal` unconditionally, guarded only by the idempotency flag
  `terminalDeliveryCommitted` (not by suppression). ✓
- **Both stop entry points reach `finalize` with `'stopped'`.** `WorkflowRun.stop()`
  → `terminal.stop()` (`run.ts:172-174`); `WorkflowRun.closeAdmission()` →
  `terminal.reserveStop()` (`run.ts:176-178`). `WorkflowService.stop()` →
  `active.stop()` (`index.ts:203-212`); `stopAll()` → `closeAdmission()` then
  `run.stop()` per run (`index.ts:228-236`). `workflow_stop` MCP → `WorkflowService.stop()`
  (`teammate-collection/mcp-delegate.ts:306-309`). ✓
- **`suppressDelivery` is unrelated.** `run-terminal.ts:60-62` returns `intent !== null`
  and gates only `runner.send({type:'agent_result'})` in `completeAgent`/`sendAgentError`
  (`run.ts:537, 554`) — it never touches terminal delivery. ✓
- **The create-versus-closeAdmission race is real and already wired.** `createRun`
  sets `if (!this.accepting) run.closeAdmission()` at `index.ts:174`, after the run
  is materialized but before `run.start()` (`index.ts:185`); `start()` then sees
  `terminal.requested !== null` and returns without starting (`run.ts:157-160`).
  `stopAll()` calls `closeAdmission()` before draining `runCreations` (`index.ts:229-232`).
  ✓
- **Natural completed/failed paths do not go through the stop entry points.**
  They enter via `terminal.request()`/`observe()` (`run.ts:231-235`, `run-terminal.ts:95-118`),
  so "natural paths do not abandon" is true **only in the absence of a racing stop** —
  which is exactly the gap below. ✓

## Findings

### W1 — High: abandonment fires too early; it drops natural completed/failed delivery that races a stop

**Evidence.** `WorkflowRunTerminal.reserveStop()` guards on the run still being
undecided: `if (this.intent !== null || this.deps.status() !== 'running') return;`
(`run-terminal.ts:65`). A run that has already selected `'completed'`/`'failed'`
has `intent !== null`, so `reserveStop()` is a no-op and `terminal.stop()` merely
joins the in-flight `finalize`. The amendment, however, nulls the delivery closure
at the **method entry** — "synchronously abandon it before reserving **or joining**"
— which executes even when the run is already committed to a natural terminal.

**Failure scenario (single-threaded, no torn read):**
1. Runner emits `run_result: completed` → `terminal.request('completed')` sets
   `intent = {status:'completed'}` and starts `finalize('completed')`.
2. `finalize` is awaiting its early steps — `runner.stop()`, `joinMaterializations`,
   handle closes, `drainRunnerMessageTasks`, `drainAgentTasks`
   (`run.ts:563-592`) — **before** the `deliverTerminal` line at `run.ts:629`.
3. `workflow_stop` (or `stopAll`'s `run.stop()`) arrives → amendment nulls the
   closure → `terminal.stop()` joins (does not override `intent`).
4. `finalize` reaches `deliverTerminal`, snapshots `null`, and submits nothing.

Result: the run is durably `completed`, the `workflow_stop` receipt returns
`completed`, and the owner receives **no** terminal completion — a real news loss,
not a cleanup suppression. This conflicts with acceptance criterion 3 and with the
operator's "already completed submission is not retracted" principle, which the
EntityTurn design honors via its `deliveryTask !== null` guard.

**Why the EntityTurn guard does not transfer directly.** In `EntityTurn`, settlement
and delivery-start are synchronous in one call — `settle()` sets `selectedOutcome`
then `startDeliveryIfReady()` sets `deliveryTask` immediately (`turn-recording.ts:139-173`),
so "settled" ⇔ "delivery started" and the `deliveryTask !== null` check protects
every settled outcome. Workflow `finalize` has a multi-await gap between intent
selection and delivery invocation, so "settled" ⇏ "started". The Workflow analog
must therefore gate abandonment on *undecided-ness* (`intent === null`), not on the
closure still being non-null.

**Required action.** Gate the abandonment on the run's terminal still being
undecided, matching `reserveStop()`'s own guard. Concretely, abandon inside
`reserveStop()` after its `intent === null && status === 'running'` guard (threading
an abandon callback into `WorkflowRunTerminal`), or, equivalently, keep the
abandonment in `WorkflowRun` but condition it on `this.terminal.requested === null`
at `stop()`/`closeAdmission()`. Either way the invariant becomes: *abandon only when
the deliberate stop actually transitions the run to `'stopped'`; never when the run
already committed to a natural terminal.*

### W2 — Medium: name both stop-delivery assertions that invert, and the one that must stay

The amendment says "invert the existing `workflow.stop` delivery assertion" without
naming it. Two independent assertions assert the removed behavior, both in
`packages/dreamux/tests/workflow-service.test.ts`:

- `:300` `expect(delivery.delivered).toHaveLength(1)` inside *"ignores a runner
  message that arrives after the run is already durably terminal"* (stop path).
- `:425-426` `toHaveLength(1)` + `toMatchObject({ kind:'workflow', status:'stopped' })`
  inside *"stop() converges already-accepted work…"*.

Both must become `0` (or assert no delivery). The requirement's amended evidence
section already names `workflow-service.test.ts` generally; the draft should carry
the two line anchors so the inversion is reviewed as requirement-driven, not as a
weakened contract.

The natural-failure test *"a failed run delivers its failure through the
null-completion-token entry point"* (`:430-454`) must **stay green unchanged** — it
is the Workflow analog of the `completion-delivery.test.ts` locked contract and
must not be folded into the inversion.

### W3 — Medium: `stopAll()` delivery absence and the create-versus-closeAdmission race are untested

- The existing `stopAll()` test (`:596-624`) asserts only `status === 'stopped'` and
  `runner.stopped`; it never reads `delivery.delivered`. The amendment's "prove
  `stopAll()` also produces no terminal completion" is therefore an **add**, not an
  invert — and it must assert the observable (owner records no submission), not a
  private flag.
- There is **no** test exercising a run created after `WorkflowService.closeAdmission()`
  begins. The amendment hedges "if existing composition coverage does not observe its
  delivery consequence" — it does not. The `index.ts:174` `run.closeAdmission()`
  branch (create-versus-scope-stop) is load-bearing for the race and currently has
  zero delivery-level coverage; the test is required, not optional.

### W4 — Low: make the "already-started" wording precise, and affirm minimalism

- The snapshot-then-invoke mechanics in `finalize` are sound in the narrow sense:
  the snapshot read and the nulling are both synchronous, so once `finalize` reads a
  non-null closure and begins `await delivery(...)`, a later stop cannot retract it.
  State this explicitly as the "already-started" guarantee, distinct from the
  W1 "selected-but-not-yet-started" hole.
- Otherwise the mechanism is minimal and correctly owned: one mutable pending
  obligation on `WorkflowRun` (the existing `deps.deliverTerminal` owner), no stop
  mode, no caller-role branch, no router/queue cancellation, no persisted fact. The
  requirement invariant "reuse the same source-obligation concept at `WorkflowRun`"
  is honored.

## Bottom line

Approve the amendment's scope and owner. Resolve **W1** (gate abandonment on
`intent === null`, matching `reserveStop()`'s guard) before it is authoritative, or
the fix will regress natural completion delivery under a stop race. Fold **W2**/**W3**
into the verification plan with the concrete test anchors. No change to the chosen
owner or to the shared rule between explicit stop and aggregate cleanup is warranted.
