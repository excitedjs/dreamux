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

## 2026-09-08 Workflow-stop amendment review

Independent re-review of the amendment only, against current source. Inputs
verified by hash: `requirement.md` =
`0f34ff8be04b6a42c363db28246c7c9763918a63ff4650af46f9be81068d6ea9`,
`technical-design/draft.md` =
`9b732820d647c5ef4ae8b9d0d92c5fdd7253bfb37f36e43f6598459dc4c10d44`. Both match
the authoritative values. Branch state: `HEAD` = `3974df3`, two commits ahead of
`fffc3bd`; `git diff fffc3bd..HEAD -- packages/dreamux/src/service/workflow-service/`
is **empty** — the amendment is design-only, no Workflow source exists to review
yet, so every source claim below is checked against the unchanged baseline.

Note on the frozen-input header: `draft.md` §Inputs still cites requirement
SHA-256 `d2b40d9b…`, which is the pre-amendment hash. The requirement has since
gained the Workflow clauses and now hashes to `0f34ff8b…`. Per
`engineering-whitepaper` §4, a design that cites a stale freeze of the document
it implements should update the citation in the same change.

### Verdict

The amendment's **owner choice is correct and its mechanism is minimal** — the
core claims survive source verification, and the two-entry-point design is
justified by a real race I confirmed rather than a hypothetical one. Three
findings: one requirement conflict the amendment introduces against its own
non-goal (W1), one missing observable test the verification amendment does not
cover (W2), and one scope-boundary contradiction between the amendment and the
already-committed `final.md` (W3). W1 is a blocker for the operator, not for the
design.

### Confirmed against source

- **The defect is real and stated accurately.** `WorkflowRun.finalize()` calls
  `this.deps.deliverTerminal({...})` at `workflow-service/run.ts:629-650`,
  guarded only by `terminalDeliveryCommitted`, with no consultation of *why*
  finalization ran. `WorkflowRun.stop()` → `terminal.stop()`
  (`run.ts:172-174`) and `WorkflowService.stopAll()` →
  `run.stop()` (`index.ts:228-236`) both reach it. Both explicit stop and
  aggregate cleanup do push a stopped Workflow completion. Confirmed by test:
  `workflow-service.test.ts:425-426` asserts exactly that
  (`delivery.delivered[0]` matches `{kind:'workflow', status:'stopped'}`).
- **The `suppressDelivery` disclaimer is correct.**
  `WorkflowRunTerminal.suppressDelivery` (`run-terminal.ts:60-62`) is read only
  at `run.ts:537` and `run.ts:554`, both of which gate
  `runner.send({type:'agent_result'})` — child results into the aborting runner.
  It never touches `deliverTerminal`. The amendment is right that this is an
  unrelated mechanism, and right not to overload it.
- **The owner choice is right.** The captured closure is created at
  `WorkflowService.createRun` (`index.ts:164-165`) and handed to the run; the run
  is the only holder and `finalize()` the only invoker. This mirrors the TeamMate
  boundary exactly — obligation retired at the source that owes it, not at
  `CompletionDeliveryPolicy`, which stays a stateless downstream policy. No new
  entity, mode, or role branch. Consistent with `engineering-whitepaper` §3.
- **The create-vs-`closeAdmission` race is real, and `closeAdmission()` is the
  right second entry point.** `stopAll()` calls `closeAdmission()` *first*
  (`index.ts:229`), which fans out to `run.closeAdmission()` for every live run
  (`index.ts:105`) → `terminal.reserveStop()` (`run.ts:176-178`). Separately,
  `createRun` calls `if (!this.accepting) run.closeAdmission()`
  (`index.ts:174`) for a run that finished construction after the service
  fence dropped. A run in that window is *never* in `this.runs` when
  `closeAdmission()` fans out, so hooking only `stop()` would miss it. Both
  aggregate paths reach the fence before the sweep:
  `DispatcherService.beginShutdown()`/`stop()` call
  `workflowOwner.closeAdmission()` (`dispatcher-service/index.ts:307`, `:331`)
  ahead of `stopAll()` (`:337`), and `TeamClosing` calls
  `workflows.closeAdmission()` (`team-service/closing.ts:253`, `:364`) ahead of
  `stopAll()`. Two entry points here are **not** the F1 duplication I flagged for
  TeamMates: they cover two structurally disjoint populations (runs in the map
  vs. a run not yet in it), which is the same justification the TeamLeader
  accepted for the sweep+predicate pair.
