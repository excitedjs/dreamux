# Boundary review — draft technical design

Seat: independent boundary reviewer (ownership, end-to-end behavior, change
boundary, contracts, verification, risks, simpler alternatives).

## Inputs read

- Requirement:
  [`../../requirement.md`](../../requirement.md).
- Draft under review: [`../draft.md`](../draft.md).
- Source baseline: working tree at `origin/next`
  `fffc3bd337f8ce28070fb8658fc30893e71730bb`, files read directly:
  `packages/dreamux/src/service/teammate-service/{turn-recording,turn-coordinator,runtime-owner,index}.ts`,
  `packages/dreamux/src/service/teammate-collection/{index,dissolve-members}.ts`,
  `packages/dreamux/src/service/team-service/{index,closing,collaborators,completion-targets}.ts`,
  `packages/dreamux/src/service/dispatcher-service/{index,input-source-start-rollback}.ts`,
  `packages/dreamux/src/service/completion-router/index.ts`,
  `packages/dreamux/src/service/workflow-service/{index,run,run-terminal}.ts`,
  `packages/dreamux/tests/entity-turn.test.ts`,
  `.agents/product/README.md`, `.agents/domains/dispatcher-orchestration.md`,
  `packages/dreamux/src/service/CLAUDE.md`.

## Verdict

The chosen owning boundary is correct and the ownership argument survives the
source check. Three of the draft's four rejected alternatives are rejected for
the right reasons. What the draft does **not** yet survive is its own change
boundary: it adds two mechanisms where one fact suffices (F1), it leaves one
user-visible behavior change unenumerated (F2), it misses three of the five
places that record the invariant it invalidates (F3), and its verification plan
omits a mandatory repository gate that this specific change is likely to trip
(F4). None is a blocker to the direction; F1 and F2 should be settled before
implementation starts.

## Confirmed: the boundary and the symmetry claim hold

Verified against source, not restated from the draft.

**The obligation really is created and retained where the draft says.**
`TeammateCollection.resolveCompletionDelivery()`
(`teammate-collection/index.ts:661-669`) is the single place a
`TurnCompletionDelivery` closure is built for a TeamMate; it is handed to
`TeammateService.submitInput` → `admitToRuntime`
(`teammate-service/index.ts:300-303`) → `EntityTurnCoordinator.submitRuntimeTurn`
→ `attachSubmission` (`turn-coordinator.ts:103-117`) → `new EntityTurn(...)`
(`turn-recording.ts:101-105`). `EntityTurn.settle()` calls
`startDeliveryIfReady()` (`turn-recording.ts:139-143`), which is what turns a
runtime stop into an owner-facing turn. The draft's four-step ownership chain is
accurate.

**Owner symmetry is real and is not a role check.** Dispatcher-owned TeamMates
resolve `initiatorFor: () => Promise.resolve(this.mustAgent())`
(`dispatcher-service/index.ts:206`); Team-owned members resolve
`initiatorFor: async () => input.leaderCompletionTarget()`
(`team-service/collaborators.ts:51`). Both flow through the *same*
`resolveCompletionDelivery` and the same `TeammateService`. A boundary placed in
`TeammateService` therefore satisfies the requirement's "one semantic path
rather than duplicate role checks" without any branch on scope. Confirmed.

**All three operator-reported paths converge on two entry points.** Explicit
close → `closeAuthorized` (`teammate-service/index.ts:531-557`) →
`transitionToClosed` (`:559-594`). Team dissolve → `TeamClosing`
`stopRuntimesForDissolve` (`team-service/closing.ts:216-227`) and
`closeResources` (`:251-266`) → `member.stopForHost()` /
`member.close()`. Host restart → `DispatcherService.doStop`
(`dispatcher-service/index.ts:335-395`) → `stopHostTeammateRuntimes`
(`:617-631`) and `TeamClosing.stopForHost` (`closing.ts:344-361`) →
`stopForHost()`. Both `transitionToClosed` and `releaseHostRuntime`
(`teammate-service/index.ts:410-418`) run the identical convergence sequence and
both end in `settleAndDeliverRetained()`. The draft's claim that one boundary in
`TeammateService` covers all three is correct.

**The two "do not do this" constraints are correctly honored.** Clearing
`retainedTurns` would break the unsettled-turn proof at
`turn-coordinator.ts:84-90`; clearing the recipient FIFO would hit a queue keyed
per recipient (`completion-router/index.ts:124-134`) that carries unrelated
valid completions. Both rejections check out.

## Findings

### F1 — Two new mechanisms where the codebase's own idiom needs one (design)

The draft adds four things: a mutable `deliveryClosure`, an
`EntityTurn.abandonPendingDelivery()`, a coordinator
`abandonPendingDeliveries()` sweep, and a coordinator option
`acceptsCompletionDelivery()`. Draft §"Expected entropy delta" undercounts this
as "one Turn operation and one coordinator predicate/capability".

