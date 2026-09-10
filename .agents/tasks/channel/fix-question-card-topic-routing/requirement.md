# Requirement

## Confirmed outcome

The operator requested a fix for follow-up question cards opening a new topic.
The answer must carry the message id of the card being answered:
“我的回复消息应该带上的是回复的卡片的message_id，不应该带别的。”

## Current source evidence

`askUserQuestion` resolves the original message's target and sends a card, but
never records the resulting card id in `FeishuTargetRouter`. Settlement already
uses the card id in both the answer envelope and presentation anchor. A later
question addressed to that card misses the router's observed-message ledger and
falls back to the group; transport receives no reply anchor and creates a new
message/topic. The defect predates the COT display change.

## Scope and invariants

- Keep successive question/answer rounds in an already observed topic.
- Preserve the answered card id in the answer envelope and presentation anchor.
- Reuse the existing message-to-target ledger and its lifetime and bounds.
- Leave no-message, unknown-message and cross-chat behavior unchanged.
- No new fields, persistence, API lookup, routing fallback, or COT display change.

## Acceptance

1. A question addressed to an observed message is sent in its topic.
2. Clicking and submitting it delivers the actual card id as `message_id` and
   the presentation anchor; neither the earlier message nor the synthetic round
   id replaces it.
3. A second question using that answer's `message_id` stays in the same topic,
   and its answer carries the second card's id.
4. Existing routing, question registry and settlement tests continue to pass.

No unsettled product decisions remain within this boundary.
