# Technical design

Input: the final requirement in
[`requirement.md`](/.agents/tasks/channel/subscribe-document-comments/requirement.md).
This is the TeamLeader-authored draft with the independent review on
[issue #427](https://github.com/excitedjs/dreamux/issues/427) merged in. Every
divergence from the draft is marked **(review)**.

## The shape of the change

One new fact enters this Channel: *a recipient follows a document*. Everything
else in the feature is an existing mechanism extended to carry that fact.

- The routing document already holds what this Channel routes and who it routes
  to, and already loses a Team's rows in one commit when that Team closes. The
  subscription is a third section in it, removed by the same commit.
- Route removal already has exactly two proofs — Core's final `team.state`
  closed event, and a delivery rejected before admission. A subscription is
  removed by those same two proofs and adds no third authority.
- Delivery is already "one submission, to whoever this Channel's routing chose".
  A comment event produces one submission per subscriber, through the same
  `submit`.

What is genuinely new is one event route, one tool trio, and one body shape.

## Subscription state

`routing/document.ts` gains one record and one section:

```ts
export interface FeishuDocSubscriptionRecord {
  file_token: string;
  file_type: string;
  /** The Team that receives it, or null for the Dispatcher Agent. */
  team_name: string | null;
  created_at: number;
}
```

No title is stored. Operator ruling, verbatim:「有文档token就可以了，不一定非得
有标题」. The metadata read at subscribe time therefore exists only to prove
permission, and its result is not persisted.

`FeishuRoutingDocument` gains `subscriptions: FeishuDocSubscriptionRecord[]`.

`routing/store.ts` accepts a document that predates the section and reads it as
`[]`: an absent section loses no fact a released build wrote, so it is not a
version bump and not a `Rebuild:`. `FEISHU_ROUTING_DOCUMENT_VERSION` stays `1`.
A present-but-not-an-array `subscriptions` still fails loud, like the two
sections beside it.

**(review)** `validated()` reconstructs the document explicitly
(`store.ts:170-179`), so it must materialize `subscriptions: []` there rather
than leaving `store.current.subscriptions` undefined until a subscription write
happens to run. `subscriptions` is the *one* optional section; `bindings` and
`spaces` stay required and keep failing loud when absent.

`routing/index.ts` gains the reads and writes, all through the existing commit
path:

- `subscribe(input)` — insert the row for one `(file_token, team_name)` pair,
  reporting whether it was already there;
- `unsubscribe(fileToken, teamName)` — remove that one row;
- `subscribersFor(fileToken)` — the rows a delivered event must reach;
- `listSubscriptions(teamName)` — the rows one recipient owns, for the read tool;
- `forgetTeam(teamName)` — extended to drop that Team's subscriptions in the
  same mutation that drops its bindings, so one commit still holds one
  consistency domain.

Keying by `(file_token, team_name)` is what makes the operator's ruling
structural: a recipient can only ever write its own row, and two recipients
following the same document hold two rows.

`forgetTeam` returns the dropped subscriptions as a **separate** list, not
folded into `removed`. `FeishuRouteReconciliation` announces each removed route
to `describeTarget(row.target)`, and a subscription has no target to announce
into — a dropped subscription is logged with its file token and never reaches
`announceRoutesRemoved`.

## Tool surface

- `subscribe_document` — follow one document's comments. One definition, offered
  to both callers: neither variant takes a recipient, so there is nothing to
  split. The recipient is derived — `caller.kind === 'team_leader'` yields
  `caller.team_name`, `dispatcher` yields `null` — and a TeamLeader therefore
  cannot name another Team, because the argument that would say so does not
  exist.
- `unsubscribe_document` — one definition, both callers, recipient derived the
  same way. The review recommended mirroring `bind_channel` / `unbind_channel`
  with two definitions so the Dispatcher could clean up any Team's rows; the
  operator ruled against it, verbatim:「这个地方，两边都只能删自己的」. So
  unsubscribe carries no team field for anyone, and no caller can remove another
  recipient's row.
- `list_subscriptions` — the name is the operator's instruction (「list 工具的名
  称简化一下不要那么长」), and it matches the `list_bindings` beside it. One
  definition, both callers, **caller-scoped
  result**: each caller sees exactly the rows it owns. It answers the review's
  concern (a persisted section no surface can read is durable state discoverable
  only by remembering URLs) without granting the Dispatcher the authority the
  operator just withheld. Unlike `list_bindings`, which is the Dispatcher's
  channel-wide operator view, this list is the counterpart of a caller-only
  unsubscribe: you can see what you may remove, and nothing else.

  Nothing becomes invisible under that scoping. Every row has an owner who can
  list and remove it, and a row whose owner is gone is removed by the two
  proofs rather than left for an auditor to find.

