# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Blockers: No unresolved product decision.
- Next action: Deliver the reviewed Vitest-native isolation and Windows long-path corrections to the existing PR and verify its CI. Merge remains paused at the operator's request.
- Coverage limit: The historical skill-publication timeout did not recur in local or hosted diagnostics; its original log lacks the failing await stage, so this correction does not claim to resolve that timeout.
- Pull request: [Native Windows support](https://github.com/excitedjs/dreamux/pull/476)
- Related tasks: None.

## Development approval

- On 2026-10-18 the operator selected native Windows source support in the runtime-choice card, then explicitly instructed implementation.
- Approved boundary: Native CLI, local IPC, provider processes, managed service, and Windows test infrastructure. The operator separately required Windows test failures to be repaired in the test infrastructure.
- Delivery authority: The operator explicitly requested a PR first, then an alpha built from that PR branch. This authorizes publishing the branch and alpha, not merging into `next`.
- The operator prioritized completing this repository after a test-isolation incident. Recovery of unrelated operator state is outside this public change; regression prevention belongs here.
- On 2026-10-19 the operator required Dreamux-provided capabilities to be independent of the platform, explicitly allowing platform command lines for installing and controlling the persistent platform service. The implementation uses Node APIs where available and native bindings behind shared capability boundaries otherwise; this instruction also covers avoidable Bash usage in development and test tools.
- On 2026-10-19 the operator explicitly approved six authenticated model tests through the interactive card. Those tests passed against the final native implementation using disposable homes and locally intercepted channel IO.
- On 2026-10-19 at 13:18 (UTC+08:00), after re-review, the operator explicitly instructed correction of the three reported findings: provider log ownership, Windows PATH precedence, and large Job termination. This authorizes their implementation and regression verification within the existing PR; it does not authorize a merge or another release/install operation.
- On 2026-10-19 at 15:33 (UTC+08:00), the operator explicitly requested the non-blocking failure-injection tests suggested in the [PR review](https://github.com/excitedjs/dreamux/pull/476#pullrequestreview-5568105760): interrupted or mismatched bootstrap identity verification and candidate-process exit before Job termination. This extends test coverage within the existing PR without authorizing a merge or release.
- On 2026-10-19 at 16:24 (UTC+08:00), the operator explicitly instructed correction of the [eager Koffi loading comment](https://github.com/excitedjs/dreamux/pull/476#discussion_r4311329746). This authorizes lazy initialization within the native owners, behavioral regressions and delivery to the existing PR.
- On 2026-10-19 at 16:56 (UTC+08:00), the operator required investigation of the actual CI failure causes before reporting completion. A successful rerun alone is not causal evidence. This follow-up remains within the previously authorized Windows failure corrections.
- On 2026-10-19 at 20:18 (UTC+08:00), the operator paused the previously requested merge to review the test-script changes.
- On 2026-10-19 at 21:45 (UTC+08:00), the operator explicitly instructed using Vitest's native capabilities after reviewing the proposed replacement of the custom launcher. This authorizes configuration, lifecycle setup, regression verification and delivery to the existing PR; it does not resume the paused merge.
- On 2026-10-19 at 21:49 (UTC+08:00), the operator required small-scope isolation verification before broader test execution to protect existing Dreamux and Codex configuration. The initial verification must itself use disposable account/application homes and sentinel files, with cleanup targets reviewed before execution.

## Delivery

- Deliver the approved corrections to the existing PR targeting `next`. GitHub owns delivery status; merging remains paused by the operator.
- Knowledge closeout: Native platform boundaries, service maintenance, test isolation, publication lifetime and product behavior are documented in the owning references.
