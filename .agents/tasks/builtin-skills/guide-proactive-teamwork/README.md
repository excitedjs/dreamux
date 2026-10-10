# Guide proactive TeamMate collaboration without repeated skill loads

## Current state

- Goal: Encourage useful TeamMate delegation, consult teamwork only for missing guidance, and explain standing identity consequences.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/builtin-skills/guide-proactive-teamwork/requirement.md)
- Final solution: [Approved prompt and skill boundaries](/.agents/tasks/builtin-skills/guide-proactive-teamwork/technical-design/final.md)
- Solution review Issue: N/A; the operator approved the concrete proposal directly.
- Blockers: None.
- Next action: None.
- Related tasks: Supersedes the subagent-framing portion of [TeamMate judgment](/.agents/tasks/builtin-skills/teamwork-teammates-are-not-subagents/README.md) and the TeamLeader-only prompt boundary of [role skill guidance](/.agents/tasks/mcp/relocate-role-skill-guidance/README.md).

## Development approval

- Status: Granted by the operator on 2026-10-10 after the three-layer proposal: "可以，改一下试试，然后拉 trae-seed 和 mimo 去 review."
- Approved implementation boundary: TeamLeader collaboration prompt, teamwork skill, TeamMate tool descriptions, the existing launch fixture, owning KB pages, and one Rush patch note. No runtime effort, schema, state, or lifecycle changes.

## Delivery

- Pull request: [#467](https://github.com/excitedjs/dreamux/pull/467).
- Verification: [Validation and review adjudication](/.agents/tasks/builtin-skills/guide-proactive-teamwork/verification.md)
- Knowledge closeout: Current skill and model-facing guidance owners describe the approved boundaries. The pinned [Codex investigation](/.agents/research/codex-ultra-delegation.md) remains a frozen source snapshot; this task owns the follow-up decisions.
