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
