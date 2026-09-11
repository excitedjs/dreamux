# Requirement

## Initial request

The operator reported the problem from repeated experience rather than from one
incident (Feishu group, 2026-09-11, verbatim): "这个问题经常有啊，你给我想一想办法",
then "你帮我想一想，这个问题怎么解决。是不是可以搞一个CI来自动刷状态？".

The recurring problem: a task record merges into `next` still saying
`State: review`, a state that can never be true once the pull request carrying
it has merged.

## Confirmed current behavior and evidence

Measured on `next` at `27428f85`, 2026-09-11.

- 7 of 36 task records carry a state that cannot be true on the trunk. Three
  are values outside the supported set entirely — `implemented`, `in-progress`,
  `delivery` — which the existing check would have rejected.
- Every one of the 7 was delivered. Six were delivered by a merged pull
  request: #367 (`616a55b7`), #390 (`2b3d6971`), #357 (`2cf21cc6`), #402
  (`9886af82`), #391 (`71316ab9`), #412 (`27428f85`). The seventh,
  `mcp/relocate-role-skill-guidance`, referenced #369, which the operator
  closed unmerged on 2026-09-05 after ruling its content ships through #380;
  the record already states this.
- The one non-`done` record that is legitimate is
  `architecture/harness-gaps` at `intake`: nothing has started, which stays
  true indefinitely.
- The same state was duplicated in the domain index entry for all 35 records,
  and two of those copies already disagreed with the record they described. A
  reader had no way to tell which of the two was stale.
- `architecture/split-streaming-display-from-pushback` carried six lines of
  prose after its state — branch name, four gate results, and a probe finding.
  Every one of those is a snapshot.
- A per-task checker already existed and already rejected four of these
  records. It had never been wired into any gate, so nothing ran it.

The last point is the actual diagnosis. The rules were not missing; nothing
enforced them, and nothing could, because the check ran only when a person
remembered to run it for the one task they were holding.

## Desired outcome

A state that reaches the trunk is a state that stays true while the file sits
untouched. Facts that expire on their own are not written down at all, because
git and GitHub already record them authoritatively and for free.

## Desired behavior

- The knowledge-base gate that already runs in CI validates every task record
  in the repository, not one named task.
- A record may be committed to the trunk only in `intake`, `blocked`, or
  `done`. The six mid-workflow states stay available on a working branch, where
  they are correct.
- A domain index entry carries the title, the link, and the goal, and does not
  repeat the state.
- Existing records are brought into compliance in the same change that adds the
  gate, because the gate turns them red immediately.

## Scope

- `.agents/skills/dev-workflow/scripts/init_task.py`: the rule and its
  enforcement.
- `.agents/scripts/check.sh`: run it over the whole tree.
- `.agents/skills/dev-workflow/references/`: state the rule where the format is
  owned.
- All existing task records and domain indexes: bring them into compliance.

## Non-goals

- No new CI job. The existing `kb` job already runs `.agents/scripts/check.sh`.
- No change to the set of nine workflow states.
- No migration of historical records to the current task layout; that exemption
  in `task-records.md` stands.

## Acceptance criteria

- `.agents/scripts/check.sh` passes on the branch.
- It fails, naming the record, when any record is set back to a mid-workflow
  state, when a state line carries trailing prose, and when an index entry
  repeats a state.
- `--allow-in-flight` lets a TeamLeader hold a mid-workflow state on a branch,
  and `check.sh` never passes it.

## Decisions and unknowns

- Confirmed operator decisions (Feishu group, 2026-09-11, verbatim):
  - "可以，那边贡献的人多，你先把规则定死了，剩下的状态起一个 workflow 去刷一遍。"
    — pin the rules first, then sweep the remaining states with a workflow. The
    stated reason is that the upstream repository this workflow system borrows
    from has many contributors.
  - "workflow 里全都起 sonnet 节点，先刷，再起 sonnet 复核，最后让opus 收尾即可。"
    — the sweep and its review run on Sonnet; Opus closes out.
  - "尽量把上游好的方式全都借鉴过来" — borrow what is good upstream.
  - "那你顺道也看一下其他 task 有没有不是done 的。这个仓库只有我自己在开发，理论上所有在
    Next 分支上的feature都是已合入的" — every feature on `next` is merged, so a
    non-`done` record there is a defect unless the work genuinely has not started.
  - "这套 workflow 体系有一部分借鉴了 deepseek-harness 你去看一看我抄的作业，它原本是怎么写的"
    — read the upstream design before proposing one.
- Assumptions: none outstanding.
- Blocking unknowns: none.
