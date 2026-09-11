# Pin the state a task record may carry on the trunk

## Current state

- Goal: Make a task record's state a fact that stays true after its own pull request merges, and enforce it in the knowledge-base check
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/pin-task-record-states/requirement.md)
- Final solution: [Pin the state a task record may carry on the trunk](/.agents/tasks/architecture/pin-task-record-states/technical-design/final.md)
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

- Pull request: Not opened.
- Scope delivered: the rule and its enforcement, the seven non-compliant
  records, and four further records that carried the same expiring prose in
  fields the gate cannot read — `mcp/remove-creation-repo-slug`,
  `channel/add-feishu-slash-commands`, `builtin-skills/adopt-lean-self-upgrade-sop`,
  and `mcp/scheduler/remove-cron-run-now`. Two of those four made claims that
  were already false: PR #335 had been merged for a month while its record said
  no merge had been performed.
- Known limit: the check reads the `State:` line and the index entries, not the
  prose around them. A record can still describe a finished task in the present
  tense and pass. Enforcing that mechanically would need a phrase list that
  cannot tell a live status from the same words inside a quoted operator ruling,
  so the rule is written down and the check covers the fields that carry state.
- Knowledge closeout: Complete. `task-records.md` owns the rule;
  `knowledge-closeout.md` points at the gate that enforces it. No package
  boundary, CLI surface, protocol contract, or persisted state shape changed,
  so no other knowledge owner and no change file is affected.
