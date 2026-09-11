# Requirement

## Initial request

Investigate Feishu message flags, remove the reply tool's separate mention list in
favor of XML mentions in the body, and simplify the overall reply logic.

Operator source wording, preserved for scope rather than expanded to other APIs:

> 先调研一下飞书有没有接口能把消息设置成旗标
> 去掉 Mention list 参数，改为直接在 正文中 拼接 xml 的方式at 别人
> 把整体逻辑简化一下，现在太复杂了

## Three-runtime solution review and complexity priority

After the consolidated scope was explained, the operator requested independent
solution review rather than development:

> 看起来没问题。走三路方案审查
> 拉 seed、claude、deepseek

The operator specified the review's priority:

> 重点关注代码复杂度，尽可能把能删的机制都删干净。尽可能利用 飞书内置的机制。

That review examined the complete then-current solution, prioritizing mechanism
removal and native Feishu capabilities. The operator subsequently ended the wait
for Seed and selected the completed Claude and DeepSeek reports. Their historical
inputs included the identity-array proposal that the later ruling below removes.
Review and scope decisions do not authorize development.

## Presentation reaffirmed after comparison

The operator questioned whether the reply conversions could simply be removed
while preserving the current card presentation:

> 我怎么感觉这个东西也比较扯淡呢?是不是所有的转换都去掉，跟现在一样，也可以实现?

Five direct-HTTP raw Card 2.0 probes were visually accepted:

> 全都正常。

When the leader proposed retaining cards on that evidence, the operator corrected
the choice:

> 不，还是用富文本吧。

The required outgoing presentation therefore remains native `post + md` as
selected below. Successful card rendering is comparative evidence, not a change
to that product decision or development authorization. Existing cross-format
inbound requirements remain in force.

## Accepted product decision

On 2026-09-11 the operator selected the following option in response to whether
reply should use native Feishu rich text (`post + md`):

> 原生富文本 (Recommended)

The selected option described ordinary rich-text presentation, native rendering
of Markdown and inline XML mentions, and continued support for tables, code blocks,
and long replies. This approves the presentation direction; introducing user
OAuth or removing existing inbound formats remains outside it. The later
consumer-scope ruling below separately permits retiring unused transport APIs.

After inspecting the direct-HTTP rendering probes, the operator asked to trace
the corresponding inbound behavior:

> 看起来没什么问题啊。但是你这边调整之后，Channel入站解析是不是也需要一起调整？你把那边逻辑也梳理一下

This records visual acceptance of the initial examples and authorization for the
inbound investigation. The resulting proposed fixes are documented with current
source and live readback evidence in [the inbound analysis](inbound-analysis.md).

The operator then made the inbound interoperability boundary explicit:

> 现在的 markdown 富文本卡片之类的都需要额外处理。因为你没有办法控制对端 bot 到底用哪种方式 at 你。

And identified the existing card path as an established working baseline:

> 现在 Devbox 艾特你，用的就是你修改之前的发送的那张卡片，这条链路已经通了很久了

Inbound support must cover existing text, rich posts, and interactive cards as
well as native post Markdown. Peer bots do not need to adopt this channel's new
outgoing format. Existing card receipt/wakeup is already working; model-facing
mention formatting defects must not be described as delivery or wakeup failures.
The additional live peer check concerns the new post path.

## Reply context in automatically provisioned Team identity

After the Thread-ID addressing experiment, the operator rejected adopting the
lookup/reply approach and specified the replacement:

> 这个其实不太行的。
> 不过我已经知道怎么解决了。
> 你在 feishu channel 在绑定话题群为协作空间的地方，自动创建团队时，额外 append 一条 Identity。告诉模型：当前 feishu channel 绑定群为 chat_id: xxxx, message_id 为 ：xxxxx （这个id 是初始触发创建的 message id），使用 reply 工具回复时，如果当前上下文没有其他可见 message_id，请务必传递该 message_id，不允许不传递 message_id

For a Team automatically created for a topic in a bound Feishu Collaboration
Space, append the bound chat ID, the initial triggering message ID, and this
reply instruction to its existing TeamLeader identity. If another reply message
ID is visible in the current context, use that context; otherwise the model
must pass the stored initial message ID and must not omit `message_id` when
replying in the bound conversation. Preserve any configured identity text.

