# State where a document comment is anchored

## Current state

- Goal: Stop presenting Feishu's truncated quote as the anchored text, and carry the anchor facts Feishu does give: whole-document vs anchored, the anchor id, and whether the anchored content was deleted.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/state-the-comment-anchor/requirement.md)
- Final solution: None. The operator took the minimal-change fast path by
  authorizing the four enumerated items directly; the requirement carries the
  whole scope and the measured payload shape it rests on.
- Solution review Issue: Not created — the fast path creates none.
- Verification: [Gates and what waits for deployment](/.agents/tasks/channel/state-the-comment-anchor/verification.md)
- Blockers: None.
- Next action: None.
- Related tasks: [Subscribe to Feishu document comments](/.agents/tasks/channel/subscribe-document-comments/README.md) — this corrects the envelope that task shipped.

## Development approval

- Status: Granted by the operator on 2026-09-16 in the Feishu work group. He
  first scoped the work: 「引用这个地方，确实有很大的风险，单独开一个PR修一下。
  这个地方我感觉你可以拿到一些其他的值，比如说飞书给到的一些可以查询到评论段落
  的属性值之类的。我觉得你可以实测一下，你可以给全文全部选中，然后加评论，去
  查询一下这个评论，飞书给到的引用到底是什么格式的」, created the
  whole-document comment the probe needed (「发了」), and answered the four
  proposed items with 「你直接做了，这四个点」. That instruction is the
  authorization: it waived the development-authorization card for this task.
- Approved implementation boundary: `@excitedjs/feishu-transport` (what
  `fetchDocCommentText` reads and the shape it answers),
  `@excitedjs/feishu-channel` (the doc-comment envelope's attributes and its
  `<quote>` note), the tests that state either, and the knowledge pages that
  describe the envelope. Subscription state, the routing document, the tool
  surface, the access gate, and the chat delivery path are out of bounds.

## Delivery

- Scope delivered: all four authorized items. `FeishuDocCommentText.quote` is
  replaced by a `FeishuCommentAnchor` that is either the whole document or
  content with an id, a preview, and Feishu's own verdict on whether that
  content still exists; the envelope carries `anchor`, `anchor_id`, and
  `anchor_deleted`; and the `<quote>` note describes a preview instead of the
  anchored text.
- Carried along: reading one comment moved out of `transport/feishu.ts` into
  `transport/doc-comment.ts`. The anchor pushed that file past the 700-line
  source limit, and the comment reader was the one whole concept inside it that
  nothing else in the file touches.
- Left alone deliberately: `DOC_COMMENT_REMINDER`. The `<quote>` note is written
  exactly when there is a preview to warn about, and the reminder is sent for
  every comment including the ones with no preview at all; a sentence about
  `<quote>` there would be vacuous on half the deliveries.
- Knowledge closeout: Complete. `.agents/domains/channel.md` gained the three
  anchor attributes and the preview's nature, and lists the new transport
  module; `packages/channel/feishu-channel/CLAUDE.md` restates the delivery
  responsibility without the claim that `<quote>` is the anchored text.
  `dreamux-maintenance/references/builtin-feishu.md` is untouched: it owns
  persisted state and the tool surface, and neither moved.
- Rush change files: `@excitedjs/feishu-transport` and
  `@excitedjs/feishu-channel` as `minor` with plain notes — no persisted file
  changes shape, so nothing here is upgrade-blocking — plus `@excitedjs/dreamux`
  as `none` for the knowledge page and the boundary-guard pin.
