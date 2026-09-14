# Simplify Feishu replies with native Markdown

## Current state

- Goal: Send native Feishu rich-text replies with inline mentions, preserve incoming peer formats and initial topic reply guidance, and expose actionable send errors.
- State: `done`
- Requirement: [Approved scope](/.agents/tasks/channel/simplify-feishu-replies/requirement.md).
- Final solution: [Implementation design](/.agents/tasks/channel/simplify-feishu-replies/technical-design/final.md).
- Solution review Issue: [#410](https://github.com/excitedjs/dreamux/issues/410).
- Pull request: [#414](https://github.com/excitedjs/dreamux/pull/414).
- Verification: [Probes, pre-review corrections, and review dispositions](/.agents/tasks/channel/simplify-feishu-replies/verification.md).
- Inbound investigation: [Source and platform evidence](/.agents/tasks/channel/simplify-feishu-replies/inbound-analysis.md).
- Related tasks: the inbound half of this task is superseded by
  [read-feishu-inbound-as-text](/.agents/tasks/channel/read-feishu-inbound-as-text/README.md),
  whose pull request carries this task's outbound commit and then, under a
  2026-09-14 ruling recorded there, returns the reply presentation from native
  posts to Markdown cards; the reply tool signature, send-error reporting, and
  identity guidance from this task stand.

The submitted implementation uses native `post + md`, removes the separate mention
parameters and unused Markdown-to-card APIs, and retains explicit cards and COT.
It keeps the 28 KiB serialized-content budget, ordered incoming semantic parts,
and existing string identity storage. Feishu appends initial reply guidance when
it provisions a Team. Transport describes platform send failures at its existing
send boundary so ordinary logs and MCP results retain their actionable details.

Knowledge owners updated in the same change:

- [Channel contracts](/.agents/domains/channel.md).
- [Product behavior](/.agents/product/README.md).
- [Transport invariants](/packages/channel/feishu-transport/CLAUDE.md).
- [Feishu maintenance](/packages/dreamux/skills/dispatcher/dreamux-maintenance/references/builtin-feishu.md).
- [Interactive development authorization](/.agents/skills/dev-workflow/references/development-approval.md).

The glossary and root routing need no new concept or entry. Identity remains a
string; no stored version, shape, migration, or provider contract changes.

## Development authorization

On 2026-09-11 the operator required an actual interactive development card:

> 再严格一点，必须通过 ask_user_question 等交互式卡片获取开发授权，没有发送过卡片的情况下，不认为是已经获取到了开发授权

The earlier native-post choice card and application-ID probe request did not
provide development authority. A developer prematurely started after requirement
confirmation was stopped and closed; inspection found no product-code changes.
The approval skill records the resulting regression trap.

After the complete solution was published to Issue #410 and read back, the
channel question tool returned `status: asked` for this dedicated card:

> 是否批准按已同步的完整方案 #410（https://github.com/excitedjs/dreamux/issues/410）开始开发：reply 使用原生 post/md、保留 28KB 拆分；删除 Mention list、旧卡片渲染器及无调用方 API；统一文本／富文本／旧卡片的入站解析；保持 Identity 字符串并追加初始回复地址；补齐日志和 MCP 的平台错误详情；完成全部检查并交 Devbox 做代码 review？

The matching operator answer explicitly selected:

> 批准全部开发 (Recommended)

The leader recorded this sent-card and answer evidence before resuming the sole
implementation writer. Private transport receipts remain in the conversation;
no live identifiers are copied into the repository.

## Scope and review decisions

The operator selected native rich text after comparing raw cards, deferred
identity arrays in favor of string concatenation, and removed external-consumer
compatibility from this transport's requirements. Those exact rulings and their
boundaries are preserved in [the requirement](/.agents/tasks/channel/simplify-feishu-replies/requirement.md).

The operator ended the wait for Seed and selected the completed Claude and
DeepSeek solution reviews. Their reports and the leader's factual corrections
remain under [solution review adjudication](/.agents/tasks/channel/simplify-feishu-replies/technical-design/reviews/2026-09-11-adjudication.md).
The original reports are [Claude](/.agents/tasks/channel/simplify-feishu-replies/technical-design/reviews/2026-09-11-claude.md)
and [DeepSeek](/.agents/tasks/channel/simplify-feishu-replies/technical-design/reviews/2026-09-11-deepseek.md). This was two
completed reviews, not a three-reviewer pass. The historical
[public solution snapshot](/.agents/tasks/channel/simplify-feishu-replies/artifacts/issue-410-current-solution.md) and the
[local input manifest](/.agents/tasks/channel/simplify-feishu-replies/implementation-review/input-manifest.json) records the
pre-PR snapshot; published PR commits identify the subsequent review inputs.

The operator explicitly corrected the final review handoff:

> 你必须要开 pr 才能给 他 review

For this task the PR was published before Devbox implementation review. That
exception changes review ordering; it does not authorize merge. On 2026-09-11,
Devbox [approved commit 87dda034](https://github.com/excitedjs/dreamux/pull/414#pullrequestreview-5180205413).
The leader confirmed the one non-blocking, inherited placeholder-prefix finding
and deferred its correction as a follow-up; see the evidence and disposition in
[verification](/.agents/tasks/channel/simplify-feishu-replies/verification.md). No product change was dispatched from that nit.

The 2026-09-14 integration onto the task-record rule change preserves the reviewed
product bytes. Only task documentation and the index require reconciliation.
Following the trunk record contract, `done` denotes completed and submitted work;
the PR itself owns review, CI, and merge state.
