# R73 Workflow construction admission: independent proposal (DeepSeek)

## Status and authority

- Active requirement: [product decisions, 2026-10-02, revision 1](/.agents/tasks/architecture/code-organization-refactor/artifacts/product-decisions-20261002.md), R73: "停止新建".
- Authority reading: [`rulings.md`](/.agents/tasks/architecture/code-organization-refactor/rulings.md) (R72/R73 block, R62/R67, R69/R71, R10).
- Requirements baseline for this proposal: `.agents/` worktree of the code-organization task, task record at [`README.md`](/.agents/tasks/architecture/code-organization-refactor/README.md).
- Source baseline: `feat/plugin-system-mvp` after the [PR #460](https://github.com/excitedjs/dreamux/pull/460) merge. PR #460's late-publication lock
  release is already in the source; it is **not** an open item.
- Prior design consulted as evidence: [`technical-design/data-flow/final.md`](/.agents/tasks/architecture/code-organization-refactor/technical-design/data-flow/final.md), section 1 and its
  entry-fence table. Its last two rows deliberately preserved the construction-admission asymmetry "pending a product
  ruling". R73 settles that specific exception; this proposal does not re-litigate the rest of that solution.
- This file is a proposal only. No source, tests, prototypes, other task/KB files, or GitHub were touched. This author
  did not read another current proposal in this round.

## 1. User story (stated before the contract)

A Workflow run that its owner already accepted keeps driving its steps. When one of those steps is about to construct a
new TeamMate, and the owning Team — or, for a dispatcher-level run, the Dispatcher — has already begun closing, the run
must not build that TeamMate at all: no workspace checkout, no identity record, no plugin launch hook. The owner is
tearing down, so every token such a TeamMate would spend is wasted. A step whose construction was already admitted
before the close keeps today's behavior exactly: it finishes building, and the owner's existing stop, finalization, and
lock handoff handle it.

## 2. Current-source evidence (who actually admits today)

All paths are under `packages/dreamux/src` unless noted.

| Site | Fence it crosses | Source |
| --- | --- | --- |
| `TeammateCollection.spawn` | `this.opts.fence.admit(...)` | `service/agent/index.ts:187` |
| `TeammateCollection.send` / `.close` / `.list` / `.status` / `.history` / `.last` / `.getCapabilities` | `this.opts.fence.admit(...)` | `service/agent/index.ts`, same file, one per verb |
| `TeammateCollection.createLocked` | **none** — goes straight to `createFreshEntity` | `service/agent/index.ts:212` |
| `TeammateCollection` late-close guard, after publish | `this.opts.fence.isClosing()` read only | `service/agent/index.ts:772` (`selfCloseIfClosing`) |
| Dispatcher Workflow factory | wraps `createLocked` in `this.fence.admit(...)` | `service/dispatcher-service/index.ts:284-289` |
| Team Workflow factory | passes the raw collection: `teammates: this.teammateCollection` | `service/team/service.ts:228` |
| Workflow step construction | `this.deps.teammates.createLocked(...)` | `service/workflow-service/run.ts:481` |
| Workflow run creation | `this.opts.fence.admit(...)` (already fenced) | `service/workflow-service/index.ts:101` |
| `TeamService` as a `WorkAdmission` | `admit` = `assertOpen()` then `deps.fence.admit` | `service/team/service.ts:552-570` |
| `WorkFence` (dispatcher) | `admit` = synchronous `assertOpen()` then `work.track` | `platform/work-fence.ts:21-31` |
| The collection's bound owners | dispatcher collection: `fence: this.fence`; Team collection: `fence: this` | `service/dispatcher-service/index.ts:247`; `service/team/service.ts:218` |

Two facts decide the design:

1. `createLocked` is the **one** public collection verb that does not cross its owner's fence. Its own doc comment
   explains that the omitted gate is a *capability* gate (output-schema support), not the admission fence — so the
   un-gated admission is an oversight in an otherwise uniform verb family, not a deliberate admission policy.
2. The documented model in [`packages/dreamux/src/service/CLAUDE.md`](/packages/dreamux/src/service/CLAUDE.md)
   says member/Workflow work "receive[s] the Team itself as their fence: Team check first, then dispatcher admission".
   That is true for run creation and for `spawn`/`send`/`close`, and false for the Workflow's own agent construction.

So the two scopes are asymmetric exactly as R71's design recorded:

- **Team scope** today: no admission at all. `createFreshEntity` allocates the name, resolves the workspace, runs the
  overlap check, creates the identity, runs the `teammateLaunch` hook, and builds the Agent; only then does
  `selfCloseIfClosing` stop the runtime and throw. Workspace, identity, and launch hook all happen *after* the owner
  began closing — precisely what R73 forbids.
- **Dispatcher scope** today: the inline wrapper refuses up front, but it duplicates a check the collection's own fence
  would perform, and it leaves the underlying verb ungated for the Team's raw-collection path.

## 3. Authoritative owner

The object that owns "am I closing" is the same object the collection already holds as
`TeammateCollectionOptions.fence` (a `WorkAdmission`). The collection admits through it for eight of its nine public
verbs. A Workflow run is a **caller** of construction; it must not re-derive or re-check the owner's closing fact, and
neither may the two factory suppliers. The fix therefore belongs at the collection verb, once, not at the Workflow and
not at two suppliers.

This also corrects the inherited boundary: the previous solution kept two different shapes for one capability (an
outer wrapper in one scope, a raw path in the other). R73 removes the need for both shapes.

## 4. Selected approach

Make `createLocked` cross the same owner fence as every sibling verb, and delete the now-duplicated dispatcher wrapper.
No new type, flag, phase, entity, or cancellation model is introduced.

### 4.1 Exact edits (two source files)

`service/agent/index.ts`

```ts
createLocked(
  input: SpawnTeamMateInput,
  options: CreateLockedTeammateOptions = {},
): Promise<LockedTeammate> {
  return this.opts.fence.admit(() => this.createLockedAdmitted(input, options));
}

private async createLockedAdmitted(
  input: SpawnTeamMateInput,
  options: CreateLockedTeammateOptions,
): Promise<LockedTeammate> {
  // existing body, unchanged, including the lock-handoff comment
}
```

This mirrors the file's own dominant convention (`spawn`/`spawnAdmitted`, `send`/`sendAdmitted`, `close`/
`closeAdmitted`, `status`/`statusAdmitted`, `history`/`historyAdmitted`, `last`/`lastAdmitted`). An inline arrow inside
`admit` is behaviorally identical; the named split is recommended only for consistency with the surrounding verbs.

