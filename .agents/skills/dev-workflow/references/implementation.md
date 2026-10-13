# Implementation and Local Verification

Enter `implementation` only after the development-authorization card receives an
explicit approving response and that evidence is recorded in the task README.
Implement the approved requirement and solution within the recorded boundary.
Preserve unrelated worktree changes.

Before requesting `review`:

- inspect the whole diff for requirement completeness and scope compliance;
- run the checks required by the changed owners and repository rules;
- record commands, results, skipped checks, coverage limits, and residual risks in
  `verification.md`;
- correct known failures and verify the complete resulting change.

Do not call the stage green until the repository's required build, lint, test, and
`typecheck:tests` gates pass. For narrower validation, report exactly what passed
and what was not run.

A material requirement, solution, or scope change stops implementation and returns
to the earliest affected stage for confirmation and renewed development approval.
Once the approved change and local verification are ready, request entry to
`review` through the stage-transition card. Continue with
[implementation review](implementation-review.md).
