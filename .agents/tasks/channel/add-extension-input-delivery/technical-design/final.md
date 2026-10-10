# Feishu extension input delivery: final solution

This is the operator-approved reconciled solution. Development authorization
and delivery state are recorded in the task README; runtime evidence is in
[verification](/.agents/tasks/channel/add-extension-input-delivery/verification.md). Its input is the
[requirement](/.agents/tasks/channel/add-extension-input-delivery/requirement.md).
The independent draft reviews are preserved in
[Seed](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/seed.md),
[Codex](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/codex.md)
and [DeepSeek](/.agents/tasks/channel/add-extension-input-delivery/technical-design/reviews/deepseek.md).
Source evidence describes `next` after #466. The original solution review was documentation-only; later implementation
and verification do not retroactively make those paper reviews runtime evidence.

## Problem and resulting behavior

A card extension can acknowledge a click and decide its meaning, but cannot
observe submission through its own Feishu instance or submit timer-produced
input. It currently needs an unrelated channel's command authority to do that.

Add one instance operation: submit to the expected Team only while this instance
still routes the supplied conversation to that Team, and return the actual
submission outcome. The operation does not choose another recipient, provision,
retry, persist a business decision or explicitly claim a presentation anchor.

Existing detached `forward` keeps its current-routing and presentation effects.
Use it for callback-originated input whose recipient should follow ordinary
inbound routing and whose outcome the extension does not need. Use the new
operation for expected-Team input requiring an outcome, including later work
after a click and timer work. A click handler records its own business decision
and returns promptly; later work awaits the new operation. No completion hook
is added and callback acknowledgement does not wait for admission.

## Owners and public contract

Feishu owns addressing, effective binding, its instance command port and channel
provenance. The extension owns the decision, timing, durable recovery, retry and
repaint policy. Core owns Team admission and process-local source deduplication.
There is no new host executor or route authority.

Add to `FeishuInstanceApi`:

```ts
submitToBoundTeam(input: {
  target: FeishuTarget;
  expectedTeamName: string;
  text: string;
  sourceId: string;
  attrs?: Readonly<Record<string, string>>;
  reminder?: string;
}): Promise<FeishuBoundTeamSubmitOutcome>;
```

The actual `target` comes from `sendCard` or `readMessageRoute` and can be kept in
extension-owned state. No opaque card handle, fresh lookup on every retry or
durable card-address ledger is required. `expectedTeamName` is both a binding
precondition and the only allowed recipient. Topic targets use the same parent
inheritance as `owner(target)`. Arbitrary command invocation, Dispatcher delivery,
provisioning and fallback modes are not exposed.

Name the existing typed client's actual command result subset once as
`FeishuCommandSubmitOutcome`: submitted, duplicate, stopped, failed, ambiguous,
named-Team rejection and unknown invocation error, with their existing payloads.
`FeishuSubmitOutcome` continues to include that subset plus its existing
provisioning-only `unsubmitted` member. Export the new operation's result from
the package root:

```ts
type FeishuBoundTeamSubmitOutcome =
  | FeishuCommandSubmitOutcome
  | {
      status: 'refused';
      reason: 'closed' | 'binding_changed';
    };
```

`refused` proves this operation did not invoke Core. It is distinct from Core's
named-Team `rejected` outcome and from provisioning's `unsubmitted` result.
Narrow `submitOutcomeFor` and `FeishuCoreCommands.teamSubmit`/`dispatcherSubmit`
to their actual command outcome type; existing wider consumers remain compatible.
Keep the existing parser/catch conversion as the only result classifier. Do not
route new precondition outcomes through helpers for the old broader union unless
those helpers deliberately support the new public contract.

Return submitted/duplicate/stopped/failed/ambiguous, `TEAM_NOT_FOUND` or
`TEAM_CLOSED` rejection, and unknown invocation errors faithfully. Do not turn
them into success/error booleans or infer a retry policy. In particular,
`duplicate` means this call did not establish another submission; a prior
ambiguous attempt may have committed the same key without a known outcome.
Admission is not execution completion, user receipt or crash-safe exactly-once.

## Routing and invocation boundary

Synchronously check `lifecycle.isLive()`. If aborted, return `refused/closed`.
Read `routing.plan(target, null)` and require a bound plan whose Team equals
`expectedTeamName`; otherwise return `refused/binding_changed`, with no Core call,
route mutation, provisioning or replacement recipient.

Compose the payload and call `commands.teamSubmit` with that captured Team in
the same synchronous turn, with no awaited lookup or callback between the check
and invocation. Register the resulting promise with existing `lifecycle.track`
in that turn. Independent calls can overlap; no serial delivery queue is added.