`service/dispatcher-service/index.ts`

```ts
teammates: this._teammates,
```

Delete the inline `createLocked: (spawnInput, options) => this.fence.admit(() => this._teammates.createLocked(...))`
wrapper. The dispatcher's collection is already constructed with `fence: this.fence`
(`service/dispatcher-service/index.ts:247`), so the verb performs exactly the same check. Keeping the wrapper would
double-admit the same span into the fence's in-flight set — harmless but redundant, and it would keep the verb's
admission contract split across two places.

### 4.2 Resulting end-to-end admission and close behavior

| Scope | Fence crossed by `createLocked` | Refusal, before construction | Admitted-then-close |
| --- | --- | --- | --- |
| Dispatcher-level Workflow | dispatcher `WorkFence` | `ServerShuttingDownError` (dispatcher) | unchanged: `selfCloseIfClosing` stops the built runtime after publish |
| Team-level Workflow | `TeamService`, then dispatcher `WorkFence` | `TeamClosedError` (Team closing/closed), then `ServerShuttingDownError` (dispatcher) | unchanged: `selfCloseIfClosing` stops the built runtime after publish |

The dispatcher row is a move, not a change: the wrapper already performed exactly this `WorkFence.assertOpen()` check
on the same span. The Team row is the R73 fix: the Team is checked first, then the Dispatcher, matching the order every
other Team-scoped entry point already uses, and both checks now run **before** any construction work.

### 4.3 Why the refusal precedes allocation

