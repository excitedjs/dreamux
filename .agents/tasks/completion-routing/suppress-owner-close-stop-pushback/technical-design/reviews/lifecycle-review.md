# Independent lifecycle review

## Verdict

**NEEDS REVISION — do not approve implementation yet.** The proposed source
owner and normal teardown path are sound, but F1 leaves a concrete host-stop
failure path that can re-enable a pre-boundary completion delivery. F2 and F3
are required corrections to the knowledge and verification boundary.

## Review basis and boundary

- Requirement reviewed: `../requirement.md`, SHA-256
  `d2b40d9b10451621d9c04463df29b8f0ad701f3163bb8f9276f1e7a2221e3961`.
- Draft reviewed: `../draft.md`, SHA-256
  `474d89e8aaec44029256ad453271e663a838cb91ad2f204cae1a347da78f53d9`.
- Current source and `origin/next` both resolve to
  `fffc3bd337f8ce28070fb8658fc30893e71730bb`.
- Read the engineering whitepaper before the requirement, draft, current
  source, and lifecycle history (`8ed949e` and `2ed5f5e`). Existing structure
  was treated as evidence, not as a preservation requirement.
- This review writes only this file. It changes no implementation, test,
  requirement, draft, task metadata, or other reviewer output. No build, test,
  or live-provider run was performed; this is a design review.

## Findings

### F1 — P1: A failed host stop clears the proposed boundary before a delayed admission attaches

**Draft:** “Make `EntityTurnCoordinator` own abandonment across admission
races” (lines 70-90) and the `phase === 'active' && hostStop === null`
predicate (lines 92-108).

**Current-source evidence:**

1. `submitRuntimeTurn()` invokes `runtime.submit()` before the serialized
   continuation attaches the returned submission (`turn-coordinator.ts:39-64`).
   A submitted provider admission can therefore still be awaiting attachment
   when host teardown starts.
2. `stopForHost()` publishes `hostStop`, but clears it in `finally`
   (`teammate-service/index.ts:398-407`). Its worker calls
   `stopRuntime()` *before* `drainAdmissions()` and
   `settleAndDeliverRetained()` (`:410-418`), so either later step is skipped
   if `stopRuntime()` rejects.
3. A rejecting native stop is an explicit supported path, not hypothetical
   hardening: `TeammateRuntimeOwner.stopRuntime()` records each `runtime.stop()`
   error and rethrows it after releasing authority
   (`runtime-owner.ts:139-166,173-193`). Dispatcher shutdown collects that
   error and later performs another stop sweep (`dispatcher-service/index.ts:335-379`).
4. Once the first host-stop promise rejects, the draft's predicate becomes true
   again for an active entity. A delayed admission then attaches the original
   delivery closure; the current `EntityTurn` starts that closure after its
   outcome is selected (`turn-recording.ts:132-172`).

**Triggering flow:** an owner has already called `runtime.submit()` for a
TeamMate, but the provider has not resolved its admission. Dispatcher or Team
teardown starts, publishes `hostStop`, and abandons the current retained-turn
snapshot. The provider's `runtime.stop()` rejects. The first host-stop task
clears `hostStop` without draining the delayed admission. That admission then
resolves as `submitted` and settles before the dispatcher's later sweep reaches
it. The draft attaches its old completion closure because the entity is again
`active` and `hostStop` is `null`.

**User-visible consequence:** a result that was pending at the deliberate
teardown boundary is pushed back to the TeamLeader or Dispatcher after all,
recreating the extra model turn or failed COT submission this task removes.
The close path does not share this leak because its `phase` remains `closing`;
the gap is specific to the transient host-stop fence.

**Required correction:** state how the host-stop operation keeps every
pre-boundary admission in the abandonment decision until it has attached, even
when native termination fails. The smallest compatible direction is to retain
the published host-stop boundary through admission convergence (and abandon a
late attachment) before clearing it, then surface the existing stop error in
the current failure-collection style. Do not persist a marker, cancel a
recipient queue, or reclassify work first admitted after the boundary.

**Required verification:** use a controllable real-Core composition in which a
pre-boundary admission remains unresolved, `runtime.stop()` rejects, and the
admission later returns a submission that settles. Assert that host stop still
reports its stop failure, while the owner records no completion submission.
This must be separate from the draft's successful-stop admission-race case.

### F2 — P2: The documentation boundary leaves two live blanket invariants stale

**Draft:** “Documentation and release surface” (lines 206-216) names the
product catalog and `dispatcher-orchestration.md`, but not the local service
architecture instructions.

**Evidence:**

- `packages/dreamux/src/service/CLAUDE.md:138-140` says “Every settled turn is
  reported.” It is the direct local instruction for the three files the draft
  changes.
