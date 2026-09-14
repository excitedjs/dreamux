# Read Feishu inbound messages as text

## Current state

- Goal: Deliver every inbound Feishu message to the model as one text body whose mentions use the outbound reply syntax, with cards reduced to their text and attachments plus a lark-cli pointer.
- State: `done`
- Requirement: [Confirmed requirement](/.agents/tasks/channel/read-feishu-inbound-as-text/requirement.md).
- Final solution: [Implementation design](/.agents/tasks/channel/read-feishu-inbound-as-text/technical-design/final.md).
- Solution review Issue: None. The operator ruled on each open design point in the working session and assigned the implementation directly; see Development authorization.
- Verification: [Evidence](/.agents/tasks/channel/read-feishu-inbound-as-text/verification.md).
- Pull request: [#424](https://github.com/excitedjs/dreamux/pull/424).
- Related tasks: supersedes the inbound half of [simplify-feishu-replies](/.agents/tasks/channel/simplify-feishu-replies/README.md) (its PR #414 and the parts-only rework #422 were closed in favour of this task); builds-on the outbound half of that task, which this pull request carries unchanged as its first commit.

The submitted implementation replaces the ordered-parts inbound model with one
string per message. Transport flattens every message type into Feishu's own
vocabulary — `@_user_N` placeholders where a mention was written, the resource
key where an image or file was — and lists the resources beside the text. The
Channel escapes the text once and substitutes the placeholders and keys the
records name: a mention becomes `<at user_id="…">Name</at>`, byte-identical to
the syntax the `reply` tool takes; a resource becomes the `<attachment>` it
already rendered. Cards are read from the event alone, as their text and
attachments plus a `<refs>` row that says the message is a rich card the model
can pull with lark-cli; the two card reads, the read merge, the Markdown lexer,
the card layout reconstruction, the typed XML serialization, and the
`user_card_content` read mode are gone.

Knowledge owners updated in the same change:

- [Channel contracts](/.agents/domains/channel.md).
- [Product behavior](/.agents/product/README.md).
- [Transport README](/packages/channel/feishu-transport/README.md).

## Development authorization

This task ran in the operator's own working session, not through a Feishu
TeamLeader, so no interactive card was sent. On 2026-09-14 the leader listed the
five decisions the redesign needed and the operator answered each one:

> 1. 选B，就是它必须和出站保持一致。在入站和出站不一致的情况下，模型其实有可能出现幻觉，用入站的方式在出站消息里at别人。
> 2. 这块我们展开聊一下
> 3. 给他们废弃掉，再开一个新的
> 4. 先留着，这个任务做完之后再删。不然连个参考的都没有
> 5. 你来做。

After the card discussion the operator ruled:

> 1. 卡片也不一定全是应用发，人也是可以发的出的。目前你用的lark-cli 没办法用用户身份去发卡片，但是有些工具的 larkcli 是有这个权限的。
> 2. 出站只是 reply 不发卡片，但是可以用 lark-cli 去发卡片，那几个探针都是 claude code 用 lark-cli 发出来的
>
> 这两个候选的问题：
> 推荐 C。富文本卡片可以和那个合并转发消息带附件或者是其他的方式一样处理。额外提醒一句，模型：这个消息是一个富文本卡片，你可以用 larkcli 去拉。
> 那我们只需要把富文本卡片里面有用的东西提取出来就行。
>
> 具体什么是有用的东西？我感觉就是纯文字

While the implementation was being planned the operator added:

> 等等，卡片里的图和文件走和附件相同的逻辑

Item 5 ("你来做") is the development assignment. Item 3 is the delivery shape:
close #414 and #422, open one new pull request from `next` that carries the
#414 outbound commit first. Item 4 keeps the external capture evidence until
this task is finished. The approved boundary is the requirement's scope
section; the leader's own readings of "纯文字" are labelled as assumptions
there, not as rulings.