Input contract: `document` takes a Feishu document URL or a bare token; `type`
is required only for a bare token, and is auto-read from a URL path.

**(review)** Ordering inside `subscribe_document` is fixed and matters:

1. parse the reference;
2. resolve a wiki node to its `{ objToken, objType }` — *before* anything else,
   because the metadata API needs the object type and the event carries the
   object token, so a stored node token would make both the permission check
   and every later event match wrong;
3. read the resolved document's metadata;
4. write the row, carrying the resolved token and type.

**(review)** Accepted document types are whatever the reference parser can name
and the metadata read confirms. There is no allowlist: comment delivery was
probed for `docx` only, and an allowlist would be a defense with no named
failure behind it. A type Feishu never notifies about simply yields an inert
row, which `list_subscriptions` shows and `unsubscribe_document`
removes.

**(review)** The metadata read is a *permission proof*, and the refusal must not
lie. `fetchDocMeta` currently returns `null` for three unrelated situations
(`transport/feishu.ts:517-531`): the token came back in `failed_list`, the
request threw and was caught, and the file type was unsupported. Telling an
operator to add the bot as a collaborator after a 5xx or a timeout sends them to
fix permissions that are fine. So the transport gains a discriminated result:
`failed_list` for the requested token proves invisibility, a request error
propagates as an ordinary retryable tool failure, and an unsupported type is its
own answer. The probe's observation — that today's `null` happens to mean
invisible — holds only because the code swallows the other two cases.

The tool description states the delivery rule, so the model does not promise a
user something Feishu will not do. The rule is that a comment reaches this bot
exactly when the bot would itself be notified about it; what satisfies that is
the platform's to decide and is not a list this repo holds. An earlier wording
enumerated the two cases known before the ownership rows were probed and closed
with "anything else is never delivered", which a document the bot owns
falsifies — it is a rule with examples now, and the examples are named as
observations.

**(operator)** The same description carries the ownership case, and what a
subscription does *not* do:「你可以在 Subscribe 工具的 Description 里边写一下，
只有 Bot 身份写的文档才可以收到所有评论内容。」 Three facts in order: the rule;
that a document written under this bot's identity delivers every comment on it
while a collaborator on someone else's document receives none of that even with
full access, so the discriminator is ownership and not a permission level; and
that subscribing widens none of it — until the tool is called nothing Feishu
pushes for that document reaches a recipient at all, bar a trusted commenter's
mention, which reaches the Dispatcher Agent.

The third is the operative one. A per-repository development skill is planned
that has a model author documents under the bot's identity and subscribe
immediately afterwards, and this description is where that model reads why
neither half works alone: authoring without subscribing delivers every comment
to nobody, and subscribing someone else's document cannot widen what arrives.

## Transport additions

- `resolveWikiNode(token)` → the underlying `{ objToken, objType }` or `null`.
  The only new platform call; the wiki node API is the only way a wiki URL can
  become the token the event carries. The app already holds the wiki node read
  scope (a bot-identity call returns `not found` for an unknown token, not a
  scope refusal), so the null case is "this bot cannot see that wiki node".
