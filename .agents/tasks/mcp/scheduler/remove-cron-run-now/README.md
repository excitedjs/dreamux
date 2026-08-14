# Remove cron run-now capability

## Current state

- Goal: Remove the broken cron immediate-run capability and its complete dependency chain without compatibility aliases or unused code.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/scheduler/remove-cron-run-now/requirement.md)
- Final solution: [Final solution](/.agents/tasks/mcp/scheduler/remove-cron-run-now/technical-design/final.md)
- Verification: [Verification](/.agents/tasks/mcp/scheduler/remove-cron-run-now/verification.md)
- Solution review Issue: [#334](https://github.com/excitedjs/dreamux/issues/334)
- Blockers: None.
- Next action: Await explicit operator direction before merging pull request
  [#335](https://github.com/excitedjs/dreamux/pull/335).
- Related tasks: None.

## Development approval

- Status: Confirmed by the operator on 2026-08-14 for the existing
  implementation and direct transition to review.
- Approved implementation boundary: The recorded requirement and final solution;
  pure removal of both run-now entries and their dependency chain, with timer
  behavior preserved and no replacement capability, plus the operator-directed
  capability-domain task-record routing correction.

## Delivery

- Pull request / CI / merge: Pull request
  [#335](https://github.com/excitedjs/dreamux/pull/335) is open against `next`;
  CI and merge state are tracked on the pull request, and no merge has been
  performed.
- Knowledge closeout: Complete. Current behavior is recorded in the package
  README, bundled workflow skills, dispatcher and service-topology references;
  superseded scheduler proposals are archived. Capability-domain task routing is
  recorded in
  [Capability-domain task routing](/.agents/decisions/capability-domain-task-routing.md).
