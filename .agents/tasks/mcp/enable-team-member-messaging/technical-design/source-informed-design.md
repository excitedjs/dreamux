> Historical recommendation before delegated final-delivery ownership. The
> current selected solution and authority are in final.md and the task README.
> The earlier hold was superseded by the operator's 2026-10-14 proceed instruction.

# Source-informed recommendation: one reporting owner, existing result identity

Status: TeamLeader recommendation under the operator hold, not an approved
implementation plan. Requirement revision 3 remains the product authority.
This document supersedes the TeamLeader's recommendation of a new attributed
native-event protocol in `greenfield-conclusion.md`; that alternative and its
completed independent consultation remain historical comparison evidence.
No product code, tests, configuration, or scripts were changed for this proposal.

## Recommendation

Keep per-input `RuntimeSubmission.settled` and the existing provider-owned
`RuntimeCompletion` identity. Add the narrow native-result observation needed
for results without submissions. Make `AgentService` the sole owner of result
notification decisions and delivery convergence. Remove notification state and
side effects from `EntityTurn`; retain submission outcome and public receipt
identity. Do not introduce `inputId`, `answeredInputIds`, a Core native-turn
registry, or a residency/aggregation lifetime.

This is an ownership replacement in Core and an additive provider capability,
not a replacement of the request-answer protocol. It follows from the current
consumers, not from minimizing the diff or treating the earlier design as binding.

## What the reference implementations establish

The read-only source study used Codex commit
`fbc169827e9789f9e7ba2ed97c15e2021c3312bb` and DeepSeek Harness commit
`ddefc45fbc7f8e46dd73185e68295696d1297887`.

- Codex MultiAgent V2 admits steering into an existing native turn and reports
  from its terminal publication. Its result-message path does not consult a
  turn-id deduplication table. Turn identity names the execution unit; the
  activity-item id is a different presentation fact. Input acknowledgements
  are not per-input execution-result promises.
- DSH continuable children report once per Activation disposal, after Agent
  idleness, empty inboxes, and release of owned child Activations. Queue inputs
  can produce several turns in one Activation. The final notice contains the
  closing output, not every intermediate turn's output. A memoized close
  transaction prevents duplicate disposal/publication.
- Both place notification ownership at an execution/lifecycle boundary. Neither
  proves that an attributed input-id event is necessary for Dreamux, and neither
  provides the same combination of per-input script values, folded requested
  TeamLeader replies, and ordinary-member per-turn subscriptions.

Reference source locations: Codex `core/src/session/turn_input.rs:632`,
`core/src/session/mod.rs:2392`, and `core/src/agent/control/completion.rs:88`;
DSH `packages/core/agent-loop/src/inbox.ts:109`,
`packages/subagent/subagent/src/continuation-activation.ts:724`, and
`packages/subagent/subagent/src/inbox.ts:62`. Codex paths are under `codex-rs/`.

## The result model

For each selected native result, the provider creates one completion object C.
It publishes C through the observation callback and resolves every input that
the native runtime actually answered with C. These are two observations of
one authoritative result, not independent result producers.

```text
native runtime selects result C
  -> results(C)                     ordinary-member result visibility
  -> submission A settles with C   per-input value / requested reply
  -> submission B settles with C   per-input value / requested reply
  -> submission C settles with C   per-input value / requested reply

AgentService owns every notification decision
  -> existing completion identity fold
  -> one recipient queue entry for C
```

Keep native folding and queuing authoritative in the adapter. Several queued
turns produce distinct completion objects even when their output text is equal.
Core neither infers membership from receipt ids nor reconstructs native turns.
The existing invariant is one actual notification recipient per completion;
do not introduce multi-recipient machinery without a new consumer.

For ordinary members, the construction-bound native recipient and the recipient
resolved for an admitted submission must be the same `CompletionInitiator`
object. This is true in current source: TeamService returns itself, and
DispatcherAgent returns its stable contained AgentService. Preserve these
actual recipients; a fresh wrapper per observation would invalidate token-only
folding even if its displayed name were equal.

