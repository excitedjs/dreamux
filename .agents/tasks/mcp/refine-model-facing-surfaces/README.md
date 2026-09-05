# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `solution`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R20 recorded verbatim, evidence, and proposed changes 1–12; frozen for the solution phase at the revision that records R20 (2026-09-06).
- Final solution: Not created. Draft: [technical-design/draft.md](/.agents/tasks/mcp/refine-model-facing-surfaces/technical-design/draft.md) (2026-09-06), under review by two independent reviewers on the Codex and Seed runtimes (R18); reviews land in `technical-design/reviews/`.
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Two independent reviewers (Codex and Seed runtimes, R18) review the draft; the TeamLeader adjudicates every finding into `technical-design/final.md` and asks for development approval. The delivery is a new PR on `next` that includes PR #369's content (R4).
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task adds one delivery line to that PR's record (draft §3.11): #369 is not merged and its content ships through this task's PR.
- Related tasks: None.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