- **Natural completed/failed delivery is genuinely untouched.** Those paths
  reach `terminal.request('completed'|'failed', …)` from
  `handleRunnerMessage` (`run.ts:230-232`) and `terminal.observe('failed', …)`
  (`run.ts:106`, `:119`, `:196`, `:397`, `:412`) — none of which is `stop()` or
  `closeAdmission()`. The amendment's "do not abandon on natural terminal paths"
  is satisfiable without a discriminant. Correct.
- **"Snapshot and invoke only when still owed" is the right shape.** Read the
  closure into a local before `await`, mirroring the existing
  `terminalDeliveryCommitted` idiom at `run.ts:629-650`. No second boolean is
  needed: a nullable closure field *is* the state, per
  `service/CLAUDE.md` "The operation is the fence" and whitepaper §7 ("a nullable
  promise field is itself the state — do not put a boolean or phase enum beside
  it"). The final design should say so explicitly, because
  `terminalDeliveryCommitted` already sits adjacent and invites a copycat flag.

### W1 — The amendment contradicts the requirement's own Workflow non-goal (requirement conflict)

Requirement §Non-goals: *"No change to naturally completed or failed Workflow
delivery, child-Agent result delivery inside a running Workflow, …"*.

Source shows this cannot hold as written under a `closeAdmission()`-triggered
abandonment. `closeAdmission()` → `reserveStop()` sets
`intent = {status:'stopped'}` **only if** `this.deps.status() === 'running'`
(`run-terminal.ts:64-68`). So far consistent. But the fence is published by
`beginShutdown()` (`dispatcher-service/index.ts:327-333`) and by
`input-source-lifecycle.ts:286` — points at which a run may be *milliseconds
from its natural terminal*. Concretely: a runner emits `run_result: completed`;
`handleRunnerMessage` is queued behind `runnerMessageTail` (`run.ts:191-195`);
`beginShutdown()` fires; `closeAdmission()` abandons the closure; the queued
`terminal.request('completed', …)` then finalizes with status **completed** —
and delivers nothing.

That is a naturally completed Workflow whose delivery was abandoned. It is
defensible under the operator's 「全部丢弃」 boundary ruling, and it is the same
trade the TeamMate side already accepted. What is *not* defensible is the
requirement simultaneously listing it as a non-goal and the acceptance criteria
promising *"A Workflow that naturally completes or fails while its scope remains
active keeps exactly one terminal completion delivery."* The escape hatch is
"while its scope remains active" — but `closeAdmission()` is precisely the moment
the scope stops being active, so the two clauses only reconcile if the
requirement says so.

Per whitepaper §5 ("Know what you are touching" — enumerate the user-visible
behaviors a change alters) and §1 (a design must name the concrete scenario, not
leave it implicit), the final design must state this window explicitly: *a
Workflow whose natural terminal is queued behind the shutdown fence loses its
delivery.* Then either the operator confirms it, or the non-goal is narrowed to
"natural terminal reached before any stop or admission-close boundary". I
recommend stating and confirming rather than adding a mechanism to close the
window — a check that distinguishes "already-decided natural terminal" from
"stop-induced terminal" is exactly the causal discriminant the requirement's own
constraints forbid.

### W2 — One missing observable test, and one listed test that cannot observe what it claims

The verification amendment's five bullets are otherwise right; two problems:

**Missing: `stopAll()` currently has no delivery assertion at all.** The
amendment says "prove `WorkflowService.stopAll()` also produces no terminal
completion". `workflow-service.test.ts:596-624` is the only `stopAll()` test and
it asserts record status and `runner.stopped` — it never inspects
`delivery.delivered`, even though it already constructs a
`fakeCompletionDelivery()` at `:600`. Today that test would pass both before and
after the amendment. The new assertion must be added there (or in a sibling),
and it should assert `delivery.delivered` is **empty**, not merely "not stopped".

**Weak: the create-vs-`closeAdmission` race bullet is hedged.** The amendment
says "cover the create-versus-close-admission race *if existing composition
coverage does not observe its delivery consequence*". I checked: it does not.
`grep` for `closeAdmission` across `workflow-service.test.ts` returns nothing,
and no test drives `service.run()` after admission closes. Since `index.ts:174`
is the entire reason the amendment needs a second entry point, an untested branch
there means the second mechanism is unverified — and per whitepaper §1, an
unverifiable branch is a candidate for deletion rather than a candidate for
trust. Make this bullet unconditional: create a run while `accepting === false`,
let it finalize, assert no delivery. If that test proves awkward to write, that
is evidence the second entry point should be reconsidered, not waived.

Also worth one line, mirroring what the TeamMate side got right: the amendment
should name `workflow-service.test.ts:425-426` as the load-bearing assertion
being **inverted** and cite the operator's 「继续」 as its superseding authority.
Root `CLAUDE.md` treats a green run produced by a rewritten assertion as circular
evidence; the TeamMate half handled this explicitly (`final.md` review
adjudication), and the Workflow half currently does not.

### W3 — The amendment contradicts committed text in `final.md` and the merged docs (scope boundary)

`final.md:58-60` — already committed in `6615908` — states:

> Workflow-run terminal delivery is separate: `WorkflowService` calls
> `CompletionDeliveryPolicy` directly, so this change does not suppress or alter
> Workflow completion semantics.

and `final.md:258` records, as an accepted review outcome, "Workflow-run terminal
delivery remains outside this path." The amendment reverses both. Likewise the
already-merged docs enumerate exactly three boundaries and exclude Workflow:
`.agents/product/README.md:119-124` ("TeamMate close, Team dissolve, and host
stop"), `.agents/domains/dispatcher-orchestration.md:455-460`,
`packages/dreamux/src/service/CLAUDE.md` ("A settled turn is reported while its
delivery relationship remains active"), and
`dreamux-maintenance/references/service-lifecycle.md:35-40`.

The amendment's own verification bullet does list "update product, architecture,
service-local, maintenance, task, Issue, and Rush change-note text", so the
intent is right — but it must also **supersede `final.md`'s explicit exclusion in
the same change**, per whitepaper §5 ("Know why it was the way it was … update
its record in the same change"). Leaving a committed design document asserting
the opposite of the shipped behavior is precisely the stale-record failure §4
warns about.

Two concrete items the amendment's doc list under-specifies:

- The Rush change file `common/changes/@excitedjs/dreamux/dreamux-dreamux-codex-team_2026-09-07-14-49.json`
  currently reads "Stop deliberate **TeamMate** teardown from pushing pending
  completion notifications to owners." It must be widened to both source-owned
  obligations. `type: "patch"` remains correct — no persisted shape, config, or
  path changes, so no `BREAKING:`/`Rebuild:` is owed.
- Every doc sentence above enumerates the three TeamMate boundaries as a closed
  list. Widening them to "two source-owned obligations" is a rewrite of four
  separate sentences, not an append. Name them individually so none is missed —
  the maintenance reference is again the costliest to leave stale, since it is
  operator-facing troubleshooting guidance that would misdiagnose an abandoned
  Workflow delivery as a delivery bug.

### Entropy assessment

Net favorable, and for the right reason. The amendment **removes** an asymmetry:
before it, Core had two source-owned delivery obligations governed by two
different rules, so explaining teardown required "TeamMate deliveries are
abandoned, Workflow terminals are not, and there is no principle distinguishing
them." After it, one sentence covers both. That is a genuine reduction in what a
maintainer must hold, not a dedup-by-indirection: no shared layer is introduced,
each owner keeps its own field, and the two implementations stay independent.

**Additions**, counted honestly (the amendment does not tally them, and the
TeamMate half was previously under-counted — see F1): one mutable closure field
on `WorkflowRun`, abandonment at two call sites, and one snapshot-and-check at
the finalize invocation. Three, against one removed cross-cutting exception. The
final design should state this count rather than leave it implicit.

One boundary to keep watch on, not a finding: this is now the **second**
implementation of "source-owned obligation, abandoned at teardown, not retracted
once started" in the same module tree. A third would be the whitepaper §6 signal
("a second implementation of a mechanism that already exists once") firing for
real. Two independent owners each holding their own nullable closure is the
correct shape today — a shared `PendingObligation` helper would be exactly the
dedup-by-indirection §0 bans. Worth one sentence in the final design so a future
round does not "unify" them.

### Amendment findings summary

1. **W1 (blocker for the operator, not the design)** — state the
   natural-terminal-behind-the-fence window explicitly and reconcile it with the
   requirement's Workflow non-goal and acceptance criterion.
2. **W2** — add a `delivery.delivered` assertion to the existing `stopAll()`
   test; make the create-vs-`closeAdmission` race test unconditional; name the
   inverted assertion at `workflow-service.test.ts:425-426` and its superseding
   ruling.
3. **W3** — supersede `final.md:58-60` and `:258` in the same change; widen the
   four enumerated doc sentences and the Rush change note.
4. Housekeeping — update the draft's stale requirement hash citation, state the
   three-addition entropy count, and record why the two obligations stay
   independent rather than being unified.

Ownership, mechanism minimality, and the two-entry-point justification are
**accepted**. No finding requires a different owner or a new entity.