- `fetchDocMeta` gains its first caller and the discriminated result above.
- `parse/document-ref.ts` — pure: a Feishu document URL or bare token in, a
  `{ token, type }` out, with the wiki case flagged for the caller to resolve.
  It sits beside `parse/comment.ts` because it is Feishu-format knowledge with
  no I/O.

That the event carries the object token rather than the node token is
**derived, not probed**: every comment API takes the object token, and
`lark-cli` unwraps a wiki token before calling them, but no probe saw a comment
event's payload for a wiki-hosted document — the daemon only logs "no handle",
never the body. It is therefore a named implementation-verification case:
subscribe a wiki-hosted document, @-mention the bot, confirm the event reaches
the subscriber. The new route's own log prints the token.

`fetchDocComment` gets **no** caller and is deleted in this change, together
with `commentFromBatchQuery` and the `FeishuDocComment` / `FeishuDocCommentReply`
types it exists for. Its body is what `lark-cli` already pulls on demand, the
operator asked for exactly that split, and a platform method with no caller is a
mechanism nobody is paying for.

Two checks stand behind that deletion, and both are methods rather than
completeness claims:

- In this repository, every hit for both names was read (no truncation):
  the definition, the `FeishuTransport` interface declaration, the
  `src/index.ts` export barrel, two sentences in `feishu-transport/README.md`,
  the transport's own tests, a stub method in
  `feishu-channel/tests/feishu-bot.test.ts` that exists only to satisfy the
  interface, and one entry in the exact-match exported-symbol list in
  `packages/dreamux/tests/package-boundary-guards.test.ts`. All are part of this
  change; the last also has to gain the new exports.
- **(review)** The transport is a shared package with a second host. Its
  current integration branch tip was fetched and grepped for the same three
  names: every hit sits inside its vendored copy of this same package, its own
  tests, or build output — no source consumer. That is one branch tip at one
  moment, not a guarantee about every branch there.
- **(review)** `parse/comment.ts`'s own header still advertises `fetchDocComment`
  as the enrichment path (`parse/comment.ts:11-13`) and must be rewritten to
  point at lark-cli instead.

`POST /drive/v1/files/:token/subscribe` is not called. The probe (requirement,
row G) shows it does not widen comment delivery, so calling it would be platform
state we own for no effect.

## The event route

`bot.ts` gains a fourth typed route, `onDocComment`, normalized by the
transport's existing `normalizeCommentEvent`. The seam's own note
(`bot.ts:120-128`) says a third event type should promote it to a map; the note
is answered in the same change rather than followed: each route carries a
*different* payload type and its own normalizer, so a `Record<string, handler>`
would erase the typing that makes the seam worth having. The comment is
rewritten to say that, so the threshold the file set for itself is retired
knowingly rather than quietly crossed.

## Delivery

`feishu-document-comments.ts` (new) owns one flow:

1. `subscribersFor(event.fileToken)`. Empty → the unclaimed rule below.
2. For each subscriber, build one submission and `submit(team_name, …)`.
3. A `rejected` outcome carrying `TEAM_CLOSED` / `TEAM_NOT_FOUND` removes that
   subscription — the same proof, and the same commit path, that removes a
   stale binding.

**(review)** Three fan-out rules the draft implied and now states, so no
implementer generalizes the chat path into this one:

- **Proofs act per subscriber, never per event.** If one document carries both a
  Team row and the Dispatcher's row, the Team's `TEAM_CLOSED` rejection drops
  only the Team's row; the Dispatcher's submission is unaffected.
- **A rejected event is dropped, not re-routed.** A subscriber whose Team
  refused the delivery loses its row; its event is not handed to the Dispatcher
  instead.
- **Subscribers are submitted independently and concurrently.** One
  subscriber's failure must not block the others, and `bot.start` awaits the
  whole route before the SDK acks — N sequential submissions, each of which may
  start a runtime, is an avoidable ACK-timeout risk.

A Team closing is already handled: the session's `team.state` listener calls
`forgetTeamRoutes`, whose commit now takes the subscriptions too.

The submission:

