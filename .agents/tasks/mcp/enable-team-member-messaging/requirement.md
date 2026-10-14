# Requirement: proactive ordinary-member messaging

- Revision: 3, consolidated on 2026-10-13 after the managed-Team reply clarification.
- Source: [Issue #471](https://github.com/excitedjs/dreamux/issues/471) and the operator decisions quoted below.
- Prior requirement: [Revision 2 and its investigation history](/.agents/tasks/mcp/enable-team-member-messaging/requirement-revision-2.md).
- Status: Accepted product behavior. The selected design and resumed delivery authority are recorded in the task README. This consolidation alone is not development approval.

## Product outcome

Ordinary members can contact their conversational owner and peers without an
owner relay. Their applicable turn results automatically reach that owner.
Managed Teams have a different relationship to the Dispatcher: they answer
specific Dispatcher requests, without becoming a stream of Team activity in
the Dispatcher's conversation. Management ownership alone does not imply a
continuous result subscription.

## Actors and reporting boundaries

| Producer | Conversational owner / recipient | Automatic-result coverage |
| --- | --- | --- |
| Ordinary member of a Team | That Team's TeamLeader | Every provider-observed normal or failed native result, including a result without a Dreamux submission. |
| Ordinary member of the Dispatcher's root member collection | That Dispatcher agent | The same ordinary-member result coverage. |
| TeamLeader of a managed Team | Dispatcher agent only for a particular request | Retain the result answering an explicit Dispatcher `team.create` prompt or `team.send`. Do not automatically forward unrelated leader turns or Team internal activity. |
| Member controlled by a running Workflow | Workflow script | Preserve script-consumed results and existing Workflow terminal reporting; no new ordinary-member reporting or messaging tools during that control. |

The TeamLeader is not an ordinary member of the Dispatcher's root collection.
A Team member report stops at its TeamLeader; it creates no automatic upstream
reply obligation. If a leader turn also answers a pending explicit Dispatcher
request, the response to that request remains valid. That does not subscribe
the Dispatcher to later autonomous turns.

## Explicit ordinary-member communication

- An ordinary member can address its actual owner or another ordinary member
  in the same owning collection. It can discover its owner and scoped peers.
- Team members have same-Team peers. Root members have peers in that root
  collection. This grants no cross-Team, cross-collection, or cross-Dispatcher
  messaging, and does not add TeamLeaders to the root peer set.
- The host binds the real sender. Recipients see that identity; the model
  cannot choose a different sender.
- The explicit message goes only to its addressed recipient. A peer message
  is not automatically copied to the owner. The receiving member's eventual
  result may still be automatically reported under the separate result rule.
- Send returns an admission receipt without waiting for a response or task
  completion. Admission is not proof that the model has processed the input.
- An explicit send starts processing on an idle recipient. Busy input follows
  the runtime's existing admission behavior; there is no universal promise of
  immediate interruption.
- Replies are explicit. A peer sender receives no automatic completion reply;
  an owner-directed message creates neither an automatic owner reply to the
  member nor a new upstream reporting obligation. Pre-existing submitted
  requests retain their own reply obligations.
- Existing owner-to-member tools remain available. Member communication does
  not grant spawn, close, dissolve, or other owner lifecycle authority.

## Automatic ordinary-member result reports

- Report each provider-observed normally completed or failed native turn to
  the member's actual owner, whether it answered an owner request, a peer
  message, or no Dreamux submission.
- Preserve successful result content. Keep existing failure-notice content;
  failure coverage does not authorize adding error details to the public body.
- Multiple submissions answered by one native result produce one owner report.
  Native observation and submission settlement describing that same result do
  not produce duplicate reports. Distinct results report separately and retain
  their applicable ordering; no cross-turn quiet-point aggregation is selected.
- Report an observed turn outcome, not an assertion that the assigned goal is
  achieved. A turn can end while a background build continues. Its later normal
  or failed result is separately reportable; task success remains content the
  member states in its result or explicit message.
- Do not copy the explicit peer-message transcript or recursively forward
  reports through the management hierarchy.
- Existing submission-associated failure/interruption outcomes remain in
  scope. The background expansion does not add unbound interruption reports
  or fabricate a turn terminal for a connection-level error or unobserved work.
- Work ended by owner close, stop, Team dissolve, or service shutdown retains
  existing suppression. Do not notify an owner about the stop it requested;
  a report whose delivery already began is not retracted.

## Admission, availability, and recovery limits

- Explicit send to a durably closed same-collection peer can reopen that same
  recorded member using existing session recovery, then submit the message.
  It does not replace the member or require the owner to reopen it first.
- Reads and startup do not reopen closed members. The peer-send decision does
  not reopen a closed/dissolving Team or bypass Dispatcher/Team teardown fences.
- Ordinary input continues to respect active Workflow locks. A historical
  Workflow origin is not a permanent new member category after ordinary reopen.
- Explicit input retains its existing wake behavior. Automatic result delivery
  retains live-runtime push-back: it does not start an unavailable owner runtime.
  An unavailable owner or a closing scope can reject/drop the automatic report.
  No durable offline mailbox or unconditional replay guarantee is added.
- Busy-input differences between the two runtimes remain observable rather
  than being replaced by a Core interruption rule.

## Managed-Team boundary

- Team member messages, result reports, leader autonomous turns, and Team
  internal activity must not become unsolicited Dispatcher conversation input.
- Preserve the asynchronous response to a Dispatcher request made through
  `team.create` with a prompt or `team.send`. The tool receipt remains admission,
  with the corresponding request result delivered later under the existing
  folding, availability, and stop rules.
- A create without a prompt does not create an artificial turn answer. A
  Channel-originated Team request does not acquire a Dispatcher reply recipient
  merely because the Dispatcher manages that Team.
- Later leader continuation results do not extend the original request's reply
  obligation. The Dispatcher can make another explicit request when it needs
  another answer.
- Management inventory/state visibility is distinct from injecting input into
  the Dispatcher model. The operator ruling on conversational pushes does not
  authorize removing existing reads, lifecycle state projections, or Channel
  presentation.

## User stories and observable acceptance

1. A Team member reports a blocker during its turn; its TeamLeader sees the
   sender and can explicitly respond. A root member can do the same with its
   Dispatcher agent.
2. Two peers in either member collection exchange questions and explicit
   replies across turns, without an owner relay or cross-collection access.
3. A submitted turn says a build is running; a later background turn reports
   the observed build outcome. Both distinct results reach the member's owner
   under the existing availability limits, without a duplicate for folded inputs.
4. An observed failed member background turn reports failure once; an owner
   stop does not create news about the owner's own stop.
5. Sending to a closed peer reopens its recorded identity/session; sending to
   a Workflow-locked member still observes the lock.
6. Multiple Teams generate member and leader results without unsolicited
   Dispatcher input. An explicitly requested TeamLeader answer still returns
   once; later unrelated results do not continue that request's push stream.
7. Both in-tree runtimes obey the ordinary-member coverage and isolation rules.
   Report actual runtime differences and unrun live gates honestly.

## Accepted operator decisions

The original Team-scoped cards below are applied to ordinary root members by
Q4. They do not turn managed TeamLeaders into root members.

### Q1: every normally completed native turn

> 每个完成回合自动报 (Recommended)

English rendering: "Automatically report every completed turn (Recommended)."
The card covered normal ordinary-member native results, including observed
background turns; it did not decide failure or interruption expansion.

### Q1a: observed failed background turns

> 失败也自动报 (Recommended)

English rendering: "Automatically report failures too (Recommended)."
This adds observed failed member background results, preserving owner-stop
suppression and the existing unbound-interruption boundary.

### Q2: peer send reopens a closed peer

> 允许 send 重新打开 (Recommended)

English rendering: "Allow send to reopen (Recommended)."
This applies existing recovery to the same closed peer, without new lifecycle
management authority or access through teardown/Workflow fences.

### Q3: ordinary members only

> 只覆盖普通成员 (Recommended)

English rendering: "Cover ordinary members only (Recommended)."
Active Workflow-controlled members retain their script and lock contract.

### Q4: both ordinary-member categories, reusable mechanism

> 我期望是两类都覆盖，其实 dispatcher 和 teamleader 越来越像了。dispatcher 只是带了teamCollection 的 teamService。这里我不希望有过多的代码分叉，这套机制应该简洁，足够抽象和可复用。

English rendering: "I expect both categories to be covered. Dispatcher and
TeamLeader are becoming increasingly alike; Dispatcher is a TeamService with
a TeamCollection. I do not want excessive code branching here. This mechanism
should be concise, sufficiently abstract, and reusable."

This authorizes common ordinary-member behavior in the two collections. It
prescribes neither service inheritance/merger nor recursive parent reporting.

### Q5: managed Teams do not stream activity; explicit request replies remain

The operator first stated:

> 我想到了一个比较恶心的点，其实 dispatcher 之于 teamleader 并不能走这一条通道，因为 team 会非常多，team 的任何动态不应该推送给 dispatcher。
> 而 team 的则需要推送。
> 我感觉这里还是有没有考虑到的点。导致目前的架构看起来有点诡异。

English rendering: "Dispatcher-to-TeamLeader cannot use this channel in the
same way: there will be many Teams and their activity must not be pushed to
the Dispatcher. Team-side pushes are needed. Something seems overlooked,
making the architecture look strange."

The clarification card asked whether Dispatcher still receives the result of
an explicitly submitted `team.create` / `team.send` request. The operator replied:

> 保留请求答复是正确的，要不我们把现在敲定的产品行为重新梳理一遍吧。

English rendering: "Keeping request replies is correct. Let's reorganize the
product behaviors we have agreed so far."

Record the prohibition and its confirmed request-response boundary together.
Do not use Q5 to remove Q4 root-member coverage, explicit requested replies,
existing management reads, or script/Channel behavior.

## Technical design and authorization boundary

The product snapshot does not select required versus optional runtime fields,
version-support policy, Core notification ownership, or service inheritance.
The selected revision-3 solution records those technical choices under the
resumed authority in the task README. The prior revision-2 solution and delivered
code remain comparison evidence; the historical hold is retained in the decision
trail rather than inferred as the current workflow state.

Keep the acknowledged member MCP home and actual-owner scope division as
recorded in revision 2, without treating placement as proof of an optimal
interface. Preserve a concise reusable mechanism, neutral provider boundaries,
existing state/config/lifecycle contracts, and no excessive owner-kind forks.

The task README owns current workflow and authorization status. Revision-2
approval and the subsequent hold remain historical evidence; the operator's
2026-10-14 delegated quality ownership and explicit proceed instruction are
recorded there. This product revision alone does not grant implementation or
publication authority. Read the current task authorization before advancing.
