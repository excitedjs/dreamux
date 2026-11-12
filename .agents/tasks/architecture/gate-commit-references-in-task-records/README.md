# Gate commit references in task records

## Current state

- Goal: Make task records name work by pull request, review, or Actions run instead of commit hash, and enforce it in the knowledge-base check
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/gate-commit-references-in-task-records/requirement.md)
- Final solution: [Gate commit references in task records](/.agents/tasks/architecture/gate-commit-references-in-task-records/technical-design/final.md)
- Verification: [Probes, mutation matrix, and the rewrite](/.agents/tasks/architecture/gate-commit-references-in-task-records/verification.md)
- Solution review Issue: None. The operator directed the work and ruled on the open decisions in a Claude Code session.
- Blockers: None.
- Next action: None.
- Related tasks: [Pin the state a task record may carry on the trunk](/.agents/tasks/architecture/pin-task-record-states/README.md) — the same merge constraint, applied to states.

## Development approval

- Status: Granted by the operator on 2026-09-17 (Claude Code session). The
  operator first directed, verbatim, "直接按b 来推进", then answered the three
  open decisions of the drafted solution, verbatim: "1. A", "2. 加", and
  "3. 和上次一样就行。" — the last naming how the rewrite runs.
- Approved implementation boundary: the rule in `init_task.py`, its statement in
  `task-records.md`, the `kb` job checkout in `.github/workflows/ci.yml`, and
  the rewrite of every existing citation the rule rejects. No new CI job, no
  scan outside `.agents/tasks/`, and no pre-commit hook change.

## Delivery

- Pull request: [#440](https://github.com/excitedjs/dreamux/pull/440).
- Scope delivered: the commit-citation rule in `check-all`, over every file of
  the task tree; its statement in `task-records.md`; full history and every pull
  request head for the `kb` job; and the rewrite of all 188 citations the rule
  found, on 167 lines in 77 files, including #413's counting script.
- Coverage limit: the rule sees only what the checking clone holds, and only a
  hexadecimal run standing as its own word. A commit that was never pushed is
  caught in the author's checkout and nowhere else, and a prerelease version
  that embeds a commit prefix is not a candidate.
  [Limits](/.agents/tasks/architecture/gate-commit-references-in-task-records/verification.md)
  lists what the rewrite left as written and why.
- Knowledge closeout: Complete. `task-records.md` owns the rule; the `kb` row of
  [CI Gates](/.agents/domains/repository-operations-and-release.md) and the
  header of `.agents/scripts/check.sh` describe what the job now fetches and
  checks. No package boundary, CLI surface, protocol contract, or persisted
  state shape changed, so no change file is needed.