`WorkFence.admit` runs `assertOpen()` synchronously before scheduling the task, and `TeamService.admit` runs
`assertOpen()` synchronously before delegating to the dispatcher fence. The refusal therefore happens in the same
synchronous turn as the `createLocked` call, ahead of `createFreshEntity`'s name allocation, workspace resolution,
overlap check, identity create, launch hook, and build. That is the R73 boundary, with no extra check written.

## 5. Concurrency and lock handoff

Three windows, all preserved:

1. **Owner already closing before the call** → refusal inside `admit`; nothing is allocated. (New for the Team scope;
   already true for the dispatcher scope.)
2. **Owner closes after admission, before publish** → unchanged. The admitted call is tracked by the fence's
   `InFlightWork`, so the owner's `drain()` joins it; `selfCloseIfClosing` (`service/agent/index.ts:772`) stops the
   runtime it built and throws; `createFreshEntity`'s `undo()` releases the lock taken by `beforePublish`. The
   collection's `materializations`/`inFlight` tracking and `WorkflowRun.finalize`'s `materializations.drain()` plus
   handle close are untouched.
3. **`TurnAdmission` semantics** (submit path) are untouched — this change never enters the runtime boundary.

Lock-handoff invariant is unchanged: `createLocked` returns a `LockedTeammate` only on success. A refusal — the new
up-front one or the existing late `selfCloseIfClosing` — never yields a handle, so ownership of the lock never passes
to a failed call.

Runtime note: `createLocked` never starts a runtime; the runtime starts on `handle.submit` in
`WorkflowRun.executeAgent`. So the only thing the new Team-scope fence tracking adds to the owner's in-flight set is a
bounded disk-I/O span (name allocate + identity write), which is strictly shorter than the already-tracked Team-scoped
`spawn` span that does start a runtime. `DispatcherLifecycle.doClose` already sweeps runtimes *before* draining admitted
work for exactly that class; no ordering change is needed.

Stop-and-reclaim is unchanged: `TeamService.destroyChildren` still stops Workflows first, and
`WorkflowService.stopAll`/`requestStopAll` still reserve the `stopped` intent. The up-front Team refusal only makes
`executeAgent` fail sooner, inside its existing `catch`, which records the step `stopped` when the run's terminal was
already requested and `failed` otherwise.

## 6. Minimal change and deletion boundary

Removed:

- the dispatcher-scoped inline `createLocked` wrapper closure (one construction-time mechanism);
- the "one collection verb that skips admission" special case;
- the deferred Team-vs-Dispatcher construction-admission asymmetry carried by the previous design.

Added:

- one `fence.admit` crossing on `createLocked`, identical to the eight sibling verbs (an existing mechanism, not a new
  one), and a private `createLockedAdmitted` split for naming consistency.

Nothing else changes: no persisted file, no config shape, no MCP tool or Command, no CLI surface, no
`WorkflowTeammateFactory` / `TeammateCollection` / `LockedTeammate` type change, no new close flag or cancellation
model.

## 7. Compatibility

- **Persisted state/config:** unaffected.
- **Public contracts:** `WorkflowTeammateFactory`, `TeammateCollection.createLocked`, `LockedTeammate`, and all
  Commands/MCP tools keep their shapes. Deleting the dispatcher wrapper is internal.
- **Error contracts:** the dispatcher scope keeps `ServerShuttingDownError` unchanged. The Team scope now refuses with
  `TeamClosedError` (Team closing or closed) before `ServerShuttingDownError` (dispatcher closing) — the exact
  Team-then-Dispatcher contract every other Team-scoped child entry point already has through `TeamService.admit`
  (`service/team/service.ts:552-570`). This is what "the existing error contracts" names.
- **One real message delta, stated explicitly:** a Workflow step racing its **Team's** dissolve previously failed with
  `dispatcher '<id>' is shutting down`; it will now fail with `Team '<id>' is closing`. The class changes from
  `ServerShuttingDownError` to `TeamClosedError`. The old string was already wrong for a Team-triggered refusal. Both
  outcomes land in `WorkflowRun.executeAgent`'s existing `catch` and end the step as stopped/failed; neither error
  reaches MCP/CLI directly, and the run journal carries only the message text. See section 9; this is the single open
  micro-question.
