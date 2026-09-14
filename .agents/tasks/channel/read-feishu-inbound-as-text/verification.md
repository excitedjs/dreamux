# Verification

## Capture replay

The four captured events (a post with one mention, a rich card with two
mentions, a text message with a mention directly before a time, and a post
with a code block) were replayed through the built `parseInbound` and
`formatFeishuMessageForRuntime` on 2026-09-14. The replay printed only
lengths, tag counts, and masked tags; the capture stays outside the
repository.

| Message | Placeholders left in body | `<at user_id>` tags | Tag id equals the record's open id | Name inside the tag |
| --- | --- | --- | --- | --- |
| post with one mention | 0 | 1 | yes | yes |
| rich card with two mentions | 0 | 2 | yes, yes | yes, yes |
| text, mention before `9:00` | 0 | 1 | yes | yes; `</at>9:00` follows |
| post with a code block | 0 | 3 | yes, yes, yes | yes; one fenced block |

The card body came from the event alone: no message read was issued, and
the `<refs>` row carried the message id and the lark-cli note. The card's
mention ids are the ones its `mentions` records carry, not the literal ids
inside its Markdown, which is the #414 defect this task closes.

## Outbound presentation

One card was sent from this session, to the operator's direct chat on
2026-09-14, by a probe script kept outside the repository: a v2 card with a
single `markdown` element carrying `<at user_id="…">Name</at>` on one line
and `<at id="…"></at>` on the next, its envelope asserted byte-equal to the
built `cardContents` output for the same text. The operator reported that
both lines rendered as mentions, which is why no outbound rewrite exists.
The daemon was not restarted. The rest of the evidence for the card path is:

- `transport.test.ts`: a body is sent as one `interactive` message whose
  content is a v2 card with a single `markdown` element carrying the body as
  written, mention tag included; oversized bodies split into cards that each
  fit the 28 KiB budget; fences, table headers, and grapheme clusters survive
  the split; a table header plus one oversized row is refused before any
  request.
- Which other Markdown constructs the card's `markdown` element renders
  (headings, tables) is not verified here.

## Gates

`rush build`, `rush lint`, `rush test`, and `rush typecheck:tests` pass on the
whole repository at the submitted commit; `.agents/scripts/check.sh` passes.
`rush typecheck:tests` is the gate that caught the test files still importing
`InboundContentPart` and `FeishuMessageReadMode`.

## Coverage limit

- The two unknowns in the requirement (a bot-authored `<at user_id>` inside
  a native `md` node; `mention_key` on a schema 1.0 card) are covered by unit
  tests of the reader, not by a captured message.
- A card with `i18n_elements` is not in the capture; the walk reads every
  locale, as the design notes.
