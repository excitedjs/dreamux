# Requirement

## Initial request

The operator reviewed the inbound half of #414 and the parts-only rework #422
against a live capture of four real messages (a mention in a post, a rich card
with two mentions, a plain-text mention followed by a time, and a post with a
code block) and asked for the inbound side to be redone as one new pull
request: "给他们废弃掉，再开一个新的", "你来做".

After the pull request was opened, the operator ruled that replies go back to
the Markdown card #414 had replaced with a native post, because the post
renders its text larger and thins the information out, and then narrowed the
change to the message sent rather than the renderer. Both messages are quoted
verbatim in the task README.

## Confirmed current behavior and evidence

Facts the capture proves directly (the capture itself stays outside the
repository; it holds real message content):

- Every message type delivers a mention in the body only as a placeholder.
  Plain text carries `@_user_N`; a post `at` node carries the placeholder in
  its `user_id` field, not an open id; native post Markdown carries `@_user_N`
  in the string; card Markdown carries `<at id=… mention_key=@_user_N></at>`
  with an empty label. The message's `mentions` records are the only source of
  who a placeholder names.
- The `id` attribute inside card Markdown is not the open id the records carry
  for the same person. The #414 parser lifted that literal id and never read
  `mention_key`, so a mention inside a card rendered with an id a reply cannot
  address.
- A v2 card event already carries the full card as `user_dsl`. Neither
  `im.v1.message.get` representation added visible text: `user_card_content`
  replayed `user_dsl` without the mention names, and `default` replayed the
  legacy `elements` block, which for a v2 card is the "please upgrade your
  client" placeholder plus one placeholder image.
- Native posts arrive with both `content` and `content_v2`; the `content_v2`
  Markdown keeps a code block's line breaks, the legacy flattening doubles them.
- `@_user_1` directly followed by `9:00` in plain text must still read as the
  mention followed by the time. An uncommitted fix on the #414 branch added a
  digit lookahead that made that placeholder stay literal; that was a
  regression, not evidence that text messages skip substitution.

Facts about the current design that motivate the change:

- The inbound body is an ordered list of typed parts built by a Markdown lexer
  (fences, code spans, escapes, two `<at>` dialects, image references), a card
  walker that reconstructs layout (buttons, selects, pickers, columns, node
  and depth budgets), two card reads merged line by line with per-line
  identity comparison, and a typed XML serializer with CDATA splitting and a
  binary-search truncator. Explaining how one mention reaches the model takes
  five modules.

## Desired outcome

The model receives each inbound message as one text body. A mention in that
body is written exactly the way the `reply` tool takes one, so what the model
reads is what it writes back. Attachments keep their download, cache, and
budget behavior. A card contributes its text and its attachments, and the body
says it is a card the model can pull in full with lark-cli.

## Desired behavior

- Text: the message text with each placeholder the records name replaced by
  `<at user_id="ou_…">Name</at>`. A record that carries no user identity (an
  application) renders as `@Name`. Text the records do not name stays literal.
- Post: title, then rows; `text` as written, `md` as written with its
  mentions and message-image references resolved, `a` as a Markdown link,
  `code_block` as a fenced block, `hr` as `---`, `at` as the mention, `img` /
  `file` / `media` as attachments at their position. `content_v2` is read when
  present. A node tag the flattening does not know is dropped and the body is
  marked incomplete. The fence and the unknown-tag handling are the leader's
  readings, listed under Assumptions.