- `sourceId` = `${fileToken}:${commentId}:${replyId}`. **(review)** `comment_id`
  identifies a whole comment *thread*; every reply in it repeats that id and is
  distinguished only by `reply_id`, which is `''` on the top-level comment
  (`parse/comment.ts:30-32`). Core's ledger commits on
  `[dispatcherId, teamId, name, sourceId]` (`admission-ledger.ts:77-82`), so a
  source id of `comment_id` alone would admit the first reply and return
  `duplicate` for every later one — silently killing the F2 case the feature
  exists to deliver. The file token is carried too so the id needs no assumption
  about comment ids being unique across documents. `notice_type` is *not* in the
  key: `add_comment` only ever arrives with an empty `reply_id` and `add_reply`
  only ever with a non-empty one, so it cannot break a tie that exists. The
  delivery `event_id` is not used — it need not stay stable across a Feishu
  redelivery, the way a chat `message_id` does.
  Because the ledger key already contains the recipient, the same source id
  reaching two subscribers is two distinct keys and both are admitted.
- **(review)** `FeishuSubmission` becomes a **discriminated union**, not a shared
  type with a nullable anchor: the chat variant keeps `anchor` required, and a
  new doc-comment variant carries no anchor field at all and its own reminder.
  `submit()` attaches the inbound COT anchor only in the chat branch
  (`feishu-channel.ts:390-392`). A nullable field would let a future caller
  forget the branch and reintroduce a null-anchor COT open; a union will not
  compile.

  The COT machinery already behaves correctly for an anchorless turn:
  `prepareVisibleAnchor` returning null makes `onAnchoredSubmission` return
  before touching state (`feishu-cot-adapter.ts:157-159`), so the turn never
  detaches a leader's in-flight chat presentation, never sets `admittedTurnId`
  (its activity is therefore not presented — there is no card to open), and
  leaves a pre-existing chat anchor for `cron` and `task-notification`
  continuations untouched.

  One consequence is deliberate: `beginInboundSubmission` is also what registers
  a source id with `inboundCorrelations`, which is how a chat message the
  operator can already see is *suppressed* in the COT card. A document comment
  is not visible in the chat, so not registering it is correct — `onInput` shows
  the envelope, which is how the operator learns a document comment woke that
  agent.
- **(operator)** The delivered envelope has one shape, the inbound chat one.
  Raised after the walkthrough —「现在 channel 入站不是 dreamux 层自己拼接的 XML
  格式吗？它外边应该有一个统一的 channel 标签才对」— and settled by a card
  answered `拍平`. There is no `<doc-comment>` wrapper: every fact that addresses
  the comment is an attribute of the envelope Core renders, exactly as a chat
  message's `chat_id` and `message_id` are, and the comment's own blocks are its
  direct children the way a chat message's `<content>` is.
- `attrs` = `source=feishu`, then `file_token`, `file_type`, `comment_id`,
  `reply_id`, `notice_type`, `mentioned`, then the commenter's `sender_id` and
  best-effort `sender_name` (the same bounded lookup the chat path uses) and
  `create_time`. An empty value is dropped, as the chat path drops one: a
  top-level comment carries no `reply_id`, and `notice_type` is what says so.
  Core escapes each value, so the Channel passes them unescaped.
- `text` = the blocks a chat body is made of:

  ```xml
  <quote note="the document text this comment is anchored to">
  …the anchored document text…
  </quote>
  <content>
  <at user_id="ou_…"></at> …what the commenter wrote…
  </content>
  ```

  `<quote>` appears only when Feishu answered with one — a comment on the whole
  document has none. Its note is the one thing nothing else says: without it
  `quote` reads just as easily as text quoted from an earlier reply. There is no
  `note` pointing at lark-cli: the reminder already says that, and a second copy
  is a second place to keep true.

  `<content>` is always written, self-closing when there is nothing to put in
  it. Two reasons agree: it is what the chat path renders for a message with no
  text, and `team.submit` validates `text` as a non-empty string, so a body
  omitted entirely would turn a comment Feishu answered nothing for into a
  *failed* delivery — the one outcome this path exists to avoid.

  No title, by the operator ruling above. The agent learns which document it is
  reading from the same lark-cli call that gets it the rest of the thread.
