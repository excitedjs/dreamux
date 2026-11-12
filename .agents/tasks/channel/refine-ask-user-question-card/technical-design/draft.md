# Technical solution — draft for review

Input: [requirement.md](/.agents/tasks/channel/refine-ask-user-question-card/requirement.md),
converged 2026-09-16 after asker ownership moved to
[#434](https://github.com/excitedjs/dreamux/issues/434).

Two changes, one owner. Everything lives in `@excitedjs/feishu-channel`; Core,
`dreamux-types`, and `feishu-transport` do not change.

## 1. Round lifetime: 14 days minus one minute

### Change

`ASK_USER_CARD_TTL_MS` in `src/feishu-ask-user.ts` becomes
`14 * 24 * 60 * 60 * 1000 - 60 * 1000`.

The comment above it is rewritten around the bound that actually exists. The
current comment says Feishu stops accepting clicks 15 minutes after a card is
sent; Feishu's card and messaging documentation states no such limit, and the
premise was never exercised live (#362). The real bound is on the expiry
repaint: `expireAskUserQuestion` repaints through `bot.editCard`, which is
`im.message.patch`, and Feishu patches only messages sent within the last 14
days (`230031`). A round therefore closes one minute before that window ends,
so its repaint still lands.

### Unchanged

The timer seam (`AskUserTimers`, `realTimers` with `unref`), expiry settlement
and its notice text, `expireAskUserQuestion`, settlement routing,
`abandonAll` on teardown, and the tool's `next` instruction.

Node's `setTimeout` accepts delays up to 2^31−1 ms (about 24.8 days), so a
1,209,540,000 ms delay needs no chunking.

An open round holds its questions, the answers chosen so far, and one unref'd
timer for up to 14 days, and is dropped on settlement or session teardown. No
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
already fails before sending with a reason the model can act on. The submitted and
closed cards are smaller than the live card they replace, because answers or a
status line take the place of the option panels and buttons.

## 3. Tests

`tests/feishu-ask-user.test.ts`:

- "closes before Feishu stops accepting clicks" asserts
  `ASK_USER_CARD_TTL_MS < 15 min`, which encodes the falsified premise. It is
  replaced by an assertion that the TTL is under Feishu's 14-day patch window,
  and the file header's expiry paragraph is rewritten to match.
- The schema test expects `['chat_id', 'message_id', 'text', 'questions']` with
  `required` unchanged.
- `parse` keeps `text` when given and omits the property when absent.
- The handler passes `text` to the session.
- With `text`, the live, submitted, cancelled, and expired cards start with the
  explanation element, and the remaining elements equal the no-`text` card's
  elements — so the explanation is a pure insertion and a card without `text` is
  unchanged.
- The explanation survives a pick repaint.
- The three direct `registry.open(QUESTIONS)` calls move to
  `registry.open({ questions: QUESTIONS })`. Vitest erases types, so a missed
  call stays green under `rush test`; only `rush typecheck:tests` catches it.

`tests/feishu-settlement-envelope.test.ts`: the card handed to the fake bot's
`sendCard` carries the explanation when `askUserQuestion` receives `text`.

## 4. Knowledge and release

- `.agents/domains/channel.md`, `ask_user_question`: the argument list and
  difference count; the expiry paragraph states the 14-day patch window instead
  of a 15-minute click cutoff; finished cards keep the explanation.
- `.agents/product/README.md`, entry "A question the agent cannot answer becomes
  a card, and the turn ends": the card can carry the explanation, which survives
  every finished state; an unanswered card closes itself after 14 days rather
  than "before Feishu stops accepting clicks".
- Rush change file for `@excitedjs/feishu-channel`, type `minor`, plain note: a
  question card stays answerable for 14 days instead of 14 minutes, and
  `ask_user_question` accepts an optional `text` explanation shown above the
  questions. No persisted state or config changes, so no `BREAKING:`, no
  maintenance-skill update.
- Ride-along cleanup: the header comment of `src/feishu-session-mcp.ts` says a
  thrown error "reaches the model as Core's fixed sanitized error", but
  `McpLeaseRegistry.invoke` renders the error's own code and message
  (`service/mcp/leases.ts`, `failureText` in `mcp/failure-text.ts`), which is
  the path traced under Size. The sentence is corrected in the same package.

## 5. Verification

- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
- `.agents/scripts/check.sh`.
- Live, once a build carrying the change runs: send a card with `text` holding
  a heading, a list, and a mention, and confirm it renders above the questions;
  submit one card and cancel another and confirm both keep the explanation;
  answer a card more than two hours after sending it. The 14-day expiry repaint
  is covered by the unit timer seam only.
