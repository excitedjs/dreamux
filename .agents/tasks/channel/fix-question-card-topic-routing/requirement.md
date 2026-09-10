# Requirement

## Current approved outcome (2026-09-10)

The original constraint was: “我的回复消息应该带上的是回复的卡片的message_id，不应该带别的。”
After reviewing the minimal repair, the operator approved the proposed replacement:
“可以，改一下提个 pr 上去我看看”. The accepted proposal separates sending a card
from routing its answer:

- Send exactly as `reply` does: an explicit `message_id` addresses a reply to
  that message; without it, create a message in `chat_id`.
- Route submitted and cancelled answers from the actual card's message details,
  using the callback's card message id. Preserve that id in the answer envelope
  and presentation anchor.
- Expiry uses the sent card id through the same message-query and delivery path.
- Remove the question round's precomputed `target`. Resolve the card's actual
  chat/topic through Feishu message lookup and the existing binding router.
- A failed lookup is a delivery failure, never evidence that the answer belongs
  to the parent chat or Dispatcher. One lookup per settlement is accepted.
- Keep this change within Feishu transport/channel. No Core, runtime provider,
  shared Dreamux contract, persistence, new routing cache, or COT display change.

This supersedes the earlier restriction on API lookup and on preserving unknown
message and cross-chat send behavior: sending now follows the explicit message id
just as `reply` does. It does not change unrelated notification sending.

## Current source evidence

Feishu callback context exposes `open_message_id` and `open_chat_id`, but no
`thread_id`. The existing `im.v1.message.get` reader discards the response's chat
and topic fields. Expose those Feishu facts and reuse existing inbound routing.
The current question registry stores a target inferred before sending; its
settlement carries that target even if the actual card was sent elsewhere.

Official contracts:

- [Card callback](https://open.larkoffice.com/document/feishu-cards/card-callback-communication)
- [Message details](https://open.larkoffice.com/document/server-docs/im-v1/message/get)

## Acceptance

1. Explicit message ids reach the card reply transport unchanged, including an
   id absent from the observation ledger. No id still creates a new message.
2. Submitted and cancelled answers resolve the actual card's chat/topic, and
   carry that card id in both their envelope and anchor.
3. Consecutive rounds remain in the actual topic without relying on prior card
   observation. Expiry uses the sent card id and the same resolution path.
4. Lookup failures do not deliver to an inferred parent chat or Dispatcher.
5. Existing ordinary-message routing, card lifecycle, and content-reading
   behavior remain intact. No precomputed target survives in a question round.

## Earlier minimal repair (superseded)

### Earlier source evidence

`askUserQuestion` resolves the original message's target and sends a card, but
never records the resulting card id in `FeishuTargetRouter`. Settlement already
uses the card id in both the answer envelope and presentation anchor. A later
question addressed to that card misses the router's observed-message ledger and
falls back to the group; transport receives no reply anchor and creates a new
message/topic. The defect predates the COT display change.

### Earlier scope and invariants

- Keep successive question/answer rounds in an already observed topic.
- Preserve the answered card id in the answer envelope and presentation anchor.
- Reuse the existing message-to-target ledger and its lifetime and bounds.
- Leave no-message, unknown-message and cross-chat behavior unchanged.
- No new fields, persistence, API lookup, routing fallback, or COT display change.

### Earlier acceptance

1. A question addressed to an observed message is sent in its topic.
2. Clicking and submitting it delivers the actual card id as `message_id` and
   the presentation anchor; neither the earlier message nor the synthetic round
   id replaces it.
3. A second question using that answer's `message_id` stays in the same topic,
   and its answer carries the second card's id.
4. Existing routing, question registry and settlement tests continue to pass.

These restrictions describe the earlier repair, not the current brief.
