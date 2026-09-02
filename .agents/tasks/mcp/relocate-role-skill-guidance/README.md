# Relocate role skill guidance into MCP descriptions and role prompts

## Current state

- Goal: Dispatcher and TeamLeader stop loading dispatcher-workflow and team-workflow every turn: tool knowledge moves into MCP tool and parameter descriptions, behavioral rules move into the role prompts, and both skills stay bundled as optional, non-mandated skills.
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/mcp/relocate-role-skill-guidance/requirement.md)
- Final solution: [technical-design/final.md](/.agents/tasks/mcp/relocate-role-skill-guidance/technical-design/final.md) (draft: [draft.md](/.agents/tasks/mcp/relocate-role-skill-guidance/technical-design/draft.md); review: [reviews/codex-review.md](/.agents/tasks/mcp/relocate-role-skill-guidance/technical-design/reviews/codex-review.md)).
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/368
- Blockers: None. The task record was restored and WIP-committed (operator-approved) after the incident below; the leftover edits of the stopped run were discarded (operator-approved).
- Next action: Independent implementation review (code-review workflow at xhigh with the requirement-fidelity finder) over the current workspace; then adjudication, operator ratification, knowledge closeout, PR.
- Implementation: workflow `run-2e69c695-1f27-403a-a814-2b5965a913f2` completed with all gates green (the earlier `run-2973de5d-635f-4feb-9df2-6a71857d38aa` failed at script compile before any agent started). TeamLeader pre-review passed; evidence in [verification.md](/.agents/tasks/mcp/relocate-role-skill-guidance/verification.md).
- Related tasks: None.
- Solution path (operator ruling, 2026-09-02, Feishu group, verbatim): "ok，拉一个 codex 评审即可，不用走三位了" — TeamLeader-authored solution reviewed by exactly one Codex reviewer instead of three. Requirement input revision: requirement.md as of this ruling.
- Review adjudication (2026-09-02): one Codex reviewer, 11 findings; 10 accepted, 1 partially (test coverage of the private TeamLeader prompt builder); rulings recorded in final.md §10.

## Development approval

- Status: Granted by the operator on 2026-09-02 (Feishu group), verbatim: "批准，启动 ultracode 一次性搞定，成员都用 opus".
- Approved implementation boundary: the boundary played back in the approval request — `base-prompt.ts` (both prompts), `leader-agent.ts` TeamLeader prompt; tool and property descriptions in the `teammate`, `team`, and `cron` delegates; feishu-channel `reply` and both `bind_channel` descriptions; both `SKILL.md` bodies and descriptions; `dispatcher-skill.md`, `model-facing-writing.md`, `provider-runtime.md`, two `dev-workflow` references; one new structural test; change files (`dreamux` minor, `feishu-channel` patch). Unchanged: skill names/roots/injection, tool names, schema types and constraints, results, `workflow` and `dreamux-maintenance` skills.
- Adjacent `react` correction: operator ruling (2026-09-02, Feishu group, verbatim): "React那个东西是要去掉的，因为这个工具，dispatcher和TeamLeader都可以调，把这个Dispatcher Channel的描述去掉" — the "dispatcher channel" wording on `react` is removed because both callers reach the tool.
- Implementation method (operator ruling in the same message): run the implementation through the ultracode workflow with all members on the Opus-backed runtime (`claude`), instead of a single developer TeamMate.

## Incident (2026-09-02)

- Implementation workflow run `run-27f7158a-ca05-4865-a395-1f8963ced47a` (9 disjoint writer lanes → fidelity critic + gates → bounded self-repair) started 17:25 Asia/Shanghai. Every writer lane completed, then the Team workspace directory was deleted from under the run at about 17:39: the Dreamux server log shows a dissolve of a different Team, `dreamux-fable-ylw3mjs`, first blocked because "the managed worktree is dirty" (dirty with this Team's uncommitted lane edits), which points at both Teams having resolved to the same managed worktree path. The round-1 fixer re-created the worktree clean at ca30883; all uncommitted work, including this task record, was lost. The run was stopped by the TeamLeader at 18:10 before the round-2 fixer could invent prompt text without the solution.
- Recovery: the task record (README, requirement, draft, final, review) was rewritten from the TeamLeader's context. Lane reports from the stopped run are the only record of the lost edits; the implementation is re-run from the restored solution.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