The source is the message that triggers Team creation, not the latest message,
a Thread ID, or a message looked up later. This extends the creation-time
identity only. It does not request rewriting existing Teams, changing manual
Team creation, or adding automatic target recovery to the reply tool. Keep the
reply addressing fields unchanged and do not implement Thread-ID lookup.
This product instruction is not development authorization under the operator's
separate interactive-card requirement.

## Identity remains a string in this release

The operator superseded the earlier identity-array requirement on 2026-09-11:

> 这样，Identity 改数组本期不做了。你只要确保自上而下的字符串是拼接起来的就可以了。

Keep the existing string-valued MCP, internal creation, workflow, space-policy,
and persisted identity contracts. At automatic Feishu Team creation, concatenate
configured identity text and the generated reply guidance with a blank-line
separator. With no configured identity, use the generated guidance alone.
Preserve the space policy rather than writing Team-specific text back into it.

Dreamux's built-in instructions and the resulting identity must all reach the
runtime in the existing prompt order. The runtime-neutral append list already
exists and remains an implementation detail: this task does not change its
contract. Codex receives one rendered developer-instruction string; Claude Code
receives one rendered append-system-prompt argument. Verify creation, storage,
restore, and provider serialization without overwriting an upstream contribution.

Remove the proposed identity-array types, delegate wrapping, persistence version
bumps, old-state rebuild, array-specific reader/error changes, and workflow/schema
changes from this release. The special reply instruction remains scoped to newly
auto-provisioned Feishu space Teams. The earlier array-review findings are retained
as historical evidence, not active implementation requirements.

## Transport consumer scope

The operator explicitly superseded the external-compatibility premise:

> 不用考虑 claudemux 了，那个已经archive 了。
> feishu-transport 就是当前仓库唯一的使用者，我没有把这个玩意对外提供给别人使用的预期

Use current Dreamux production callers to decide which affected transport
mechanisms survive. Claudemux's historical imports and package export status do
not require retaining otherwise unused APIs. Once send uses native post, remove
the Markdown-to-card renderer, unused `editText` with its text-update fallback,
and associated serializers, types, caps, exports, and tests. Preserve the pure
long-message splitting behavior in the native-post implementation, rather than
keeping the retired renderer around it.

Remove obsolete mention/text-projection helpers after semantic parsing takes
over, and remove the outbound `conversationKey` field: it has no producer or
consumer, only declarations and forwarding. Preserve actual raw `sendCard` /
`editCard` callers and native COT I/O, which do not use Markdown-to-card rendering.
Update descriptions that still claim a shared external-proxy purpose. This
changes the solution scope; it does not authorize development or change package
publication infrastructure.

## Message-send error visibility

The operator added a concrete failure requirement:

> 刚才看到你有两次Reply调用失败了。日志里边有打印具体原因吗？不过先不管日志的话，给你透出的信息感觉也不太够啊。把这个问题顺手修掉。至少要在日志里边打印具体的失败信息，并且在MCP的返回值中给出更清晰的错误信息

Two live replies were rejected with HTTP 400, platform code `230028`, and the
platform reason `The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS`.
The SDK diagnostic already contained the reason and platform log ID, but the
higher send/MCP logs and model-facing result retained only the Axios message.

Preserve the platform's available operation, HTTP status, code, reason, and log
ID in the ordinary failure description used by both logging and the MCP result.
The model must be able to identify a platform rejection from the tool result
without searching daemon logs. Keep credentials and request bodies out of that
description. Preserve cancellation and ordinary network errors, and retain
successful earlier-part receipts when a later part fails. This adds send-error
visibility to the existing task; it does not authorize development.

## Current source facts

Baseline: `3cac2f7b00a7be159a52bd6aee0a9cdcd43214e1`.

- `packages/channel/feishu-channel/src/tools/messaging-tools.ts` exposes
  `chat_id`, `message_id`, `text`, and `mention_user_ids` for reply.
- The mention list crosses the tool session and session operation, becomes
  `ChannelOutboundTarget.mentionUsers`, then becomes
  `OutboundTarget.mentionUserIds`. Transport prepends `<@...>` to the body, and
  the card renderer converts that shorthand into card-specific XML.
