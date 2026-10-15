# Requirement: proactive ordinary-member messaging

- Revision: 2.
- Finalized for renewed solution consultation on 2026-10-13 after accepted Q4, covering Team-owned and Dispatcher-root ordinary members and the acknowledged MCP/owner placement.
- The original Team-scoped Q1/Q1a/Q2 evidence remains below. Q4 explicitly applies the selected enhanced capability to both member categories; it supersedes the earlier Dispatcher exclusion without expanding interruption or Workflow coverage.

## Initial request and authority

The requirement source is [Issue #471](https://github.com/excitedjs/dreamux/issues/471),
which preserves the operator's original wording. English translation:
"Bring this mechanism to Dreamux, add TeamMate-initiated sends to the TeamLeader
and sends between peers; the completion push-back mechanism may need adjustment."

The operator confirmed creation of this task through an interactive intake card
on 2026-10-13. That confirmation authorizes task records and requirement
clarification, not implementation. The issue's confirmed behaviors below are
the imported requirement baseline. The accepted decisions recorded below
resolve the relevant issue questions and are the current requirement authority.

The [research appendix](https://github.com/excitedjs/dreamux/issues/471#issuecomment-6126982114)
and [candidate implementation approach](https://github.com/excitedjs/dreamux/issues/471#issuecomment-6126999206)
are evidence and a proposal, respectively. Neither grants approval to its
implementation choices or resolves the issue's open product decisions.

## User stories

1. An ordinary TeamMate discovers a blocker or intermediate result. It can
   contact its actual conversational owner during its current turn: the
   TeamLeader for a Team member, or the Dispatcher agent for a Dispatcher-root
   member. That owner can identify the sender and explicitly respond.
2. Ordinary member A needs information from member B in the same owning
   collection. They exchange messages and explicit replies across turns without
   the owner relaying them. A Team's members and a Dispatcher's root members
   each have their own peer scope; this grants no cross-collection messaging.
3. The actual owner follows work across multiple member turns. Every applicable
   normal or failed provider-observed native result returns to that owner once,
   including background continuations, regardless of which peer initiated an
   explicit input. The peer sender receives only explicit replies.
4. The same communication contract serves both ordinary-member categories.
   Maintaining the feature should not require mirrored Team/Dispatcher tool or
   routing policies. Dispatcher-specific Team management stays available.

## Confirmed behavior for revision 2

The original baseline in #471 addressed Team members. Accepted Q4 generalizes
the same enhanced capability to Dispatcher-root ordinary members. The actual
owner and its collection supply the recipient and peer scope; the remaining
communication rules stay the same.

- Explicit messages go only to the addressed owner or same-collection peer;
  peer messages are not automatically copied to the owner.
- The host binds the sender to the actual calling member. The recipient sees
  that identity and can address an explicit reply.
- Sending returns an admission receipt without waiting for a response or
  completion. Admission does not prove execution or receipt by the model.
- An explicit send starts processing on an idle recipient. Busy input follows
  the runtime's existing behavior and does not promise immediate interruption.
  The operator's selected wording is preserved in #471; English translation:
  "Wake the recipient to process it (Recommended); when busy, use the runtime's
  message-reception behavior."
- A peer-triggered completion goes to the actual owner. A reply to the initiating
  peer requires an explicit send. Receiving input does not change ownership.
- Distinct applicable completed turns each report their result; submissions
  folded into one native completion produce one automatic report.
- Automatic reports contain completed results, not every explicit peer message.
- A message to the owner does not create an automatic completion reply to the
  sending member. Existing owner submission obligations, including
  TeamLeader-to-Dispatcher completion obligations, are not replaced.

## Current source behavior and evidence

Source inspection establishes the following; no live runtime experiment is
claimed by this task.

- Ordinary members have no Dreamux MCP delegate in
  [`TeammateCollection.teammateOptions`](/packages/dreamux/src/service/agent/index.ts).
  [`TeamMateMcpScope`](/packages/dreamux/src/service/agent/mcp.ts) has Dispatcher
  and TeamLeader scopes, without a member scope. This was also rechecked against
  the fetched `next` source at intake.
- `spawn` and `sendResolved` in that collection select the collection owner's
  completion recipient. The Team is its members' recipient;
  [`TeamService.completionRecipient` and `prepareCompletion`](/packages/dreamux/src/service/team/service.ts)
  deliver to the TeamLeader under the existing Team fence.
- [`DispatcherService`](/packages/dreamux/src/service/dispatcher-service/index.ts)
  constructs its root `TeammateCollection` with `teamScope: null`, its existing
  fence, and its actual Dispatcher agent as `completionOwner`. Its
  `submitToAgent` is already a fenced ordinary-input entry without a caller
  completion recipient. [`DispatcherAgent`](/packages/dreamux/src/service/dispatcher-service/agent.ts)
  returns its contained `AgentService` as the completion recipient. This is
  existing submitted-result ownership, not an existing member communication
  surface or unbound-native-result guarantee.
- [`AgentService.submitInput` and `submitRuntimeTurn`](/packages/dreamux/src/service/agent/service.ts)
  submit through the runtime and attach an `EntityTurn` only to an admitted
  `RuntimeSubmission`. The recipient comes from the submitted input.
- [`EntityTurn`](/packages/dreamux/src/service/agent/turn.ts) reports the eventual
  submission outcome; [`CompletionDeliveryPolicy`](/packages/dreamux/src/service/completion-router/index.ts)
  folds reports by the provider's completion identity. A provider-started turn
  without a Dreamux submission creates no such Core turn or automatic report.
- [`AgentRuntime`](/packages/dreamux-types/src/agent-runtime.ts) exposes
  submission settlement. Native activity is a separate presentation surface;
  [`RuntimeGeneration.generationActivitySink`](/packages/dreamux/src/service/agent/runtime-generation.ts)
  sends it to display rather than using it as the result-delivery contract.
- The [product catalog](/.agents/product/README.md#background-work-and-completion-delivery)
  explicitly permits later native background turns without an automatic parent
  report, preserves steering/queued-submission answers, and suppresses reports
  for work the owner itself stopped.
- [`completionStatusLine` and `teammateStatusLine`](/packages/dreamux/src/service/agent/completion-renderer.ts)
  render a successful submission outcome as "has finished its task", although
  the observed fact is that a submission was answered by a native turn, not
  that the member's assigned goal was achieved. The ordinary member's
  [role prompt](/packages/dreamux/src/service/agent/system-prompt.ts) promises
  delivery of its turn-end output without naming the background exception.
  Both were rechecked during the three-model consultation. Aligning that
  wording with the selected policy is proposed; neither text has been edited.
- Neither the runtime lifecycle status nor the number of unanswered Dreamux
  requests proves that native background work has drained. Even actual
  quiescence would not prove semantic task success: a quiet member can be
  blocked or awaiting input. No existing authoritative work-drain producer
  was found in the in-tree runtime contracts or adapters.
- [`TeammateCollection.send`, `sendReopened`, and `reopenFrom`](/packages/dreamux/src/service/agent/index.ts)
  reopen a durably closed member before submitting the message. This is the
  existing TeamLeader/Dispatcher send behavior, not proof of authority for a
  new peer caller. The [closed-record product entry](/.agents/product/README.md)
  treats explicit send as the reopening operation; startup and read operations
  do not reopen a closed record.
- [`WorkflowRun.executeAgent`](/packages/dreamux/src/service/workflow-service/run.ts)
  creates a locked member with Workflow instructions and an optional output
  schema, submits through the lock handle, and reads `admission.turn.settled`
  as the script's result. [`AgentService.enterOrdinaryMutation`](/packages/dreamux/src/service/agent/service.ts)
  refuses ordinary input while that lock is held. Its `submitLocked` path does
  not attach an automatic completion recipient; individual results belong to
  the script, rather than a separate ordinary-member completion notification.

## Scope and constraints

- Requested scope: ordinary members of a Team and ordinary Dispatcher-root
  members, their actual owner, and peers in that same owning collection.
- Cross-collection, cross-Team, and cross-Dispatcher member messaging is outside
  this feature. The owner actor is not added as an ordinary member of its own
  child collection; its existing role, tools, and submission obligations remain.
- Member spawn, close, dissolve, or other lifecycle authority is not implied.
- Keep runtime-specific scheduling and transport behind `AgentRuntimeProvider`.
- Normal native/background completion and observed background-failure
  reporting are expanded by accepted Q1 and Q1a below. Peer reopening of
  closed peers is accepted in Q2 and applied to both owning collections by Q4.
  Members under active Workflow control in either collection are outside this
  feature's scope under Q3.
- The acknowledged MCP home is `service/agent/mcp.ts`, using the existing
  `teammate` server and member `send`/`list` surface. Actual owners provide the
  scoped messaging capability; collection/entity construction and generation
  leases remain the mounting mechanism.
- The communication/member capability must be concise, abstract enough for
  both owners, and reusable, without excessive Team-versus-Dispatcher branches
  or duplicate implementations. Choose any foundational refactor from actual
  source responsibilities and state what it removes. The operator's similarity
  observation is not a prescribed inheritance model or blanket authorization
  to replace state, configuration, channel, or lifecycle contracts.
- Preserve existing interruption, failure, shutdown, completion folding, and
  automatic-completion wake semantics unless a separate explicit decision
  changes a named behavior.

## Product behavior entries to reconcile

- Add the ordinary-member communication capability and its sender, recipient,
  admission, and busy-input semantics for both owning collections.
- Replace the current silence for unbound normally completed native turns
  with automatic reporting under accepted Q1. Background work still survives
  the submitted turn; reporting does not declare that its goal was achieved.
- Expand automatic failure reporting to provider-observed failed background
  turns under accepted Q1a, retaining existing owner-stop suppression.
- Extend the existing explicit-send reopening behavior to ordinary same-collection
  peer callers under accepted Q2; startup and reads still do not reopen records.
- Preserve active Workflow input locks, script-consumed member results, and
  Workflow terminal reporting under accepted Q3; no new member communication
  tools or ordinary-member automatic reporting are added to those calls.
- Preserve owner-requested stop behavior and asynchronous dispatch receipts
  unless the operator explicitly selects a change.

## Original Q1 consultation and selected policy

The original decisions below were scoped to Team members. Accepted Q4 is the
authority applying those selected policies to both ordinary-member categories
in revision 2 and replacing the original Dispatcher exclusion. Their failure,
interruption, owner-stop, folding, and delivery limits remain intact.

The operator-requested DeepSeek, MiMo, and Trae Seed consultation included
independent source exploration and an exchange of the resulting alternatives.
The TeamLeader rechecked decisive source claims. This was read-only exploration;
no live runtime validation or implementation is claimed.

Distinguish three facts: a native turn ended, a submitted request was answered,
and the assigned work achieved its goal. Neither submission settlement nor
native quiescence proves the third. Host-generated notification wording must
state the observed fact; meaningful work completion can be expressed in the
member's result or explicit message.

The evaluated short list concerns successful results from ordinary Team members.
Candidate A was subsequently selected as the requirement; its technical solution
and development remain unapproved.

| Candidate | Automatic reports to the TeamLeader | Background continuation | Product and mechanism trade-off |
| --- | --- | --- | --- |
| A: every observed normal native completion | Each provider-observed normal native completion, including one without a Dreamux submission | Automatically reports each observed continuation result | Adds passive coverage and more notifications; requires a runtime-neutral native-result capability. One result can share its identity with submission settlement to avoid duplicate delivery. This does not guarantee that an assignment is finished. |
| B: retain submission-associated reports | Existing submission-associated successful outcomes, including peer-triggered outcomes | Member explicitly sends meaningful results, progress, or blockers | Preserves the confirmed baseline; no new completion capability. A meaningful later result can remain silent if the member does not send it. Member tools are already part of #471. |
| D: successful work reports are explicit | No automatic successful-result reports from ordinary members | Member explicitly reports meaningful results, as it does for initial work | Gives the member responsibility for success reporting and loses passive success coverage, including leader-spawned work and peer-triggered results. Revises #471 and the dispatch receipt/push contract. Existing submission-associated failures/stops and other roles' settlement remain separate. |

The concrete differentiator is a background build: the submitted turn says
"build running", then a later unbound turn says "build passed". A automatically
reports both distinct results. B automatically reports the first and relies
on an explicit message for the second. D relies on explicit work reports for
both; the member may choose to send only its final work report. During a peer
exchange consisting entirely of submitted turns, A and B provide the same
automatic result coverage; D removes those successful automatic reports.

DeepSeek and Trae Seed's final preference was B; MiMo's was A. The operator
selected A after reviewing the differences. D was evaluated as a distinct
product option, not a defect repair or an automatic entropy improvement; it
was not selected. Consultant agreement does not establish product authority.

### Accepted decision Q1: report every normally completed native turn

On 2026-10-13, the operator selected the normal-result reporting policy card.
Selected answer (verbatim quoted evidence):

> 每个完成回合自动报 (Recommended)

English rendering: "Automatically report every completed turn (Recommended)."
The card's question and explanation limited this choice to normally completed
ordinary-TeamMate native turns, including provider-observed background turns.

- Every provider-observed normally completed native turn from an ordinary
  Team member automatically reports its result to that Team's TeamLeader,
  whether or not a Dreamux submission is associated with it.
- The same native completion produces one automatic report when several
  submissions fold into it. Separate native completions report separately;
  there is no cross-turn quiet-point aggregation.
- The report states the native-turn result. It does not claim the member's
  assigned work achieved its goal merely because a turn ended.
- Existing explicit-message recipients, peer replies, Team ownership, and
  completion-delivery wake/fence semantics remain as previously confirmed.
- Q1 covers normal completion only; the separate accepted Q1a below covers
  observed failed background turns. Neither decision expands reporting for
  unbound interrupted turns, Workflow members, Dispatcher-scoped members, or
  the TeamLeader's own native turns.
- This is requirement approval, not approval of a provider interface,
  implementation mechanism, or entry into development.

Deferred aggregation candidate: keep background results until a quiet point
and send one combined report. The required authoritative native-work quiet
fact is absent. Waiting for all work to drain can indefinitely delay a
"server ready" report while that server remains running; a quiet member may
also be blocked rather than successful. This adds a work-observation contract
and result-holding semantics without establishing semantic completion. It is
not presented as a ready, smaller solution. Submission-associated reporting
plus the already-requested explicit messaging is a fuller account of B, not
a distinct third automatic policy.

### Accepted decision Q1a: also report observed failed background turns

On 2026-10-13, the operator selected the independently asked background-failure
policy. Selected answer (verbatim quoted evidence):

> 失败也自动报 (Recommended)

English rendering: "Automatically report failures too (Recommended)."

- A provider-observed failed native turn from an ordinary Team member
  automatically reports failure to that Team's TeamLeader even without a
  related Dreamux submission.
- The same native failure is reported once, including when submission
  settlement and native observation describe the same result.
- Existing submission-associated failure reporting and owner-requested
  stop/close suppression remain in force. Reporting a failed native turn does
  not extend the decision to interrupted turns or fabricate a terminal result
  for background work the runtime did not observe ending.
- This is a separate requirement decision; no implementation is approved.

The consultation itself did not authorize failure/interruption expansion;
Q1a above is the operator authority for failed background turns. Interruption
coverage remains at its existing boundary. No claim of durable or unconditional
delivery is added: existing completion-delivery fences and limits still apply.

## Accepted decision Q2: peer send can reopen a closed member

On 2026-10-13, the operator selected the closed-recipient policy card.
Selected answer (verbatim quoted evidence):

> 允许 send 重新打开 (Recommended)

English rendering: "Allow send to reopen (Recommended)."

- An ordinary member's explicit message to a durably closed same-Team member
  can reopen that same member under the existing runtime-session recovery
  rules and then submit the message. It does not create a replacement member
  or require the TeamLeader to reopen the recipient first.
- The recipient stays in its existing Team and keeps its recorded identity;
  result reporting still goes to that Team's TeamLeader.
- This authorizes the effect of sending to a closed member, not member access
  to spawn, close, dissolve, or another lifecycle tool.
- Existing Team and entity admission/teardown fences still govern the send.
  This does not authorize reopening a closed or dissolving Team.
- A member under an active Workflow's lock is a different situation from
  the closed-recipient scenario; Q2 does not settle that input authority.
- This is requirement approval, not entry into development.

## Accepted decision Q3: ordinary members only

On 2026-10-13, the operator selected the Workflow-scope card.
Selected answer (verbatim quoted evidence):

> 只覆盖普通成员 (Recommended)

English rendering: "Cover ordinary members only (Recommended)."

- This feature does not include members while they are controlled by a running
  Workflow. They receive no new ordinary-member communication tools, and
  ordinary peer input still observes their existing Workflow lock.
- Individual results remain script-consumed; Q1/Q1a do not add ordinary-member
  automatic result/failure notifications to Workflow calls. The Workflow run's
  own existing terminal notification remains its separate contract.
- A closed record's historical creation by a Workflow is not a new permanent
  member category. Existing recovery rules and actual current ownership/locks
  govern access; this decision does not authorize bypassing a held lock.
- This is a scope decision, not an implementation approval.

## Accepted decision Q4: both member categories and shared mechanism

On 2026-10-13, the operator answered the scope card asking whether the enhanced
capability also covers Dispatcher-root ordinary members. The card context
included proactive owner/peer messaging, normal/failed per-turn result reports
to the actual owner, same-collection peers, and continued Workflow exclusion.
Selected answer (verbatim quoted evidence):

> 我期望是两类都覆盖，其实 dispatcher 和 teamleader 越来越像了。dispatcher 只是带了teamCollection 的 teamService。这里我不希望有过多的代码分叉，这套机制应该简洁，足够抽象和可复用。

English rendering: "I expect both categories to be covered. Dispatcher and
TeamLeader are becoming increasingly alike; Dispatcher is a TeamService with
a TeamCollection. I do not want excessive code branching here. This mechanism
should be concise, sufficiently abstract, and reusable."

- Both ordinary-member categories receive the enhanced communication and
  normal/failed provider-observed native-result reporting capability.
- Team members address their TeamLeader and same-Team peers. Dispatcher-root
  members address their Dispatcher agent and peers in that root collection.
  Each native result reports to the actual owner, never the peer sender.
- Apply the same admitted-input, explicit-reply, closed-peer reopen, once-only
  native-result, and owner-stop boundaries. Workflow-controlled members remain
  excluded; no cross-collection access is introduced.
- Keep a common mechanism and avoid excessive owner-kind branching or copied
  Team/Dispatcher communication implementations. Verify current differences
  before designing the abstraction; preserve Dispatcher-specific Team management
  and the existing user-visible lifecycle/state/config/channel contracts.
- The acknowledged tool home and owner-routing division remain input to this
  renewed technical consultation. No concrete inheritance or service-merger
  implementation is prescribed by the analogy.
- This is scope/design-direction approval, not development authorization.

## Observable acceptance criteria

- A member in either category can report progress or a blocker to its actual owner
  during a turn, with its actual sender identity visible.
- Two ordinary members in the same owning collection can send and explicitly reply directly,
  across completed turns, without an owner relay.
- Explicit send to an idle recipient starts processing; busy input follows
  the runtime's normal admission behavior.
- Every distinct applicable completion reaches the actual owner; its initiating
  peer receives only explicit replies. Folded inputs do not duplicate reports.
- Provider-observed normally completed native turns without a Dreamux
  submission follow the same automatic owner-reporting contract in both scopes. A native
  result reported through submission settlement and native observation is
  not delivered twice.
- Provider-observed failed native background turns without a Dreamux
  submission automatically report failure once to the actual owner; no new
  report is generated for work the owner itself ended.
- Owner receipt does not create an automatic reply loop to the member.
- Target scope and sender binding are host-owned; the model cannot substitute
  a different sender identity or address another collection's member.
- Explicit peer send to a durably closed same-collection member reopens that same
  member using existing recovery rules, then submits the input; existing Team
  and Dispatcher teardown fences remain effective.
- Members controlled by a running Workflow receive no new communication
  tools, continue to refuse ordinary external input through the held lock,
  and return results to the script without a duplicate ordinary-member report.
- Validate both owning scopes through both in-tree runtimes, with
  busy-input differences documented rather than hidden by a Core special case.
- Update role instructions, tool descriptions, product behavior, and owning
  architecture documentation with the eventual implementation.
- Use one reusable communication/member capability for both owners. Explain
  each owner-specific branch by an actual differing responsibility; copied
  routing/tool policies or a new wrapper that removes nothing do not satisfy
  the operator's design-direction requirement.
- Cover mixed bound/unbound result ordering and delivery convergence. Claude's
  RPC parser handles multiple result lines synchronously while bound Core
  reporting runs through Promise continuations; a revised solution must explain
  report order and verify it, not merely cite the router's FIFO after arrival.

## Blocking decisions

None for requirement revision 2. Concrete abstraction, component ownership,
public contract shape, compatibility, and result-ordering choices belong to the
renewed technical consultation. A proposal that changes an additional product
behavior must name that change and return for operator confirmation.

## Scope-review evidence resolved by Q4

The operator answered the development-authorization card with this question,
not an implementation approval (verbatim evidence):

> 我在想这个是放在 team 里比较好，还是放在 teammate 里比较好。因为还要考虑 dispatcher 拉起的 teamamte

English rendering: "I am considering whether this belongs in Team or TeamMate,
because we also need to consider TeamMates started by the Dispatcher."

Current source has one `TeammateCollection` construction/operation owner for both
cases: `TeamService` supplies itself as the Team members' completion owner;
`DispatcherService` supplies its actual Dispatcher agent for its root members.
Ordinary member communication still does not exist in either scope. The generic
agent/collection layer can own messaging and native-result reporting while its
actual owner supplies addressing, the parent inbox, and peer scope.

The review asked whether this feature also applies to Dispatcher-root ordinary
members and compared that scope with the earlier Team-only scope. Q4 above is
the operator's explicit answer authorizing both categories; the shared-layer
placement discussion alone was not used as scope approval. Cross-collection
and cross-Team communication remain outside this feature, and Q3 remains intact.

### Scope footprint comparison (investigation, not a decision)

The operator asked which of the two coverage choices has the larger change
surface before selecting one. Source inspection supports this comparison:

| Area | Team members only | Team and Dispatcher-root ordinary members |
| --- | --- | --- |
| Neutral result contract and both adapters | Required | Same underlying capability; no second provider protocol or result mechanism |
| Agent result delivery/folding/convergence | Required | Same mechanism; actual completion owner also binds the Dispatcher recipient |
| Member send/list and provenance | Required | Same verbs; owner identity/roster/prompt become independent of TeamLeader-only wording |
| Owner composition | TeamService supplies the member context | TeamService plus DispatcherService supplies actual owner identity, fenced inbox, and existing member collection |
| Lifecycle and input locks | Existing fences, reopen, and Workflow exclusion | Existing Dispatcher fence/inbox and the same collection/lock machinery; no planned lifecycle redesign |
| Verification and docs | Team scenarios and four-package knowledge/change notes | Additional Dispatcher-member messaging, native-result, roster, reopen, shutdown, and isolation scenarios plus corresponding behavior docs |
| Persisted config/state | No shape change proposed | No shape change proposed |

The broader choice therefore has a somewhat larger total change surface,
concentrated in Core owner composition, owner-neutral model-facing copy, and
acceptance coverage. Most implementation cost is shared by both choices.
This is a source-based design estimate, not a measured diff or test result;
file/line counts and the final constructor contract require the revised solution.
If both member categories are wanted, implementing their common owner-based
surface together is expected to avoid later reworking a Team-only context.
Q4, rather than this cost estimate, is the authority for Dispatcher coverage.

### Accepted placement and shared-capability direction

The operator asked whether communication should live in `TeamService`, since
it holds both the TeamLeader and `TeammateCollection`. Source confirms that
ownership: the Team holds the leader, creates its member collection, owns the
Team admission fence, and already provides the leader-submission entry.

The placement division is narrower than saying that all communication belongs
in the agent layer:

- `TeamService` owns Team-scoped addressing, roster composition, routing to
  leader versus peer, and the Team access boundary.
- `TeammateCollection` owns peer resolution, ordinary send, and same-record
  reopen; `AgentService` and the adapters own submission and native-result facts.
- The member MCP surface parses tool arguments and binds the actual caller,
  invoking a narrow structural capability supplied by the real owner. It does
  not import the concrete higher-tier Team service.
- `DispatcherService` supplies the
  corresponding owner-scoped routing through its existing agent and collection.
  Shared protocol/delivery remains the same capability; no new routing service
  entity is required.

The earlier phrase "put it in the TeamMate layer" refers to shared tool/delivery
machinery, not ownership of Team-wide addressing and authority.

The MCP home is the existing `service/agent/mcp.ts`: the `teammate`
server gains an ordinary-member catalog with `send`/`list`, its schemas, receipt
copy, and adapter handlers. Those handlers bind the actual caller and invoke the
owner's narrow structural messaging capability. Team/Dispatcher addressing
remains with the actual higher-tier owner; the MCP module imports no concrete
Team or Dispatcher service. `TeammateCollection` installs the member delegate in
that entity's options at construction, and `RuntimeGeneration` continues to mint
its generation lease through existing MCP infrastructure. No second server or
duplicated Team/Dispatcher tool implementation is proposed.

On 2026-10-13, the operator replied to that MCP placement and responsibility
proposal with this verbatim answer:

> 可以

English rendering: "Yes / acceptable." Recorded narrowly in the context of the
preceding MCP-placement proposal: the tool adapter/catalog belongs in the agent
MCP module, while actual owners supply the scoped messaging capability and the
collection installs it. The later Q4 scope-card answer explicitly covers both
member categories and requires concise reusable mechanisms without excessive
branching. No development authorization was given by either answer.

## Technical solution authority

The [prior revision 1 solution](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/final.md)
and revision 1 proposal/review sections are superseded inputs, not accepted
technical choices for revision 2. Reuse the same three consultation seats to
independently revise their proposals from this requirement, then cross-review
and reconcile a new final solution. The shared owner/member capability, public
roster/receipt contract, native-result seam, identity, ordering, convergence,
and compatibility remain technical choices to justify against current source
and the accepted requirements. Development remains unapproved.

Beyond the recorded Q1/Q1a decisions, no additional failure, stop, teardown,
or automatic-completion wake change is authorized. Development approval has
not been granted.
