# Stream opt-in reasoning into Feishu COT

## Current state

- Goal: Display native reasoning increments with a Thinking prefix, throttle COT updates, and label TeamMate messages to their leader.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/stream-cot-reasoning/requirement.md)
- Final solution: [Technical solution](/.agents/tasks/channel/stream-cot-reasoning/technical-design/final.md)
- Verification: [Evidence and coverage limits](/.agents/tasks/channel/stream-cot-reasoning/verification.md)
- Scope authority: The operator requested the four changes on 2026-10-22; the direct request is quoted in the requirement. No separate authorization card was sent.
- Next action: Follow the delivery PR in GitHub, which owns CI, review, and merge status.
- Related tasks: Builds on [conversation cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md) and [member messaging](/.agents/tasks/mcp/enable-team-member-messaging/README.md).

## Delivery

- Pull request: [#479](https://github.com/excitedjs/dreamux/pull/479), targeting `next`.
- Knowledge closeout: Provider, Channel, product, maintenance, and public configuration/usage documentation updated; independent review and repository gates passed.

## Historical baseline

The checkout was refreshed from `next` to `30da2c84` before implementation
because its previous baseline lacked member-to-owner messaging.
The later documentation-only update from [PR #477](https://github.com/excitedjs/dreamux/pull/477)
was incorporated before repository-wide checks; its new configuration and usage
guides are updated with the COT behavior in this change.
