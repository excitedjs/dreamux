# Teach the TeamLeader that a TeamMate is not a subagent

## Current state

- Goal: Make the bundled teamwork skill tell a TeamLeader to hand members the question and its own framing as evidence, and to reopen the premise when review rounds keep adding mechanism, instead of using members as subagents of a frozen design
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/builtin-skills/teamwork-teammates-are-not-subagents/requirement.md)
- Final solution: [Judgment added to the teamwork skill](/.agents/tasks/builtin-skills/teamwork-teammates-are-not-subagents/technical-design/final.md)
- Solution review Issue: N/A; the operator asked for the change directly and the boundary is one bundled skill.
- Blockers: None.
- Next action: None.
- Related tasks:
  - Prior ruling and the skill's current shape: [Refine the model-facing surfaces](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md), ruling R8.
  - The principle's repository-side form: [PR #392](https://github.com/excitedjs/dreamux/pull/392), whose task record lands with that PR.
  - The failure that exposed the gap: [Suppress owner close/stop pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/README.md), PR #389 replaced by PR #391.

## Development approval

- Status: Granted by the operator on 2026-09-08 in the request itself: “你把 dreamux 内置的 teamwork 技能也优化一下，把这个原则写进那个技能。不要让team leader始终把teammate当做subagent 来用”.
- Approved implementation boundary: `packages/dreamux/skills/team-leader/teamwork/SKILL.md`, one Rush change file, this task record.

## Delivery

- Pull request: [#393](https://github.com/excitedjs/dreamux/pull/393).
- Verification: [Completed verification](/.agents/tasks/builtin-skills/teamwork-teammates-are-not-subagents/verification.md)
- Knowledge closeout: the skill is its own owner; no domain or product page describes its content. Change file recorded.
