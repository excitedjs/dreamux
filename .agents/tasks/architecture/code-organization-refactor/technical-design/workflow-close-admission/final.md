# Refuse new Workflow TeamMate construction after owner close

## Requirement and authority

Selected by the TeamLeader on 2026-10-02 after three independent proposals
and one cross-review round (Codex, MiMo, DeepSeek). Source adjudication resolved
the async boundary, nested admission, error ordering, and terminal-status
claims; the choice is not based on reviewer votes.

This continues the code-organization task on the PR #453 branch after
[PR #460](https://github.com/excitedjs/dreamux/pull/460). R73's operator answer,
"停止新建", requires an already accepted Workflow to obtain admission for
each new TeamMate construction. If its Team or Dispatcher is already closing,
refuse before name allocation, workspace resolution, identity creation, or
the launch hook. Preserve construction admitted before close and its existing
stop, cleanup, lock handoff, and finalization.

R72, "不用保留", accepts onboard's existing unknown-wrapper-field rewrite.
No onboard implementation change or raw-document preservation mechanism is
selected. Provider-owned config contents and load-time tolerance retain their
existing contracts.

Development was explicitly approved on 2026-10-02 in response to the
development-authorization card against this final solution and Issue #461.
The task README records that evidence. The selected implementation and local
four-gate validation and independent review are complete. The
[verification record](/.agents/tasks/architecture/code-organization-refactor/technical-design/workflow-close-admission/verification.md)
distinguishes passing checks from uncovered concurrency and live behavior.

## Verified problem and ownership

`packages/dreamux/src/service/agent/index.ts:212` constructs a locked member
without entering the collection's existing admission owner. Dispatcher
Workflow compensates with an outer wrapper
(`service/dispatcher-service/index.ts:284`); Team Workflow receives its actual
collection directly (`service/team/service.ts:225`).

A Team dissolve publishes its task, then awaits the closed-record write
before requesting Workflow stop (`service/team/service.ts:591-653,752-757`).
A later Workflow step in that ordinary window currently allocates a name,
creates an identity, and runs launch construction before late publication
refuses it. R73 selects refusal at the construction request instead.

The greenfield shape has one public construction verb admitting through the
owner it already holds. Workflow owns the run and received handles; it does
not reproduce Team/Dispatcher closing policy. This is an adaptation of
`TeammateCollection`, not a new service or cancellation model. The prior R71
design intentionally deferred this exception; R73 supersedes it without
rewriting its history. PR #460's late lock-release repair remains intact.

## Selected implementation

1. Keep `TeammateCollection.createLocked` **async**, with the same arguments,
   default options, and promised handle. Invoke `this.opts.fence.admit`
   directly in that method's synchronous prologue, putting the existing
   construction-and-lock body inside its async task. Select the inline body
   because this change needs no additional private method.
2. Pass `teammates: this._teammates` directly to Dispatcher `WorkflowService`.
   Delete its outer object and forwarding closure in the same change.
3. Update the adjacent `WorkflowTeammateFactory` comment in
   `service/workflow-service/types.ts`; keep its narrow interface unchanged.
   Team wiring already passes the actual collection and needs no edit.

Keeping public `async` turns owner refusal into a rejected Promise, as the
current collection method promises. The owner check itself remains
synchronous. Removing the outer wrapper prevents a second check in a later
microtask from retracting an already admitted construction.

Entropy account: remove the Dispatcher-only factory object, forwarding
closure, and two-scope exception. Reuse one existing admission operation.
Add no owner, type, close flag, persisted fact, retry, timeout, or queue. The
inline task is a call-scoped admission operation, not a stored parent-state
supplier. A private admitted helper would also be valid, but is unnecessary
for this selected implementation.

## Behavior and concurrency boundaries

| Construction request | Result |
| --- | --- |
| Team is closing or closed | Existing `TeamService.admit` refuses first with `TeamClosedError`; no new TeamMate construction effects. |
| Team is open and Dispatcher is closing | Existing Dispatcher admission refuses with `ServerShuttingDownError`. |
| Dispatcher-scoped owner is closing | Same early Dispatcher refusal currently supplied by its wrapper. |
| Owners admit before close | Existing allocation/build tracking and late-publication check continue; an unhanded lock is undone on publication failure, and a received handle belongs to Workflow finalization. |

The newly early Team error is an observable change from the old late,
Dispatcher-worded refusal. Do not translate it into the wrong owner's error.
Preserve `assertOpen`'s current precedence: a dissolve task reports closing
even after the closed write; closed wording applies when that task is absent.
The distinct late-publication error stays unchanged for admitted builds.

Admission is decided at the owner's synchronous check. Do not recheck before
allocation merely because the admitted task starts after close. Keep the
collection's allocation tracker, materialization map, publication undo, and
Workflow's materialization join unchanged. The new Team-scope admitted-work
span ends at construction/handle handoff, not a native turn. Awaited launch
taps have no completion-time guarantee; R73 adds no timeout or cancellation.

Workflow may already have written its own call row before requesting member
construction. Its current catch records stopped if a terminal intent exists,
otherwise failed, and releases the slot. Run terminal intent remains
first-wins; this refusal does not guarantee a stopped run or override an
earlier completed/failed intent. Keep R67 dissolve order, the two host sweeps,
completion suppression, queued delivery, and member workspace policy intact.

## Delivery and verification

One source writer implements the two behavioral edits and one comment edit.
The TeamLeader updates the product/Workflow admission knowledge and task
status, annotates the superseded R71 exception, and records R72's accepted
onboard behavior. Unrelated architecture findings and inherited Feishu bugs
are outside this continuation. No config or persisted-file schema, path, or
meaning changes; no migration or maintenance-state rewrite is required.

Use one ordinary `@excitedjs/dreamux` minor Rush change note. No `BREAKING:`,
`Rebuild:`, or major bump. Deliver a reviewed child PR into the PR #453 branch
under the existing delivery ruling; this does not authorize merging #453 to
`next`.

Run build, lint, test, and `typecheck:tests` through
`node common/scripts/install-run-rush.js`, plus `.agents/scripts/check.sh`
and the diff check. Independently review the complete implementation and its
preserved lock/terminal/close paths. R43 still forbids new or repaired child
unit tests; no deletion is predicted, and source regressions must not be
hidden by deleting assertions.

The surviving runner suite does not prove construction admission. Final
PR #453 coverage must exercise actual owner fences and observe: both-scope
refusal before allocation/identity/hooks; Team-before-Dispatcher errors and
Promise rejection; close immediately after admission without a second gate;
late-publication lock release and successful handle finalization. Preserve
the separate high-risk #63 coverage obligation. Controlled local acceptance,
if available, must be reported separately from live-provider E2E. No gate,
probe, or live validation was run during consultation. Current delivery
evidence is in the verification record; consultation is not validation.

Consultation evidence lives under the task's
`technical-design/workflow-close-admission/`: `proposals/codex.md`,
`proposals/mimo.md`, `proposals/deepseek.md`, `source-audit.md`, and
`adjudication.md`. This local final file is the durable solution; the public
solution-review Issue mirrors it for operator review.
