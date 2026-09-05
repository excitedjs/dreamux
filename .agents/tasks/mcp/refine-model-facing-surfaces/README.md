# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `solution`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R20 recorded verbatim, evidence, and proposed changes 1–12; frozen for the solution phase at the revision that records R20 (2026-09-06).
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: None.
- Next action: The TeamLeader writes `technical-design/draft.md` on the simple path (R17), then two independent reviewers on the Codex and Seed runtimes review it (R18); the TeamLeader adjudicates into `technical-design/final.md` and asks for development approval. The delivery is a new PR on `next` that includes PR #369's content (R4).
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task does not change that PR's record.
- Related tasks: None.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