## Core ownership and concrete removal

`AgentService` consumes native observations and selected submission outcomes.
Native observations use the ordinary member's construction-bound recipient;
submission observations use the recipient explicitly supplied at the existing
admission boundary. Both enter the existing completion delivery policy through
one reporting decision. Scripts also consume the submission outcome value.

The submission record still owns its receipt id, selected outcome, and settled
Promise. It no longer owns producer rendering, recipient revocation, completion
delivery policy, `selectedCompletion`, `deliveryTask`, `startDeliveryIfReady`,
or `ensureDelivery`. Request recipient information remains necessary in Core's
admitted-operation binding; removing a field does not remove this product fact.

Replace per-submission delivery joining plus `nativeReports` with one Agent-owned
set of started delivery work. Closing first fences publication, stops the runtime,
drains admissions, verifies every accepted submission settled, and then drains
all started reports. Preserve fail-loud runtime-stop convergence. Do not add a
third reporting service or leave the old EntityTurn delivery mechanism intact
behind a forwarding callback.

The retained-submission set and `isSettled()` proof remain live consumers: runtime
stop returning with an unanswered accepted input must still fail loudly. Remove
an entry after its selected outcome has been recorded; delivery retention then
belongs to the Agent-owned report set rather than to that entry's delivery task.
There are still two observation instants, native publication and submission
settlement. One notification owner does not turn those into one clock.

At submission selection, consume `settlement.completion` directly, select the
script-facing outcome, and pass that completion to the reporting policy in the
same reaction. A later `ensureDelivery()` no longer needs to retrieve a stored
token, so keeping a separate `selectedCompletion` mirror is unnecessary. The raw
settlement Promise already carries the authoritative result. Recipient binding
and selected outcome remain necessary; the proposal does not claim all
per-submission information disappears.

Keep the existing token fold: several Dispatcher requests answered by one leader
result still require one reply, even though the leader has no native-result
subscription. Once-settled input Promises alone do not provide that guarantee.

## Reporting rights

| Agent / input | Native-result recipient | Submission reply / value |
| --- | --- | --- |
| Ordinary Team member | Actual TeamLeader through the Team's fenced recipient | Existing owner binding; fold with the native observation. |
| Ordinary root member | Actual Dispatcher agent | Same rule; no owner-kind branch. |
| Managed TeamLeader | None | Explicit Dispatcher `team.create` prompt / `team.send` recipient only. |
| Workflow-controlled member | None | Script consumes `settled`; Workflow terminal reporting remains separate. |
| Member message to its owner | Owner's own existing subscription, if any | The message creates no reply recipient or new upstream obligation. |

No recipient is derived by recursively walking a management tree. Team internal
member reports stop at their TeamLeader. A leader answering an already pending
explicit Dispatcher request is a valid requested response, not a subscription.

Member MCP remains the existing `teammate` server's member scope in the Agent
module, exposing only shared `send` and `list`. TeamService and DispatcherService
supply their actual fenced owner inbox and peer collection at composition time.
Keep the Dispatcher aggregate admission fence; its contained agent is not a
substitute for that service operation. Do not merge services or add a parent-kind
dispatch table.

## Provider interface and version support

The new capability carries only the existing result object. `submit({text})`,
admission, settlement values, and public `turn_id` receipts retain their meanings.
State remains durable runtime state and activity remains presentation.

The TeamLeader recommends an optional public `results` callback, with mandatory
publication when it is supplied. Current Core always supplies it. A new provider
on an old host without the callback retains its old submission behavior instead
of throwing at a native terminal. This recommendation deliberately differs from
the delivered required-field candidate; it is not an operator ruling.

Adapters must invoke the callback conditionally at the optional observation
boundary; the candidate's bare calls must change. New-Core construction and
fixtures still always supply it, and acceptance tests must assert actual native
delivery with it present, not merely successful loading.

