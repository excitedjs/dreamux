# Implementation review

## Inputs and coverage

- Task README: [`README.md`](README.md)
- Frozen requirement: [`requirement.md`](requirement.md), SHA-256
  `701f939ce8b8d309ee58224464b9183153578ea54a2fd535af84accbd3b5d887`
- Approved solution: [`technical-design/final.md`](technical-design/final.md),
  SHA-256
  `b9c070877832cc5aea9eb2ef936969d536887f8d39a116c804240d1ee0834ada`
- Ratified correction inputs after operator adjudication: requirement SHA-256
  `83f505e031f5a00236b42c808eb3fc954fbe3e0f290e9739ffa10a182543d04e`
  and final solution SHA-256
  `0fd4de0242e351459daaa208e5f1deabc6adba9956ee46a38e2d8accf5d10849`.
- Final architecture-correction inputs: requirement SHA-256
  `286ec6ccc55b25753a24ce0eee7696323d8b281166da0b0990ef5241f1f7d264`
  and final solution SHA-256
  `31935350993ec7391b56cb8b07cf18bb94e0387b70a5cce8e6116537f102dc68`.
- Review target: complete working tree relative to
  `fffc3bd337f8ce28070fb8658fc30893e71730bb`
- TeamLeader pre-review: full Dreamux suite, Rush build, lint,
  `typecheck:tests`, knowledge-base check, and `git diff --check` passed before
  review.
- Review method: one xhigh code-review workflow with all finders, verifiers,
  sweep, and synthesis complete. It produced 15 candidates, verified all 15,
  refuted 2 candidate instances, and reported 10 findings. No finder, verifier,
  sweep, or synthesis coverage failed.
- Additional operator-requested architecture consultation:
  [`technical-design/reviews/fable-architecture-consultation.md`](technical-design/reviews/fable-architecture-consultation.md).

## TeamLeader adjudication and operator ratification

No implementation correction was dispatched before the operator ruled on each
accepted group. The table records the final disposition.

| ID | Finding | Adjudication | Reason | Operator-ruling conflict |
| --- | --- | --- | --- | --- |
| IR-1 | Per-entity `stopForHost()` abandonment occurs after the Team/Dispatcher aggregate fence, so a Turn can start delivery while earlier teardown resources are still converging. The self-dissolve path exposes the same leader/member window. | Accept — blocking and ratified. | The event interleavings are reachable and directly violate the confirmed “全部丢弃” ruling at Team dissolve or service-restart start. The operator selected “采用栅栏语义 (Recommended)”. | No. The correction restores the ruling. |
| IR-2 | TeamMate `stopForHost()` also suppresses pending delivery during failed input-source startup rollback. | Finding accepted; blocker superseded by product ruling. | The original implementation stretched the earlier named scope. After the scenario and cost were explained, the operator selected “确认丢弃 (Recommended)”, explicitly adding failed-start rollback to the teardown boundary. | The requirement now authorizes the current rollback behavior. |
| IR-3 | Workflow `closeAdmission()`/`stopAll()` also suppresses terminal delivery during failed-start rollback, even though the initiating Dispatcher Agent survives and admission reopens. | Finding accepted; blocker superseded by product ruling. | The accepted Workflow can have no terminal answer after rollback. The operator explicitly accepted that narrow-window consequence by selecting “确认丢弃 (Recommended)” and rejected recovery or replay. | The requirement now authorizes the current rollback behavior. |
| IR-4 | Product documentation applies “stop wins” to both source types, although TeamMate retirement applies to every still-pending outcome at the teardown fence. | Accept — ratified documentation correction. | The wording can make a later maintainer restore completed/failed delivery after the boundary. The operator selected “同步更正 (Recommended)”. | No. |
| IR-5 | EntityTurn coverage proves a retired stopped outcome but not a retained Turn that completes or fails after the fence. | Defer by operator ruling. | The behavior remains required, but the operator selected “只测主路径” rather than adding the extra completed/failed matrix in this change. | No. Existing source-level obligation semantics remain authoritative. |
| IR-6 | Workflow coverage does not place an already-received natural terminal message behind a blocked runner-message tail while stop reserves first intent. | Defer by operator ruling. | The operator selected “只测主路径”; no additional queued-message test is added in this correction. | No. The first-intent source rule is unchanged. |
| IR-7 | Restart coverage creates a new Server and Service rather than proving that a future Turn on the same cached Service regains eligibility after a transient release/rollback. | Defer by operator ruling. | The operator selected “只测主路径”; no additional same-Service re-arm test is added in this correction. | No. The implementation must still re-arm future work correctly. |
| IR-8 | The amended draft links the current requirement while retaining only its pre-amendment hash. | Accept — ratified traceability correction. | The linked input and recorded digest must identify the same artifact. The operator selected “同步更正 (Recommended)”. | No. |
| IR-9 | Task and parent-index current state still say the Workflow amendment awaits implementation. | Accept — resolved by current-state bookkeeping in this review stage. | The implementation and all pre-review gates completed before the review. | No. |
| IR-10 | Workflow delivery is retained both in constructor deps and a mutable field while the pre-existing committed Boolean also participates in delivery retry bookkeeping. | Accept as in-scope refactor. | After the duplicate bookkeeping and risk were explained, the operator selected “本次重构”. The nullable closure becomes the only stored obligation; success clears it, failure leaves it retryable, and a local snapshot preserves no-retraction. | A late-status collapse remains prohibited; the accepted cleanup keeps first-intent causality. |