- `.agents/domains/dispatcher-orchestration.md:337-355` says every selected
  outcome invokes the policy, and repeats the same blanket invariant at
  `:450-452`.
- The required behavior is the opposite at one named boundary: all delivery
  still pending when deliberate teardown starts is abandoned
  (`requirement.md:86-95,177-183`).

**Consequence:** after implementation, an engineer reading the source-local
instructions or the detailed completion-routing section is told to restore the
very behavior the task removes. Updating only the repeated sentence in the
domain document does not fix the earlier detailed claim, and leaving the local
instruction unchanged creates conflicting architectural authority.

**Required correction:** extend the documentation scope to update the product
catalog, both relevant assertions in `dispatcher-orchestration.md`, and
`packages/dreamux/src/service/CLAUDE.md`. State the narrower invariant: a Turn
delivers its selected result while its delivery relationship remains active;
deliberate entity teardown abandons only deliveries that have not started.

### F3 — P2: The verification plan omits the repository's mandatory test typecheck gate

**Draft:** repository gates (lines 195-200) run build, lint, test, and the
knowledge check, but omit `typecheck:tests`.

**Evidence:** `AGENTS.md:112-123` makes all four Rush commands mandatory and
states that Vitest's esbuild execution erases test types; only
`node common/scripts/install-run-rush.js typecheck:tests` proves new tests
compile against the changed Turn and coordinator seams.

**Consequence:** the proposed test suite can pass while a new fake or
observable completion-recipient test compiles against an invalid interface.
The implementation cannot be reported green under this repository's standing
acceptance rule.

**Required correction:** add
`node common/scripts/install-run-rush.js typecheck:tests` to the verification
plan and to the final implementation handoff.

## Confirmed design choices

- **The source Turn is the correct owner.** A collection resolves its
  ownership-derived recipient before submission
  (`teammate-collection/index.ts:158-170,661-669`); Team members resolve to the
  TeamLeader (`team-service/collaborators.ts:28-56`) and dispatcher-owned
  TeamMates to the Dispatcher (`dispatcher-service/index.ts:194-208`). The
  coordinator retains the resulting `EntityTurn`, while the router owns only
  recipient FIFO/folding (`turn-coordinator.ts:29-117`,
  `completion-router/index.ts:87-133`). Clearing a router queue or filtering
  notification text would therefore be too late and too broad.
- **One entity operation covers all required owners.** Both MCP scopes call the
  same scoped collection close (`teammate-collection/mcp-delegate.ts:217-226`),
  which resolves the live entity and calls `TeammateService.close()`
  (`teammate-collection/index.ts:245-260`). Team dissolve reaches held members
  through `stopForHost()` and later the same entity close
  (`team-service/closing.ts:215-265`; `dissolve-members.ts:29-57`), while
  dispatcher stop sweeps materialized TeamMates through `stopForHost()`
  (`dispatcher-service/index.ts:335-379,620-626`). No role test or
  provider/channel branch is needed.
- **Do not retract a started delivery.** `CompletionDeliveryPolicy` owns an
  already-selected per-recipient FIFO promise (`completion-router/index.ts:124-133`).
  The draft's “do nothing once `deliveryTask` exists” matches the requirement's
  explicit no-retraction limit and avoids inventing downstream cancellation.

After F1-F3 are addressed, the design has a minimal Core-only boundary and can
proceed to implementation approval without a provider- or Channel-specific
mechanism.

## 2026-09-08 Workflow-stop amendment review

**Verdict: NEEDS REVISION.** `WorkflowRun` is the correct source owner and one
mutable, in-memory delivery obligation is the minimal mechanism. However, the
draft abandons that obligation before it knows that stop won the terminal race.
That can suppress a naturally completed or failed Workflow, contrary to the
amendment's retained-natural-delivery contract. Its verification plan also
leaves the named lifecycle paths and create/admission race without the required
observable coverage.

### Review basis

- Requirement reviewed: `../requirement.md`, SHA-256
  `0f34ff8be04b6a42c363db28246c7c9763918a63ff4650af46f9be81068d6ea9`.
- Draft reviewed: `../draft.md`, SHA-256
  `9b732820d647c5ef4ae8b9d0d92c5fdd7253bfb37f36e43f6598459dc4c10d44`.
- Source reviewed at PR #389 head `3974df3e621b1adbcdc75fc7b8437e666ec27732`
  against `origin/next` `fffc3bd337f8ce28070fb8658fc30893e71730bb`.
- This amendment review is source- and whitepaper-based only. No source, test,
  Git, GitHub, or task-record change was made, and no test command was run.

### W1 — P1: Stop may discard a natural terminal outcome it did not cause

