# Refine the model-facing surfaces of the TeamLeader

## Current state

- Goal: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used.
- State: `clarification`
- Requirement: [Current requirement](/.agents/tasks/mcp/refine-model-facing-surfaces/requirement.md) — operator rulings R1–R3 recorded verbatim, evidence inventory, proposed changes, and the open decisions.
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: Open decisions (a), (d), (e), (h), (i) in the requirement; the mid-turn completion-delivery fact is being probed by this TeamLeader.
- Next action: The operator answers the remaining open decisions (second question card); the TeamLeader records the probe result, then writes the solution for a new PR on `next` that includes PR #369's content (R4).
- Lineage: the deep review of PR #369 (https://github.com/excitedjs/dreamux/pull/369) on 2026-09-05; that PR's own record (`relocate-role-skill-guidance`, on the PR branch) holds the 2026-09-02 rulings this task builds on. This task does not change that PR's record.
- Related tasks: None.

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
