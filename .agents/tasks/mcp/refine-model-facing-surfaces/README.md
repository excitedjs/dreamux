# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R20 recorded verbatim, evidence, and proposed changes 1–12; frozen for the solution phase at the revision that records R20 (2026-09-06).
- Final solution: [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) (2026-09-06), adjudicated from [draft.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/draft.md) and the two reviews under `technical-design/reviews/` (Codex and Seed runtimes, R18; the Codex file includes its reconsideration under R21).
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Enter development — implement final.md §3 on a branch from `origin/next` merged with `origin/pr-369`, through the ultracode workflow (R24), then open the PR on `next`.
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task adds one delivery line to that PR's record (draft §3.11): #369 is not merged and its content ships through this task's PR.
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-06 (chat message answering the approval card), verbatim: "进开发。你自己用 ultracode 模式一次性搞定。" Bound to [requirement.md](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) R1–R24 and [technical-design/final.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/final.md) as committed at `a169ac94`.
- Approved implementation boundary: final.md §6 (source files in `packages/dreamux`, `packages/channel/feishu-channel`, `packages/agent-runtime/claude-code`; the renamed skill roots and three `SKILL.md` files; the tests of final.md §7; the KB pages and README of §3.10; three change files of §3.11; the task records of §3.13). Non-goals: final.md §5. The three approval-time questions of final.md §9 are settled by R22 (public-artifact rule dropped; second channel-reply sentence deleted) and R23/R24 (Claude adapter fix A, in this PR).
- Implementation method (operator ruling in the same answer): the ultracode workflow, driven by this TeamLeader; member models per R25: opus for the agents that write code, sonnet for the rest.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