**Draft:** both `WorkflowRun.stop()` and `WorkflowRun.closeAdmission()` abandon
the closure *before* “reserving or joining” the stopped transition
(`draft.md:249-261`).

**Current-source evidence:** a runner's `run_result` selects `completed` or
`failed` through `WorkflowRunTerminal.request()` (`run.ts:229-235`), which sets
the first terminal intent and begins the single finalization task
(`run-terminal.ts:95-104,120-140`). A later `WorkflowRun.stop()` currently only
delegates to `terminal.stop()` (`run.ts:172-177`); `reserveStop()` deliberately
does nothing once any intent already exists (`run-terminal.ts:64-69`), and
`stop()` then returns that selected status (`run-terminal.ts:86-93`). Terminal
owner delivery occurs later, after runner/agent convergence and durable journal
and record writes (`run.ts:558-650`). There is therefore a real asynchronous
window after a natural intent wins and before `deliverTerminal` begins.

**Trigger and consequence:** the runner selects `completed` or `failed`; its
finalization is awaiting ordinary teardown or durable I/O; then an explicit
`workflow_stop`, or `stopAll()` through a Team dissolve/host stop, reaches the
run. The draft's proposed pre-reservation clear removes the natural outcome's
pending closure even though `reserveStop()` will decline to change the terminal
intent. Finalization then records the natural terminal fact but sends no
completion. This conflicts with the requirement that a naturally completed or
failed Workflow while its scope is active delivers exactly once and that the
2026-09-08 ruling does not alter natural Workflow delivery
(`requirement.md:112-115,192-194,214-218`).

**Required correction:** make abandonment conditional on atomically winning the
`stopped` intent. The existing terminal already owns the only fact needed:
`reserveStop()` can report whether it reserved `stopped` (or expose an equivalent
single operation), and `WorkflowRun` abandons only on that result. A natural
intent already selected means no abandonment; a selected delivery task remains
untouched. This stays one source-owned closure, adds neither a mode nor durable
state, and preserves the existing failure convergence in which a rejected
terminal task can be retried (`run-terminal.ts:135-137`).

**Required observable test:** hold finalization after a natural `completed` and,
separately, `failed` intent is selected but before owner delivery starts; issue
explicit `stop` and `stopAll()` in that window; then release it. Assert the
receipt/status remains natural and the owner observes exactly one natural
completion. Keep the complementary gated test in which delivery has already
started, then stop, to prove no retraction.

### W2 — P2: The plan does not test the named Team-dissolve and host-stop call chains at the owner boundary

The draft proposes a `WorkflowService.stopAll()` no-delivery assertion
(`draft.md:268-277`), but that is only the shared mechanism. Team dissolve calls
`workflows.closeAdmission()` then `workflows.stopAll()` in `TeamClosing`
(`team-service/closing.ts:251-265`); Team host stop calls `stopAll()` through a
separate failure-collecting path (`:344-360`); Dispatcher host stop fences its
own Workflow scope, stops Team runtimes, then makes a second sweep
(`dispatcher-service/index.ts:326-379`). The current Workflow tests only assert
that direct `stopAll()` reaches terminal records (`workflow-service.test.ts:596-624`),
and the new real-host lifecycle test contains no Workflow scenario.

The requirement specifically demands no stopped Workflow completion for Team
dissolve and host stop, and requires observed owner submissions rather than
private implementation state (`requirement.md:188-197`). Add real-Core tests
with controllable runtime recipients: one starts a Team-scoped Workflow then
dissolves the Team, and one stops the host with an active Workflow scope. Each
must retain the stopped record/receipt where applicable and assert no Workflow
terminal input reaches its TeamLeader or Dispatcher. This verifies the two
actual lifecycle paths without adding a new production mechanism.

### W3 — P2: Create-versus-close-admission coverage is required, not conditional

The draft says to cover this race only “if existing composition coverage does
not observe” it (`draft.md:275-277`). Current coverage does not: there is no
`closeAdmission`, `runCreations`, or admission-race case in
`workflow-service.test.ts`. The source has a material race: `createRun()` checks
`accepting`, awaits script resolution, constructs and initializes a run, then
only after inserting it into `runs` notices a scope that closed meanwhile and
calls `run.closeAdmission()` (`workflow-service/index.ts:117-174`). `stopAll()`
waits for those tracked creations before stopping its live snapshot
(`:228-235`).

Add a deterministic composition test that closes admission after the initial
check but before the new run is visible, then lets creation finish. It must show
one stopped journal/record and no owner completion. This is the concrete
creation race the amendment invokes to justify the second entry point; without
the test, a future ordering change can restore the exact cleanup pushback while
the ordinary explicit-stop and natural-result tests remain green.
