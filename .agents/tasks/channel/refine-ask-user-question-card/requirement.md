# Requirement

## Initial requests

The operator, 2026-09-16, in the Feishu work group (a reference to a comparable
card in another Feishu integration is elided):

> 调整一下 ask user question 工具 … 我发现那个卡片发出来两个小时，它都可以点。然后这个Ask user question工具好像15分钟确实设的有点太激进了

The referenced card is a single-choice stage card built the same way as the
question card (JSON 2.0, `callback` behaviors, repainted from the callback
response). Its registry deliberately has no timer: a round ends on a click, when a
newer card for the same conversation supersedes it, or when the process loses its
in-memory registry. The operator observed it still accepting clicks two hours
after it was sent.

The first direction question card for this task closed on its own 14-minute
timer before the operator answered it. The operator, same day:

> 这个卡片没有收到.这个15分钟确实有点扯淡了

A second request arrived during clarification, same day:

> 额外给 ask_user_question 加一个参数，其实你先在想要问我问题，需要先 reply 发一个解释，然后再发问答卡片，是两个 toolcall 轮次，其实可以给问答卡片直接加一个参数，把解释和问答拼在一起。

## User stories

- A person in a Feishu chat is asked a decision by an agent and answers hours
  later, after lunch or the next morning, and the click still settles the
  question.
- An agent that needs to explain evidence before asking sends one card holding the
  explanation and the questions, instead of a `reply` followed by a card; the
  person reads the explanation above the questions, and can still read it after
  the card is finished.

## Current alignment

- Status: Converged.
- Desired outcome: Keep an `ask_user_question` card answerable for 24 hours, and
  let one card carry the explanation that precedes its questions.
- Desired behavior:
  - A round stays answerable for 24 hours unless a click settles it or its
    session closes.
  - When the timer fires, the card is repainted as closed and the expiry notice
    is delivered exactly as today.
  - Settlements keep today's routing through the card's actual conversation.
  - A shutdown or restart keeps dropping open rounds silently; a later click keeps
    getting the existing "这轮提问已失效，直接说你的想法就行。" toast.
  - `ask_user_question` accepts an optional Markdown explanation. The live card
    shows it above the questions, rendered the way a `reply` body is (mentions
    included). The submitted card shows the explanation and the answers; a
    cancelled or expired card shows the explanation and one grey status line. A
    card without an explanation looks as it does today.
  - The tool description tells the model to put the explanation in this
    parameter instead of sending a separate `reply` first.
- Scope: `ask_user_question` round lifetime and card content in the built-in
  Feishu channel, plus the knowledge that states them.
