# Keep question-card replies in their topic

## Current state

- Goal: Keep follow-up questions in the answered card's topic.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/fix-question-card-topic-routing/requirement.md)
- Final solution: [Actual-card routing](/.agents/tasks/channel/fix-question-card-topic-routing/technical-design/final.md)
- Verification: [Evidence](/.agents/tasks/channel/fix-question-card-topic-routing/verification.md)
- Solution review Issue: None; the operator approved the replacement in conversation, and PR #402 served as the review surface.
- Blockers: None.
- Next action: None.
- Related tasks: Found during [COT display work](../refine-cot-tool-details-and-notifications/README.md); this is an independent, pre-existing routing defect.

## Development approval

On 2026-09-10 the operator approved replacing the minimal repair with direct
reply addressing and message-query-based settlement routing:
“可以，改一下提个 pr 上去我看看”. The current requirement and final solution record
that proposal. This approval includes removal of the precomputed round target,
the shared expiry resolution path, and one message lookup per settlement.

### Earlier minimal repair approval

The operator requested the repair on 2026-09-10 after the diagnosis was reported:
“修一下这个回复卡片问题”. The accompanying constraint was:
“我的回复消息应该带上的是回复的卡片的message_id，不应该带别的。”

Approved boundary: question-card topic routing with the answered card identity
preserved. The TeamLeader owns this mechanically direct local repair and its
verification; no public or persisted contract changes.

## Delivery

- Pull request: https://github.com/excitedjs/dreamux/pull/402.
- Knowledge closeout: Channel and product documentation updated for actual-card routing.

## Review workflow ruling

The operator explicitly replaced the planned independent workflow review:
“不要跑 dynamic-workflow 了。你直接找 devbox 去 review” (2026-09-10).
No workflow review was started. TeamLeader pre-review and repository checks run
before publication; DevBox reviews the updated PR directly. The previous approval
of the minimal patch is not a review of this revision.
