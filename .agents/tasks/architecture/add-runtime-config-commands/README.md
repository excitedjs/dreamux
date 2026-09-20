# Add runtime config Commands

## Current state

- Goal: Move every persisted runtime store onto one transactional store kind (file first, then memory), and add a Config Service with Core Commands that let a Channel read and replace the `agents` section of config.json at runtime
- State: `awaiting-development-approval`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/architecture/add-runtime-config-commands/technical-design/final.md)
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/448
- Solution path: three independent proposals with one cross-review round, merged by the TeamLeader into `technical-design/final.md`, then reviewed by Devbox on a GitHub Issue (operator, 2026-09-19: "三份独立方案（推荐）").
- Solution input: `requirement.md` and `rulings.md` as committed with this state change.
- Blockers: None. The sequencing blocker cleared when the Dispatcher Command task merged (#444, 2026-09-18); the operator chose to continue this task in the same Team.
- Authority order: the confirmed final product shape decides. Existing code, prior decisions, and existing documents are evidence of how the system got here; any of them may be overturned to fit the current product scenario, knowingly — by naming what is being changed and why its original rationale no longer holds. User-visible behavior changes are operator decisions. This is a multi-stage architecture refactor; [`rulings.md`](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md) is its rulings ledger.
- Next action: None. The operator deferred development on 2026-09-21; the task waits for a new development-authorization decision from them.
- Related tasks: changes a configuration-ownership decision recorded in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md).

## Development approval

- Status: Not granted. A development-authorization card was sent on 2026-09-21 through the channel's question card, playing back the recorded requirement, the final solution, the three-pull-request implementation scope, and the verification plan. The operator answered "暂不开发" — development is not authorized. The same card re-confirmed write validation by the next start's rules and the `workflow_status` change; both are recorded in [`rulings.md`](/.agents/tasks/architecture/add-runtime-config-commands/rulings.md).
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