- Non-goals:
  - Closing cards on shutdown or restart, or persisting open rounds.
  - A newer card superseding an older one in the same conversation.
  - Repeating the explanation in the answer text delivered to the model.
  - Notifying the model when a shutdown drops its round.
  - Asker ownership of settlements — expiry notices and clicks after the asking
    Team closed, and cards sent into a conversation that never routed to the
    asker. Moved to [#434](https://github.com/excitedjs/dreamux/issues/434).
- Accepted risk until #434 lands: a round that settles after its asking Team
  closed keeps today's routing, so in a Collaboration Space topic it provisions a
  new Team and elsewhere it reaches the Dispatcher Agent. A 24-hour lifetime
  makes that more likely than the 14-minute one did.
- Constraints and invariants: A round still settles exactly once. A question card
  is one message and cannot be split, so a card over Feishu's content budget
  keeps failing the tool call before anything is sent (`sendCard` checks the
  budget first).

## Confirmed current behavior and evidence

- `packages/channel/feishu-channel/src/feishu-ask-user.ts` arms a timer of
  `ASK_USER_CARD_TTL_MS` (14 minutes) when a round is activated. On expiry the
  round settles as `expired`: the model receives "The question card expired with
  no answer from the user … Wait for the user's next message", and
  `expireAskUserQuestion` in `feishu-session-ops.ts` repaints the card as closed
  through `bot.editCard`. That repaint is the only `editCard` caller in the
  channel package. The `expired` outcome changes only the delivered text and a
  log field; settlement routing does not branch on it.
- The timer's only stated reason is the comment "Feishu stops accepting
  interaction on a card 15 minutes after it is sent". It was introduced by #362,
  whose description records the expired-card path as not exercised live. The
  same premise is restated in `.agents/domains/channel.md` (`ask_user_question`),
  in the product behavior catalog entry "A question the agent cannot answer
  becomes a card, and the turn ends" ("a card nobody answers closes itself before
  Feishu stops accepting clicks"), and in `tests/feishu-ask-user.test.ts`, which
  asserts the TTL is under 15 minutes. That assertion encodes the falsified
  premise, so rewriting it is part of this change rather than a weakened test.
- Feishu's published card and messaging documentation (checked 2026-09-16)
  states three time limits and no click cutoff: a card callback must be answered
  within 3 seconds; a delayed-update token is valid for 30 minutes and two uses
  (Dreamux does not use delayed update; its repaint rides the callback response);
  an already-sent message card can be patched only within 14 days of sending
  (error `230031`).
- Open rounds live only in memory; `FeishuChannelSession.teardown` abandons them
  silently, and a later click is answered with the "这轮提问已失效" toast.
- Graceful shutdown path: SIGTERM/SIGINT → `Server.shutdown` → dispatcher
  `doStop` (team runtimes stop first) → `ChannelService.closeAll` →
  `FeishuChannelSession.close` → `teardown` (`askUser.abandonAll()`, then
  `cot.close()`, which already repaints every live COT card as interrupted within
  a 5-second drain window) → `bot.close()`. `dreamux restart` goes through the
  service manager (`systemctl restart` / `launchctl kickstart -k`), which sends
  SIGTERM. A crash, a SIGKILL, or a service manager killing a shutdown that
  outlasted its stop timeout never reaches `teardown`.
- Late settlement routing. The timer or a submit/dismiss click →
  `deliverAskUserSettlement` reads the card's chat and thread from Feishu →
  `FeishuTargetRouter.project` yields the topic target with its container chat →
  `FeishuChannelSession.deliver` → `FeishuRouting.plan`. A Team's routes are
  removed when its `team.state` closes (`forgetTeamRoutes`). So after the asking
  Team is dissolved: in a registered Collaboration Space topic the plan is
  `provision`, and `FeishuProvisioning.run` calls `team.create` with the
  settlement's `sourceId` (`ask_user_question:<request id>`, new per round) as
  request id, creating a new Team whose first input is the settlement text; in a
  chat with no space the settlement goes to the Dispatcher Agent. The path exists
  today, but a 14-minute window rarely spans a dissolution and a 24-hour window
  can.
- A card-action event carries the chat id and card message id but no thread id,
  which is why settlement reads the card back from Feishu to find its topic.
- A `reply` is a JSON 2.0 card holding one `markdown` element
  (`feishu-transport` `cardContents`), split into several cards above 28 KB.

## Acceptance criteria

- An unanswered round stays open for 24 hours; a click inside that window
  settles it as today.
- On expiry the card is repainted as closed, keeping its explanation, and the
  expiry notice is delivered as today.
- A restart still drops open rounds without repainting them.
- `ask_user_question` accepts an optional explanation; with it, the live,
  submitted, cancelled, and expired cards show it as described above;
  without it, every card matches today's output.
- The tool description, `.agents/domains/channel.md`, and the product behavior
  catalog no longer state a 15-minute Feishu cutoff and describe the new behavior.

## Decisions and unknowns

- Confirmed operator decisions (2026-09-16):
  - Question card: create a new channel task rather than reusing
    `fix-question-card-topic-routing` — "新建任务".
  - Question card, answered through the free-text field instead of the offered
    "remove the timer" / 2 hours / 24 hours options: keep the round timer and raise
    it to 14 days — "直接拉到14天，但是重启后估计很难找回来了，重启的时候能批量把卡片
    关掉吗？". Superseded on the development-authorization card below.
  - Development-authorization card, answered through the free-text field instead
    of approving 14 days minus one minute: the lifetime is 24 hours — "还是不要设这么久的
    有效期了。就给他设24个小时吧".
  - Question card: a shutdown or restart does not close open cards — "不做批量
    关闭". Offered alternatives were closing cards on a graceful shutdown, and
    additionally persisting open card ids to close them on the next start.
  - Question card (moved to #434, see below): an expired round notifies the model
    only while the asker still owns the conversation — option "原 Team 还在才通知", whose description read
    "发卡时记下发问方，超时时路由已不指向它就只改卡片。会多出一套归属记录和检查
    （workflow 卡片对点击有类似做法）". Offered alternatives were repainting only
    with no notice, and keeping today's notice.
  - Question card (moved to #434, see below): a click that arrives after the
    conversation no longer routes to the asker is refused and closes the card — option "拒绝并关卡", whose
    description read "复用超时要加的那套归属检查。路由已经不指向发问方时，这次点击
    不投递，卡片改成「已关闭」，并弹提示「发问的 Team 已经不在了，直接说你的想法就
    行」。workflow 卡片对点击就是这么处理的。" The offered alternative was
    delivering as today.
  - Question card: the explanation-parameter request joins this task and its pull
    request — "并进当前任务 (Recommended)".
  - Question card: every finished state keeps the explanation — "所有结束状态都保留
    (Recommended)", whose description read "提交后显示「解释 + 每个问题的答案」。
    取消、超时、迟到被拒显示「解释 + 一行灰字状态」，问题和按钮去掉。没填解释的卡片
    跟现在完全一样。"
  - Development-authorization card, whose question named "重启丢弃不通知模型" among
    the approved items: the model is not notified when a shutdown drops its
    round — "批准，进入开发 (Recommended)".
- Assumptions: The two-hour observation transfers to the question card because
  Feishu accepts or rejects a callback before Dreamux's registry sees it. Not
  observed directly on a question card, which also carries `input` elements.
- Asker ownership (moved to #434 with the two rulings above; kept here as the
  evidence the move carries): at settlement — expiry, or a
  submit or dismiss click — the card's conversation must route to the asker: the
  asker's Team for a TeamLeader, the Dispatcher Agent for the Dispatcher. The
  operator was asked whether this rule should also refuse a card whose
  conversation never routed to the asker, and answered with a question —
  "怎么可能会有这种卡片". The traced answer: no normal path produces one. Core admits
  the tool by caller catalog and neither `createFeishuSessionMcp` nor
  `askUserQuestion` checks the target against the caller's routes, so it arises
  only from a model mistake — omitting the optional `message_id` in a topic group,
  where a top-level send opens a new topic (`.agents/domains/channel.md`), or
  passing another chat's id. No mechanism is added for it; the settlement rule
  above covers it as written.
- Card routing (deferred to [#434](https://github.com/excitedjs/dreamux/issues/434)).
  Answering the solution-path card, the operator proposed instead that card
  settlements stop riding the conversation routing table — "这个问题确实比较恶心，
  之前我也遇到过几次。我觉得，要彻底解决这个问题，卡片的回推是不是不应该走路由表，
  而是应该有一个单独的卡片路由表？？" — and then deferred it: "这样吧，这个问题你先开个
  issue记一下，先不在本次解决吧。" Issue #434 records both traced misdelivery
  scenarios and the direction.
  - Question card: the two asker-ownership rulings above move to #434 with the
    card-routing redesign — "挪进 #434". The offered alternative was keeping them
    in this task. They no longer bind this task.
- Blocking unknowns: None.
