# GitHub PR and CI Handoff

Enter only after TeamLeader adjudication leaves no accepted unresolved review
finding, proportionate local checks pass, knowledge closeout is complete, and the
task README says `State: done`.

## Commit and open the PR

The TeamLeader reviews the final working diff, uses the real author identity,
commits with the required co-author trailer, pushes the task branch, and opens or
updates one public GitHub PR. Target `next`, as owned by
[`/.agents/reference/release-process.md`](/.agents/reference/release-process.md).
If the repository default branch differs from `next`, stop and ask rather than
following the drift.

Keep the English PR body public-safe. Link the task's solution-review Issue when
one exists, summarize intent and scope, list exact validation and limitations,
and use the repository's normal Issue-closing syntax when merge should close that
Issue. Follow the release reference for change files, CI, and merge topology.

## Wait for normal CI

Do not repeat the implementation review after commit and push. The independent
review already covered the working diff before the TeamLeader finalized the task
record and created the commit.

Wait for the repository's required GitHub CI. Do not present the PR as ready until
CI is green and every previously accepted blocking finding remains cleared.

If CI or PR feedback requires a repository change, use the existing writer rule,
then return to TeamLeader pre-review and the normal independent implementation
review before committing and pushing the replacement. Editing PR metadata alone
does not reopen implementation review.

## Merge

Merge only with operator authority and the repository's normal squash-merge rules.
Confirm the resulting commit on `next`. Do not add another implementation-review
round for the pushed commit or the merge result.
