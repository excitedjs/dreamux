# GitHub PR and Exact-Head Gate

Enter only after TeamLeader adjudication leaves no accepted unresolved review
finding, proportionate local checks pass, and the task and knowledge closeout are
part of the intended head.

Do not enter while a security embargo is active. A public branch and PR are allowed
only after the operator explicitly approves a sanitized disclosure boundary.

## Prepare the head and PR

The TeamLeader reviews the working diff, uses the real author identity, commits with
the required co-author trailer, pushes a preliminary task head, and opens or updates
one public GitHub PR. Target `next`, as owned by
[`/.agents/reference/release-process.md`](/.agents/reference/release-process.md).
If the repository default branch differs from `next`, stop and ask rather than
following the drift.

Keep the English PR body public-safe. Link the task's solution-review Issue when one
exists and is safe to disclose. Summarize intent and scope, list exact validation and
limitations, and use the
repository's normal Issue-closing syntax when merge should close it. Follow the
release reference for change files, CI, and merge topology.

After the PR exists, update the task README with its public URL and base, set
`State: pr`, and commit and push that handoff as the candidate head. Do not copy the
candidate SHA, CI result, review result, or later merge outcome into that candidate
head because doing so would create a different head.

## Review the exact pushed head

Resolve the full pushed candidate-head commit before final review and record it in
the PR review evidence, not in a repository file. Require a clean worktree with local
`HEAD` equal to that pushed head, and give reviewers the explicit base and head
commits. Approval never carries to a different head.

For the one-file fast path, repeat its one direct read-only review against the exact
head. For every other path, repeat the implementation-review workflow against the
exact head. The reviewer identities and focus split stay stable; a workflow run may
create fresh TeamMates. Never use the author as a reviewer.

For non-`.agents` work, send every accepted fix back to the same developer. The
TeamLeader handles only its own fast-path and `.agents/**` corrections. After a fix,
repeat TeamLeader pre-review, relevant local checks, task and knowledge closeout,
restore the recorded PR handoff and `State: pr`, commit and push the replacement
head, and review that new exact head.

## Gate readiness and merge

Do not present the PR as ready until:

- GitHub CI is green for the exact head;
- every mandatory review surface settled;
- every accepted blocking finding is cleared;
- rejected findings have concise concrete rationale in the task or PR record.

Do not modify the task or candidate head after this gate. Merge only with operator
authority and the repository's normal squash-merge rules. Confirm the resulting
commit through the linked PR and `next`. Do not create a post-gate or post-merge task
write solely to mirror delivery facts.
