# Requirement

## Initial request

- Operator, 2026-09-08: “你把 dreamux 内置的 teamwork 技能也优化一下，把这个原则写进那个技能。不要让team leader始终把teammate当做subagent 来用”.
- The principle is the one PR #392 wrote into this repository's own review
  prompts after PR #389: a member challenges the TeamLeader's framing rather
  than confirming it.

## Prior ruling this builds on

- R8 of the model-facing-surfaces task, 2026-09-06: “我在大量的使用过程中，我发现teamleader 总是会把teammate 当做subagent去执行任务” and “重点就一句话，context not control”.
  The current `teamwork` skill is the answer to that ruling, and it targeted
  the brief: over-specific edit plans (“改什么，不改什么，怎么改”) that left a
  member no room to report that the plan does not survive the code.
- PR #389 had no edit plan. Its TeamLeader handed down a frozen premise, that
  the producer owns the completion obligation, and asked reviewers to find
  holes in it, so every reviewer became a subagent of that premise. The
  2026-09-06 change did not cover that shape; this task does.

## Current alignment

- Status: Clarified; implemented directly with the operator on 2026-09-08.
- Baseline: `origin/next` at `71316ab93fee0829475d2d41cdfffbed7cbfae2a`.
- Desired behavior: the bundled `teamwork` skill tells a TeamLeader that a
  member's own judgment is what distinguishes it from a subagent; that the
  brief carries the question the work turns on before the leader's answer,
  with the leader's design marked as a guess; that a member's identity includes
  standing to contradict the leader's framing; and that when review rounds keep
  adding mechanism to one area, the leader stops patching, writes the premise,
  and puts it to members that have not seen the draft.
- Scope: `packages/dreamux/skills/team-leader/teamwork/SKILL.md`, one Rush
  change file, this task record.
- Non-goals: no change to the skill's name, description, or load trigger; no
  change to the `dev-workflow` skill; no new tool, prompt surface, or review
  mechanism; no lifting of the repository-specific reviewer identity wording
  from PR #392 into a skill that ships to every Team.

## Acceptance criteria

- The choice section says a member has a judgment of its own and that a member
  briefed like a subagent returns a subagent's result.
- The hand-down carries the question before the answer and marks the leader's
  design as a guess.
- `identity` includes standing to contradict the leader's framing.
- One new situation section covers review rounds that keep adding mechanism.
- Skill validator, Rush build, lint, test, `typecheck:tests`,
  `.agents/scripts/check.sh`, and `git diff --check` pass.

## Decisions and unknowns

- Confirmed operator decisions: the initial request above, verbatim.
- Labeled inference: the practice of giving fresh members the user's story and
  the baseline rather than the draft comes from the PR #389 TeamLeader's own
  retrospective, which the operator forwarded on 2026-09-08 (“架构 reviewer
  只拿用户故事、基线源码和白皮书，先独立给解法；实现 reviewer 才拿现有 draft”).
  It is adopted as the skill's advice, not recorded as an operator ruling.
- Blocking unknowns: None.
