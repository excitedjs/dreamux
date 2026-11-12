# R73 Workflow construction admission — MiMo proposal

## 1. Authority, baseline, and scope

Authority is the R73 ruling in the
[rulings ledger](../../../rulings.md#existing-behavior-follow-up-2026-10-02) —
the operator's words: "停止新建" — restated by the decision artifact,
[product-decisions-20261002.md](../../../artifacts/product-decisions-20261002.md)
(revision 1), acceptance boundaries:

1. If the relevant owner is already closing when a Workflow requests its next
   TeamMate construction, refuse before allocating a workspace, creating a new
   identity, or running its launch hook.
2. Apply this to Team and Dispatcher Workflow construction. Preserve the Team
   then Dispatcher refusal order and the existing error contracts.
3. Construction admitted before close retains the existing materialization
   tracking, runtime stop, lock handoff/release, and Workflow finalization.
4. Preserve queued completion delivery, stop-and-reclaim semantics, and R67
   dissolve order. Do not introduce a second close flag or cancellation model.

Baseline is `feat/plugin-system-mvp` after
[PR #460](https://github.com/excitedjs/dreamux/pull/460). PR #460's
"createLocked releases its lock when publication is refused" fix is landed and
is **not** reopened here; this change is only admission *before* construction.
The task-linked
[source audit](../source-audit.md) is read as evidence and is consistent with
every source claim below; where it draws a boundary (notably the early Team
refusal using `TeamClosedError`), this proposal adopts it explicitly rather
than silently.

This proposal changes one lifecycle admission boundary and nothing else: no
product decision beyond R73, no persisted shape, no new capability.

## 2. Ownership

**The authoritative owner of "may a new TeamMate be constructed right now" is
the construction collection's own admission owner (`WorkAdmission`)**, and the
only construction owner is `TeammateCollection`:

- `TeammateCollection` already holds that owner as `opts.fence`, documented as
  "Every public verb enters this owner" (`service/agent/index.ts:91-97`), and
  every public verb obeys it — `spawn` (index.ts:187-189), `send` (:246-248),
  `close` (:333-335), `list`/`status`/`history`/`last`/`getCapabilities`.
  `createLocked` (index.ts:212-236) is the single verb that skips it. That is
  the defect, not a design choice: the class's own option contract already
  states the rule the method breaks.
- For dispatcher members the fence is the dispatcher's `WorkFence`
  (`platform/work-fence.ts:25-44`): `assertOpen` refuses with
  `ServerShuttingDownError` once `close()` raised the permanent flag.
- For Team members the fence is `TeamService` itself
  (`service/team/service.ts:218` `fence: this`), whose `admit` (service.ts:552-555)
  is exactly the required order: `assertOpen()` first (`TeamClosedError` while
  `dissolveTask` is set or the record is `closed`, service.ts:562-569), then
  the dispatcher's `admit` (`ServerShuttingDownError`). Team, then Dispatcher.

Workflow is the *caller*, not an owner: `WorkflowRun.executeAgent` requests
construction through the narrow `WorkflowTeammateFactory` seam
(`workflow-service/types.ts:13-18`) and owns only what happens to the returned
handle. The gate belongs on the construction owner's verb, where `spawn`
already put it — not on the Workflow side, and not in a second owner-side
wrapper.

The R71 final design (`data-flow/final.md` §1, last two table rows) kept the
current owner-side asymmetry — an outer Dispatcher wrapper for dispatcher runs
versus a raw collection path for Team runs — as a *deferred* product exception.
R73 settles exactly that exception. So the inherited shape is evidence of the
deferral, not a verdict on the final boundary: the wrapper is removed and the
gate moves to the owner.

## 3. Named failure scenario

An accepted Team Workflow run is waiting on an earlier step or a concurrency
slot. The operator dissolves the Team: `dissolve()` passes the worktree
precheck and publishes `dissolveTask` — the Team fence is now up
(service.ts:591-605) — and only then does `runDissolve` await the durable
`closed` write before `destroyChildren` reaches
`workflowService.stopAll()` (service.ts:624-663, 752-772). That is an ordinary
asynchronous window, not a crash or timeout. A queued `executeAgent` reaches
its `createLocked` request inside that window
(`workflow-service/run.ts:481-497`) and, today, the raw collection path runs
the whole pre-publication side effect set first — name allocation
(index.ts:673-682), workspace resolution where the scope has one (index.ts:691-710),
identity creation (index.ts:711-728), the `teammateLaunch` hook
(index.ts:730-733), lock acquisition (index.ts:735-741) — before
`selfCloseIfClosing` (index.ts:772-778) notices the owner is closing and
refuses late. A brand-new member identity and a plugin launch-hook run are
produced for a Team that is already over; the name is allocated and the
teammate.state fact is published before anything unwinds. R73 requires the
refusal at the request instead. The dispatcher scope has the same scenario
shape (host stop with a dispatcher-run Workflow mid-flight); its outer wrapper
already refuses at the front, which is the asymmetry.

No simulated crash, timeout, restart, or compound trigger is involved.

## 4. Selected approach

**Fold construction admission into `TeammateCollection.createLocked`, exactly
as `spawn` already does, and delete the Dispatcher's outer wrapper.** Both
Workflow wirings then pass their collection itself. One gate, one owner, both
scopes, no new mechanism.

### 4.1 The code change

`packages/dreamux/src/service/agent/index.ts` — `createLocked` becomes the
same shape as `spawn`:

```ts
createLocked(
  input: SpawnTeamMateInput,
  options: CreateLockedTeammateOptions = {},
): Promise<LockedTeammate> {
  return this.opts.fence.admit(() =>
    this.createLockedAdmitted(input, options),
  );
}
```

with the current method body renamed `createLockedAdmitted` (private), lock
comment included. Nothing inside `createFreshEntity`, `selfCloseIfClosing`, or
`AgentService` changes.

`packages/dreamux/src/service/dispatcher-service/index.ts:284-289` — the
wrapper object is deleted; the wiring becomes `teammates: this._teammates`.
Behavior-identical for the dispatcher scope: the collection's fence *is* the
same `WorkFence` the wrapper called, so the refusal error, the refusal moment,
and the admitted-work tracking are unchanged.

`packages/dreamux/src/service/team/service.ts` — no change at all. The raw
`teammates: this.teammateCollection` wiring (:228) is now correct because the
collection's verb fences itself through `fence: this` (:218).

`packages/dreamux/src/service/workflow-service/types.ts:9-12` — update the
`WorkflowTeammateFactory` comment (the seam and signature stay; the clause
"with dispatcher admission wrapped by its owner for dispatcher-level runs"
describes the mechanism being deleted).

### 4.2 End-to-end admission behavior (request-time refusal)

A Workflow step that reaches `run.ts:481` after its owner started closing:

- **Team scope, Team closing** (dissolve published): `TeamService.admit` →
  `assertOpen` throws `TeamClosedError('Team "…" is closing')` — before name
  allocation, workspace, identity, and the launch hook. If the record write
  already landed and the TeamService instance is on its final legs, the same
  check throws `TeamClosedError('Team "…" is closed')`. Error class, code
  (`TEAM_CLOSED`), and wording are the ones every other Team-fenced member
  verb already raises from the same owner.
- **Team scope, Dispatcher closing only**: `admit` passes the Team check and
  the dispatcher leg refuses with `ServerShuttingDownError`
  (`SERVER_SHUTTING_DOWN`, `platform/errors.ts:151-159`) — Team-then-Dispatcher
  order preserved by construction, because the Team's own `admit` composes it.
- **Dispatcher scope**: `WorkFence.admit` → `assertOpen` refuses with the same
  `ServerShuttingDownError('dispatcher "…" is shutting down')` the wrapper
  raises today.

The run's existing catch (`run.ts:539-558`) classifies a refused construction
exactly as it classifies today's wrapper refusal: the agent call settles
`stopped` when the run was already asked to stop, otherwise `failed` carrying
the owner's message. That catch is untouched.

### 4.3 End-to-end close behavior

**Team dissolve (R62/R67 order, unchanged):** worktree precheck → publish
`dissolveTask` (fence rises; *this* is the moment R73 refusals begin) → write
the `closed` record → `destroyChildren` in order: `workflowService.stopAll()`
(requestStopAll → per-run `stop()` → `finalize`), `scheduler_.destroy()`,
`teammateCollection.destroy(note)`, `leader.close` → worktree cleanup. The
only difference R73 makes inside this sequence is that every `createLocked`
requested from the fence-rise onward is refused at the gate instead of being
built and then late-refused. `stopAll`/`finalize` still settle runs admitted
before the close exactly as before.

**Dispatcher close / host stop (unchanged order):**
`DispatcherLifecycle.close()` synchronously raises `fence.close()`, closes
channel admission, `workflows.requestStopAll()`, stops the scheduler, and
`teams.stopAdmissions()` (lifecycle.ts:90-108), then `doClose` runs sweep →
`fence.drain()` → sweep → channel close (lifecycle.ts:217-263). Construction
requested after the fence raise is refused at the front; construction admitted
before it runs the existing path: register into `materializations`, and if the
close overtakes it mid-build, `selfCloseIfClosing` stops the entity's runtime
and refuses late publication, the PR #460 undo releases the lock, and the
two-pass sweep plus `heldMembers` cover anything in flight.

### 4.4 Error contract table

| Refusal moment | Owner | Error (class / code / message) | Status |
| --- | --- | --- | --- |
| Request-time, Team closing | `TeamService.assertOpen` | `TeamClosedError` / `TEAM_CLOSED` / `Team "…" is closing|closed` | existing owner contract, newly reachable here (the Team-scope raw path previously refused nothing) |
| Request-time, Dispatcher closing | `WorkFence.assertOpen` | `ServerShuttingDownError` / `SERVER_SHUTTING_DOWN` / `dispatcher "…" is shutting down` | unchanged dispatcher-scope contract (the wrapper already produced it) |
| Late publication of an admitted build | `selfCloseIfClosing` | `ServerShuttingDownError` / `SERVER_SHUTTING_DOWN` (names the dispatcher even for a Team close) | unchanged on purpose — admitted-before-close keeps its existing path |

The source audit's boundary is honored: the early Team refusal is the owner's
`TeamClosedError`, the late one keeps its current wording, and the change is
not sold as "identical behavior" — the Team-scope refusal at request time is
new product behavior mandated by R73.

## 5. Minimal change and deletion boundary

**Changed (two files, one behavior):**

| File | Change |
| --- | --- |
| `packages/dreamux/src/service/agent/index.ts` | `createLocked` admits through `this.opts.fence.admit`; body moves to `createLockedAdmitted`. Net: +1 mechanism-crossing line, 0 new types |
| `packages/dreamux/src/service/dispatcher-service/index.ts` | delete the inline `createLocked` wrapper closure; `teammates: this._teammates` |
| `packages/dreamux/src/service/workflow-service/types.ts` | comment-only: drop the wrapper clause from `WorkflowTeammateFactory`'s doc |

**Deleted:** the Dispatcher-side admission wrapper (the deferred asymmetry
mechanism from `data-flow/final.md` §1) — exactly the special case R73
settles. This is the change's removal entry: after it, there is one admission
site per construction, owned by the collection, and the Workflow seam carries
no owner-side compensation.

**Explicitly untouched (boundary):**

- `createFreshEntity`, `selfCloseIfClosing`, the `inFlight` allocate counter,
  `materializations`/`reopening`, `heldMembers`, `destroy`/`stop` —
  admitted-before-close tracking and sweep behavior (R73 boundary 3).
- `AgentService.lock`/`LockedTeammate`/`unlock`, and PR #460's
  failed-publication undo (`index.ts:735-748`) — lock handoff and release.
- `workflow-service/run.ts` (request site, materialization tracking, catch
  classification, `finalize`'s handle close/unlock, stop reservation) and
  `workflow-service/index.ts` (`accepting`, `requestStopAll`, `stopAll`) —
  Workflow finalization and the existing workflow-admission flag.
- Team dissolve order and verbs (R62/R67), `SchedulerService`,
  completion-router queued delivery and suppression, `WorkFence`/`InFlightWork`
  primitives, all error classes and messages, `TeammateOps`/`WorkflowOps`
  surfaces, `workflow-service/mcp.ts` tools.
- No persisted state, config, path, CLI, Command, or MCP contract changes. No
  second close flag, no cancellation token, no error taxonomy.

Every addition above is paid for by R73's stated acceptance boundary 1; the
only deletion is the wrapper the ruling's settled asymmetry made obsolete.

## 6. Concurrency and lock handoff

- **Admission defines the race line.** Requested before the owner's fence
  rises → admitted: construction runs to handle creation and is tracked in the
  owner's admitted-work set (`WorkFence`'s `InFlightWork`) — the span ends at
  handle creation, never including the native turn's submit or completion, so
  a sweep can always stop the runtime first (the source-audit boundary holds).
  Requested at/after the fence → refused synchronously at `assertOpen`, before
  any side effect. There is no third window: a close overtaking an
  already-admitted build is the *existing* late-publication path
  (`selfCloseIfClosing` → `stopForHost` → throw → PR #460 undo → run's catch),
  preserved unchanged.
- **No lock on refusal.** `entity.lock()` runs inside `beforePublish`, after
  the build; a front refusal never constructs, so no lock is ever taken and
  nothing needs releasing. On the admitted path the lock's single-token rules
  (`service/agent/service.ts:167-211`: active-only, one token, idle, no
  unsettled turn) and the handoff are unchanged: the build releases the lock
  itself if publication fails (PR #460), ownership of a published handle
  passes to the Workflow run, and `finalize` closes then unlocks each held
  handle once via `unlockedHandles` (`run.ts:696-756`).
- **Double-admission hazard, designed out.** Keeping the wrapper *and* adding
  the internal admit would nest two admits on one owner and create a
  pathological case: an outer-admitted construction refused by the inner
  `assertOpen` after the fence rose mid-flight — violating boundary 3
  ("construction admitted before close retains…"). Exactly one admission point
  exists under this design; the wrapper is deleted, not complemented.
- **Sweeps.** `heldMembers` (index.ts:612-630) still joins the narrow
  allocate window and the `materializations`/`reopening` maps; the run's
  `finalize` still drains its own `materializations` before collecting
  handles. A refused request leaves `call.handle === null`, so it is excluded
  from close/unlock exactly as today's dispatcher-scope refusal is. Concurrent
  same-name construction keeps the existing "already materializing" refusal
  (index.ts:683-688).
- **Team-scope tracking side effect (accepted).** A Team-scope `createLocked`
  now counts as admitted work on the dispatcher's fence (that is where
  `TeamService.admit` tracks). At host stop this only extends the drain by the
  construction span — bounded, no native turn — and the same close overtaking
  it produces the existing late refusal. It makes the two scopes symmetric and
  is required for boundary 3 to mean anything in the Team scope.

## 7. Compatibility

- **User-visible behavior change (the R73 requirement itself):** a Workflow
  agent step requested after its owning Team or Dispatcher starts closing now
  fails fast with the owner's closing error instead of constructing a member
  that is immediately torn down. Diffed against `.agents/product/README.md`:
  the dissolve entries ("Dissolve means terminate now and reclaim",
  "Dissolve has exactly one reversible step") are unchanged — this refines
  *when a new step is admitted during* that sequence, consistent with "the Team
  is over for good" once closing begins. A one-line product-catalog entry is
  owed in the knowledge closeout (named in §9).
- **Dispatcher-scope behavior is bit-for-bit the same** (same fence, same
  error, same tracking) except the gate's location. Team-scope request-time
  refusal is new; the Team-scope late-publication path keeps its current
  `ServerShuttingDownError` wording (§4.4).
- **Persisted formats, paths, config, CLI/Command/MCP surfaces:** untouched.
  A refused construction writes nothing: no identity file, no run-record
  change beyond the agent row the existing catch already writes.
- **Changelog:** one ordinary change note on `@excitedjs/dreamux` describing
  the refusal. Not `BREAKING:`, not `Rebuild:` — nothing upgrade-blocking, no
  schema or path change (per `state-config-and-files.md` policy). No
  exported-type change, so no other package note. 0.x line → `minor` type.
- **No public API change.** `WorkflowTeammateFactory`, `TeammateCollection`,
  and `LockedTeammate` keep their signatures.

## 8. Verification mapping under R43

R43 governs: this pull request writes **no new unit tests** and repairs none;
the four Rush gates run; a test that fails is deleted and logged in
`artifacts/deleted-tests.md`; the final test completion restores coverage.

| # | Acceptance boundary | How it is verified without new tests |
| --- | --- | --- |
| 1 | Refuse before workspace / identity / launch hook, both scopes | Source trace in the PR description: the refusal is `fence.admit`'s `assertOpen`, strictly before `createFreshEntity` (index.ts:647+); diff accounting shows the request sites (run.ts:481, dispatcher-service/index.ts wiring) reach only the fenced verb. Gate: `rush typecheck:tests` proves no test/source type drift from the renamed private method |
| 2 | Team-then-Dispatcher order, existing error contracts | Trace of `TeamService.admit` (service.ts:552-555) composing `assertOpen` before dispatcher admission; error table §4.4 cites unchanged classes/codes. No error class or message is edited anywhere in the diff |
| 3 | Admitted-before-close retains tracking, runtime stop, lock handoff/release, finalization | Whole-diff structural accounting: the PR's touched ranges exclude `createFreshEntity`'s body, `selfCloseIfClosing`, `heldMembers`, `AgentService.lock`, `run.ts`. PR #460's undo path cited as the already-landed lock-release fix (not re-fixed) |
| 4 | Queued delivery, stop-and-reclaim, R67 order, no second close flag | Diff accounting: no completion-router, dissolve, or `WorkflowService` lifecycle edit; no new flag/token type in the diff |
| — | Regression net | `rush build`, `rush lint` (dependency-cruiser layering holds: `service/agent` collection tier may still import its own `platform/work-fence` type as today), `rush test`, `rush typecheck:tests`, plus `.agents/scripts/check.sh` for the knowledge updates |

Predicted test impact: **none**. No live test constructs Workflow TeamMates or
pins the wrapper (the workflow-run suite's `createLocked` cases were deleted in
an earlier stage and are already in the ledger for final restoration — note
there that `createLocked` now enters collection admission so the restored
"reaches only createLocked on the teammates dependency and holds the lock"
case is written against the fenced verb). If a gate nonetheless fails, R43
applies: delete, log the pinned contract in `artifacts/deleted-tests.md`, never
weaken the assertion. The issue #63 live gate is untouched by this diff.

Coverage limit to state in the completion report: no test run demonstrates a
live mid-dissolve Workflow race; the evidence for boundary 1 is the code path
ordering above, not an executed concurrency test.

## 9. Knowledge delta (named for the implementation PR)

This settles a recorded design exception, so the same PR updates:

- `packages/dreamux/src/service/CLAUDE.md` — the `workflow-service` /
  `agent/` bullets where the dispatcher wrapper and the raw Team path are
  described; state that `createLocked` enters the collection's admission owner
  like every public verb.
- `packages/dreamux/src/service/workflow-service/types.ts` — the seam comment
  (§4.1).
- `.agents/product/README.md` — one line: a Workflow step requested after its
  owner starts closing is refused before any member is created (R73).
- `.agents/domains/dispatcher-orchestration.md` / `service-topology.md` where
  they describe Workflow member construction admission.
- The task record (`product-decisions-20261002.md` status, README "Remaining
  stage", `ownership-follow-up.md`'s deferred-behavior entry) flips from
  "implementation pending" — TeamLeader-owned.

## 10. Rejected alternatives

1. **Front `isClosing()` check at the top of `createFreshEntity`/`createLocked`
   without `admit`.** Rejected: it duplicates the refusal beside the owner's
   own gate (a second mechanism for one fact), must invent one error flavor for
   two owners (the collection does not know whether its fence is a Team or a
   WorkFence), and does not track the construction as admitted work, so
   boundary 3 has nothing to hold onto. `spawn` already shows the correct
   shape.
2. **Mirror the Dispatcher wrapper at the Team** (wrap the member collection in
   an admitting `WorkflowTeammateFactory` in `team/service.ts`). Rejected: it
   adds a second owner-side wrapper instead of deleting the first, and leaves
   `createLocked` as the one collection verb that bypasses its own fence —
   symmetric glue, not a boundary. R71's direction (delete repeated
   admission/forwarding closures) and the class's own "every public verb"
   contract both point the other way.
3. **Keep the wrapper and also admit inside `createLocked`** (belt and
   suspenders). Rejected: nested admits on one owner create the
   admitted-then-inner-refused case that violates boundary 3, double-count
   in-flight work, and leave two sources of truth for "was this construction
   admitted".
4. **Check the owner in `WorkflowRun.executeAgent` before calling
   `createLocked`.** Rejected: re-derives at the Workflow layer a fact the
   collection's owner states authoritatively (the banned
   state-re-derived-above-its-owner glue), leaves the collection constructible
   ungated by any future caller, and TOCTOU-checks instead of entering the
   admission.
5. **Thread a cancellation token / close flag into `WorkflowRun`.** Rejected
   by boundary 4 verbatim ("Do not introduce a second close flag or
   cancellation model"); `terminalRequested`/`accepting` already exist and stay
   as they are.
6. **Classify every admission refusal as `stopped` in the run's catch.**
   Rejected: it needs an error-taxonomy check the run has no business owning
   (the whitepaper's "core rephrases foreign errors" family), and would alter
   the dispatcher scope's existing classification. The existing catch stands;
   see §11 for the one observable it produces.
7. **Let dissolve/stop drain running Workflows naturally before closing**
   (remove the window entirely). Rejected: contradicts R10/R62/R67
   stop-and-reclaim (no drain anywhere) and boundary 4's dissolve-order
   preservation; the window is closed by refusing admission, not by waiting it
   out.

## 11. Derived consequences and unsettled items

Nothing in the requirement is left unsettled for implementation. Two derived
items, labeled as inference, are recorded so the completion report does not
have to rediscover them:

- **(inference) Agent-row wording in the Team-close window.** Because the run's
  catch classifies by `terminalRequested` (unchanged), a step refused during
  the dissolve window *before* `destroyChildren` reaches `stopAll()` records
  status `failed` with `Team "…" is closing`, while the dispatcher path records
  `stopped` (its `close()` raises the fence and `requestStopAll()` in the same
  synchronous tick). The run's own terminal status is `stopped` in both cases.
  This follows from "preserve the existing error contracts" plus "no second
  cancellation model"; changing it would be the rejected alternative 6. If the
  operator wants uniform `stopped` rows, that is a separate product ruling.
- **(inference) Team-scope construction now counts as dispatcher admitted
  work** (§6). Consequence is a slightly wider host-stop drain bounded by the
  construction span; it is the direct reading of boundary 3 ("construction
  admitted before close retains…") and needs no new mechanism.

No product question is opened by this design; both inferences can be checked
against source in review and neither blocks the change.

---

# Cross-review round (2026-10-02)

Append-only review of [codex.md](codex.md) and [deepseek.md](deepseek.md)
against this seat's first round, the [source audit](../source-audit.md), the
decision artifact revision 1, and the rulings ledger. The first-round
reasoning above is preserved; revisions are stated here. Citation hygiene:
the bare baseline commit hash in §1 is replaced by the PR link.

## Convergence (no adjudication needed)

All three proposals independently land on the same core change:
`TeammateCollection.createLocked` enters its existing `opts.fence.admit` before
construction, the Dispatcher's outer wrapper is deleted (so both scopes pass
their collection itself), the late-publication path
(`selfCloseIfClosing` + PR #460's lock undo) is untouched, early refusals are
`TeamClosedError` (Team first) then `ServerShuttingDownError` (dispatcher leg
and dispatcher scope), and no new flag/token/registry/test is introduced. The
first-round error table (§4.4) matches Codex's table and DeepSeek's §4.2
verbatim in substance. Nothing in the ownership, change/deletion boundary,
or R43 verification mapping needs revision on these points.

## The five named source checks, resolved

1. **Public async rejection boundary — accepted from Codex; revises §4.1.**
   Codex's "Retain `async createLocked` so a refusal remains a rejected promise
   at this method boundary" is correct and fixes a real flaw in both my §4.1
   sketch and DeepSeek's §4.1 snippet: making the verb non-async (mirroring
   `spawn`) would let `WorkFence.admit`'s synchronous `assertOpen` throw escape
   the seam as a *synchronous* exception, while `WorkflowTeammateFactory`
   declares `Promise<LockedTeammate>` and today's method is `async`
   (Team-scope refusals via `TeamService.admit` already reject). Revised shape:
   `async createLocked(...)` returning `this.opts.fence.admit(...)` (body in a
   named `createLockedAdmitted`, per the file's verb/verbAdmitted family
   convention — Codex's inline-callback variant is behaviorally identical and
   acceptable). The admission linearization point is unchanged: `assertOpen`
   still runs synchronously inside the call, before any await. One
   micro-observable, no contract change: a refused dispatcher-scope request now
   leaves `call.materialization` holding a settled-rejected promise (tracked
   then drained) instead of `null`; `finalize`'s handle filtering is identical
   (`handle` stays `null`) and `executeAgent`'s catch is unchanged.
2. **One admission, not nested — resolved.** Codex names the mechanism this
   first round (§10 alt 3) described only from the outside: `WorkFence.admit`
   defers its body through `Promise.resolve().then(task)`, so with the wrapper
   retained the inner `assertOpen` would run a microtask *after* the outer one
   and could reject construction the outer fence already accepted — violating
   acceptance boundary 3 and double-counting in-flight work. Wrapper deleted;
   one admission point. (My §6 "double-admission hazard" paragraph and Codex's
   §Selected-change item 2 agree.)
3. **Newly early owner errors vs unchanged late errors — resolved; DeepSeek's
   §9 "genuinely unsettled" is rejected as unsettled.** All three proposals
   select the same behavior (early `TeamClosedError`), and the requirement's
   own words settle the interpretation: "Preserve the Team then Dispatcher
   refusal order and the existing error contracts" names the owner *contract*
   — the literal-string reading would demand a Team refusal carrying the
   dispatcher's message, which contradicts the very "Team then Dispatcher"
   order it claims to preserve. The source audit states the boundary
   explicitly (early Team refusal uses `TeamClosedError` from its owner; the
   late `ServerShuttingDownError` naming the Dispatcher even on a Team close
   stays; "do not conceal that observed error change as identical behavior").
   My §4.4 table already separates the three rows; DeepSeek's §7 "one real
   message delta" statement is accepted as the honest user-visible wording of
   the same fact (a step that previously died late on `dispatcher '…' is
   shutting down` after side effects now dies early on `Team '…' is closing`
   without them). The literal-string option DeepSeek sketches is rejected for
   the reason DeepSeek itself gives (a bespoke pre-check re-implementing the
   fence) — and is moot, since no proposal selected it.
4. **No time-bound guarantee for awaited launch taps — correction to §6 and to
   DeepSeek §5.** DeepSeek's "bounded disk-I/O span (name allocate + identity
   write)" and this seat's §6 "bounded, no native turn" both overclaim: the
   admitted construction span also *awaits* the `teammateLaunch` plugin taps
   (`composeLaunchDraft`), which are foreign code with no timeout. The
   guarantee that actually holds — and the only one R73 needs — is structural,
   not temporal: the span contains no native runtime start and no turn, and
   ends at handle creation or rejection. The drain may wait on a slow tap
   exactly as it already does for an admitted `spawn` (whose span runs the
   same taps plus a runtime start, strictly longer), so no new hazard class is
   introduced and no timing promise should be written into the design or its
   docs. Related, accepted from Codex's V6: because hook taps are isolated
   (failure-swallowed), a "rejecting launch hook" cannot be used to exercise
   the late-publication path — verification must not fabricate one.
5. **Must a run always end `stopped` when a Team-close construction fails
   before Workflow stop reserves its terminal intent? — resolved: no.** This
   is §11 inference-1, now settled rather than open. All three proposals keep
   `executeAgent`'s existing catch (call row `stopped` iff a terminal intent
   was already requested, else `failed` carrying the owner's message), and
   Codex adds the right framing: R73 forbids the construction side effects,
   not the run's ordinary accounting writes, and a refusal must not become a
   run-level cancellation. At run level, the normal dissolve sequence still
   ends `stopped`: `destroyChildren` → `stopAll` → `requestStopAll` reserves
   the stop intent, and finalize reports `stopped`. If the user's script turns
   the refused step into a run failure *before* that reservation reaches the
   run, the run may report `failed` — the same classification property the
   dispatcher scope already produces for any step failure, and a consequence
   of the preserved R67 order (the `closed` write and child teardown lag the
   fence rise), which R73 forbids reordering. Forcing `stopped` would require
   exactly the error taxonomy / intent pre-emption that boundary 4 excludes
   (first-round rejected alternative 6 stands).

## Accepted arguments (beyond the five checks)

- Codex's three-lifetime table (admitted construction / collection discovery /
  Workflow's received handle) matches §6 and sharpens the claim that the
  Workflow's own `materializations` join already covers an admitted request
  whose deferred body has not run — adopt into implementation review notes.
- Codex's verification table (V1–V10) is accepted as the coverage handoff
  expansion of §8: the surviving `tests/workflow-runner.test.ts` establishes
  no collection admission or close ordering; the deleted-tests ledger
  obligations (`deleted-tests.md` around the Workflow lock/finalization cases
  and the creation-versus-close cases) are preserved, and the restored
  "reaches only createLocked … holds the lock" case should be written against
  the now-fenced verb (this seat's §8 note).
- Codex's history note (PR #459 moved admission facts into `WorkFence`; the
  R71 final solution's two exception rows are superseded by R73 without
  erasing their rationale) matches §2 and §9; the closeout wording should say
  "supersedes", not "was wrong".
- DeepSeek's point that `createLocked`'s existing "No capability gate" comment
  concerns output-schema support, not admission — supporting evidence that the
  missing fence was an oversight in a uniform verb family, consistent with §2.
- DeepSeek's §5 observation that `createLocked` never starts a runtime (the
  turn starts at `handle.submit`) supports §6/§8; keep the "no native turn in
  the admitted span" phrasing as the load-bearing fact.

## Rejected arguments

- **DeepSeek §9, treating the error-contract reading as a blocking product
  question** — rejected (see check 3): the acceptance boundary's wording and
  the source audit settle it; all three proposals selected the same behavior.
  At most it is a completion-report footnote, not an item to put to the
  operator.
- **Codex's inline-callback-only shape ("no new … private bypass verb")** —
  not rejected on substance but not binding: `spawnAdmitted`/`sendAdmitted`/
  `closeAdmitted` already establish that a private admitted body is the
  family convention and is never called outside `admit`. Implementation may
  take either shape; this seat keeps the named split.

## Revised position

- §4.1 sketch: keep the `async` signature on `createLocked` (check 1). The
  rest of §4.1 stands (`teammates: this._teammates`; comment-only
  `types.ts` edit).
- §6: replace "bounded, no native turn" with "no native runtime start and no
  turn; the span awaits the same `teammateLaunch` taps an admitted `spawn`
  already awaits, and no time bound is claimed for them" (check 4).
- §11 inference-1 is upgraded from open inference to resolved consequence
  (check 5), with the run-level `failed`-possible note recorded above.
  §11 inference-2 (Team-scope construction counts as dispatcher admitted
  work) stands unchanged and is corroborated by Codex's lifetime table.

## Unresolved material disagreement

None. The three proposals agree on ownership, the code change, the deletion
of the wrapper, the error split, lock handling, compatibility accounting, and
R43 verification. The only deltas are shape preferences (async boundary — now
resolved in Codex's favor; named vs inline admitted body — non-material) and
two overclaims corrected above. Nothing here needs another operator ruling.
