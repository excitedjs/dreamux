# Requirement

## Initial request

The operator reported, in a Feishu group topic, that the Feishu channel keeps
producing a "re-sent" message: they see several COT cards for one message, and
recalled that Feishu re-pushes a long-connection event when no acknowledgement
arrives within some number of seconds. They asked whether it can be fixed.

## Reported symptom (operator's own words, 2026-11-12)

Asked which shape of "several cards" they were seeing, the operator answered:

> 前一张卡没任何内容，变成完成后开一张新卡，主要出现在我第一次发消息之后。

So: a card with no content is marked finished, and a new card opens in its
place — mainly after the first message they send.

## Confirmed current behavior and evidence

Verified against the pinned Lark SDK, this repository's source, and one
dispatcher's channel log (72 days, ~4.3k accepted inbounds).

- **The platform re-pushes.** Feishu requires an event to be handled within 3
  seconds; otherwise it re-pushes after 15 s, 5 min, 1 h and 6 h, at most four
  times. It also documents delivery as at-least-once even when handling
  succeeds. Long-connection delivery is not broadcast: exactly one client of the
  app receives a push.
- **The SDK acknowledges only after the handler settles.** There is no ack
  timer in the SDK and no event-level retry of its own; a throwing handler
  answers with a failure code, still only after the await.
- **This channel holds the handler open across the whole inbound path.** The
  route awaits gate, enrichment, attachment resolution and the Core submission;
  its own budget is 60 s for enrichment and 20 s for resources, far above the
  platform's 3 s.
- **The observed duplicates are a single retry, not a distribution.** 102
  duplicates over 72 days, each replaying an identical message id, arriving a
  median 13.9 s after the original submission — the tight mode expected from the
  15 s retry step.
- **Cold start is the trigger.** 89 of the 102 duplicates were the first inbound
  in their chat after at least a ten-minute gap, against a 43 % base rate for
  all submissions. This matches the operator's "after the first message I send":
  the first message of a session pays for the runtime start.
- **Core already refuses the second turn.** The admission ledger keys on the
  Channel-supplied source id, which for a chat message is the Feishu message id;
  a repeat after admission returns `duplicate` without touching the runtime.
  Measured: zero second turns, and duplicated messages averaged no more outbound
  sends than controls. So the duplicate costs no answer and no runtime call.
- **The visible defect is in the COT presentation.** The Channel claims the COT
  anchor and opens a receipt card *before* it invokes Core. A redelivery
  therefore advances the anchor again: it closes the card that was showing (an
  empty receipt, since the cold-started turn had not produced anything yet) and
  opens a fresh receipt card. Core then answers `duplicate`, which this Channel
  does not treat as proving no admission, so the fresh card is never retired —
  it becomes the card the rest of the turn writes into. Measured across 95
  pairs: the card a redelivery closes had a median life of 18.7 s and held only
  its opening label; its successor lived a median 133 s and was longer-lived in
  79 of 95 pairs.
- **The same redelivery also re-runs inbound work.** Gate decision, target
  projection, routing, a real user-lookup API call, the parent-message probe and
  attachment resolution all run again, and automatic provisioning replays its
  `team.create` under the message id.
- **Nothing at the Channel boundary dedupes.** The only event-id ledger in the
  repository is the bot-added one, and it is dead in production: it reads the
  event id from a nested envelope the SDK has already flattened, so the id it
  reads is always empty.
- **The existing duplicate-anchor behavior is pinned by a test**, not merely
  accidental: it drives a `duplicate` outcome and asserts two cards under one
  message with terminals `[done, null]`.

## Desired behavior

Confirmed in scope (operator, 2026-11-12): the fix is at the acknowledgement
timing. Asked which layer to fix — display only, display plus re-run, or also
the acknowledgement timing — the operator chose:

> 还要改 ack 时机

Asked how "do not reopen the card" would be decided, the operator answered that
the acknowledgement change makes it unnecessary:

> ack 解决了，没有重推，问题自然解决了

So the target outcome is: **an inbound event is acknowledged within the
platform's window, so the platform has no timeout reason to re-push it**, and
the duplicate card therefore stops happening as a consequence rather than being
patched at the anchor.

### Facts that constrain this outcome

