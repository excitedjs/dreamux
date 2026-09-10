# Keep question-card replies in their topic

- Goal: Keep follow-up questions in the answered card's topic.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/fix-question-card-topic-routing/requirement.md)
- Final solution: [Minimal repair](/.agents/tasks/channel/fix-question-card-topic-routing/technical-design/final.md)
- Verification: [Evidence](/.agents/tasks/channel/fix-question-card-topic-routing/verification.md)
- Solution review Issue: Not needed for the minimal-change fast path.
- Blockers: None.
- Next action: Open the reviewed repair PR to next and wait for CI.
- Related tasks: Found during [COT display work](../refine-cot-tool-details-and-notifications/README.md); this is an independent, pre-existing routing defect.

## Development approval

The operator requested the repair on 2026-09-10 after the diagnosis was reported:
“修一下这个回复卡片问题”. The accompanying constraint was:
“我的回复消息应该带上的是回复的卡片的message_id，不应该带别的。”

Approved boundary: question-card topic routing with the answered card identity
preserved. The TeamLeader owns this mechanically direct local repair and its
verification; no public or persisted contract changes.

## Delivery

- Baseline: `22cf0a7a53ea636daad9c939ff2185e3379bc42e` from freshly fetched next.
- Pull request / CI / merge: Pending.
- Knowledge closeout: Complete; channel domain and product behavior match the reviewed implementation.
