# Implementation design

## Contract between the two packages

`parseInbound` returns one body per message:

```ts
interface ParsedInbound {
  text: string
  resources: InboundResource[]   // { type: 'file' | 'image'; key: string; name?: string }
  incomplete?: boolean
}
```

`text` is written in Feishu's own vocabulary. A mention stands as the
placeholder the message's `mentions` records name (`@_user_N`); an image or
file stands as its resource key. `resources` lists each key once, in first
occurrence order, with the type and display name the download needs.
`incomplete` says the body omits something visible: a template card, an
unknown post node, an unknown message type, unparseable content.

That is the whole seam. Transport never sees XML, the reply syntax, or the
cache; the Channel never re-reads a raw body.

## Transport

- `parse/body.ts` — the body builder: append text, start a line, register a
  resource once and get its key back to write into the text.
- `parse/inline.ts` — the one place that reads Markdown strings: an `<at>` tag
  becomes the record key it names (matched by `mention_key`, or by `user_id` /
  `id` equal to a record's key or identity); an unmatched tag stays literal. A
  Markdown image whose target is a message image key becomes that key and a
  resource; a web image stays literal.
- `parse/post.ts` — locale pick (`zh_cn`, `en_us`, `ja_jp`, then the block
  itself), `content_v2` before `content`, title then rows, node flattening.
- `parse/card.ts` — `user_dsl` unwrapped when present (string or object),
  otherwise the outer card; `type: 'template'` is an empty incomplete body;
  a document-order walk that descends only through the keys a card displays
  its children under (`body`, `header` and its `title`/`subtitle`,
  `elements`, `columns`, `fields`, `actions`, `rows`, `cells`, `extra`, and
  a control's `text`, `placeholder`, and `options`), turns every
  `img`/`image`/`file` component
  it reaches into a resource and every `content`/`text` string leaf into one
  line read through the inline reader. A control's `value`/`behaviors`
  payload is never reached, so text whoever authored the card hid there
  cannot enter the body; the first review of the pull request caught a
  generic walk that read it. A select's placeholder and option labels are
  display strings, read as plain lines like a button's label; the walker on
  `next` read them too, as one `[select: …; options: …]` line.
  `i18n_elements` is read once from the card root or body, the two places
  the schema puts it and the two the walker on `next` read; a locale map
  hung on a component is not walked (the second review's first item).
- `parse/content.ts` — the per-type switch and `narrowMetaFromEvent`.
- `transport/message-read.ts` — `readMessage({ messageId })`; the
  `user_card_content` mode is gone because nothing reads a card.

Deleted: `parse/parts.ts`, `parse/markdown.ts`, `parse/mention.ts`, the old
card walker and read merge, `toChannelInbound`, `ChannelInbound`,
`mergeInteractiveInbound`, `InboundContentPart`, `FeishuMessageReadMode`.

## Channel

`FeishuInboundEvent` carries `text`, `resources`, and `contentIncomplete`
beside the envelope fields; `parsedText` and `contentParts` are gone.

Rendering (`feishu-message-render.ts`):

1. Escape the text once.
2. Build one substitution table: each mention record key →
   `<at user_id="…">Name</at>` (or `@Name` for a record without a user
   identity); each resource key → its `<attachment>` tag.
3. Replace with one longest-token-first alternation over the escaped text, so
   `@_user_1` inside `@_user_19:00` and `@_user_10` beside `@_user_1` both
   resolve correctly.
4. Wrap in `<content>` (`incomplete="true"` when the body says so), then the
   `<refs>` rows — merged-forward, reply-to, and for a card
   `<card message_id="…" note="…" />` with the lark-cli pointer — and the
   optional `<group_bots>` block.
5. If the whole exceeds 160,000 characters, cut the substituted text at the
   remaining budget, back off before an unfinished `<…` or `&…`, drop a
   trailing high surrogate, and append the truncation marker. The group-bot
   block is dropped first when even the marker would not fit beside it.

Enrichment (`feishu-inbound-enrichment.ts`) keeps the merged-forward lazy
ref, the `nonsupport` re-read, and the parent-type probe; the interactive
branch is deleted.

Attachment resolution (`feishu-message.ts`) is unchanged except that a
resource always has a key, so the `no_key` reason is gone, and the dead
`FEISHU_SKILL_FALLBACK_NOTE` export is removed.

## Outbound

`transport.send` keeps #414's path: `transport/message-content.ts` serializes
the body and splits it when it is oversized, `transport/outbound-message.ts`
sends each piece. What changes is the message: the content is a v2 card,
`{ schema: '2.0', config: { update_multi: true }, body: { elements: [{ tag:
'markdown', content }] } }`, sent as `interactive`, and the send primitive
loses its message-type parameter because every message it sends is a card.
The body goes in as written: card Markdown renders the authored
`<at user_id="…">Name</at>` tag as a mention (live card in a direct chat,
2026-09-14), so
transport neither parses nor rewrites the agent's text. The block splitter,
its JSON-escaped measurement, and the byte guard for raw cards are #414's,
unchanged.

The Channel changes only the `reply` tool's `text` description.

## Tests

Transport: `transport.test.ts` send cases rewritten onto the card shape, with
the authored mention tag asserted verbatim in the content; `content.test.ts`
(per-type bodies, unparseable content, envelope metadata, message-read
mention identity), `post.test.ts`, `card.test.ts`, `inline` cases inside
those. Channel: enrichment without the card branch, render and budget cases
rewritten onto `text`/`resources`, the mention serialization cases, and the
export inventories in both packages plus the Dreamux boundary guard.

Cases added for the capture: `@_user_1` before `9:00`; `@_user_1` and
`@_user_10` in one message; a card Markdown `<at id=… mention_key=…>` whose
`id` differs from the record's open id; `content_v2` preferred over
`content`; a card image rendered as one attachment.

## Known limits

- A card with `i18n_elements` contributes every locale's text.
- A node the walk reaches contributes both its `content` and a string `text`
  sibling as two lines; `next` read one (`content ?? text`). No schema node
  and none of the captured cards carries both. The second review raised it
  beside the `i18n_elements` placement; the operator had only the placement
  changed.
- A header title carried only as a locale map (`title.i18n` with no
  `content`) is not read; the walker on `next` read one locale of it. The
  capture holds no such card, so nothing was added for it.
- A body over the budget is split from the lexer's block `raw` values, which
  normalize CRLF to LF; a body that fits is sent as written. Pinned by a test,
  not fixed: the agent writes LF.
- The two unknowns in the requirement are handled both ways but not asserted
  as platform facts.
