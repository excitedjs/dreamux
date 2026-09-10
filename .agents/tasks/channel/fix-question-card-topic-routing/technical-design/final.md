# Route question answers from the actual card

Approved on 2026-09-10 after the minimal observation-ledger repair in PR #402.

Sending a question uses the caller's chat id and optional reply message id
directly, matching `reply`. It no longer passes through `outboundTarget` and
`notificationTarget` to select a different anchor or silently create a new topic
on an observation miss.

The registry owns questions, answers, expiry and the sent card id, not a
precomputed routing target. A submitted or cancelled settlement uses the card id
reported by its callback. Expiry uses the card id recorded on successful send.
Both reach the same settlement delivery path.

That path queries the existing Feishu message reader for the actual card, obtains
its chat and optional thread id, and resolves them through existing Feishu
chat-mode and binding routing. Preserve normal topic-group versus ordinary-chat
semantics. The answer envelope and presentation anchor use the actual card id.
A lookup failure follows the existing delivery-failure handling and does not
fall back to guessed parent-chat or Dispatcher delivery.

Expose the message response's chat/topic metadata in the existing Feishu reader.
The HTTP operation already exists; no new cache, persistence, Core or provider
surface is needed. This costs one message lookup per settlement, as approved.
Unrelated notifications and ordinary-message delivery remain unchanged.

Validation covers direct reply addressing without an observation, no-id creation,
submitted/cancelled answers, consecutive rounds, expiry, and lookup failure without
misdelivery. Existing content reads must still work. Run Rush build, lint, test,
typecheck:tests and built-CLI smoke, change verification and KB checks; independently
review the complete resulting PR diff before publication.
