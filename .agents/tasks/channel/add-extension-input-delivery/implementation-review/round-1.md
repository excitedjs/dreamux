# Implementation review, round 1

## Coverage

The xhigh workflow completed with complete coverage and no failed seat. Seven
finders produced nine candidates; four source-location verifiers returned nine
verdicts. The second-tier sweep and synthesis completed. The report consolidated
four findings, all classified CONFIRMED, with no refuted candidate. Reviewers read
source and guidance without repeating the TeamLeader runtime or static gates.

## TeamLeader adjudication

This table records source-based adjudication before any correction is assigned.
The original per-item request was paused for a historical-ruling lookup. After
that lookup was reported, the operator instructed continuation on 2026-10-10.
The bounded corrections below restore the already approved behavior and test
acceptance; they do not change the public API or approved user stories.

| ID | Finding and source | Disposition | Concrete reason and bounded action | Conflicts with an operator ruling? |
| --- | --- | --- | --- | --- |
| R1 | Caller metadata with an own `__proto__` key is lost; `feishu-extensions.ts:325`. | Accept | The helper assigns dynamic keys onto a plain object. Core deliberately reconstructs attrs with `Object.fromEntries` to preserve this valid key. Filter entries and reconstruct them without invoking the inherited setter; add a metadata-preservation regression assertion. This fixes actual payload loss without adding validation or a new mechanism. | No: the final solution requires caller business metadata to survive. |
| R2 | The timer test assumes binding commits before its first 50ms tick; contract test:492. | Accept | The interval starts before the awaited route write. A tick during that write correctly refuses and sends no command, while the test requires the first tick to submit and counts all ticks as submissions. Make observations distinguish pre-binding refusals from bound submissions without changing the product timer or adding sleeps. | No: actual timer delivery remains required; timer ordering was never promised. |
| R3 | Domain still says the instance API has no input delivery; `channel.md:1732`; product catalog not yet updated. | Defer to mandatory knowledge closeout | The stale statement is real, but current domain/product reconciliation is already assigned to the TeamLeader after implementation review and accepted corrections by `knowledge-closeout.md`. It is a before-PR deliverable, not a newly discovered runtime defect or developer-owned omission. Complete both owners in that stage and verify no opposite statement remains. | No: final solution explicitly includes these documentation updates. |
| R4 | A failing contract-test assertion can bypass session close and leave the new interval alive; contract test:82. | Accept | The new fixture's afterEach restores mocks and removes the directory without closing created sessions. Register created sessions and close them unconditionally before restoring mocks/removing storage, following the adjacent tool-session fixture. This is cleanup of owned test resources, not product recovery machinery. | No: lifecycle acceptance requires timers to stop when their owner closes. |

## Verified premises

- R1: `deliveryAttrs` writes `fields[name] = value` into `{}`. The owning Core
  boundary in `service/agent/channel-submission.ts` explicitly preserves own
  `__proto__` entries with `Object.fromEntries`; this is an open string-key
  contract, not an unsafe object value or a speculative security scenario.
- R2: `inputExtension.start` starts the interval, `startedSession` returns, then
  the test awaits `bindGroup`. Routing commits only after asynchronous storage.
  Waiting for binding does not stop an already running interval.
- R3: the channel-domain instance-api paragraph contradicts the new API. The
  task is still in review, before its prescribed knowledge-closeout stage, so
  this work remains tracked rather than being reported as already complete.
- R4: the interval is cleared only by extension close. The first failed
  assertion skips the test body's explicit close. The existing adjacent
  `helpers/feishu-tool-session.ts` demonstrates unconditional session cleanup.

## Initial assignment status before historical lookup

The same developer would own R1, R2 and R4 in the existing source/test files;
no public signature, Core, routing, presentation or lifecycle model changes.
The TeamLeader would own R3's domain/product reconciliation during closeout.
At that checkpoint no correction had been dispatched. The original question
was paused for the historical lookup below; the later continuation records the
bounded source/test authority actually used.

## R1 historical-ruling reconciliation

