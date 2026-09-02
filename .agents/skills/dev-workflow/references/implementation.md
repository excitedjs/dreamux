# Single Developer TeamMate and TeamLeader Pre-Review

## Start one development writer

Enter this phase only after valid development approval is recorded in the task
README. Set `State: implementation` and preserve the approved requirement, final
solution, scope, and verification links.

For the minimal-change fast path, have the TeamLeader implement directly as previously
approved and do not start a TeamMate. When the entire implementation surface is
`.agents/**`, the TeamLeader also implements directly as the sole repository writer.
For every other path, load and follow `team-workflow`, then directly start exactly
one write-capable developer TeamMate with the identity in
[developer-identity.md](developer-identity.md). Do not run another writer
concurrently. The TeamLeader must regain control and inspect the completed diff
before deciding the next action.

Dispatch from repository artifacts, not a paraphrased requirement. Give the
developer TeamMate:

- the confirmed task README path;
- the approved requirement and final solution paths;
- the approved implementation boundary;
- the applicable repository-guidance paths;
- instructions to preserve unrelated worktree changes;
- the expected local verification and completion report.

Do not repeat or paraphrase the identity in the work prompt. Let the identity carry
the developer role and `.agents` ownership boundary; let repository artifacts carry
the approved work.

## Wait without polling

Normally wait for Dreamux to push the developer TeamMate's completion without
polling. When development starts, create a one-hour reminder. Delete it if the
TeamMate completes first. If the reminder fires and the TeamMate has not completed,
check whether it is still running normally.

Do not infer commit, push, or merge authority from the implementation assignment.
Those actions belong to the later PR and merge rules.

## Run TeamLeader pre-review

After implementation finishes, have the TeamLeader inspect the worktree and whole
implementation diff before starting the review workflow. This is a fast quality
and completeness gate, not the independent code review.

Check at least:

- every acceptance criterion and approved solution element is represented;
- the workspace change is coherent, complete, and remains inside the approved
  boundary;
- relevant compile, static, and focused unit checks pass;
- skipped or unavailable checks have an exact reason and visible residual risk;
- the developer's completion report matches the actual diff and check results.

Select commands from the changed owners and repository guidance; do not run an
irrelevant ritual command set. Inspect failures rather than reporting only exit
codes.

If the change is incomplete or a basic check fails, send precise findings back to
the same developer TeamMate and repeat the pre-review after it finishes. Do not ask
an independent reviewer to find or clean up defects already visible to the
TeamLeader. For a TeamLeader-authored fast-path or `.agents/**`-only change, the
TeamLeader fixes its own implementation before independent review. If remediation
requires a material requirement or solution change, stop, set
`State: awaiting-development-approval`, and return to the earliest affected stage.

When the gate passes, have the TeamLeader create or update `verification.md`, record
the commands and results and known limitations, and set `State: review` in the task
README. The TeamLeader, not the developer, owns these writes. Pass only a concise
note that compile, static, and unit checks passed; reviewers do not repeat those
checks.

Continue with one direct TeamMate review for the approved minimal-change fast path, or
the workflow review for every other path.
