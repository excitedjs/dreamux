# Pin the state a task record may carry on the trunk

## Current state

- Goal: Make a task record's state a fact that stays true after its own pull request merges, and enforce it in the knowledge-base check
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/pin-task-record-states/requirement.md)
- Final solution: [Pin the state a task record may carry on the trunk](/.agents/tasks/architecture/pin-task-record-states/technical-design/final.md)
- Verification: [Gates, behavior probes, and counts](/.agents/tasks/architecture/pin-task-record-states/verification.md)
- Solution review Issue: None. The operator directed the work in the Feishu group and approved the approach there.
- Blockers: None.
- Next action: None.
- Related tasks: [Task System Records](/.agents/tasks/architecture/task-system/README.md) holds the backfilled decisions this format came from.

## Development approval

- Status: Granted by the operator on 2026-09-11 (Feishu group), verbatim: "可以，那边贡献的人多，你先把规则定死了，剩下的状态起一个 workflow 去刷一遍。"
- Approved implementation boundary: the rule and its enforcement in
  `init_task.py` and `.agents/scripts/check.sh`, the dev-workflow references
  that own the task-record format, and the existing task records and domain
  indexes brought into compliance. No new CI job, and no change to the set of
  nine workflow states.

## Delivery

- Pull request: [#413](https://github.com/excitedjs/dreamux/pull/413).
- Scope delivered: the rule, its enforcement, and every record brought into
  compliance. Several were false rather than merely stale: PR #335 had been
  merged for a month while its record said no merge had been performed, and
  `adopt-lean-self-upgrade-sop` was `done` while its delivery said the pull
  request had not started.
- Coverage: the check reads the `State:` line, the index entries, and the
  delivery-status bullet labels. The label rule is
  [ported from upstream's format gate](/.agents/tasks/architecture/pin-task-record-states/technical-design/final.md),
  which rejects a closed set of structural tokens rather than parsing prose —
  the first version of this task checked only the state line and left the rest
  to a hand sweep. What it still cannot see is stale text inside a label that is
  not banned: `teamwork-teammates-are-not-subagents` said "Land the pull request
  after CI and review" under `- Next action:` after #393 had merged, and only a
  reader found it. A green gate is not a clean tree.
- Knowledge closeout: Complete. `task-records.md` owns the rule;
  `knowledge-closeout.md` points at the gate that enforces it. No package
  boundary, CLI surface, protocol contract, or persisted state shape changed,
  so no other knowledge owner and no change file is affected.
