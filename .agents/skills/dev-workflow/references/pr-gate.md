# GitHub PR, CI, and Merge

Enter delivery after accepted blocking findings are resolved, required local
verification and knowledge closeout are complete, and the operator has confirmed
`done`. Commit the reviewed change with the required author identity and co-author
trailer, push the branch, and open or update one public GitHub PR targeting `next`.
Follow [repository operations](../../../domains/repository-operations-and-release.md)
for anti-leak gates, Rush change files, CI, and squash merge.

Keep the English PR description self-contained and public-safe. Explain the
resulting behavior, scope, validation, and limitations; link the task and a
solution-review Issue when present. GitHub owns PR, CI, and merge status.

Wait for required CI before requesting merge. Do not claim readiness while checks
or accepted blocking findings remain unresolved. Review evidence continues to
apply to unchanged content; pushing a commit does not itself require another
review. If feedback requires implementation changes, obtain the necessary review
rulings or renewed scope approval, then verify and review the resulting change.

Merge only with operator authority granted through an interactive card against
the reviewed PR. Preserve that authority while its scope remains unchanged.
Confirm the resulting commit on `next` before offering
[Team dissolution](team-dissolution.md).
