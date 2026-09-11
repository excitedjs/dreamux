# Simplify Feishu replies with native Markdown

## Current state

- Goal: Send native Feishu rich-text replies with inline XML mentions and fewer reply-layer mechanisms
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/channel/simplify-feishu-replies/requirement.md)
- Final solution: [Implementation plan](/.agents/tasks/channel/simplify-feishu-replies/technical-design/final.md). The native-post plan was reviewed; creation-time guidance concatenates into the existing identity string. Identity arrays are deferred. The unused card renderer/editText API is now removed from the target design under the repository-only consumer ruling.
- Solution review Issue: [#410](https://github.com/excitedjs/dreamux/issues/410). The [published snapshot](artifacts/issue-410-current-solution.md) includes all current scope decisions and send-error visibility; remote body readback matched.
- Verification: [Native Markdown probes and inbound replay](/.agents/tasks/channel/simplify-feishu-replies/verification.md).
- Inbound investigation: [Current path and confirmed findings](/.agents/tasks/channel/simplify-feishu-replies/inbound-analysis.md).
- Blockers: No unresolved TeamLeader pre-review finding. Independent Devbox code review remains outstanding.
- Next action: Commit and open the PR to `next`, then request Devbox review of its published head. The operator explicitly requires a PR before that review; no independent pass or merge is claimed.
- Related tasks: None.

## Independent solution review, 2026-09-11

The operator selected three independent reviewers: `seed`, `claude`, and
`deepseek`. Each reviews the complete solution. The requirement records the
operator's complexity and native-Feishu emphasis verbatim. Reviewers may write
only their own report; implementation remains unauthorized.

Frozen source HEAD: `3cac2f7b00a7be159a52bd6aee0a9cdcd43214e1`.
Original frozen review-input SHA-256 values (historical, before reconciliation):

| Input | SHA-256 |
| --- | --- |
| `requirement.md` | `c12630eb0386a9f6959c153c339599a360671bcaae8a14500b13a95078f28df2` |
| `technical-design/final.md` | `9cb18a30dbe869f415657f6a2c3416e5ac18d5412a1c93ded6968e6e6004b725` |
| `verification.md` | `cbcd2d0d4706321b904a6051d5520eafca3092d1f0d3f0eeb0959b9551a907bb` |
| `inbound-analysis.md` | `922958491aac3c4312ef25dbc8ed01e5f0c7a44a2e6d9854727224122d06a23c` |

Assigned reports: `technical-design/reviews/2026-09-11-seed.md`,
`technical-design/reviews/2026-09-11-claude.md`, and
`technical-design/reviews/2026-09-11-deepseek.md`.

| Runtime | Submission status | Review status |
| --- | --- | --- |
| `seed` | Submitted; subsequently closed | No completed report; operator ended the wait at 18:47 and selected the other two reviews |
| `claude` | Accepted; subsequently closed | [Review and correction received](technical-design/reviews/2026-09-11-claude.md); accepted findings reconciled in the solution |
| `deepseek` | Accepted; subsequently closed | [Review and correction complete](technical-design/reviews/2026-09-11-deepseek.md); no blocking correctness finding |

All three submission receipts were received on 2026-09-11. Only two completed
reviews are available; do not represent this round as a three-reviewer pass.
The operator's final review-scope ruling was:

> 别等他了，就采纳两席的方案。告诉我他们都审核出来什么问题

DeepSeek's follow-up withdrew the alleged surviving introduce-ack card-render
path and card dependency in the existing pure splitter. It also corrected its
claim that release-note obligations were absent: the requirement and solution
already record them. The narrow release-note suggestions are incorporated;
they do not authorize implementation or a new compatibility mechanism.

Claude's follow-up withdraws scalar-reader compatibility, the missing send-helper
simplification claim, and the unverified-renderer-consumer premise. It retains
the need to specify incompatible-state error propagation and code-part production
when removing the channel fence scanner. Primary-source checks confirm that the
known external consumer imports the shared card renderer and `mentionName`, but
owns its own transport; the solution's external `FeishuTransport.send` claim must
be narrowed; the reconciled solution now does so. It also specifies the existing
state-version/error boundaries and routing-store validation owner in the earlier
reconciliation. Those array-specific changes are superseded by the scope
reduction below. No new implementation permission has been granted.

The [TeamLeader fact checks](technical-design/reviews/2026-09-11-adjudication.md)
record final finding dispositions and the verified public consumer. The solution
and validation plan were revised after the original frozen-input review; the
two reports retain their original inputs and corrections for traceability.

## Identity scope reduction, 2026-09-11

The operator subsequently ruled:

> 这样，Identity 改数组本期不做了。你只要确保自上而下的字符串是拼接起来的就可以了。

The current requirement and solution retain the existing string contracts and
stored formats. Feishu appends the reply guidance to configured identity at
creation; existing Core and provider composition preserves all contributions.
Remove the array conversion, version bumps, rebuild, and associated reader/schema
changes from this release. The two review findings about the removed format
change are historical, not active blockers or tasks. Native reply/inbound work,
28 KiB splitting, and creation-time reply guidance remain in scope. Only task
documents changed; development approval remains absent.

## Transport consumer-scope ruling, 2026-09-11

> 不用考虑 claudemux 了，那个已经archive 了。
> feishu-transport 就是当前仓库唯一的使用者，我没有把这个玩意对外提供给别人使用的预期

The current solution retires the unused Markdown-to-card pipeline, `editText`
and fallback, obsolete mention/text helpers, and unused target hint. Pure long-
message splitting moves into the native-post path. Raw explicit-card operations
and native COT remain for their real callers. This supersedes the earlier external
renderer-retention disposition; no new reviewer pass is claimed. Only task
artifacts changed, with no implementation approval.

## Message-send failure visibility, 2026-09-11

The operator requested that logs and MCP results expose concrete platform failures
after two observed reply rejections. SDK logs already contained HTTP 400, Feishu
code 230028, the platform reason, and a log ID; upper layers retained only the
Axios message. The current solution adds one descriptive-error construction at
the existing transport send boundary so the existing logs and MCP result retain
those details. See the [evidence](verification.md#observed-message-send-failure-detail-loss)
and [solution](technical-design/final.md#preserve-actionable-message-send-failures).
The existing review reports predate this addition; no new reviewer pass is claimed.
This addition is included in the complete-scope interactive approval recorded below.

## Whole-scope implementation request, 2026-09-11

The operator requested proceeding with all work:

> 开始开发吧。
> 这个问题修复，加上前面的所有方案，全部开发完。

This establishes intent to implement the current complete proposal. The earlier
mandatory interactive-card rule has not been waived; an explicit approving answer
to the current-scope development card is still required before implementation.

## Development authorization

Granted for the complete current scope through the interactive card recorded below.
Earlier in this task, the leader incorrectly treated requirement confirmation as
development authorization and started a developer. The operator immediately
corrected that interpretation:

> 我没有给你开发授权，你先给我口述一下你的技术方案

The developer was stopped and closed, and the recovery reminder deleted.
Worktree inspection after closure found no product-code changes; only the
existing task artifacts and parent index were changed. Do not resume development
without the operator's explicit authorization after discussing the solution.

The operator further required authorization through an interactive question card:

> 再严格一点，必须通过 ask_user_question 等交互式卡片获取开发授权，没有发送过卡片的情况下，不认为是已经获取到了开发授权

At the time of this ruling, no development-authorization card had been sent. The
earlier native-rich-text product-choice card is not development authorization.
The workflow skill and its
approval, implementation, and task-record references now require both the sent
development-authorization card and the explicit approving response.

A dedicated development-authorization card was subsequently sent on 2026-09-11.
The operator answered with an additional probe request, not approval:

> 还有几个点，你先测试下新的 post 富文本是否支持通过 appId 去 at 其他 bot，直接测试 devbox ，最开始做的时候是不支持的，不过现在飞书好像已经支持了，如果可以的话，我们都不需要去解析成 Open ID。

This authorizes the direct app-ID probe only. Development remains unauthorized.

Probe authorization and observed results are recorded in [verification](verification.md).

### Complete-scope authorization granted, 2026-09-11

Sent-card evidence: `channel-feishu.ask_user_question` returned `status: asked`
for a dedicated **development authorization** card after the current solution
was published to Issue #410 and its body read back successfully. The leader
stopped work pending the answer. The card asked:

> 是否批准按已同步的完整方案 #410（https://github.com/excitedjs/dreamux/issues/410）开始开发：reply 使用原生 post/md、保留 28KB 拆分；删除 Mention list、旧卡片渲染器及无调用方 API；统一文本／富文本／旧卡片的入站解析；保持 Identity 字符串并追加初始回复地址；补齐日志和 MCP 的平台错误详情；完成全部检查并交 Devbox 做代码 review？

The operator's matching card-answer event explicitly selected:

> 批准全部开发 (Recommended)

This authorizes the current [requirement](requirement.md),
[solution](technical-design/final.md), and verification plan in full. The approved
option explicitly retains raw cards and COT, keeps scalar identity storage, and
does not change persisted formats. Sent-card and approving-answer receipts remain
in the private channel transcript; live channel identifiers are omitted here.
This record was written before resuming a developer or permitting implementation
writes. Earlier refusals and probe-only approvals above are historical.

## Implementation dispatch

The existing Claude developer seat was resumed as the sole implementation writer
after the complete-scope approval record was written. Its brief points at the
current requirement, final solution, verification, and engineering whitepaper;
earlier implementation guesses are superseded. The leader owns task and KB
writes. Full sequential Rush gates and a completion report were assigned. A
one-hour, one-shot recovery reminder checked the developer on 2026-09-11 at
20:54 local time: the seat was running without a recorded runtime error and
the Rush test process was active. The consumed reminder was deleted; completion
remains push-delivered. Completion and subsequent correction reports have now
arrived. Consumed recovery reminders are deleted; no second writer was started.

## TeamLeader pre-review complete

The sole developer completed the approved scope and the accepted P1-P4
corrections. The leader withdrew P5's unsupported prefix inference; the added
classifier is removed while typed application-record handling remains. Final
built-code replay passes the same concrete counterexamples, including the
line-owned card merge case. The developer's final recorded sequential Rush run
shows build, lint, test, and test-typechecking success; transport tests now
participate in the last gate. Existing unrelated error-path test warnings remain.
See [verification](verification.md) for gate and evidence boundaries.

The initial review request pointed Devbox at the complete local working changes.
The [input manifest](implementation-review/input-manifest.json) preserves that
pre-PR snapshot, including new files and deletions, and excludes itself. It is
historical evidence, not the identity of the later published review head.

### PR required before Devbox review

The operator corrected the review handoff on 2026-09-11:

> 你必须要开 pr 才能给 他 review

For this task, publish the PR before Devbox reviews it. This supersedes the
workflow's default ordering of independent review before PR creation; it does
not claim review completion or authorize merge. The PR head and its base become
the review input. The leader preserves the pre-review evidence and updates the
review request with the PR URL and commit.

The original source baseline contains an unrelated Workflow-notification commit
that is absent from current `next`. Rebase only this task's implementation onto
`next` before publication, keeping that unrelated feature out of the PR, and
rerun the required checks on the resulting source. Historical baseline probe
results remain labeled with their original scope.

## Delivery

- Pull request: Creation authorized before independent review; preparing publication.
- CI / independent review / merge: Pending.
- Knowledge closeout: Channel and product owners updated; final reconciliation follows independent review.