The check observes committed routing, including inherited topic bindings. It
does not wait for queued binding writes. This is an invocation-time precondition,
not a transaction between routing and Core. A rebind committing after invocation
cannot retarget or undo the captured call; a subsequent call sees the new binding.
Core decides a concurrent Team closure. Return its rejection without Dispatcher
fallback, provisioning or operation-owned stale-route reconciliation. Existing
event-driven route cleanup is unchanged.

## Payload, instructions and presentation

Feishu composes `source: 'feishu'`, the actual chat id and, for a topic, its thread
id. Caller attrs retain identity and business metadata but do not override
`source`, `chat_id` or `thread_id`, including inventing a thread for a non-topic.
This new operation makes its checked target authoritative. Existing `forward`
attribute precedence is left unchanged rather than silently changing that API.

The caller supplies faithful text and source identity. For deduplication, retry
one decision with the same ID and give different decisions for the same recipient
different IDs. The Core key is scoped to the recipient entity and source ID, not
channel/extension origin; different Feishu instances do not get independent
deduplication namespaces. Empty IDs retain Core's existing meaning: no source
deduplication. Do not auto-prefix IDs or introduce another ledger.

An omitted `reminder` uses `CHANNEL_REMINDER`. An explicit string replaces it in
Core's existing single reminder slot; an empty string deliberately supplies no
reminder. This preserves existing extension-owned model instructions, including
timer-produced input, without a new Core field. A timer author makes the same
choice as a click author: use the channel note, provide a business note, or use an
empty note. Timing alone does not create a different reminder policy. Replacement
does not additionally inject the channel note, so authors supplying their own
note also own its completeness.

Factor the existing submission payload fields consumed by `FeishuCoreCommands`
from the chat/document presentation union. The typed client consumes this payload;
ordinary chat submissions still require their proper anchor and document comments
retain their distinct presentation shape. The new operation is not disguised
as either existing presentation branch merely to obtain a receipt.

The new operation calls the typed client without `beginInboundSubmission`: it
does not move or establish a standing anchor, register an inbound echo correlation,
or open that submitter's pre-admission receipt. **It does not suppress display.**
Core can project input before runtime admission. Without a matching correlation,
the existing COT adapter can display that input with role `user` in the `input`
namespace at a standing anchor and can open a presentation there if necessary.
With no presentation state/anchor, it has no place to display it. The role labels
an input, not a verified human identity. Existing event rendering and sanitization
remain authoritative; this operation adds no display flag or attribution scheme.

That conditional echo already exists for the downstream's direct `team.submit`
path: it also bypasses correlation registration, while the Feishu session
subscribes to the same Dispatcher events. Preserve it rather than adding echo
suppression as part of obtaining receipts. Ordinary inbound, question settlement
and detached `forward` retain their existing correlation and anchor effects.
Changing input attribution, hiding echoes or moving COT to an extension card
requires a separate product decision.

## Lifecycle

Use the existing per-instance lifecycle's abort and tracked-work facts. Extend
the existing extension contract: initialize is local IO only and may read
`owner`, while input delivery, like the existing outbound methods, is called from
start onward. The command port is initialized before extension initialize, but
that availability does not authorize initialize-time submission.

Do not add a readiness bit, activation method or `not_started` refusal solely to
enforce an extension's pre-start contract violation. No legal caller needs that
new state. Start and initialize obligations are documented, not converted into
a second admission phase. Existing `isLive` semantics and operations stay intact.

After abort, new calls return `refused/closed` before invoking Core. An already
invoked command stays tracked until it settles and returns its actual outcome,
even if close begins. Abort is not evidence of non-admission and must not replace
that result. Existing teardown aborts admission, unsubscribes, closes COT, drains
tracked work, closes extensions and drains routing before releasing the bot.
The extension stops its own timers on the supplied signal and waits for its own
journal tails in close. No cancellation signal, deadline or retry is added.

## Change boundary and removal account

Implementation belongs inside `packages/channel/feishu-channel`: public contract
and exports, instance API builder/session injection, typed payload/client and
behavior tests. Use existing lifecycle tracking without changing its state
model. Update the package guide, channel-domain extension contract, public
behavior catalog and Rush change note in the same delivery.

No change to `dreamux-types` plugin contracts, host publication, Core admission,
transport, config, persisted state or dependency topology is required. The
historical statement that instance APIs have no delivery capability must be
updated alongside the new capability; it is not an immutable product ruling.

