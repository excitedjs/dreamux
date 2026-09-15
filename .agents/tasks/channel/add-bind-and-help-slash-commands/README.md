# Feishu /bind and /help slash commands

## Current state

- Goal: Add /bind <team_name> and /help to the Feishu slash-command table, and settle whether the table needs an argument-parsing library
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/channel/add-bind-and-help-slash-commands/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/channel/add-bind-and-help-slash-commands/technical-design/final.md)
- Solution review Issue: [#426](https://github.com/excitedjs/dreamux/issues/426)
- Blockers: None. Requirement converged and the solution was reviewed on issue #426; every finding is adjudicated in the final solution.
- Next action: Implementation by one developer TeamMate, then TeamLeader pre-review.
- Related tasks: [add-feishu-slash-commands](/.agents/tasks/channel/add-feishu-slash-commands/README.md) built the command table this task extends.

## Development approval

- Status: **Granted by the operator on 2026-09-15**, in answer to a
  development-authorization card sent through `ask_user_question` in the Feishu
  work group. The card played back the acceptance criteria, implementation
  scope, non-goals, verification plan, and two residual risks, and named
  `requirement.md` plus `technical-design/final.md` as the boundary. The
  operator's answer, verbatim: "批准，开工".
- The card was re-sent once. The first card was answered with a question rather
  than an approval — "现在的 bind 应该不支持 bind 到话题吧？话题的绑定关系是不是
  只有协作空间可以做到？" — which was answered before approval was asked again.
  A question is not an approval.
- Approved implementation boundary:
  [requirement.md](/.agents/tasks/channel/add-bind-and-help-slash-commands/requirement.md)
  plus
  [technical-design/final.md](/.agents/tasks/channel/add-bind-and-help-slash-commands/technical-design/final.md).
  Anything outside them returns to the operator.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