The sweep and the predicate exist for the same reason — a Turn must not deliver
if the entity stopped owing completions — but they answer it at two different
times (already-attached vs. attached-later). That is the shape signal
`engineering-whitepaper` §6 names: a second implementation of a mechanism that
already exists once, plus a Deps object growing a second function-valued
predicate beside `isActive` (`turn-coordinator.ts:11-14`).

A strictly smaller equivalent: give `EntityTurn` the one predicate and read it
inside `startDeliveryIfReady()`, dropping the closure at that moment when it is
false. Then:

- the attach-time race the draft's §2 predicate exists for is covered for free —
  a Turn attached after the boundary reads `false` when it settles;
- the sweep disappears — `settleAndDeliverRetained()`
  (`turn-coordinator.ts:82-92`) already drives `ensureDelivery()` on every
  retained Turn *inside* the teardown, i.e. while the predicate is still false;
- `deliveryTask !== null` (`turn-recording.ts:156`) already gives the
  "already-started delivery is not retracted" carve-out with no new code;
- one new fact crosses the seam instead of two, and `EntityTurn` gains no new
  public operation.

One caveat that makes this concrete rather than cosmetic: dropping the closure
at that moment is load-bearing, not an optimization. A bare predicate re-read
would make abandonment *temporary* for a transient host stop, because
`stopForHost()` clears `hostStop` in a `finally`
(`teammate-service/index.ts:401-407`). Today nothing re-drives `ensureDelivery()`
after `attachSubmission`'s one `void turn.ensureDelivery()`
(`turn-coordinator.ts:113-115`) resolves — so permanence would hold *by accident
of who happens to call it*, not by construction. Clearing the closure on the
false read makes it permanent by construction.

Recommendation: collapse §1 and §2 of the draft into a single service-owned
fact read once at settlement. If the TeamLeader disagrees, the draft should at
minimum state why two mechanisms are required and correct its entropy-delta
count to four additions.

### F2 — One user-visible behavior change is not enumerated (requirement/product)

Draft §"Behavior preserved" lists six preserved behaviors and no changed ones
beyond the requested suppression. It misses a third delivery relationship that
its own predicate silently retires.

`TeamService.submitToLeader` attaches a `deliverCompletion` closure that
delivers the **TeamLeader's own turn to the Dispatcher Agent**
(`team-service/index.ts:540-552`), used by the Team MCP delegate with
`deliverCompletionToDispatcher: true` (`team-collection/mcp-delegate.ts:190`).
The leader is itself a `TeammateService`, so the draft's boundary applies to it —
correctly for a *Dispatcher-initiated* dissolve.

But `TeamClosing.dissolve` also serves `requester: 'team_leader'`
(`team-service/closing.ts:139`, reached from
`dispatcher-service/index.ts:556-566`). In that path the Dispatcher did **not**
initiate the teardown, yet under the draft it silently loses the answer to work
it dispatched to that Team. Requirement §"User story and desired behavior" says
"A terminal outcome selected independently while the relationship remains active
is still real news"; the next sentence then rules that once deliberate teardown
begins everything pending is abandoned. The operator's recorded selection
(「全部丢弃（推荐）」, listing Team dissolve by name) covers this, so I am **not**
claiming the draft violates the ruling — I am claiming it lands a user-visible
consequence the operator was not shown.

Per `engineering-whitepaper` §5 ("Know what you are touching" — enumerate the
user-visible behaviors a change alters), the draft must state this explicitly:
*after a TeamLeader self-dissolve, a Dispatcher waiting on that Team's answer
receives nothing and must poll.* If the TeamLeader believes the recorded ruling
already covers it, quote the ruling verbatim next to the consequence rather than
leaving it implicit.

Related, and worth one sentence in the draft rather than a finding of its own:
Workflow terminal delivery does not ride `EntityTurn` at all
(`workflow-service/index.ts:165` → `CompletionDeliveryPolicy.deliver`), so it is
untouched — consistent with the requirement's non-goal, but the draft should say
so, because `doStop` calls `workflowOwner.stopAll()` twice
(`dispatcher-service/index.ts:337`, `:369`) and a reader will ask whether the
restart criterion covers it.

### F3 — The documentation surface is under-scoped by three files (change boundary)

Draft §"Documentation and release surface" names two records. The invalidated
blanket statement is recorded in **five** places:

| Location | Text |
|---|---|
| `.agents/domains/dispatcher-orchestration.md:450` | "**Every settled turn is reported.**" — named by the draft |
| `.agents/product/README.md:107-118` | background completion delivery — named by the draft |
| `.agents/product/README.md:221-224` | "one settled turn produces exactly one push" — **missed** |
| `packages/dreamux/src/service/CLAUDE.md:138` | "**Every settled turn is reported.**" — **missed** |
| `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md:35` | "Every settled turn is reported to the Agent that was waiting for it … A missing completion is therefore a delivery problem, not evidence that the turn ended badly." — **missed** |

