# Subscribe to Feishu document comments

## Current state

- Goal: Let a caller subscribe one Feishu document so the comment events Feishu pushes for it reach that caller's own recipient, and let the channel drop a subscription whose Team can no longer answer
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/subscribe-document-comments/requirement.md)
- Final solution: [Technical design](/.agents/tasks/channel/subscribe-document-comments/technical-design/final.md), with the review on #427 merged in.
- Solution review Issue: [#427](https://github.com/excitedjs/dreamux/issues/427), reviewed and answered.
- Verification: [Gates, probes, and what waits for deployment](/.agents/tasks/channel/subscribe-document-comments/verification.md)
- Blockers: None.
- Next action: None.
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-15 in the Feishu work group. The
  development-authorization card was sent (request id `cac0dceb853f123d`) and
  first answered `先划掉几处再开`. After a walkthrough of the three
  TeamLeader-added items, he approved verbatim: 「这三个都ok，可以做。list 工具
  的名称简化一下不要那么长。subscriptions 是不是就够了？」 — approval plus one
  naming instruction, applied as `list_subscriptions` to match the existing
  `list_bindings` beside it.
- Approved implementation boundary: the boundary played back before the card —
  `@excitedjs/feishu-transport` (new `parse/document-ref.ts` and
  `resolveWikiNode`, a discriminated `fetchDocMeta` result, deletion of
  `fetchDocComment` / `commentFromBatchQuery` / their two types and tests, the
  `parse/comment.ts` header and README mentions), `@excitedjs/feishu-channel`
  (the routing document's third section and its store/index reads and writes,
  three tools, a fourth typed event route, `feishu-document-comments.ts`, and
  `FeishuSubmission` as a discriminated union), the exported-symbol list in
  `packages/dreamux/tests/package-boundary-guards.test.ts`, the knowledge owners
  listed in the design, and two Rush change files. Core's submit/ledger, the
  access gate, the slash-command path, COT card rendering, and the chat delivery
  path are out of bounds.
- All three TeamLeader-added items were kept, not struck: the `notice_type` and
  `mentioned` attributes, the metadata check as a refusal, and the
  caller-scoped read tool.

## Delivery

- Scope delivered: the three tools, the routing document's subscription
  section, the fourth event route, delivery with the comment text and its
  anchor quote, and the unclaimed-mention path to the Dispatcher Agent.
- Two requirement deltas arrived while the implementation was in flight and are
  recorded in [`requirement.md`](/.agents/tasks/channel/subscribe-document-comments/requirement.md)
  with the operator's words: an @-mention in an unfollowed document now reaches
  the Dispatcher Agent when the commenter is trusted, superseding the earlier
  drop-everything answer; and the delivered body carries the comment text, which
  partly reverses the `fetchDocComment` deletion the design had argued for. The
  deletion's premise was "no caller"; the second delta created one.
- Knowledge closeout: Complete. `.agents/domains/channel.md` gained the event
  routes and the document-comment delivery rules;
  `dreamux-maintenance/references/builtin-feishu.md` gained the third section,
  the three tools, and the unclaimed-mention behavior;
  `packages/channel/feishu-channel/CLAUDE.md` gained the delivery
  responsibility. Two Rush change files, both `minor` with plain notes.