- `packages/channel/feishu-transport/src/transport/feishu.ts` renders all text
  sends to interactive cards and reports each created message before sending the
  next one. The channel uses these receipts to remember outbound addresses,
  including partial success before a later send fails.
- The same transport exports `editText`, which patches a rendered card and falls
  back to updating a text message. The package also publicly exports the card
  rendering API. No production Dreamux call to `editText` exists in this baseline.
  The operator has removed external-consumer compatibility from the task's
  preservation boundary, so these otherwise unused paths are now deletable.
- The inbound post parser recognizes `md` nodes but selects only the legacy
  `content` array. Actual GET responses nest a more faithful `content_v2` array
  inside the decoded post object; current parsing loses Markdown details.
- Rich-post parsing drops structured mention identity; text messages instead
  recover it by reparsing their raw body in the channel. The resulting text
  mention XML uses `id`, while native post replies require `user_id`.
- Message GET explicitly requests `user_id_type=open_id`, which returns bot
  mentions as `app_id`; the current normalizer then labels them `open_id`.
  Direct reads with and without this parameter confirm the difference.
- Collaboration-space provisioning currently passes `space.identity` directly
  into `team.create.leader.identity`. Its creation request already holds both the
  routed chat ID and the triggering submission's message anchor. Core persists
  the identity and supplies it through the existing system-prompt append path.

## Required behavior

1. Expose only `chat_id`, optional `message_id`, and `text` as reply inputs.
2. Send the authored body as native `post` Markdown, with inline
   `<at user_id="ou_example">Example</at>` tags. Do not prepend mentions or
   translate a separate mention shorthand in the reply path.
3. Preserve the order and contents of ordinary paragraphs, headings, links,
   tables, and fenced code. Native client styling replaces card styling.
4. Keep long replies deliverable within Feishu's request-size limit without
   silent truncation. Retain the operator-selected 28 * 1024-byte serialized
   content budget: "那就先保持28kb 吧。" Send the whole body in one message when
   it fits; otherwise split while preserving Unicode and meaningful code/table
   boundaries.
5. Preserve source-message reply addressing and message IDs in delivery order.
   Observe every successful send before attempting the next; do not erase partial
   success when a later request fails.
6. Keep the existing authorization-reminder mention by writing it in that
   reminder's body after the separate mention field disappears.
7. Simplify reply-owned plumbing without adding a rendering mode, fallback
   renderer, durable delivery state, or a new host/core capability.
8. Append the operator-specified default reply address and mandatory message-ID
   instruction to the identity of each newly auto-provisioned space Team.
9. Keep Identity as a string and preserve the concatenated configured identity,
   Channel reply guidance, and Dreamux built-in instructions through creation,
   storage, restoration, and provider serialization.
10. Expose the platform's actual message-send failure in logs and MCP results,
    including available HTTP status, business code/reason, and platform log ID.

## Inbound corrections

The requested investigation and explicit interoperability requirement establish these corrections:

- Prefer native Markdown's `content_v2` in the shared post parser, retaining
  legacy post parsing when that projection is absent.
- Parse text/post/card mentions once into ordered content parts and serialize actual
  mentions with `user_id`, so an agent can copy an inbound mention into reply.
  Preserve code literals, resource order, and existing attachment behavior.
- Interpret each input according to its own Feishu format: text placeholders,
  structured `at` nodes, post Markdown `user_id`, and card Markdown `id`.
  These form three inbound data representations: placeholders, nodes, and
  retained inline markup. Sending-only attribute variants do not independently
  establish additional inbound parser requirements. Preserve legacy card
  admission and support both existing card read representations.
- Omit message GET's identity-type parameter so readback preserves bot open IDs.
- Keep the incoming event's `mentions` and access gates. Those are independent
  of the removed outbound tool parameter; body XML never grants admission.

## Flag research result

The [official CLI flag documentation](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-flag-create.md)
and its current implementation expose `POST /open-apis/im/v1/flags`, with
`im:feed.flag:write` and user identity. Ordinary message flags use
`item_type=default` and `flag_type=message`; the CLI's dry-run serializes these as
`"0"` and `"2"`. A real flag write has not been performed. The existing channel
authenticates as an app, so flag automation would require a separately approved
user-authorization capability. The requested research does not authorize adding it.

