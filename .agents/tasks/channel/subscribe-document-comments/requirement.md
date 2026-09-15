# Requirement

## Initial request

The operator asked for a new Feishu channel capability, in two messages:

> feishu channel 最开始设计的时候其实是支持了文档评论事件的，但是一直以来都没有
> 用上。这次我希望在飞书 channel 这边增加一个 subscribe 工具，传入文档的 token，
> 或者说是文档的链接。然后 channel 这边在收到文档的评论信息的时候，推送进模型
> 上下文。这个地方需要抓一下具体飞书的 Channel 会推送什么信息？跟合并转发消息和
> 引用消息一样，带上必要信息，剩下的用 lark-cli 去拉就行了。

> subscribe 和 bind 不一样。如果飞书 Channel 这边识别到 Team 已经关闭，或者不可达
> 了，自己把订阅解除掉，不要再投递给 Dispatcher 了。。然后这个订阅是谁调用就给谁
> 投递，不给他指定让谁去订阅某一个文档

After the platform probe below was reported, the operator answered `先做吧` —
proceed on the corrected delivery semantics and open this task record.

## Confirmed platform behavior and evidence

`drive.notice.comment_add_v1` is a *notification* event, not a document feed.
The official event page states the rule outright: 「该事件通知逻辑和文档中评论通知
逻辑一致，即用户在飞书 APP 中能收到该通知才能收到对应的事件通知」. A live probe
against the running app confirmed what that means for a bot. The probe observed
delivery through the daemon's own channel log, which records the Lark SDK line
`no drive.notice.comment_add_v1 handle` for every event the app receives; no
second WebSocket connection was opened, because a second connection would split
event delivery with the live dispatcher.

| # | Setup | Comment action | Delivered to the app? |
| --- | --- | --- | --- |
| A | app holds no permission on the document | plain comment | no |
| B | app holds no permission on the document | comment @-mentions the bot | no |
| C | app is a collaborator with `full_access` | plain comment | no |
| D | app is a collaborator with `full_access` | comment @-mentions the bot | **yes** |
| E | app is a collaborator with `full_access` | anchored (block) comment @-mentions the bot | **yes** |
| F1 | the bot has not replied in that thread | reply in the thread, no mention | no |
| F2 | the bot has replied in that thread | reply in the thread, no mention | **yes** |
| G | `POST /drive/v1/files/:token/subscribe` returned `is_subscribe: true` | plain comment | no |
| J | app is a collaborator with **`view`** | comment @-mentions the bot | **yes** |

So an app receives a document comment only when the bot itself would be
notified: the comment or reply @-mentions the bot **and** the app has permission
on the document, or the reply lands in a thread the bot has already replied in.
`view` is enough permission (row J); rows C–F used `full_access` only because
that was granted first. The file-level subscribe API does not widen this — its
own documentation says a document *manager* receives only file-edit and bitable
events, and the probe agrees.

`POST /drive/v1/user/subscription` would deliver a *user's* comment
notifications, but it requires a `user_access_token`; the channel is configured
with app credentials only, so that is a different capability and out of scope.
It is also verifiably not active here:
`GET /drive/v1/user/subscription_status?event_type=drive.notice.comment_add_v1`
answers `is_subscribe: false` for both the bot and the user identity of this
app, so every event the probe observed was addressed to the bot itself and the
rule above is the whole rule.

Two more platform facts the design depends on, both from the same probe:

- A metadata read on a document the app cannot see is **not** an API error.
  `drive.metas.batch_query` returns a successful envelope with `metas: []` and
  the token in `failed_list` (code `970003`). `FeishuTransport.fetchDocMeta`
  reads `metas[0]` and returns `null` for that — but it also returns `null` for
  a caught request error and for an unsupported file type, so today's `null`
  cannot by itself carry a permission verdict. The design makes that result
  discriminated before a refusal quotes it.
- `view` permission is also enough for that metadata read to return the row.

The event body carries `file_token`, `file_type` (`doc` / `docx` / `sheet` /
`bitable` / `slides` / `file`), `comment_id`, `reply_id`, `notice_type`
(`add_comment` / `add_reply`), `notice_meta.from_user_id`,
`notice_meta.to_user_id`, and `is_mentioned`. It carries **no comment text and
no document title**. Subscribing the event needs `docs:document.comment:read`.

## Confirmed current behavior in this repository

- The decoder for this event already exists and has no caller:
  `normalizeCommentEvent` in `packages/channel/feishu-transport/src/parse/comment.ts`,
  exported from the transport's public API. `FeishuTransport.fetchDocComment`
  and `fetchDocMeta` likewise exist with no caller.
- `packages/channel/feishu-channel/src/bot.ts` registers three Feishu event
  types through a typed route seam whose own comment says a fourth type should
  promote it to a map.