- Card: read from the event's own content, `user_dsl` when present. Every
  `content` / `text` string the card carries, in document order, one per line,
  with mentions and message-image references resolved (button and control
  labels included; a leader's reading, listed under Assumptions); every `img` /
  `image` / `file` component as an attachment at its position. A template card has no
  readable body and is marked incomplete. Every card gets a `<refs>` row naming
  the message id and saying it is a rich card the model can pull with lark-cli.
  No message read is issued for a card.
- Image, file, audio, media: the attachment(s), as before. Sticker, shared chat,
  shared user: the same bounded markers as before. Merged-forward: empty
  content plus the existing lookup-only ref. `nonsupport`: the existing
  re-read. Unknown type: `(type message)`, incomplete.
- Attachments: discovered by key wherever the message put them, downloaded,
  cached, and budgeted exactly as today, rendered at their position as
  `<attachment path="…" />` or `<attachment status="not_downloaded" key="…" />`.
- The 160,000-character body cap stays; a cut never leaves an unfinished tag or
  entity.
- Outbound: a reply body is sent as one interactive card holding a single
  `markdown` element with the authored Markdown, as ordered `interactive`
  messages when the body must split. The authored `<at user_id="…">Name</at>`
  tag, the same form the inbound body shows, goes into the card as written;
  card Markdown renders it as a mention. #414's send path,
  splitter, reply tool signature (`chat_id`, `message_id?`, `text`),
  send-error description, and provisioning identity text are unchanged. The
  card title, rule, and native table routing of the renderer #414 removed are
  not brought back.

## Scope

- `@excitedjs/feishu-transport` parse layer and its message-read seam.
- `@excitedjs/feishu-channel` inbound event shape, enrichment, rendering, and
  attachment resolution; the `reply` tool's `text` description.
- `@excitedjs/feishu-transport` `transport/message-content.ts`,
  `transport/outbound-message.ts`, and the `send` path.
- Their tests, the export inventories, the knowledge base, and change files.
- Closing #414 and #422; carrying the #414 outbound commit as the first commit
  of the new pull request.

## Non-goals

- #414's reply tool signature, send-error reporting, and provisioning identity
  are carried unchanged; only the message type and its envelope change.
  `editText`, the mention list, and the public render exports stay removed.
- Access, routing, slash commands, sender naming, group-bot baseline, the
  parent-type probe, and the `nonsupport` re-read are unchanged.
- No new lookup of message content for cards, and no download of anything a
  card only links to.

## Constraints and invariants

- Inbound mention syntax is byte-identical to the outbound `reply` syntax
  (ruling 1). The outbound path converts that syntax on the way out; the
  model-facing form does not move with the presentation.
- Identity comes only from the message's `mentions` records; nothing in a body
  is trusted as an identifier.
- Untrusted text is escaped exactly once, at the Channel boundary, before any
  Channel-owned tag is inserted.
- Attachment cache paths keep their current shape; no persisted format changes.
- No Feishu ids or message content enter the repository.

## Acceptance criteria

- Replaying the four captured events through the built packages renders the
  post mention, both card mentions, and the `@_user_1` before `9:00` as
  `<at user_id="…">Name</at>` with the open id the records carry, with no
  message read for the card.
- A card with an image component renders one `<attachment>` and one download,
  and the card `<refs>` row is present.
- A reply body is sent as `interactive` cards whose single `markdown` element
  carries the body as written, `<at user_id="…">Name</at>` included; a body
  whose escaped size exceeds one card splits into cards that each fit.
- `rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` pass;
  `.agents/scripts/check.sh` passes.

## Decisions and unknowns

- Confirmed operator decisions: quoted verbatim in the task README under
  Development authorization.
- Assumptions (the leader's readings, not rulings):
  - "纯文字" for a card means the `content` and `text` string leaves the card
    carries, in document order. Link targets, button callback values, and
    control placeholders are not extracted beyond the strings they display.
  - A Devbox card whose pull-request link lives only in a button URL therefore
    needs a lark-cli pull; the `<refs>` row says so.
  - The lark-cli pointer is a `<refs>` row on the card message only, not on
    merged-forward messages.
  - No fence or code-span parsing: a mention is substituted wherever the
    records name it. A code example that spells a placeholder the records also
    name is substituted too; nobody has reported such a message.
  - The inbound `<content>` body keeps the XML escaping the Channel applies
    today, with the `<at>` and `<attachment>` tags inserted after escaping.
  - A post `code_block` renders as a fenced Markdown block in place of the
    `<code><![CDATA[…]]></code>` element the parts model emitted. No ruling
    named the shape; a fence is the plain-text form of a code block.
  - A card's button and control labels are `content` / `text` strings, so they
    appear as plain lines in document order. No ruling separated them from the
    card's prose.
  - A post node tag the flattening does not know is dropped and the body is
    marked incomplete, instead of being rendered as its raw JSON. No ruling
    covers unknown tags.
  - "原本那个卡片" is read as the interactive card message type with the
    authored Markdown inside. The implementation puts the whole body in one
    `markdown` element per card and does not restore the pre-#414 renderer's
    card title, rule, or native table routing; that reading was stated to the
    operator before the redo.
  - No outbound mention rewrite exists. The first redo rewrote the authored
    tag into the card's `<at id="…"></at>` on the assumption that card
    Markdown needs that form; a live card sent to the operator's direct chat
    on 2026-09-14 carrying both forms rendered both as mentions, so the tag
    goes out as written. A group chat was not probed.
  - Which other Markdown constructs a card `markdown` element renders
    (headings, tables) is not verified from this session and is not claimed
    in the `reply` tool's description.
- Unknowns the capture cannot settle (handled both ways, not asserted):
  - Whether Feishu rewrites a bot-authored `<at user_id="…">` inside a native
    `md` node to a placeholder before delivery. The inline reader accepts
    `mention_key`, `user_id`, and `id` and resolves by key or by identity.
  - Whether a legacy (schema 1.0) card carries `mention_key` on its `<at>`.
    The same reader covers an `id` that matches a record identity.
- Known limit: a card with `i18n_elements` contributes every locale's text.
