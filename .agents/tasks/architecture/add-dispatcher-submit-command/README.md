# Give the Dispatcher Agent its own Commands

## Current state

- Goal: Give the Dispatcher Agent its own submit and interrupt Commands, make the Team Commands address only Teams, and reply a failure notice in place when Collaboration Space provisioning cannot deliver
- State: `awaiting-development-approval`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-dispatcher-submit-command/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/architecture/add-dispatcher-submit-command/technical-design/final.md)
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/443
- Blockers: None.
- Solution path: TeamLeader-authored solution with external Devbox review. Proposed on a 2026-09-17 card that went unanswered; the operator then said "先把需求1 做了" and was told this path is being used.
- Next action: Development-authorization card to the operator.
- Related tasks: supersedes the Dispatcher addressing of `team.submit` settled in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md).

## Solution review

- Devbox reviewed Issue #443 against `next` after #440 merged; TeamLeader adjudication is recorded at the end of the final solution (six accepted, one rejected).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
