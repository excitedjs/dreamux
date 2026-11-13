# Stop a Feishu event redelivery from opening a duplicate COT card

## Current state

- Goal: A Feishu inbound event that the platform re-pushes because the acknowledgement missed its deadline must not open a second COT card or re-run inbound work the first delivery already did.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/requirement.md)
- Requirement revision: 2026-11-12, after five operator decisions (symptom
  shape, acknowledgement timing as the fix layer, residual duplicates accepted,
  failure recovery owned by Dreamux, #63 gate assertions rewritten).
- Final solution: [Final solution](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/technical-design/final.md)
- Verification: [Verification](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/verification.md)
- Implementation review: [Implementation review](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/review.md)
- Solution review Issue: Not created.
- Blockers: None.
- Next action: Close out knowledge and move the record to `done`.

## Solution confirmation

- Sent 2026-11-12 (card `47ccfe2679596cc5`); approved the same day with
  「确认，继续」. The confirmed boundary is exactly
  [the final solution](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/technical-design/final.md):
  the transport identity wrapper, the two detached routes, the corrected ACK
  statements, the #63 gate wait, and the channel test-harness waits. Channel-side
  dedupe, durable replay, COT anchor behaviour, and Core are out of scope.

## Development approval

- Status: Granted 2026-11-12.
- Card `7be5a8793f84502f`; approving response 「授权开发（推荐）」, same day.
- Approved implementation boundary: exactly
  [the final solution](/.agents/tasks/channel/stop-feishu-redelivery-duplicate-cards/technical-design/final.md) —
  the transport identity wrapper, the two detached routes, the corrected ACK
  statements, the #63 gate wait, the channel test-harness waits, and the
  bot-added event-id read.
- Scope addition, same day: the operator asked for the bot-added event-id
  defect to be fixed in this task rather than deferred (「follow up 的这个小修顺手修掉」).
  It is recorded in the requirement and as item 6 of the final solution; it
  needs no separate approval because it is a defect repair against behavior the
  knowledge base already records, and the operator named it.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
- Related tasks: None.