## Refuted candidate

The lifecycle integration tests intentionally identify completion input by the
canonical `task-notification` source rendering. The only Core completion path
uses that source and the suite also contains a positive delivery assertion, so
renderer drift would fail rather than silently hide an arbitrary extra input.
Replacing this with total input counts would mix unrelated valid provenance and
is not accepted.

## Ratified correction boundary

One correction should address IR-1 through IR-3 together:

1. Keep `EntityTurn` and `WorkflowRun` as the owners of their not-yet-started
   delivery obligations.
2. Keep explicit TeamMate close at its entity-local transition and explicit
   `workflow_stop` behind the existing first-terminal-intent arbiter.
3. Publish Team dissolve and Dispatcher shutdown delivery retirement
   synchronously at their aggregate lifecycle fences, before any teardown
   await.
4. Make later TeamMate admission and Workflow construction observe that same
   aggregate fact before acquiring an obligation.
5. Failed-start rollback remains an explicit retirement boundary for both
   source types. It converges runtimes and stopped Workflow records without
   recovery, replay, or terminal completion pushback.
6. Re-arm only future work after a transient release or failed dissolve; never
   restore an obligation already retired by a real teardown boundary.
7. Replace Workflow's duplicate closure reference and committed Boolean with
   its one nullable stored obligation while retaining delivery-failure retry and
   first-intent causality.

IR-4 and IR-8 accompany that correction as documentation. IR-5 through IR-7
remain deferred by the operator's “只测主路径” ruling; one aggregate-fence main-
path regression is required. IR-10 is included by explicit operator choice.

## Ratification status

Complete. The operator ruled on every finding group on 2026-09-08. Correction
is authorized within the boundary above. The corrected implementation completed
the required gates and both final independent reviews with no remaining blocker.

## Final architecture re-review

Fable's complete call-site re-review confirmed that the first aggregate-fence
correction fixed the delayed-settlement main path but found one remaining
blocker: `TeammateService.stopForHost()` re-armed its own delivery scope in
`finally`, even when that release was only one step inside a still-active
Dispatcher teardown. An already-admitted task could then restart the released
TeamLeader and begin a completion submission before the Dispatcher Agent was
stopped. The same review also identified asynchronous entity construction that
crossed an aggregate snapshot as the same boundary problem.

The correction keeps the approved source-owned obligations and moves re-arm to
the owner that knows the aggregate lifecycle outcome:

- per-entity host release abandons but never re-arms completion delivery;
- successful Dispatcher startup or completed failed-start rollback explicitly
  re-arms future work;
- collection-level population scopes cover current, reopening, constructing,
  and late-published TeamMate/Team services; and
- Team-local failed-dissolve re-arm cannot override a concurrently active outer
  Dispatcher fence.

Two deterministic integration paths now hold the aggregate fence open: one
settles existing direct/member/leader Turns behind an earlier Workflow stop,
and one lets an already-admitted task restart a TeamLeader after its first
release sweep. Both assert that the Dispatcher or TeamLeader receives no
completion input.

Fable's narrow follow-up found that unconditional `rearm()` could invalidate a
capture even when no fence had been lowered. Re-arm now does nothing while the
scope is already active, making `abandon()` the only operation that advances
the epoch. An operation that genuinely crossed a fence can re-arm only future
work after its own admission attached. Fable's final verdict is `ACCEPTABLE`.

## Final independent implementation re-review

The final implementation review found three remaining gaps and accepted their
correction:

- aligned leader restoration during a cold Team rebuild now captures the Team
  delivery scope before identity I/O and retires the restored leader before it
  can publish or submit when that capture crossed a fence;
- failed Team creation synchronously abandons the Team completion source before
  Workflow, leader, record, or worktree cleanup can await; and
- the admitted-task aggregate regression now names the actual Dispatcher Agent
  as completion initiator and observes that same runtime, while a direct
  TeamMate stop barrier keeps the recipient alive long enough to expose the old
  self-rearm defect.

The independent verdict is `ACCEPTABLE`; no correctness blocker remains.
