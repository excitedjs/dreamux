# Pin the state a task record may carry on the trunk

## Current state

- Goal: Make a task record's state a fact that stays true after its own pull request merges, and enforce it in the knowledge-base check
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/architecture/pin-task-record-states/requirement.md)
- Final solution: [Pin the state a task record may carry on the trunk](/.agents/tasks/architecture/pin-task-record-states/technical-design/final.md)
- Solution review Issue: None. The operator directed the work in the Feishu group and approved the approach there.
- Blockers: None.
- Next action: Correct the seven non-compliant records, then close out.
- Related tasks: [Task System Records](/.agents/tasks/architecture/task-system/README.md) holds the backfilled decisions this format came from.

## Development approval

- Status: Granted by the operator on 2026-09-11 (Feishu group), verbatim: "可以，那边贡献的人多，你先把规则定死了，剩下的状态起一个 workflow 去刷一遍。"
- Approved implementation boundary: the rule and its enforcement in
  `init_task.py` and `.agents/scripts/check.sh`, the dev-workflow references
  that own the task-record format, and the existing task records and domain
  indexes brought into compliance. No new CI job, and no change to the set of
  nine workflow states.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