- **Change note:** an ordinary note for `@excitedjs/dreamux` describing the admission tightening. Not `BREAKING:` — no
  persisted file becomes unreadable and no manual rebuild is required.

## 8. Verification mapping (R43)

R43 governs this child PR: no new unit tests, no repaired tests, no deleted tests. The four gates still run after the
complete implementation: `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.

Evidence to produce instead of tests:

- whole-diff structural account: the deleted wrapper, the new fence crossing, the moved body;
- a call-path trace for both scopes showing `assertOpen()` executes before `createFreshEntity` allocates anything;
- a repository search over `packages/dreamux/tests` confirming nothing references `createLocked`, Workflow construction
  admission, or the refusal error classes, so this change introduces no test incompatibility. If a real incompatibility
  appears, report it rather than delete a test to hide it (R43 does not authorize deleting a test to conceal a
  regression);
- documentation: `packages/dreamux/src/service/CLAUDE.md`'s "member/Workflow work receive the Team itself as their
  fence" statement becomes true for Workflow agent construction too; the deferred-asymmetry note in
  `technical-design/data-flow/final.md` and the "TeamLeader member and Workflow mutation" phrasing in
  `.agents/domains/dispatcher-orchestration.md` should be re-stated as settled by R73; then run
  `.agents/scripts/check.sh`. (The TeamLeader/implementer owns `.agents` writes; this proposal does not write them.)

Coverage limit to state: no gate run proves the live close-vs-construction race; the evidence for that is the source
trace above, not a green test suite.

## 9. The one genuinely unsettled requirement

Whether "preserve the existing error contracts" means the literal refusal string/class, or the
Team-then-Dispatcher refusal contract that every other Team-scoped entry point already uses.

- If it means the **contract** (recommended): route through `TeamService.admit` → `TeamClosedError`-then-
  `ServerShuttingDownError`, and record the message delta in section 7 as an accepted, stated change.
- If it means the **literal string** (`dispatcher '...' is shutting down` for a Team-triggered refusal): the Team path
  would need a bespoke up-front check that re-implements the fence's own fact, because the dispatcher fence's
  `ServerShuttingDownError` cannot be produced by the Team's own `assertOpen`. The engineering whitepaper's minimal-
  mechanism rule (whitepaper sections 1 and 3) makes that the worse option, and it is a product decision rather than a
  refactor side effect.

Recommendation: adopt the first reading. If the operator considers the literal refusal string a locked contract, that
is a product decision to confirm before implementation.

## 10. Rejected alternatives

- **(A) Mirror the dispatcher wrapper inside `team/service.ts`** (`createLocked: (i, o) => this.admit(() => this.
  teammateCollection.createLocked(i, o))`). Smallest textual edit, but it patches the hole at one call site, leaves
  `createLocked` as the only un-fenced collection verb (a latent trap for the next reader), duplicates an admission
  wrapper the collection already owns, and keeps the dispatcher wrapper. Added mechanism, less-obvious invariant.
- **(B) Check the owner inside `WorkflowRun.executeAgent` before `createLocked`.** Puts owner admission policy in the
  Workflow layer, which owns neither the Team's nor the Dispatcher's closing fact, and must be duplicated per scope.
- **(C) A second close flag / cancellation model.** Banned by R73.
- **(D) Add an explicit `this.opts.fence.isClosing()` early return inside `createLocked`.** `WorkAdmission` exposes
  `isClosing()` as a read for producers, not as a gate; using it as a gate re-implements what `admit` owns, skips the
  in-flight tracking that makes the owner's `drain()` correct, and creates a second place that must stay right.
- **(E) Move the check immediately before `createFreshEntity` inside the collection, leaving the verb ungated.** Same
  product outcome, more code, and the dispatcher wrapper survives.
- **(F) Tighten `WorkflowService.run` admission.** The run is already fenced
  (`service/workflow-service/index.ts:101`); the missing span is the later agent construction, so this fixes nothing.

## 11. Ownership and delegation

- Producer of the closing fact: the dispatcher `WorkFence`, or `TeamService` for a Team-scoped run.
- Consumer of the refusal: `TeammateCollection.createLocked`, on behalf of the Workflow run.
- Who must not learn it: `WorkflowRun`/`WorkflowService` must not know whether a Team or a Dispatcher is closing; the
  `agent/` module must not import Team errors (it does not — the error is raised by the injected fence object).
- One source writer implements the two-file change; the TeamLeader owns `.agents`, commits, and the child PR into the
  PR #453 branch. Independent review verifies the whole diff against this proposal and the source contract.

## 12. Cross-review round (single round, 2026-10-02)

Read for this round: [codex.md](codex.md), [mimo.md](mimo.md), this file's first round, the
[source audit](../source-audit.md), and the active requirement and rulings. The TeamLeader's adjudication file was
not read, so this is my own evaluation of the three proposals. Sections 2 through 11 above are preserved as the
first-round record; their superseded points are named in 12.3 and 12.5.

Citation hygiene: the bare commit hash that stood in "Status and authority" is normalized above to the
[PR #460](https://github.com/excitedjs/dreamux/pull/460) link, and this section cites PR numbers, not hashes.

### 12.1 Convergence

All three proposals independently select the same change, and each derives it from the same two source facts — the
collection's own "Every public verb enters this owner" option contract, and `TeamService.admit` composing
Team-then-Dispatcher refusal — rather than from a shared premise:

1. `TeammateCollection.createLocked` enters `this.opts.fence.admit(...)` like its eight sibling verbs.
2. The dispatcher's inline `createLocked` wrapper is deleted; both scopes pass their collection itself.

They also reject the same family of alternatives (Team-side wrapper, a Workflow-layer check, a second close
flag/cancellation model, an unconditional `finally { unlock() }`). The round is therefore about the refinements
below, not about choosing a design.

Review note for the TeamLeader: [codex.md](codex.md) lines 14, 55, and 62 and [mimo.md](mimo.md) line 21 still carry
bare commit hashes that the repository checker will want as PR links (PR #460, PR #459). This file is normalized.

### 12.2 The named source checks

**(a) Public async rejection boundary — Codex is right; I revise.** `WorkFence.admit` and `TeamService.admit` call
`assertOpen()` synchronously, before they return a promise (`platform/work-fence.ts:29-31`;
`service/team/service.ts:552-555`). The new early refusal is therefore a synchronous throw out of `admit`. Today
`createLocked` is `async`, so every failure at that method boundary is a rejected promise. My first-round shape
(non-async `createLocked`, mirroring `spawn`) would turn the R73 refusal into a synchronous throw at a method typed
`Promise<LockedTeammate>`; MiMo proposes the same shape. Codex's shape preserves the existing boundary at zero cost.
Keeping `async` does not delay the check: `this.opts.fence.admit(...)` is still evaluated in the async function's
synchronous prologue, so `assertOpen()` still runs inside the caller's statement, before any construction. Revised
shape:

```ts
async createLocked(
  input: SpawnTeamMateInput,
  options: CreateLockedTeammateOptions = {},
): Promise<LockedTeammate> {
  return this.opts.fence.admit(() => this.createLockedAdmitted(input, options));
}