A new host with an older provider that never emits results still lacks unbound
coverage. Optionality does not make that provider conform to the new capability.
Document that distinction and the compatible provider releases. No version-skew
test has been executed here; documentation is not runtime enforcement. This
proposal does not add capability negotiation, a fallback queue, or silent
manufactured background answers.

The emission rule has different failure consequences: a missed bound observation
can still report through its submission, but mixed native ordering can degrade;
a missed unbound observation has no submission fallback and loses coverage.
Neither a required field nor an optional field enforces emission behavior by
types alone. Adapter conformance tests must exercise both cases.

Provider obligations when the sink is present remain explicit: reuse the same
completion object across observation and answered submissions, synchronously
publish normal/failed results in observed terminal order, and do not manufacture
results for unobserved connection failures or expand unbound interruption coverage.

## Cases that the design must preserve

- Bound Codex interruption: settlement contains a completion with partial output,
  while the native-result sink is silent. Submission notification remains valid.
  Claude's stopped settlement keeps its existing different content/status.
- Connection failure: settle actual pending inputs through their existing failure
  path; do not invent a native terminal or coalesce them using a fabricated token.
- Early native result before admission continuation: the ordinary-member native
  report can be published immediately; later settled submissions carry the same
  result identity. No Core request-id registration race or event-holding queue is
  introduced.
- Owner stop: normal native reports check eligibility at terminal publication as
  in the delivered candidate. Submission-only replies retain settlement-time
  eligibility. Do not move requested TeamLeader stop timing as a side effect of
  centralizing reporting. Started delivery is not retracted.
- Ordering: normal/failed native reports enter the recipient queue at observation.
  Existing interruption/input-failure ordering limits remain named; no universal
  terminal-order claim is made for outcomes outside this observation capability.
- Q2/Q3: same-peer send retains reopening and lock/fence behavior. Workflow
  construction does not acquire ordinary tools or native result subscription.
- Availability: automatic delivery retains its live-runtime rule; explicit send
  retains its waking input rule. No offline mailbox or replay guarantee appears.

Verification remains necessary before implementation acceptance: folded versus
distinct results, both owning collections, requested TeamLeader-only responses,
Workflow value consumption, partial bound interruptions, admission/close races,
stop convergence, optional-sink version skew, and actual delivered ordering.
No existing test assertion may be weakened to fit the ownership move.

## Comparison with the attributed single-event alternative

The alternative removes completion-token folding by adding Core-issued input
correspondence, answered-id lists, and distinctions between terminal events and
input-only answers. That can be made coherent, but it changes the public request
protocol to solve attribution already supplied by settled submission handles.
The current requirement adds native result visibility, not a need for Core to
enumerate native-turn input membership.

This recommendation retains an existing necessary identity and deletes the second
Core delivery lifetime. It does not claim all folding disappears. Its strongest
remaining limitation is provider reference discipline: cloning C can duplicate
delivery. That is also the existing folded-submission limitation; observation
extends the consumers of that identity. Reference-identity and delivery tests must
cover it. A single-channel rewrite would trade it for input/event correspondence
and emission discipline, rather than structurally eliminating provider obligations.

## Read-only validation on 2026-10-14

The reused DeepSeek, Trae Seed, and MiMo seats checked the draft against current
source without editing files or executing tests. The TeamLeader incorporated
the retained-submission proof and eviction, distinct eligibility instants,
optional-callback guard requirement, stable recipient identity, and different
missing-emission failure consequences. DeepSeek's proposed need to retain a
separate token mirror was rejected against its sole live reader: consuming C
directly in the settlement reaction suffices after removal of delayed delivery
re-entry. Its narrow follow-up verified that consumer account.

No product loss was identified in this design validation. This is not executed
implementation evidence, a vote that the architecture is optimal, or permission
to advance through the operator hold.
