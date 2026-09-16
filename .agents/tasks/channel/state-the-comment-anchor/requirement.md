# Requirement

## Initial request

The operator opened this task immediately after merging the document-comment
subscription work (PR #429, `a24f7855`), against the envelope that work ships:

> 刚才，给你合入了。引用这个地方，确实有很大的风险，单独开一个PR修一下。这个地方
> 我感觉你可以拿到一些其他的值，比如说飞书给到的一些可以查询到评论段落的属性值
> 之类的。我觉得你可以实测一下，你可以给全文全部选中，然后加评论，去查询一下这个
> 评论，飞书给到的引用到底是什么格式的

Two instructions in it: the fix lands as its own PR, not on top of the merged
one; and what Feishu actually returns is to be measured, not assumed — including
from a comment made in the client over a whole-document selection, which he then
created himself (「发了」).

## Current behavior and evidence

`FeishuDocCommentText.quote` is documented as "the document text the comment is
anchored to", and `documentCommentBody` renders it under
`note="the document text this comment is anchored to"`. Four rounds of live
reads against real documents falsify that description:

- **Feishu truncates the quote.** A short anchored paragraph comes back whole; a
  long one comes back cut, with no truncation marker and no statement of the
  original length. The cut is at a fixed character count that this repository
  does not encode — it is the platform's, measured, not contracted. The same cut
  applies to a comment created in the client and to one created through the API.
- **A whole-document comment carries no `quote` field at all**, and says so
  itself through `is_whole: true`.
- **A comment carries its anchor's id** on `extra.content_anchor_id`, returned
  without asking for it. For a docx that id is a block id, which `lark-cli docs
  +fetch --block-id` reads back in full.
- **A comment says whether its anchored content still exists**, on
  `relation.content_deleted`, returned only when the read passes
  `need_relation`, and only for document types that carry a relation.
- **A selection spanning several blocks records one anchor**, so the anchor id
  names where the comment starts and not everything the commenter highlighted.

So the risk the operator named is real but is not the one either of us first
stated: the delivered body is bounded by the platform well below Core's payload
limit, and the defect is fidelity. Today the envelope presents a truncated
preview as the anchored text, and an empty `quote` means three different things
at once — the comment is on the whole document, Feishu returned no quote, or the
comment could not be read.

## Desired behavior

1. `<quote>` is labeled as what it is: a preview Feishu derived and truncated,
   not the anchored text.
2. The envelope carries the anchor's id, so a recipient that needs the real
   passage reads it itself rather than the channel pulling every anchored block
   into every delivery.
3. "Anchored to the whole document" and "we could not read the comment" are
   distinguishable in the envelope.
4. The envelope says when Feishu reports the anchored content as deleted.

## Scope

- `@excitedjs/feishu-transport`: what `fetchDocCommentText` reads and answers.
- `@excitedjs/feishu-channel`: the doc-comment envelope's attributes and body.
- The tests, knowledge pages, and maintenance reference that state either.

## Non-goals

- Reading the anchored content itself. The recipient has `lark-cli` for that,
  and a block can be far larger than the comment it carries.
- Recovering the blocks a multi-block selection covered beyond its anchor.
  Feishu records one, and no read reconstructs the rest.
- The chat path's character-vs-byte body cap. Real, unrelated, and its own task.

## Constraints and invariants

- The delivery never fails over a missing anchor fact. Every one of them is
  optional in the payload, and the envelope's ids still address the comment.
- Absence is not a denial: `content_deleted` is stated only where the platform
  stated it, never inferred as `false` from a response that omits it.
- No measured platform constant is written into source. The numbers belong to
  Feishu and change without telling us; the code reads what the payload says.
- Public-repository safety: no probe document token or Feishu id lands here.

## Acceptance criteria

- A whole-document comment and an unreadable comment are told apart by an
  envelope attribute, not by an empty string.
- A comment anchored to content delivers its anchor id when Feishu returns one,
  and delivers without it when Feishu does not.
- The `<quote>` note no longer claims the content is the anchored text.
- `anchor_deleted` appears only when Feishu says the content was deleted.
- `build`, `lint`, `test`, `typecheck:tests`, and `.agents/scripts/check.sh` are
  green, and the knowledge pages that describe the envelope match the code.

## Decisions and unknowns

- Confirmed operator decisions:
  - 「引用这个地方，确实有很大的风险，单独开一个PR修一下」 — the fix is its own
    PR against `next`.
  - 「你直接做了，这四个点」 — the four items above, played back to him as a
    proposed PR scope, are authorized as a whole. The development-authorization
    card was waived by that instruction; this task's approval evidence is the
    instruction itself.
- Assumptions: none carried into implementation. The payload shape above is
  measured, not inferred.
- Blocking unknowns: none.