- **(operator)** A mention inside a comment is normalized:
  「评论里的艾特还是要归一化成和消息入站一致的格式」. It reaches the model as the
  same `<at user_id="…">` element an inbound chat mention becomes, not as the
  `@<open_id>` Feishu's `person` element literally names. The label is empty
  because the comment API carries no display name, which is already what the
  chat renderer produces for a mention record without one.

  The transport must not write that element — assembling an agent-facing body
  format is outside its boundary, which is why the chat path renders mentions in
  the channel layer. So `fetchDocCommentText` answers the comment as ordered
  `FeishuCommentSegment`s — text, or a mention carrying an open_id — and the
  channel writes them. `docs_link` stays text: it is a URL the commenter typed.
  One function in `feishu-message-render.ts` writes `<at …>` for both paths, so
  the two cannot drift.
- **(operator)** `reminder` — a second Channel-owned reminder beside
  `CHANNEL_REMINDER`, stating one fact rather than a procedure: this turn came
  from a comment on a document and not from a chat, the `reply` tool does not
  reach that document, and lark-cli is what reads and writes document comments.
  The standing chat reminder would be false here, because there is no `reply`
  target at all.

  An earlier draft walked the model through lark-cli, `--as bot`, and
  subscribing. The operator stopped it, verbatim:「总的来说，就是我们需要让收到
  这条消息的 agent 知道发生了什么，然后后面怎么处理就可以了」. The receiving agent is
  told what happened, and what to do about it is that agent's business. Every other fact
  about the comment is already on the envelope, so nothing else belongs in the
  reminder, and the `--as bot` instruction is dropped rather than reworded.

  The cold-open delivery carries one more sentence — nothing is subscribed to
  this document, and the mention is why it arrived — because that is the fact
  the Dispatcher Agent is otherwise missing. It is a statement, not an
  instruction. Which of the two a submission carries is the reminder text the
  delivery passes to the one submission builder, not a second delivery path.

## The unclaimed event

An event no subscription claims is **not** uniformly dropped. Operator ruling,
superseding his own earlier「直接丢弃，只记日志」:「在文档里面 at bot 的时候，这个
文档又没有人订阅，这个时候投递给 dispatcher」.

The split is on the one fact the event itself carries, `mentionedBot`:

- **true.** A person addressed this bot in a document nobody follows. That is
  the cold open, and chat already answers it the same way: an unrouted
  conversation reaches the Dispatcher Agent.
- **false.** Something about this bot's relation to the document made Feishu
  notify it, and the event says nothing about which recipient would want to read
  it. Dropped and logged.

The second branch was first justified by an enumeration — Feishu would not have
sent it unless the bot had replied in that thread, so it could only be the tail
of a removed subscription — and that reasoning is retracted. Rows K–M in the
requirement show every comment on a document the bot owns arriving whether or not
anyone follows it, so the shape is ordinary rather than residual, and the set of
ways to be notified is not ours to enumerate. What such an event *should* do is
open, and the requirement records it as open. Dropping it is what ships: a
decision to revisit, not a rule the platform proves.

An unclaimed mention is admitted only when the commenter is in the Dispatcher's
`allow_users`. Operator ruling, asked as a card and answered `查 allow_users`.
The reason a *subscribed* comment runs no access gate — "the subscription is
already the recipient's own authorization" — does not exist when nobody
subscribed, so the Dispatcher's existing trusted-human set is the authority
instead. An unknown commenter's mention is dropped and logged: a document has no
chat window to send a pairing card into, and no way to answer one.

`FeishuDocumentComments` takes this as a narrow injected predicate
(`isTrustedUser(openId)`), wired at the construction site in
`feishu-channel.ts` to the existing `loadDispatcherAccess(stateDir)` read. The
module learns no state-dir layout and the gate keeps its single owner. The read
is read-only: no pairing, no mutation, and therefore not under the access mutex,
which exists for the gate's write.

