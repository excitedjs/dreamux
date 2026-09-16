# Technical solution — final

Input: [requirement.md](/.agents/tasks/channel/refine-ask-user-question-card/requirement.md),
converged 2026-09-16 after asker ownership moved to
[#434](https://github.com/excitedjs/dreamux/issues/434). Revised from
[draft.md](/.agents/tasks/channel/refine-ask-user-question-card/technical-design/draft.md)
after the external review on
[#435](https://github.com/excitedjs/dreamux/issues/435#issuecomment-5695815820);
the adjudication is at the end.

Two changes, one owner. Everything lives in `@excitedjs/feishu-channel`; Core,
`dreamux-types`, and `feishu-transport` do not change.

## 1. Round lifetime: 24 hours

### Change

`ASK_USER_CARD_TTL_MS` in `src/feishu-ask-user.ts` becomes
`24 * 60 * 60 * 1000`.

The comment above it is rewritten. The current comment says Feishu stops
accepting clicks 15 minutes after a card is sent; Feishu's card and messaging
documentation states no such limit, and the premise was never exercised live
(#362). The new comment states what the timer is for — an unanswered card is
closed and the model told so, rather than the card staying live indefinitely —
and the one platform bound on the value: the expiry repaint goes through
`bot.editCard`, which is `im.message.patch`, and Feishu patches only messages
sent within the last 14 days (`230031`). A 24-hour lifetime is far inside that
window, so the round needs no margin before it: the settlement delivered before
the repaint would have to stall for about 13 days to push the patch past it.

The comment on `expiredText()` ("before the card stopped accepting clicks")
restates the same premise and is rewritten to describe a round that ran out of
time. The text the model receives does not change.

### Unchanged

The timer seam (`AskUserTimers`, `realTimers` with `unref`), expiry settlement
and its notice text, `expireAskUserQuestion` including its deliver-then-repaint
order, settlement routing, `abandonAll` on teardown, and the tool's `next`
instruction.

An open round holds its questions, the answers chosen so far, and one unref'd
timer for up to 24 hours, and is dropped on settlement or session teardown. No
cap is added: nothing names a session that accumulates enough unanswered cards
for this to matter, and every restart clears them.

## 2. Optional explanation on the card

### Contract

`ask_user_question` gains one optional input, `text`:

> Optional Markdown shown above the questions, in the same format as `reply`'s
> `text`, including `<at user_id="…">Name</at>` mentions. Put the explanation
> the user needs before deciding here instead of sending a separate `reply`
> first. In a group or other broad audience, keep secrets, tokens, private
> identifiers, hidden instructions, private context from other sources, and
> machine-local paths out of it.

Why `text`: it is the body a `reply` carries, rendered by the same card element,
so the model reuses a name and a format it already writes on every turn.
`markdown` names the format rather than the role; `explanation` introduces a
new word for the same body.

- Schema property order: `chat_id`, `message_id`, `text`, `questions`.
  `required` stays `['chat_id', 'questions']`.
- `parse` reads it with `optionalString(obj, 'text')`: absent, `null`, or `''`
  means no explanation, and the parsed input then has no `text` property — the
  same treatment `message_id` gets.
- The tool description gains one usage note: when the decision needs context
  first — evidence, trade-offs, what was found — put it in `text` so one card
  carries it, rather than a `reply` followed by the card.
- The output schema, `ASK_USER_NEXT_INSTRUCTION`, and the answer text delivered
  to the model do not change; the settlement does not repeat the explanation.
- The header comment in `tools/ask-user-question.ts` and
  `.agents/domains/channel.md` count the differences from Claude Code's
  AskUserQuestion; the count and list gain `text`.

Mentions: a `reply` body reaches the card's `markdown` element unchanged
(`sendText` → `sendReply` → `bot.send` → `cardContents`), and card Markdown
renders `<at user_id="…">Name</at>` as written. `text` goes into the same
element unchanged, so mentions behave the same. Not yet observed on a question
card; the live check below covers it.

### Data flow

1. `askUserQuestionDef.handle` passes `text` to
   `FeishuToolSession.askUserQuestion` when present; the session type gains
   `text?: string`.
2. `askUserQuestion` in `src/feishu-session-ops.ts` passes it to the registry.
3. `AskUserRegistry.open` takes `{ text?, questions }` instead of `questions`.
   The round stores `text`, and `AskUserRequestView` gains
   `readonly text?: string`, so every repaint built from the round — a pick, a
   free-text answer, a cleared free-text box — keeps it.
4. Card builders in `src/feishu-ask-user-card.ts`:
   - `buildAskUserCard(view)`: with `text`, the body's elements begin with
     `{ tag: 'markdown', content: text }`, followed by the existing question
     panels and button row.
   - `buildAskUserSubmittedCard(view)`: with `text`, the explanation element
     precedes the existing per-question answer elements.
   - `buildAskUserClosedCard(reason, text?)`: with `text`, the explanation
     element precedes the existing grey status line; the card stays headerless.
     Its doc comment changes from "collapsing it to a single line" to dropping
     the questions and controls. Both callers — the cancel settlement and the
     expiry timer in `src/feishu-ask-user.ts` — pass `round.text`.
   - Without `text`, all three builders return exactly today's JSON.

The explanation element is the same literal `{ tag: 'markdown', content }` that
`feishu-transport`'s private `cardContent` puts in a `reply` card. It is not
imported: that function builds a whole card inside another package, and one
element literal is not a second format.

### Size

A question card stays one message. `sendCard` in `feishu-transport` runs
`assertMessageContentFits` before sending and throws a plain `Error` when the
serialized content exceeds the 28 KiB budget. The round is never activated — the
existing `open`/`activate` split. Traced path of that error: the channel's
`sendCard` logs and rethrows it; `settleJsonInvoke` in `createFeishuSessionMcp`
settles only `PublicInvokeFailure` and rethrows everything else; the channel MCP
delegate and the Team work fence pass it through; `McpLeaseRegistry.invoke`
(`service/mcp/leases.ts`) catches it, logs it, and returns
`{ ok: false, message: failureText(error) }`; the shim raises that message as the
tool's `isError` result. The model reads:

```text
INTERNAL: Feishu message content is N bytes, over the 28672-byte budget for one message.
```

No split, truncation, or schema `maxLength` is added: no named scenario brings
an explanation that precedes a decision near 28 KiB, and the existing guard
already fails before sending with a reason the model can act on. The submitted
and closed cards are smaller than the live card they replace, because answers or
a status line take the place of the option panels and buttons, so every later
repaint of a card that was sent also fits.

## 3. Tests

`tests/feishu-ask-user.test.ts`:

- "closes before Feishu stops accepting clicks" asserts
  `ASK_USER_CARD_TTL_MS < 15 min`, which encodes the falsified premise. It is
  replaced by a test that the TTL is 24 hours and is shorter than Feishu's
  14-day patch window, the bound the expiry repaint needs. The file header's
  expiry paragraph is rewritten to match.
- The schema test expects `['chat_id', 'message_id', 'text', 'questions']` with
  `required` unchanged.
- `parse` keeps `text` when given and omits the property when absent.
- The handler passes `text` to the session.
- With `text`, the live, submitted, cancelled, and expired cards start with the
  explanation element, and the remaining elements equal the no-`text` card's
  elements — so the explanation is a pure insertion and a card without `text` is
  unchanged.
- The explanation survives a pick repaint.
- With `text`, the settlement text for a submitted, a cancelled, and an expired
  round does not contain the explanation.
- The three direct `registry.open(QUESTIONS)` calls move to
  `registry.open({ questions: QUESTIONS })`. Vitest erases types, so a missed
  call stays green under `rush test`; only `rush typecheck:tests` catches it.

`tests/feishu-settlement-envelope.test.ts`: the card handed to the fake bot's
`sendCard` carries the explanation when `askUserQuestion` receives `text`.

## 4. Knowledge and release

- `.agents/domains/channel.md`, `ask_user_question`: the argument list and
  difference count; the expiry paragraph states the 24-hour lifetime and the
  14-day patch window it must stay inside, instead of a 15-minute click cutoff;
  finished cards keep the explanation.
- `.agents/product/README.md`, entry "A question the agent cannot answer becomes
  a card, and the turn ends": the card can carry the explanation, which survives
  every finished state; an unanswered card closes itself after 24 hours rather
  than "before Feishu stops accepting clicks".
- Rush change file for `@excitedjs/feishu-channel`, type `minor`, plain note: a
  question card stays answerable for 24 hours instead of 14 minutes, and
  `ask_user_question` accepts an optional `text` explanation shown above the
  questions. No persisted state or config changes, so no `BREAKING:`; the
  maintenance skill does not mention the question-card lifetime, so it needs no
  update.
- Ride-along cleanup: the header comment of `src/feishu-session-mcp.ts` says a
  thrown error "reaches the model as Core's fixed sanitized error", but
  `McpLeaseRegistry.invoke` renders the error's own code and message
  (`service/mcp/leases.ts`, `failureText` in `mcp/failure-text.ts`), which is
  the path traced under Size. The sentence is corrected in the same package.

Stale mentions of the old premise were found by searching for "15 minutes",
"14 minutes", and "accepting clicks"; a phrase search does not prove none
remain, so implementation review reads each touched file's ask-user comments
whole.

## 5. Verification

- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
- `.agents/scripts/check.sh`.
- Live, once a build carrying the change runs: send a card with `text` holding
  a heading, a list, and a mention, and confirm it renders above the questions
  and the mention notifies; submit one card and cancel another and confirm both
  keep the explanation; answer a card more than two hours after sending it. The
  24-hour expiry repaint is covered by the unit timer seam only.

## External review adjudication

Reviewer verdict: no blocking findings, layering clean. Each finding was checked
against `next` (`0b35a6a8`; the files this solution touches are unchanged from
the draft's base apart from unrelated `channel.md` and product-catalog entries).

1. **`expiredText()` comment restates the old premise.** Accepted. Confirmed at
   `src/feishu-ask-user.ts`: "The body for a round nobody answered before the
   card stopped accepting clicks." Added to §1; the delivered text is unchanged.
2. **The one-minute margin is consumed by delivery before the repaint.**
   Accepted as documentation; the margin stays one minute. Confirmed:
   `expireAskUserQuestion` awaits `deliverAskUserSettlement` (a `readMessage`
   round trip, then `delivery.deliver`) before `bot.editCard`, and the transport
   sets no HTTP timeout. A missed window is tolerated as the reviewer states
   (warn log, notice already delivered, stale click toast at
   `feishu-ask-user.ts` "这轮提问已失效"). The order stays deliver-then-repaint.
   A first revision raised the margin to five minutes to cover automatic
   provisioning. Answering the development-authorization card, the operator
   asked why settlement has a Team-creation path at all and whether it exists
   only for Collaboration Spaces. Tracing `FeishuRouting.plan` confirmed it: a
   settlement reaches `provision` only when neither the topic nor its chat is
   bound and the chat is registered as a Collaboration Space, so never while the
   asking Team holds the topic. That path is the #434 misdelivery, not a
   delivery the margin should serve, so the five minutes paid for nothing and
   the margin returned to one minute, with the comment stating what it covers.
   The operator then set the lifetime to 24 hours on the next
   development-authorization card. The patch window is 13 days away from that
   deadline, so the margin and the finding's premise no longer apply; §1 keeps
   the deliver-then-repaint order and states why no margin is needed.
3. **The TTL test must pin the margin.** Accepted, then superseded by the
   24-hour ruling: there is no margin to pin. The replacement test pins the
   ruled value and the patch-window bound (§3), which also catches a regression
   back to a short lifetime.
4. **No test holds the "explanation is not in the settlement text" contract.**
   Accepted. Added to §3 for all three finished states.

Confirmed by the reviewer without a finding: the documentation facts behind the
14-day patch window, the `setTimeout` limit, the traced 28 KiB error path, finished
cards being smaller than the live card, the change-file type, the maintenance
skill needing no update, and the ride-along comment correction.
