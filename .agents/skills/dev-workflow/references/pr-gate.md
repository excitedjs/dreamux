# GitHub PR and Exact-Head Gate

Enter only after TeamLeader adjudication leaves no accepted unresolved review
finding, proportionate local checks pass, and the task and knowledge closeout are
part of the intended head.

## Prepare the head and PR

The TeamLeader reviews the final working diff, uses the real author identity,
commits with the required co-author trailer, pushes the task branch, and opens or
updates one public GitHub PR. Target `next`, as owned by
[`/.agents/reference/release-process.md`](/.agents/reference/release-process.md).
If the repository default branch differs from `next`, stop and ask rather than
following the drift.

Keep the English PR body public-safe. Link the task's solution-review Issue,
summarize intent and scope, list exact validation and limitations, and use the
repository's normal Issue-closing syntax when merge should close it. Follow the
release reference for change files, CI, and merge topology.

## Review the exact pushed head

Resolve and record the full pushed head commit before final review. Require a clean
worktree with local `HEAD` equal to that pushed head, and give reviewers the explicit
base and head commits. Approval never carries to a different head.

For the one-file fast path, repeat its one direct read-only review against the exact
head. For every other path, repeat the implementation-review workflow against the
exact head. The reviewer identities and focus split stay stable; a workflow run may
create fresh TeamMates. Never use the author as a reviewer.

For non-`.agents` work, send every accepted fix back to the same developer. The
TeamLeader handles only its own fast-path and `.agents/**` corrections. After a fix,
repeat TeamLeader pre-review, relevant local checks, task and knowledge closeout,
commit and push the replacement head, and review that new exact head.

## Gate readiness and merge

Do not present the PR as ready until:

- GitHub CI is green for the exact head;
- every mandatory review surface settled;
- every accepted blocking finding is cleared;
- rejected findings have concise concrete rationale in the task or PR record.

Set the task state to `merge` only after this gate. Merge only with operator
authority and the repository's normal squash-merge rules. Confirm the resulting
commit on `next`, record delivery, and set the task state to `done`.