The last one is the most costly to leave stale: it is operator-facing
troubleshooting guidance that, after this change, actively misdiagnoses the new
normal (a deliberately abandoned delivery would be read as a delivery bug).

Also stale after the change: the `EntityTurn` doc comment at
`turn-recording.ts:145-153`, whose first line is the same invariant.

Add all four to the draft's documentation section.

### F4 — Verification plan omits a mandatory gate this change is likely to trip

Draft §"Verification plan" item 6 lists `build`, `lint`, `test`, and
`.agents/scripts/check.sh`. Root `CLAUDE.md` requires
`node common/scripts/install-run-rush.js typecheck:tests` as a first-class gate,
and states why it is not redundant: `tsconfig.json` excludes `tests/` and vitest
erases types, so a test compiling against a changed type stays green under the
other three.

This change is exactly that risk: `packages/dreamux/tests/entity-turn.test.ts`
constructs `EntityTurn` directly (`:209-214`) against its current three-argument
constructor. Any reshaping of `EntityTurn`'s construction or delivery surface is
invisible to `rush test` and caught only by `typecheck:tests`. Add it.

### F5 — The rewritten load-bearing test needs its rationale stated, not just its replacement (verification)

`packages/dreamux/tests/entity-turn.test.ts:35` — "delivers a close-induced
stopped settlement with no native token" — asserts precisely the behavior being
removed, and the requirement records it as protected by PR #350. The draft's
verification item 1 supplies the correct replacement ("an *unexpected* stopped
settlement still invokes delivery once") but never says that this named test's
premise is being inverted and why.

Root `CLAUDE.md` is explicit that when a diff edits a test's assertions, "the
tests pass" is circular evidence. The draft should name this test, state that the
contract it encodes was superseded by the operator's recorded ruling (quoting it),
and keep the general PR #149 rule it must *not* touch — the independently
stopped/failed turn — as a separate, unchanged assertion. Verification item 5's
"preservation controls" is the right home for that.

## Non-findings (checked, and the draft is right)

Recording these so a later round does not re-litigate them:

- **Idempotent double-abandon during dissolve.** `stopAllForDissolve()` →
  `stopForHost()` then, later, `closeAllForDissolve()` → `member.close()`
  (`team-service/closing.ts:143`, `:259`). `stopForHost` does not move `phase`,
  so the close path re-enters the boundary. Both passes are no-ops on an already
  abandoned Turn. Safe.
- **The durable-closed short circuit** (`teammate-service/index.ts:540-554`)
  bypasses `transitionToClosed` entirely, so an abandonment placed there would
  be skipped — but that branch is gated on
  `runtimeOwner.hasNoRuntimeAuthority()`, so no live Turn can exist. Safe either
  way; placing the abandonment inside `transitionToClosed` (which is
  `@deduplicate({type:'once'})`) is the cleaner of the two spots the draft's §3
  wording leaves ambiguous, and the draft should pick one.
- **"Publish `hostStop` before abandoning."** Already structurally true:
  `stopForHost` assigns `this.hostStop = task` synchronously while the body runs
  behind `Promise.resolve().then(...)` (`teammate-service/index.ts:401-407`). The
  draft's ordering requirement is satisfied by existing code, not by new work.
- **Residual failed COT cards from an already-started delivery.** A delivery that
  started before the boundary can still reach a recipient mid-teardown and hit the
  documented prepare/submit race (`.agents/product/README.md:174-183`,
  `teammate-service/index.ts:272` `projectFailedEnd`). This is *excluded by the
  requirement itself* (non-goal: no retraction of an outcome whose settlement and
  delivery were already selected). Because `settle()` starts delivery
  synchronously (`turn-recording.ts:139-143`), the window is only for turns that
  settled shortly before the boundary — narrow, and out of scope. Worth one line
  in the draft so the "no failed COT cards" acceptance criterion is not read as
  absolute.
- **Rush change file classification.** No persisted shape, version, or path
  changes; a plain `minor` change file for `@excitedjs/dreamux` is correct. No
  `BREAKING:`/`Rebuild:` is owed.

## What I would need changed before implementation

1. F1 — settle on one mechanism or justify two, and correct the entropy count.
2. F2 — enumerate the TeamLeader-self-dissolve consequence for the Dispatcher,
   quoting the operator ruling that covers it.
3. F3 — extend the documentation surface to all five records plus the
   `EntityTurn` comment.
4. F4 — add `typecheck:tests` to the gate list.
5. F5 — name the inverted test and its superseding ruling.

F1 and F2 are design/requirement decisions and should be resolved by the
TeamLeader (F2 possibly with the operator). F3–F5 are mechanical completions of
the draft's own sections.