## Scope boundaries

- Owners: the Feishu channel's conversational reply path and Feishu transport's
  text-send path; the proposed inbound correction also touches shared post/text/card
  parsing, message readback, and model-facing mention serialization. The additional
  creation-time identity instruction belongs in Feishu space provisioning, which
  concatenates into the existing string. Verify its existing storage/restore and
  provider paths; do not expand the task into identity types, schemas, workflow
  options, storage versions, or reader refactors. Include the affected behavior's
  tests, release notes, and owning documentation.
- Existing explicit card send/edit and COT paths remain card operations. This
  outgoing boundary does not exclude received cards from mention parsing fixes.
- Retire the unused Markdown-to-card API and `editText` under the operator's
  current-repository consumer ruling. Preserve raw explicit cards and native COT
  for their actual callers, and preserve long-text behavior through native post.
  Keep package-boundary checks while updating their expected export inventory.
- No changes to core routing, user authentication, or persisted identity formats.
  The existing identity string holds the creation-time reply instruction; no
  separate address state or lookup is introduced. No automatic flagging or
  substitution of Pin for flags.
- Repository artifacts use English; quoted operator source remains verbatim.

## Acceptance evidence

- Tool invocation demonstrates the three-field input and native XML body.
- Existing Identity inputs and stored string/null records retain their current
  formats. Verify that custom identity, Channel guidance, and built-in instructions
  all survive create, restore, and provider serialization in the existing order;
  empty custom identity must not drop the generated guidance.
- Provisioning payloads preserve configured identity and append the correct
  per-topic initial chat/message IDs, including when no identity was configured.
  Concurrent later messages do not replace the initial message ID. Verify that
  the persisted identity reaches the existing runtime prompt path; distinguish
  prompt injection tests from actual model behavior after compaction.
- Transport payload tests observe `msg_type: post` and unmodified Markdown/XML
  for a one-message reply; create and reply use their proper destinations.
- Long prose, Unicode, fenced code, tables, JSON escaping, and mentions at split
  boundaries are checked for complete content and valid serialized payload size.
- Existing partial-send, per-message observation, topic-routing, raw explicit-card
  operations, and native COT stay covered against their production owners. Move
  still-required long-text/Unicode/fence cases to native-post checks; remove tests
  for the deliberately retired renderer/editText surface and update export
  inventories without weakening the package-boundary gate.
- Replay realistic post payloads containing both projections through the actual
  parser and body renderer. Verify Markdown, mention identity/position, code
  literals, resource extraction, and omitted GET identity-type behavior.
- Preserve the established card-to-bot receipt path and test actual card
  Markdown, structured mention nodes, plain-text lookalikes, and both read
  projections without erasing legitimate repeated occurrences.
- A synthetic reproduction of the observed HTTP 400/platform 230028 reply
  rejection leaves the platform reason and synthetic log ID visible in both
  the send log and the real MCP failure result. Also verify create/reply,
  cancellations, ordinary network errors, and partial-send receipts. Sensitive
  request data and credentials must not appear in the new description.
- Build, lint, test, test typechecking, and knowledge checks pass. Tests modified
  from interactive-card expectations must be reviewed against this new approved
  native-post requirement, without weakening the delivery assertions.
- The operator accepted the five initial direct-HTTP rendering examples. Report
  peer-bot event delivery, supplementary empty-name rendering, and production
  end-to-end validation separately; they are not established by that assessment.

## Current status

The reply and inbound scope is confirmed by the operator instructions above. Two
external solution reviews are complete. Initially, development was not authorized:
the operator requested an oral explanation of the technical plan before deciding.
After that explanation and a dedicated authorization card, the operator requested
an additional app-ID mention experiment rather than approving development. That
experiment did not establish app-ID mentions for the tested post forms. The later
creation-time reply guidance remains in scope. Claude and DeepSeek reviewed the
expanded proposal; Seed was closed at the operator's direction. The operator then
removed the identity-array conversion from this release and required string
concatenation instead. This narrowed scope does not constitute development
authorization.

The complete current scope, including send-error visibility, was subsequently
approved through the required interactive development card on 2026-09-11. The
operator selected "批准全部开发 (Recommended)". See the
[authorization record](README.md#complete-scope-authorization-granted-2026-09-11).