private async createLockedAdmitted(/* unchanged body, lock handoff included */) {}
```

This keeps both Codex's guarantee and the file's `xAdmitted` naming. The deliberate divergence from `spawn`'s
non-async shape is stated, not silent: preserving `createLocked`'s method contract outranks mirroring `spawn`, and
converting `spawn` is out of scope.

**(b) One admission versus nested admission — Codex and MiMo correct my first round.** My first round called a
surviving wrapper "harmless but redundant". That is wrong. `WorkFence.admit` schedules its body as
`Promise.resolve().then(task)` (`work-fence.ts:29-31`), one microtask later. If the wrapper survived *and*
`createLocked` admitted, an outer `admit` could pass and the inner `assertOpen` could then fail once the close
raises the fence in that gap — refusing work the outer fence had already accepted. That is the boundary-3 case
("construction admitted before close retains the existing … behavior"). Deleting the wrapper is required for
correctness, not only for entropy. I withdraw "harmless".

**(c) Newly early owner errors versus unchanged late-publication errors — closed, not open.** The source audit
settles what my §9 had left open. Early Team refusal is `TeamClosedError` (`TEAM_CLOSED`,
`Team "…" is closing|closed`) from `TeamService.assertOpen`; early Dispatcher refusal is `ServerShuttingDownError`
from `WorkFence.assertOpen`, the same class and message the deleted wrapper raised, so the dispatcher scope is
unchanged; late publication of an already-admitted build keeps `selfCloseIfClosing`'s existing
`ServerShuttingDownError` wording, including its Dispatcher naming in Team scope. R73's "preserve the existing
error contracts" is satisfied by using each owner's own refusal error at the newly selected earlier boundary, and
the early Team refusal must be reported as a real observable (it previously produced the late, Dispatcher-worded
error), not sold as identical behavior. I therefore withdraw §9 as an open question.

**(d) No time-bound guarantees for awaited launch taps.** R73's "before … running its launch hook" is a precedence
guarantee for the early refusal only: `admit`'s `assertOpen` runs before `createFreshEntity` reaches
`teammateOptions`/`composeLaunchDraft`, so no hook *starts* for a refused request. It is not a guarantee about a
hook already running. The hook is awaited inside an admitted build with no cancellation, so a close during the hook
is caught only by the existing late `selfCloseIfClosing` path — it is not interrupted, and no ordering may be
asserted against the hook's completion. Separately, `launchDraftTaps` isolates a throwing or rejecting tap
(`plugin/hooks.ts:456-496`: `reportSkipped` then `return`), and `composeLaunchDraft` never rejects its hook; a
rejecting launch tap is not a reachable construction-failure trigger and must not appear as race coverage (Codex's
V6 warning). My §5 lists the launch hook among the pre-construction side effects that the early refusal precedes,
which is correct; the boundary itself is made explicit here.

**(e) Must a run always end `stopped` when a Team-close construction fails before Workflow stop reserves its
terminal intent? No.** `WorkflowRun.executeAgent` classifies a caught construction error by `terminalRequested`
(`workflow-service/run.ts:539-543`): `stopped` if a terminal intent is already reserved, otherwise `failed` with
the owner's message. A Team dissolve publishes `dissolveTask` — the fence — at `service/team/service.ts:602`, then
`runDissolve` writes `closed` and only later reaches `destroyChildren` → `workflowService.stopAll()`
(`service/team/service.ts:755`). A refusal inside that window records the agent row `failed` with
`Team "…" is closing`, while the dispatcher scope, whose `DispatcherLifecycle.close` raises the fence and calls
`workflows.requestStopAll()` in the same synchronous tick (`dispatcher-service/lifecycle.ts:90-108`), records
`stopped`. The run's own terminal is `stopped` in both cases. Forcing a uniform `stopped` row would make the run
rephrase a foreign owner error into its own classification, and R73 does not ask for it; accept Codex's V8 and
MiMo's inference, and state the per-row observable in the completion report so it is not mistaken for a
regression.

### 12.3 Independent evaluation of each proposal

**Codex** agrees on the selected change. Accepted additions: the async-retention rationale (a) — which supersedes
my and MiMo's non-async shape; the sharp nested-admission rejection (b); the four-row early-refusal error table;
the V6 warning against fabricating a rejecting launch tap; and the owed comment fix in
`service/workflow-service/types.ts:9-12`, whose current text names the wrapper being deleted. Nothing substantive
rejected. Its V1–V10 table is accurate but wider than this narrow change needs; I do not re-adopt its headings.
Its "no unsettled R73 product requirement" conclusion matches mine once (c) is resolved.

**MiMo** agrees on the selected change. Accepted additions: the error contract table with codes
(`TEAM_CLOSED` / `SERVER_SHUTTING_DOWN`); the statement that the construction tracking span ends at handle
creation, matching the source audit's boundary; the derived `failed`-versus-`stopped` inference (e); and the named
knowledge delta, including a one-line `.agents/product/README.md` entry for the user-visible refinement. Revised:
dropping `async` from `createLocked` is superseded by (a). Its §6 "Team-scope tracking side effect (accepted)" is
correct and should be stated as *new* Team-scope tracking on the dispatcher fence; the source audit's "construction
tracking must end at handle creation" boundary already bounds it, so it adds no hazard.

**DeepSeek (this file, first round)** — superseded points are the non-async `createLocked` in §4.1 (revised by
(a)), the "harmless but redundant" characterization of a surviving wrapper (withdrawn by (b)), and §9's open
question on the Team-close error string (closed by (c)). Retained as still correct: the two-file minimal boundary,
the three-window concurrency table, the `selfCloseIfClosing` and lock-handoff preservation argument, the R43
evidence plan with its "no gate run proves the live race" coverage limit, and the rejected-alternatives list.

### 12.4 Revised position

Adopt the converged design with Codex's async-retention refinement:

1. `service/agent/index.ts`: keep `createLocked` `async`; its body becomes `this.opts.fence.admit(() =>
   this.createLockedAdmitted(input, options))`; move the existing body, lock handoff included, to the private
   `createLockedAdmitted`.
2. `service/dispatcher-service/index.ts`: `teammates: this._teammates`; delete the wrapper.
3. `service/workflow-service/types.ts`: comment-only update to the `WorkflowTeammateFactory` doc.

Error behavior: early Team `TeamClosedError`, early Dispatcher `ServerShuttingDownError`, late publication
unchanged `ServerShuttingDownError`, with the early Team refusal recorded as a real observable change. No source,
test, prototype, or knowledge file is written by this proposal.

### 12.5 Unresolved material disagreement

None. The one first-round divergence between the three authors — async versus non-async `createLocked` — is resolved
in favor of Codex by the source evidence in (a), and I revise accordingly. Two derived observables remain, both
consequences of the existing catch and the settled error contracts rather than open product questions: the early
Team refusal's message/class, and the `failed` agent row inside the pre-stop dissolve window. If the operator later
wants a uniform `stopped` row or the legacy literal string, that is a separate product ruling and does not block
this change.

### 12.6 Correction (2026-10-02): withdraw the unconditional run-terminal claim

Section 12.2(e) correctly answers "No" to "must a run always end `stopped`", but one sentence in it is wrong and is
withdrawn: "The run's own terminal is `stopped` in both cases." The Workflow run's terminal is **first-intent
wins**. `run.ts:118-120` declares `terminalIntent` as "Set once, by whichever of `reserveStop`/`requestTerminal`
wins"; `reserveStop` (`run.ts:266-278`, reached via `requestStop` at `:244-246`) is a no-op once
`terminalIntent !== null` or the record no longer says `running`, and `requestTerminal` (`run.ts:284-294`) reserves
`completed`/`failed` only while `terminalIntent === null`. A Team-close construction refusal can reach the runner
inside the pre-`stopAll` window, so a natural terminal intent — an observed runner exit via `observeTerminal`
(`run.ts:298`) or a run-level error at `run.ts:229` — can be reserved before `TeamService.destroyChildren` reaches
`workflowService.stopAll()`; the later stop reservation is then a no-op and the run's terminal is that natural
intent, not `stopped`.

Consequences: the answer to (e) and the non-blocking conclusion are unchanged (no design or requirement choice
follows), but two phrasings are narrowed. The dispatcher scope's *ordering* claim still holds — `DispatcherLifecycle.close`
raises the fence and calls `workflows.requestStopAll()` in the same synchronous tick (`dispatcher-service/lifecycle.ts:90-108`),
so the (e) window does not exist there — yet the run's terminal there too is whichever intent was reserved first. And
the agent-row observable in (e) and 12.5 is likewise governed by first-intent arbitration at the catch point
(`workflow-service/run.ts:539-543`): `stopped` only when an intent is already reserved, otherwise `failed`; it is a
timing-dependent derived observable, not an unconditional outcome.
