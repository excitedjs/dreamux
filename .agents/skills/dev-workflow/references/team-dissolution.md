# Final Team Dissolution

Enter this stage only when code is confirmed merged into `next`, the task record is
durable, and no review finding, blocker, or operator decision remains open.

Ask the operator through the current visible user channel whether to dissolve the
Team. This is a required explicit choice at the end of every completed workflow;
do not infer consent from development approval, merge approval, silence, or an
earlier preference.

If the operator declines or has not answered, leave the Team open and take no
lifecycle action.

If the operator confirms dissolution, load and follow `team-workflow`, then inspect
the shared worktree for:

- uncommitted changes;
- untracked files;
- unmerged index entries.

If any are present, or safety cannot be determined, do not call `dissolve`. Report
what must be preserved and ask the operator how to handle it.

Only for a safe worktree, call `dissolve({ note })` with a concise completion reason.
Do not delete any branch or ref; Team dissolution never grants that authority. A
successful receipt confirms logical close admission, not immediate physical
worktree deletion. Let the current turn settle naturally and allow any eligible
cleanup to finish asynchronously.