The operator challenged the first ratification question as potentially repeated
and asked the TeamLeader to inspect task and decision records. This message is
an investigation request, not an instruction to dispatch corrections.

The task record confirms the same JavaScript data-loss mechanism was reviewed
and settled before:

- [Redact tool call arguments and invocations](/.agents/tasks/channel/redact-tool-call-arguments/README.md),
  under Rulings during implementation, records the 2026-09-11 sequence. The
  operator initially said "Activity这个场景不需要考虑原型链". After the demonstrated
  own-property loss was explained, the recorded final ruling was
  "行吧，那你按照你说的那个更简单的办法改了吧". The approved write shape was
  `Object.fromEntries`, with no prototype-chain guard. Delivery was PR #412.
- The current owning redaction source still uses `Object.fromEntries`; its
  regression tests retain string- and object-valued own `__proto__` properties.
  The original fix has not disappeared.
- Core's current `service/agent/channel-submission.ts` independently uses the
  same construction for open string-key submission attrs and explicitly
  explains own `__proto__` preservation. Git history traces this implementation
  to [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md),
  delivered in PR #444; later relocation retained the code.
- This task's new `deliveryAttrs` helper uses ordinary dynamic assignment
  before Core receives the payload. It therefore introduces the previously
  settled loss mechanism at a new location; it is not failure or removal of
  the old redaction/Core correction.

R1 remains a source-backed implementation defect. Its bounded correction restores
an established property-preservation choice; it introduces no new product or
architecture decision. The earlier question omitted the historical-ruling lookup
and should not have presented this implementation choice as unsettled. The
TeamLeader has reconciled the review record and will not repeat that question.
No source/test correction was dispatched during this historical investigation.
The legacy standalone decisions tree is archived; the task's dated ruling is the
current authoritative record, rather than a new decision entry.

## Continuation after historical lookup

On 2026-10-10, after the TeamLeader reported the historical ruling and the
new-helper recurrence, the operator instructed: "继续". The TeamLeader resumes
this already approved development slice with the same writer. This is not a
new design choice, contract expansion or authorization for downstream/live work.

| Item | Continuation boundary |
| --- | --- |
| R1 | Restore the previously settled own-property preservation behavior; no new prototype guard or validation policy. |
| R2 | Correct observations of an actual timer so legal pre-binding refusals do not become false failures; preserve real scheduling and bound-delivery evidence. |
| R3 | Complete the already specified domain/product synchronization at the normal TeamLeader-owned closeout stage. |
| R4 | Unconditionally close test-created sessions before removing their resources; no product lifecycle or recovery changes. |

The same developer is assigned R1/R2/R4 only. The TeamLeader retains R3 and task
records. Neither the review report nor this continuation expands merge authority.
Any newly discovered product/architecture choice still returns to the operator.

## Fixed-point verification after correction

On 2026-10-11 the original location verifiers independently inspected the
corrected areas and their tests, without running runtime gates. R1 is closed
through the contract payload and real-Core rendered input; R2 is closed through
phase-aware observations of actual timer outcomes.

R4's session-registration correction closes the interval leak but is incomplete
for test-held deferred commands. In the click, close/drain and detached-forward
scenarios, an assertion failure before `held.resolve` leaves a tracked command
pending forever; unconditional session close then waits forever on that test-owned
resource. The TeamLeader inspected all three source paths and accepts this
remaining cleanup finding. Releasing the test's own deferred in unconditional
teardown is within the recorded R4 correction boundary; no product lifecycle,
timeout, cancellation or recovery policy is changed. The same developer receives
this bounded follow-up. R3 remains TeamLeader-owned closeout.

## Final fixed-point closure

On 2026-10-11 the original independent verifier closed R4 after inspecting all
four registered held commands, their unconditional release before close/drain,
and the success-path resolves. The same reviewer retained R1/R2 closed verdicts.
The original documentation verifier independently closed R3 after comparing
channel-domain and product changes with the approved contract and current source.
No accepted finding remains unresolved. These follow-ups checked the complete
corrected areas and their tests; they did not rerun runtime gates or extend the
public behavior. Runtime evidence and limitations remain in verification.
