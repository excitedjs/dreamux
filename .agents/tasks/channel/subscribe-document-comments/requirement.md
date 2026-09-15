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
| K | the document is owned by the **bot** | plain comment, no mention | **yes** |
| L | the document is owned by the **bot** | anchored (block) comment, no mention | **yes** |
| M | the document is owned by the **bot**, the bot has not replied in that thread | reply in the thread, no mention | **yes** |

So an app receives a document comment exactly when the bot itself would be
notified. That is the whole rule, and what satisfies it is **not a closed
list** — the rows above are examples of it, not an enumeration of it. Two ways
are probed.

**The bot owns the document** (rows K–M): every comment on it arrives, mention
or not, anchored or not, in any thread. A human owner is notified about every
comment on their own document and the event follows the notification. Read
against row C — a `full_access` **collaborator** on someone else's document
receives nothing — the discriminator is ownership, not permission level.

**Someone else owns it**: only a comment or reply that @-mentions the bot while
the app holds permission on the document (rows B vs D), or a reply in a thread
the bot has already replied in (row F2). `view` is enough permission (row J);
rows C–F used `full_access` only because that was granted first. The file-level
subscribe API does not widen this — its own documentation says a document
*manager* receives only file-edit and bitable events, and the probe agrees.

The two halves are different products. On a document the bot wrote, a
subscription is a pure routing decision — which recipient receives what the
platform is already pushing — and the word means what it says. On anyone else's
document, nothing can widen the platform's rule and a subscription only decides
where the few events that do arrive go.

A third case the operator named and this repo has **not** probed:「别人的文档里，
有一段是 bot 身份写的，那么这一段上的评论也会投递过来」. It fits the same rule —
the bot is notified about a passage it authored — and it is recorded as his
statement rather than as a probed fact. It is also the reason the rule is stated
as a rule and not as a table: the set of ways to be notified is the platform's
to decide, and this design must not depend on having enumerated it.

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

    An unclaimed event that @-mentions the bot is a person addressing it in a
    document nobody follows — the same "unrouted conversation reaches the
    Dispatcher Agent" rule chat already has.

    The reasoning first recorded here for the other side — that an unclaimed
    event with no mention "can only be the tail of a removed subscription" — was
    wrong, and rows K–M are why: every comment on a document the bot wrote
    arrives whether or not anyone subscribed it. That shape is now the common
    case, not a residue, and what to do with it is open rather than settled.
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
  - A comment with no subscription and no mention stays dropped, including on a
    document the bot owns. Asked as a question card once the ownership probe
    showed that shape is ordinary rather than residual, offering the alternative
    of collapsing the split into one rule — deliver to subscribers, or to the
    Dispatcher Agent when there are none. He chose `维持现状，靠流程`, the option
    whose description read「继续丢弃＋记日志；改成「模型写完文档顺手 subscribe」。
    不动代码，但主线能不能通取决于模型记不记得。」

    So the delivery split is unchanged and the cost is accepted knowingly: the
    main line — the bot authors a document, a person comments on it, the Team
    reads the comment — runs only if something subscribed the document first.
    The fact that makes that possible belongs where a model decides to call the
    tool, so `subscribe_document` says it — instructed directly:「你可以在
    Subscribe 工具的 Description 里边写一下，只有 Bot 身份写的文档才可以收到所有
    评论内容。」The description states that, states what a document someone else
    wrote delivers instead so no caller reads subscribing as widening the
    platform's rule, and states that nothing reaches any recipient until the
    tool is called.

    Making it a step of the workflow that authors such a document is outside
    this task's approved implementation boundary, and the operator has said
    where it lands instead:「先把机制搭起来。后面我在每一个仓库里都会有一个开发
    技能，那个里面会要求模型用 bot 身份写文档，并且在写完之后立即去订阅」. So
    this task delivers the mechanism and the statement of fact on the tool, and
    a per-repository development skill owns the step — not this change, and not
    the channel.

  - The reminder states what happened and stops there. After a first draft that
    walked the model through lark-cli, `--as bot`, and subscribing, the operator
    stopped it:「总的来说，就是我们需要让收到这条消息的 agent 知道发生了什么，然后
    后面怎么处理就可以了」「如果一篇文档没有人订阅，那它投递给 Dispatcher 的时候，
    对于 Dispatcher 来说，可能会有一点点迷惑」「我理解短期我们可以先简单写这个
    Reminder。或者说是不写，我先看看效果」.

    So the envelope carries the facts and the reminder carries only the one fact
    the envelope cannot: that the `reply` tool does not reach this document. The
    cold-open delivery adds one sentence saying nobody subscribed the document,
    because that is the fact the Dispatcher is otherwise missing. Nothing tells
    the model what to do, and the earlier `--as bot` guidance is dropped — he is
    watching the result before it grows.

  - A cold open — an @-mention in a document nobody subscribed — is one turn,
    and the reminder must say so instead of promising the thread will keep
    arriving. Asked as a question card after the independent review found the
    contradiction; answered:「这个地方，从真实使用场景来看，大部分时候是我在一个
    文档中 at Dispatcher，然后起到一个任务分发的作用，最常见的场景，实际上是让
    Dispatcher 拉团队查一下这个问题，或者看一下这个文档。其实我也没有太想好这个
    地方数据流要怎么走，但是 at 形式的这种场景大概率就是一轮，下一轮，这个文档就
    有可能会被 teamleader 订阅上。」

    So the cold-open delivery keeps writing no subscription row. What its
    reminder should *say* about continuing was drafted from this answer and then
    overruled the same night — see the reminder decision below, which is the one
    in force: the reminder names neither `subscribe_document` nor `--as bot`,
    because both are what to do rather than what happened. This entry stands for
    the one-turn ruling itself, which the later decision did not disturb.
  - The delivered envelope has one shape, the inbound chat one. Raised by the
    operator after the walkthrough —「现在 channel 入站不是 dreamux 层自己拼接的
    XML 格式吗？它外边应该有一个统一的 channel 标签才对」— and settled by a
    question card answered `拍平`. The `<doc-comment>` wrapper is removed: the
    facts that address the comment (`file_token`, `file_type`, `comment_id`,
    `reply_id`, `notice_type`, `mentioned`) become attributes of the envelope
    Core renders, exactly as a chat message's `chat_id` and `message_id` are,
    and `<quote>` and `<content>` become its direct children the way a chat
    message's `<content>` is. The `note` attribute pointing at lark-cli goes
    with the wrapper: the reminder already says it, and repeating it in the
    body is a second place to keep true.

  - 「评论里的艾特还是要归一化成和消息入站一致的格式」 — a mention inside a
    comment reaches the model as the same `<at user_id="…">` element an inbound
    chat message's mention does, not as the `@<open_id>` the comment API's
    `person` element literally names. Said after the rendered envelope was
    walked through with him, overruling the earlier reasoning that the comment
    API carries no display name and that `@<open_id>` is the form lark-cli
    takes: one format for a mention outweighs both. The display name is empty
    because Feishu does not carry one here, which is already what the chat
    renderer produces for a mention record without a name.
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