A Dispatcher delivery of an unclaimed mention creates no subscription, and a
`rejected` outcome on it removes nothing — there is no row.

One consequence worth naming rather than discovering later: a document whose
Team closed loses its row, so a later trusted @-mention on that same document
reaches the Dispatcher. That does not contradict「不要再投递给 Dispatcher 了」,
which is about a closed Team's traffic being *redirected*; everything that
document keeps pushing without a mention is still dropped. Distinguishing "never
subscribed" from "subscription removed" would mean remembering removed
subscriptions, a persisted fact nobody asked for.

For a subscribed document, no access gate runs, deliberately. The gate's domain
is chat senders — "may this sender make this Channel interpret a message" — and
the subscription is already that decision, made by the recipient itself.

## Additions beyond what was asked

These three are the TeamLeader's, not the stated requirement. Each was played
back to the operator individually before the authorization card was settled, and
he kept all three:「这三个都ok，可以做」.

- The envelope carries `notice_type` and `mentioned`. The event carries them and
  they cost one attribute each; the requirement said only "necessary
  information". `mentioned` survives the mention normalization above, because a
  model does not know its own open_id and cannot derive the platform's verdict
  on whether this bot was addressed.
- The metadata permission check is a *refusal*, not a warning. It makes
  `subscribe_document` a multi-call tool. The alternative is to write the row
  blindly and let a silent never-firing subscription be the operator's problem.
- `list_subscriptions` being **caller-scoped** rather than a
  Dispatcher-only channel-wide view. The operator asked whether a list was
  needed and did not specify its scope; caller-scoping is the reading that
  matches his unsubscribe ruling, but a Dispatcher-wide audit view is the
  alternative he may prefer.

## Tests

- transport: `normalizeCommentEvent` already covered; add `document-ref` URL and
  bare-token parsing including the wiki case, and the discriminated metadata
  result (invisible vs request error vs unsupported type).
- routing: subscribe / unsubscribe / re-subscribe idempotence, `forgetTeam`
  dropping bindings and subscriptions in one commit and reporting them
  separately, and a document read back after a store round-trip without the
  section — asserting `subscriptions` is `[]` and not `undefined`.
- tools: caller-derived recipient (TeamLeader vs Dispatcher) on all three
  tools, a caller seeing and removing only its own rows, refusal only on proven
  invisibility, wiki resolution before the metadata read.
- delivery: no subscriber and no mention → nothing submitted; no subscriber,
  mentioned, commenter not in `allow_users` → nothing submitted; no subscriber,
  mentioned, commenter trusted → one submission to the Dispatcher and no row
  written; two subscribers → two
  independent submissions; one subscriber's `TEAM_CLOSED` removing only that row
  while the other still receives its submission; nothing re-routed to the
  Dispatcher; the submitted attrs / body / reminder shape; two replies in one
  thread both admitted (the source-id regression).

## Implementation verification (beyond the gates)

- A wiki-hosted document: subscribe, @-mention the bot, confirm the event
  reaches the subscriber — the one derived platform fact above.
- Two subscribers on one document, one of them a closed Team: confirm the
  survivor still receives its submission and the closed row is gone.

## Knowledge and release

- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-feishu.md`:
  the routing document's third section, the three new tools that write or read
  it, and "dissolving a Team also drops its document subscriptions" (the
  config/state synchronization rule).
- `.agents/domains/channel.md`: the Feishu event routes and the delivery rule
  the probe established.
- `packages/channel/feishu-channel/CLAUDE.md`: the tool list in Responsibilities.
- Rush change files for the two channel packages: an ordinary change note, type
  `minor` on the 0.x line. The routing document stays readable as it is, so no
  `BREAKING:` and no `Rebuild:`. The transport note names the deleted
  `fetchDocComment` surface and the changed `fetchDocMeta` result.
