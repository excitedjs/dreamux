# Give the Dispatcher Agent its own Commands

## Current state

- Goal: Give the Dispatcher Agent its own submit and interrupt Commands, make the Team Commands address only Teams, and reply a failure notice in place when Collaboration Space provisioning cannot deliver
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-dispatcher-submit-command/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/architecture/add-dispatcher-submit-command/technical-design/final.md)
- Solution review Issue: https://github.com/excitedjs/dreamux/issues/443
- Blockers: None.
- Solution path: TeamLeader-authored solution with external Devbox review. Proposed on a 2026-09-17 card that went unanswered; the operator then said "先把需求1 做了" and was told this path is being used.
- Next action: Enter development — one developer TeamMate on the operator-named `seed` runtime, then TeamLeader pre-review.
- Related tasks: supersedes the Dispatcher addressing of `team.submit` settled in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Add runtime config Commands](/.agents/tasks/architecture/add-runtime-config-commands/README.md).

## Solution review

- Devbox reviewed Issue #443 against `next` after #440 merged; TeamLeader adjudication is recorded at the end of the final solution (six accepted, one rejected and withdrawn by the reviewer).

## Development approval

- Status: Granted.
- Evidence: a development-authorization card was sent at 2026-09-17 15:06 UTC after a full playback of the requirement, final solution, scope, non-goals, and verification plan, asking whether to enter development against this requirement and the final solution (Issue #443). The operator answered it at 2026-09-17 16:03 UTC: "拉一个seed 作为开发节点。开始开发" — approval, with the developer TeamMate to run on the `seed` agent runtime.
- Approved implementation boundary: the Core Dispatcher and Team Command definitions, `DispatcherService` interrupt split, the shared Channel-facing submission reader (`service/channel-submission.ts` rewrite), the `dreamux-types` submit command types, the Feishu Channel `submit` / `deliver` / inbound notice / `/stop` changes and the comments they falsify, and the tests listed under Verification in the final solution. Knowledge updates and change notes are TeamLeader closeout work.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
