# Verification

## Gates

All four repository gates and the knowledge check were run on the final tree:

- `node common/scripts/install-run-rush.js build` — SUCCESS.
- `node common/scripts/install-run-rush.js lint` — SUCCESS. It failed once
  first, on `max-lines` (754 > 700) in `transport/feishu.ts`; splitting
  `transport/doc-comment.ts` out is what answered it.
- `node common/scripts/install-run-rush.js test` — SUCCESS.
- `node common/scripts/install-run-rush.js typecheck:tests` — SUCCESS. This is
  the gate that proves no test still builds a `FeishuDocCommentText` with the
  removed `quote` field.
- `.agents/scripts/check.sh` — task records and KB reachability OK.
- `rush change --verify` — satisfied by three added change files.

## What the payload actually contains

Measured against real documents over four rounds before any code was written,
and then re-measured on the exact endpoint this code calls. That second pass
matters: the four rounds read the comment-list endpoint, while
`fetchDocCommentText` calls comment batch-query, and a unit test proves nothing
about which fields a real response carries because the fixture supplies them.
Both endpoints were read directly.

Each of these is a read of Feishu's own response, not an inference:

- The quote comes back whole for a short anchored paragraph and cut for a long
  one, at a fixed character count, with no marker and no original length. The
  same cut applies whether the comment was created in the client or through the
  API. This is why the code stores no length and the note says "shortens"
  rather than naming a number: the number is Feishu's and can move.
- A comment on the whole document carries `is_whole: true` and no `quote` field.
- `extra.content_anchor_id` arrives without being asked for. For a docx it is
  the block id, and `lark-cli docs +fetch --block-id` reads that block in full.
- `relation.content_deleted` arrives only when the read passes `need_relation`.
- A selection spanning several blocks records exactly one anchor. The other
  blocks appear nowhere in the item, so no read recovers them. The operator made
  that comment from the client over a whole-document selection: it came back
  `is_whole: false`, anchored to the first selected block, with the same
  shortened quote. Selecting everything is not the same act as commenting on the
  document.

Confirmed on comment batch-query with `need_relation`, against comments this bot
owns — all four states the code distinguishes:

| comment | response |
| --- | --- |
| anchored to a block | `is_whole: false`, `extra.content_anchor_id` set, `relation.content_deleted: false`, `quote` shortened |
| on the whole document | `is_whole: true`, no `quote`, no `extra`, no `relation` |
| anchored to a deleted block | `relation.content_deleted: true` |
| anchored, short paragraph | `quote` returned whole |

The deleted-anchor case was produced by deleting the anchored block of a
bot-owned probe document and re-reading its comment. `extra.content_anchor_id`
still names the block that no longer exists, while `relation.relation` drops the
position it used to carry — which is exactly why `anchor_deleted` earns its
place: the id alone still looks answerable.

## Unit coverage added

- Transport: an anchored comment answers its id, preview, and undeleted state,
  and the call it makes asks for `need_relation`; a whole-document comment
  answers `whole_document`; a deleted anchor answers `deleted: true`.
- Channel: an anchored comment writes `anchor` / `anchor_id` and the preview
  note; a deleted anchor writes `anchor_deleted`; a whole-document comment
  writes `anchor="whole_document"` and no `anchor_id` and no `<quote>`; an
  unread comment writes no `anchor` at all, which is the distinction the change
  exists to make.

## What only a deployment can confirm

- That a live anchored comment delivers an `anchor_id` a recipient can then
  read back with lark-cli. Every field the code reads was confirmed on the
  endpoint the code calls, and the block was fetched by its id by hand; what is
  unverified is the round trip through a delivered envelope.
- The anchor id's shape for a non-docx document. Feishu documents a different
  form per type (a sheet cell, a bitable record), and every probe here was a
  docx. The envelope states the id beside the `file_type` it arrived with and
  interprets neither, so a different shape costs nothing — but nothing here
  proves what that shape is.
