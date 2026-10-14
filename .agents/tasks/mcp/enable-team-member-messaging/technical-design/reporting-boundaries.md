# Reporting boundaries: members versus managed Teams

This is source-based discussion under the operator's architecture hold, not a
replacement final solution or permission to change the delivered implementation.

## Operator input

On 2026-10-13, the operator said:

> 我想到了一个比较恶心的点，其实 dispatcher 之于 teamleader 并不能走这一条通道，因为 team 会非常多，team 的任何动态不应该推送给 dispatcher。
> 而 team 的则需要推送。
> 我感觉这里还是有没有考虑到的点。导致目前的架构看起来有点诡异。

The explicit architectural concern is that many managed Teams must not turn
their internal activity into an automatic input stream for the Dispatcher.
The earlier Q4 ruling covered ordinary root members as well as ordinary Team
members; it did not make TeamLeaders ordinary root members. The phrase about
Team-side pushes is read alongside the previously accepted member-to-leader
coverage, rather than extended to a recursively reporting ownership tree.

The subsequent clarification card asked whether a particular Dispatcher
`team.create` / `team.send` request should still receive its TeamLeader result.
The operator replied:

> 保留请求答复是正确的，要不我们把现在敲定的产品行为重新梳理一遍吧。

English rendering: "Keeping request replies is correct. Let's reorganize the
product behaviors we have agreed so far." The boundary is now recorded as Q5
in [requirement revision 3](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md):
retain specifically requested replies, without a Team-wide activity stream.

## Source findings

| Relationship | Delivered construction / current behavior |
| --- | --- |
| Ordinary Team member to TeamLeader | `TeammateCollection.teammateOptions` installs `nativeResultRecipient` from the Team's completion owner. Applicable normal/failed native results report to the leader. |
| Ordinary root member to Dispatcher agent | The same collection construction installs the actual Dispatcher-agent recipient. Q4 authorizes this ordinary-member coverage. |
| TeamLeader to Dispatcher agent | `teamLeaderOptions` installs no `nativeResultRecipient`; the leader is built separately from the ordinary root-member collection. The feature does not automatically report all leader native results upstream. |
| Explicit Dispatcher request to TeamLeader | Existing `team` MCP `create` with a prompt and `send` set `deliverCompletionToDispatcher: true`. Team creation or `TeamCollection.submitToLeader` attaches a recipient to that particular submission. Its settlement reports to the Dispatcher; this behavior predates the feature. |

Owning source: `service/agent/index.ts` (`teammateOptions`),
`service/team/leader.ts` (`teamLeaderOptions`), `service/team/mcp.ts` (`create`,
`send`), `service/team/service.ts` (prompt-bearing creation), and
`service/team/index.ts` (`submitToLeader`).

`AgentService.observeRuntimeResult` exits when no native result recipient was
installed. A provider publishing a neutral result does not itself deliver
input to an upstream agent. `TeamService.publishTeamState` publishes a Core
state projection; that source event is not a Dispatcher conversational input.
The completion router submits to its selected recipient and contains no
recursive parent-forwarding rule.

There is an important mixed case: a TeamLeader turn consuming a member report
may also answer a pending explicit Dispatcher submission. Its result can then
answer that request through existing settlement. The member report alone does
not create that upstream obligation. This case must not be obscured by saying
that a leader can never report anything to the Dispatcher.

## Architectural implication

Management ownership does not imply an automatic result recipient. TeamService
and DispatcherService can reuse ordinary-member communication because each
contains its own ordinary-member collection. This does not establish the same
reporting policy for the Dispatcher's separately managed TeamCollection.

The reusable mechanism is explicit recipient delivery, folding, admission, and
convergence. Scope assembly chooses whether native-result reporting exists and
who receives it. Preserve the existing distinction between a member-wide
native-result recipient and a per-submission reply obligation. Do not derive a
notification target from a generic parent chain or forward all descendants'
news. No new role enum, subscription registry, or policy service follows from
this distinction.

The earlier discussion of a single AgentService report owner addresses Core
side-effect ownership; it does not by itself resolve the product boundary
between managed Teams and ordinary members. Likewise, required versus optional
runtime sink presence addresses compatibility, not who receives observations.

## Missing proof and confirmed boundary

The new member tests primarily exercise the two positive ordinary-member
scopes and Workflow exclusion. They are not sufficient proof of the managed
Team boundary. After the solution is accepted and the hold lifted, verification
must cover multiple active Teams producing repeated leader/member normal and
failed results without unsolicited Dispatcher input. If request replies remain,
also distinguish an explicit request's one folded response from later unrelated
leader results. No tests are written or run during this discussion.

Specifically requested TeamLeader responses are retained by the operator's
answer. Removing even those `team.create`/`send` replies was an unselected
alternative, not an authorized simplification. Q4 ordinary-root-member
coverage remains accepted. The behavior consolidation does not lift the
architecture hold or authorize implementation corrections.