- Feishu documents **two** duplicate sources, not one. Besides the timeout
  retry, it states that the whole delivery chain is at-least-once, so a
  duplicate can arrive **even when the event was handled successfully**.
  An acknowledgement change removes the timeout class only.
- Measured on the 102 duplicates in the log: 92 fall in the 3.9 s–120 s range
  consistent with the 15 s retry step; 10 arrived between 142 s and 625 s and do
  not fit the 15 s / 5 min schedule cleanly, which is the shape the
  at-least-once class would produce.
- The handler is held open across the entire inbound path today, and its own
  budget is 60 s. Most inbounds exceed the platform's 3 s window, so the
  timeout class is systematic rather than rare.
- A handler that throws makes the SDK answer with a failure code and the
  platform re-push, so holding the acknowledgement open is today's only
  automatic retry. The evidence below shows it has never recovered anything, so
  this is a side effect to retire rather than a capability to preserve.
- The session already owns the mechanism for detached work — tracked promises
  and a drain on close — and two sibling routes (card actions, document
  comments' long work) already hand their work back before finishing.
- One further ack-latency source sits in the transport, ahead of the route
  handler: while the bot's own identity is unresolved, each inbound awaits a
  bot-info lookup with up to three attempts and backoff before the route runs.

### The operator's ruling on failure recovery (2026-11-12)

Asked what should happen to an inbound that fails after an early
acknowledgement, the operator rejected the premise:

> 我也不知道。不过 这里是不是有悖论啊？飞书消息入站，我们只要收到了说明和飞书就没关系了，你不能依赖飞书的重推去做兜底啊，而且还是因为dreamux 内部错误要求飞书重推

The TeamLeader verified this before accepting it, and it holds:

- **The platform re-push has never actually recovered a failure here.** The log
  has eight failed submissions and 102 duplicates, with **zero overlap**: not one
  re-push ever landed on a message that had failed. So the recovery this change
  would trade away is theoretical, not observed.
- **The pipeline does not throw on a delivery failure anyway.** A failed,
  unsubmitted or rejected outcome is caught and reported as a log line, and a
  `submitted`-path error is swallowed unless it is an abort. Only an unexpected
  throw escapes to the SDK — and the SDK's own diagnostics recorded zero
  `invoke event failed` lines across 72 days.
- So the "automatic retry" was never a designed recovery path for internal
  failure; it is a side effect of holding the acknowledgement open. Retiring it
  is not a loss of a capability anyone built or relies on.

Confirmed as a result:

- Failure recovery is Dreamux's own responsibility, never the platform's. An
  inbound that fails after the acknowledgement is reported and dropped; no
  durable pre-acknowledgement record, no replay, no platform dependency.
- Residual at-least-once duplicates: the operator chose 「只改 ack，接受残留」 —
  change only the acknowledgement timing and accept the remainder. The
  duplicate-card defect that motivated this task is still to be answered
  separately, because a residual duplicate still re-runs the inbound path.

### The issue #63 live gate (operator decision, 2026-11-12)

That gate is recorded as load-bearing, so changing what it asserts is a
requirement decision. Presented with the conflict — its two assertions
(`turns()` already holds two entries, and the second one's ack precedes the
blocking command's completion) hold only because `onMessage` currently returns
after submission — the operator chose to rewrite the assertions:

> 重写断言（推荐）

Confirmed boundary for that rewrite: the gate must keep proving both facts it
exists for — a later inbound is not blocked by the running turn, and it folds
into the same native turn. Only the waiting mechanism changes: instead of
awaiting `onMessage` and counting turns synchronously, it waits for the second
`turn/start` to appear. Proving the same facts through a different wait is not a
weakening; deleting either fact would be.

## Scope

Confirmed:

- The acknowledgement timing for `im.message.receive_v1` and
  `drive.notice.comment_add_v1`.
- The bot-identity lookup that sits ahead of the message route.
- The knowledge statements and code comments that describe the old ordering.
- The tests those changes touch.

Added by the operator on 2026-11-12, after the TeamLeader reported it as a
separate follow-up: **the dead bot-added event-id read**.

> follow up 的这个小修顺手修掉

## Non-goals

- Any Channel-side dedupe of chat messages (the operator ruled 「只改 ack，接受残留」).
- Any durable pre-acknowledgement record, replay, or retry.
- The COT anchor's behaviour (`advanceAnchor` keeps no same-anchor short circuit;
  `submissionProvesNoAdmission` keeps its membership).
- Core's admission, submission, or projection.

## The bot-added event-id defect (scope addition, 2026-11-12)

`normalizeBotMemberAddedEvent` reads the event id from `raw.header.event_id`.
The Lark SDK flattens a v2 envelope before dispatching — `RequestHandle.parse`
destructures `header` and `event` away and spreads both onto the top level — so
what a handler receives carries `event_id` as a **top-level** key and no
`header` at all. Verified by dispatching a v2 envelope through the real
`EventDispatcher`: the handler received
`{schema, event_id, event_type, token, create_time, app_id, tenant_key, chat_id}`.

Consequences, both confirmed:

- The read always yields `''`, so `recordBotAdded`'s
  `if (eventId !== '' && entry.seenEventIds.includes(eventId))` never fires and
  the id list is never appended to. The only event-id dedupe in this repository
  is therefore dead.
- Observed in real state: one dispatcher's `chat-bots.json` holds 124 chats and
  **zero** recorded event ids in total.

Expected behavior: a redelivered `im.chat.member.bot.added_v1` is a no-op, as
the knowledge base already states (`.agents/domains/feishu-pairing-access.md`,
"recorded idempotently per chat by Feishu event id (a bounded seen-id list)").
This makes the code match that recorded behavior rather than changing it.

## Constraints and invariants

- Feishu delivery is at-least-once by contract, so no acknowledgement change can
  eliminate redelivery; the Channel has to be idempotent regardless.
- The queue-before-ACK ordering is recorded in the knowledge base and in code
  comments but carries no operator ruling; the issue #63 live gate depends on it.
- One earlier operator ruling is directly in scope if the fix dedupes at the
  Channel boundary: asked whether a redelivery executing a slash command twice
  should be fixed by adding a TTL-expiring seen-set in the Channel, the operator
  ruled 「可以先不动。」. A boundary dedupe would supersede that ruling, so it
  needs the operator's explicit decision rather than an inference.

## Acceptance criteria

1. An accepted inbound chat message no longer holds the platform acknowledgement
   for the duration of its work. Observed: the route returns before the Core
   submission settles, while the submission still completes.
2. The work is owned by the session before the acknowledgement: closing the
   session still waits for in-flight inbound work, and a message is never left
   unowned between acknowledgement and processing.
3. A failure after the acknowledgement is reported on the channel log and does
   not surface as an unhandled rejection. An abort caused by session teardown is
   not reported as a failure.
4. Document-comment events share the same acknowledgement shape, since they run
   the same unbounded submission work under the same deadline.
5. The issue #63 live gate still proves both facts it exists for — a later
   inbound is not blocked by the running turn, and it folds into the same native
   turn — waiting for the second `turn/start` rather than for `onMessage` to
   return.
6. A residual at-least-once duplicate is still refused by Core's admission
   ledger (no second turn, no second answer). It may still reopen a COT card;
   that is the accepted remainder of 「只改 ack，接受残留」 and is recorded as a
   known limitation rather than fixed here.
7. A redelivered `im.chat.member.bot.added_v1` records nothing the second time:
   the event id reaches the store non-empty, so the bounded seen-id list is
   actually populated and the second delivery is a no-op.

## Decisions and unknowns

- Confirmed operator decisions:
  - 2026-11-12: the observed symptom is an empty card being completed and a new
    card opening in its place, mainly after the first message of a session;
    quoted above.
  - 2026-11-12: a new task is opened to drive the fix.
  - 2026-11-12: the fix is at the acknowledgement timing (「还要改 ack 时机」),
    on the reasoning that no re-push means the duplicate problem disappears.
  - 2026-11-12: residual at-least-once duplicates are accepted rather than
    defended against (「只改 ack，接受残留」).
  - 2026-11-12: failure recovery belongs to Dreamux and must not depend on the
    platform re-pushing an event (quoted above).
  - 2026-11-12: the issue #63 live gate's assertions are rewritten to wait for
    the second `turn/start` instead of awaiting `onMessage`; the two facts it
    proves stay (「重写断言」).
- Assumptions: none recorded as accepted.
- Blocking unknowns: the open scope questions under Desired behavior.
