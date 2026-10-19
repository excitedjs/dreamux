# Support native Windows execution

## Current state

- Goal: Run Dreamux natively on Windows, then deliver a PR and publish an alpha from its branch.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/native-windows-support/requirement.md)
- Final solution: [Native process and filesystem boundaries](technical-design/final.md)
- Verification: [Checks and coverage](verification.md)
- Blockers: No unresolved product decision.
- Next action: Submit the reviewed corrections to the existing PR and verify its hosted gates. Merging remains unauthorized.
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

## Delivery

- Submit this implementation as a PR to `next`, then publish alpha from that branch. GitHub owns delivery status; merging is not authorized.
- Knowledge closeout: Native platform boundaries, service maintenance, test isolation, publication lifetime and product behavior are documented in the owning references.