A later downstream adaptation can remove sibling-port delivery registration,
started/stopped mirrors and lookup, and its duplicate result classifier. It
cannot remove the whole bridge: cwd, binding and legacy-journal root discovery
are independent uses. Keep a minimal carrier for the latter instead of deleting
migration behavior with the delivery port. Business arbitration, deadlines,
pending decisions, accepted/unknown facts, repaint debt and old-state migration
remain extension-owned. Local timer and concurrent journal defects stay local.

This task does not implement the downstream adaptation. An external-style test
extension demonstrates delivery without a sibling channel; actual code deletion
is verified in that later task. The upstream contract preserves the current
non-anchor-claiming submission rather than adding a presentation owner.

## Alternatives and review adjudication

| Alternative | Disposition |
| --- | --- |
| Outcome callback on `forward` | Leaves no timer entry and adds another callback-to-business-state obligation. |
| Current-card-owner delivery | Can redirect old decisions after rebind/unbind or Team rejection. |
| Arbitrary named-Team submission | Removes the conversation-ownership precondition. |
| Host execution/scheduling service | Introduces an owner that still needs Feishu addressing and presentation facts. |
| Durable card engine | Takes business deadlines, arbitration and recovery without a confirmed common requirement. |
| Ordinary submitter unchanged | Moves the anchor and opens a receipt as an incidental effect. |
| Pre-start readiness/refusal state | Reject: enforce the existing calling obligation in the contract, not with an extra lifecycle fact. |
| Echo suppression or new attribution | Reject for this slice: would change existing downstream event presentation. |

The three independent reviews support the instance owner and bounded mechanism;
that agreement is not proof of implementation. Accepted corrections are the
distinct `refused` result, named actual command-outcome subset, real host
publication acceptance, precise COT echo disclosure, source-ID scope and
attribute/reminder verification. The readiness debate is resolved against adding
a state: the source supports pre-start invocation technically, but the existing
contract forbids it and no authorized story requires a separate refusal.
Reminder replacement is retained to preserve real existing model instructions,
not to introduce a timer-specific policy. The requirement now explicitly accounts
for that preservation and narrows presentation neutrality to no anchor claim.
These clarifications retain the reviewed stories and implementation boundary.

## Verification plan

Use real plugin/session/routing paths with controlled bot and command boundaries.
The focused real-Core integration arm registers an external-style extension via
the **real plugin host's API publication hook**, then starts the real Feishu
provider/session in an isolated root with a controlled runtime. A manually built
host or direct call to plugin contribution is not sufficient for this arm.

| Scenario | Required observation |
| --- | --- |
| Admitted click and later delivery | Callback returns before a blocked command; extension later observes the real outcome. |
| Timer without sibling channel | Expected Team receives input through this Feishu instance. |
| Extension start and close | Capability works in start; after abort, `refused/closed` with zero command invocation. Initialize remains local IO only. |
| Rebind/unbind and provisioning-eligible target | `refused/binding_changed`; zero Team/Dispatcher submits and zero provisioning. |
| Topic inherits parent binding | Correct expected Team; no extra topic binding row. |
| Rebind after invocation | Captured call never changes recipient; next call observes changed binding. |
| Team missing/closed | Actual rejection, no fallback/provisioning or route mutation by this operation. |
| All actual outcomes | Submitted/duplicate/failed/stopped/ambiguous/rejected/error retain their payloads; no hidden retry. |
| Close during blocked command | Teardown waits; admitted call returns eventual actual outcome, not a guessed refusal. |
| Two Feishu instances | Own routing/port/lifecycle; closing one does not fence the other. |
| Canonical attrs and reminder | Caller metadata survives but cannot replace target provenance; default/custom/empty reminder and one Core-rendered reminder slot are observed. |
| Input event at standing anchor | No anchor move, correlation registration or pre-admission receipt; unsuppressed input renders through existing COT rules at that anchor. |
| Input event without anchor | No invented anchor or presentation; do not promise visibility from admission alone. |
| Ordinary inbound/question/forward | Existing routing, correlations, anchor and receipt effects remain unchanged. |
| Shared/empty source identity | IDs follow recipient-scoped Core dedup semantics; empty disables it, and instances do not imply distinct namespaces. |

Run Rush build, lint, test and `typecheck:tests` for the affected closure after
implementation, plus task/knowledge checks and `git diff --check`. A new process
is not claimed to retain source deduplication. No live bot, transport, daemon,
platform or tenant operation is part of acceptance. Implementation results for these scenarios are recorded in verification;
the plan itself is not execution evidence.