- An accepted chat message becomes one `FeishuSubmission` (display attrs, body
  text, standing reminder, source id, visible-message anchor) and is routed by
  `FeishuRouting.plan`; an unrouted conversation reaches the Dispatcher Agent.
- Removing a route whose Team can no longer answer already exists with exactly
  two proofs — Core's final `team.state` closed event, and a delivery rejected
  with `TEAM_CLOSED` / `TEAM_NOT_FOUND` (`feishu-route-reconciliation.ts`).
- The live app already receives these events and drops them: the channel log
  holds `no drive.notice.comment_add_v1 handle` lines.

## Desired outcome

A caller subscribes one document and afterwards receives, in its own model
context, the comment events Feishu pushes for that document. A subscription is
the caller's own: whoever calls the tool is the recipient, and no argument
names another recipient. The channel removes a subscription itself once the
Team behind it can no longer answer.

## Scope

- A Feishu MCP tool that subscribes the calling recipient to one document, and
  its counterpart that releases it.
- Delivery of a received comment event to each subscriber of that document, as
  one submission whose body carries the identifying facts and points at
  lark-cli for the rest.
- Self-removal of a subscription whose Team is closed or unreachable.

## Non-goals

- Making Feishu push comments it does not already push (proved impossible for
  app identity above).
- User-identity subscription (`/drive/v1/user/subscription`) and any user OAuth.
- Replying into a document comment thread from the model (the transport has no
  comment-write surface today; the model can use lark-cli).

## Decisions and unknowns

- Confirmed operator decisions:
  - 「这个订阅是谁调用就给谁投递，不给他指定让谁去订阅某一个文档」 — the tool
    takes no recipient argument; the caller is the recipient.
  - 「如果飞书 Channel 这边识别到 Team 已经关闭，或者不可达了，自己把订阅解除
    掉，不要再投递给 Dispatcher 了」 — a subscription whose Team is gone is
    removed by the channel, and its events are not redirected to the Dispatcher
    Agent.
  - 「跟合并转发消息和引用消息一样，带上必要信息，剩下的用 lark-cli 去拉就行
    了」 — the body carries identifying facts only.
  - A comment event no subscription claims is dropped and logged **unless it
    @-mentions the bot**. First asked as a question card and answered
    `直接丢弃，只记日志`; the operator then superseded his own answer while the
    implementation was in flight:「在文档里面 at bot 的时候，这个文档又没有人订阅，
    这个时候投递给 dispatcher」.

    The split is exact rather than a compromise. An unclaimed event can only be
    one of two things, because Feishu delivers nothing else: it @-mentions the
    bot (a person is addressing it in a document nobody follows — the same
    "unrouted conversation reaches the Dispatcher Agent" rule chat already has),
    or it does not, in which case the bot must have replied in that thread
    before and the event is the tail of a subscription that was removed.
  - An unsubscribed @-mention is admitted only when the commenter is in
    `allow_users`. Asked as a question card and answered `查 allow_users`.
    The design's reason for running no access gate on a comment event — "the
    subscription is already the recipient's own authorization" — does not exist
    when nobody subscribed, so the Dispatcher's existing trusted-human set is
    the authority instead. An unknown commenter's mention is dropped and logged:
    there is no chat window in a document to send a pairing card into, and no
    way to answer one.
  - 「这个地方，两边都只能删自己的」 — unsubscribe follows the same rule as
    subscribe. Neither the Dispatcher nor a TeamLeader may remove another
    recipient's row, so the Dispatcher does not get the channel-wide cleanup
    authority `unbind_channel` gives it. Asked as a question card after the
    independent review recommended the opposite.
  - 「有文档token就可以了，不一定非得有标题」 — no document title is stored on
    the subscription row or carried in the delivered body.
- Assumptions, to be confirmed or struck by the operator:
  - A subscription is durable and lives in this channel's own routing document
    beside the bindings, because a Team closing removes both in one commit.
  - A TeamLeader subscribes for its own Team (the Team Core baked into the
    lease); the Dispatcher subscribes for the Dispatcher Agent.
  - One document may carry several subscriptions, one per recipient, and one
    comment event is delivered once to each of them.
  - The tool accepts a document URL or a bare token plus its type. A wiki URL
    names a node token, which is *derived, not probed* to differ from the
    `file_token` the event carries, so it is resolved before the row is written
    and the inference is a named implementation-verification case.
  - Subscribing checks that the app can actually see the document and says so
    when it cannot, because a subscription on a document the bot has no
    permission on can never fire.
  - The submission's source id is the comment id plus the reply id, so a
    repeated event is deduplicated the way a repeated message id is. Verified
    safe for several subscribers: Core's duplicate ledger keys on
    `[dispatcherId, teamId, name, sourceId]`, so the same id delivered to two
    recipients is two distinct keys and both are admitted.
- Blocking unknowns: None.
