# Feishu extension input delivery contract

## Current state

- Goal: Let a Feishu extension deliver card-related input from its own channel instance, observe the submission outcome, and constrain delivery to the expected bound Team.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/add-extension-input-delivery/requirement.md)
- Final solution: [Reconciled solution](/.agents/tasks/channel/add-extension-input-delivery/technical-design/final.md)
- Solution review Issue: [#468](https://github.com/excitedjs/dreamux/issues/468).
- Draft and reviews: [Original draft](/.agents/tasks/channel/add-extension-input-delivery/technical-design/draft.md); independent [Seed](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/seed.md), [Codex](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/codex.md) and [DeepSeek](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/deepseek.md) reports.
- Blockers: None; implementation and knowledge review are complete.
- Next action: Prepare the upstream PR, await normal CI and request merge authority. Downstream adaptation is outside this task.
- Related tasks: Builds on [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); preserves the existing plugin and channel ownership boundaries.

## Task authorization

- On 2026-10-10, the operator explicitly approved an interactive request to create this upstream task with the scope recorded in the requirement.
- Upstream capability work precedes downstream extension adaptation. Task creation does not authorize implementation.
- The confirmed product outcome decides the design. Existing code and knowledge describe the present shape; user-visible changes require an explicit decision.
- On 2026-10-10, the operator selected the TeamLeader-authored solution path followed by three independent reviews. The shared input is the requirement recorded after task creation; material changes to that input invalidate the draft review.

## Intake verification

- On 2026-10-10, the task-record checker, the knowledge-base check and `git diff --check` passed for the intake documentation.
- The intake change contained only this task's README and requirement plus its parent index. No product code, tests or configuration were changed, and no runtime gate was run for that intake.

## Development approval

- Status: Granted on 2026-10-10.
- Authorization evidence: An interactive development-authorization card was sent on 2026-10-10, referring to the requirement, reconciled final solution and Issue #468. The operator first asked whether the single new function could reduce complexity; that clarification did not authorize development. On 2026-10-10 at 19:24 Asia/Shanghai, the operator explicitly instructed development to begin against the same unchanged scope.
- Approved implementation boundary: The upstream Feishu package's instance delivery contract, implementation, exports and hermetic tests, with owning documentation and a Rush change note. The approved requirement and final solution linked above govern this slice; downstream adaptation follows upstream completion and is not included here.
- Developer assignment: The operator explicitly requested one fresh DeepSeek implementation seat on 2026-10-10. Developer code/test/release-note writes and TeamLeader task/knowledge writes are disjoint.

## Solution review

- On 2026-10-10, three independent read-only draft reviews completed. The final solution records source-based adjudication, not reviewer voting or runtime acceptance.
- The selected operation stays inside the Feishu instance, checks the effective bound Team and returns the existing command outcome or a distinct pre-submission refusal. It adds no readiness phase or presentation suppression.
- The solution preserves existing instructions and input-event display; review clarified their description without expanding the reviewed user stories. That review changed no product code, tests, configuration or current domain/product facts.
- Task checking with `--allow-in-flight` and `git diff --check` passed for the solution record. The knowledge check reported only the intentionally in-flight state; it must not be described as a passing trunk gate until the task is in a stable submission state.

## Implementation review

- The xhigh workflow completed with complete coverage: seven finders, nine candidates, four verification locations, four consolidated findings.
- [Round-1 adjudication](/.agents/tasks/channel/add-extension-input-delivery/implementation-review/round-1.md) records three accepted source/test corrections and one deferred mandatory knowledge-closeout item. The operator challenged R1 as previously settled; the historical lookup confirms the prior property-preservation ruling and the new helper repeats that mechanism. The operator subsequently instructed continuation; R1/R2/R4 are assigned to the same writer within the approved source/test scope, and R3 remains TeamLeader-owned closeout.

## Delivery

- Pull request: The implementation PR is linked from [Issue #468](https://github.com/excitedjs/dreamux/issues/468); delivery targets `next` and merge requires operator authority.
- Verification: [Evidence and pre-review boundary](/.agents/tasks/channel/add-extension-input-delivery/verification.md).
- Knowledge closeout: Completed on 2026-10-11. Supersession check: this extends the existing plugin/extension capability; no whole task is superseded. The contradictory no-delivery statement was replaced in the channel owner.
- Current facts: [Channel contract](/.agents/domains/channel.md#feishu-extensions) and [product catalog](/.agents/product/README.md) updated; package guidance and minor Rush note reviewed. The channel owner carries the own-metadata regression trap from the previously settled ruling.
- Maintenance references: N/A; no config, persisted-state shape or ownership changed. Glossary and root routing: N/A; no new overloaded term or navigation owner. Existing task index links this record.
- History: original draft and three solution reports retained inside this task; no additional snapshot is needed for reconstructible implementation evidence.
- Knowledge/task gates: passed on 2026-10-11 (53 task records, 352 reachable knowledge files), focused task check and `git diff --check` passed. See verification for evidence and limits.
