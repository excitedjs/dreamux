# Default workspace isolation to false

## Current state

- Goal: Change only the workspace default from true to false while preserving explicit configuration.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/change-workspace-default/requirement.md)
- Final solution: [Default-value substitution](/.agents/tasks/architecture/change-workspace-default/technical-design/final.md).
- Blockers: None.
- Next action: Present PR #411 for the operator's merge decision.
- Related tasks: None.

## Development approval

- Status: On 2026-09-11 the operator clarified the scope at 12:23 and explicitly
  authorized development at 13:04 with "开始开发". Exact wording is in the requirement.
- Approved implementation boundary: Only the workspace default changes from true
  to false. Corresponding regression checks and current default documentation
  accompany that change.

## Delivery

- Verification: [Checks and scope](/.agents/tasks/architecture/change-workspace-default/verification.md).
- Pull request: [#411](https://github.com/excitedjs/dreamux/pull/411).
- Review: [Approved with no blocking findings](https://github.com/excitedjs/dreamux/pull/411#pullrequestreview-5175266391).
- CI: All nine checks passed on the reviewed implementation; the documentation
  closeout follows the same CI gate. The PR records the final result.
- Merge: Awaiting operator confirmation.
- Knowledge closeout: Complete. Maintenance configuration guidance,
  [state/config](/.agents/domains/state-config-and-files.md),
  [dispatcher workspaces](/.agents/domains/dispatcher-orchestration.md), and the
  [product catalog](/.agents/product/README.md) state the authorized default.
