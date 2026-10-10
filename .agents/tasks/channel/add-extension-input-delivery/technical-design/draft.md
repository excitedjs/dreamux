# Feishu extension input delivery: draft

This is a hypothesis for independent review, not an approved implementation.
The input is the [recorded requirement](/.agents/tasks/channel/add-extension-input-delivery/requirement.md).
Source references describe `next` after #466; no implementation or prototype
has been written for this task.

## The problem and resulting behavior

An extension can send a card and decide its business outcome, but cannot obtain
a delivery receipt or deliver a timer-produced decision through its Feishu
instance. It currently has to borrow another channel's command authority.

Provide one instance operation: submit input to the expected Team only if this
instance still routes the supplied conversation to that Team. Return the
submission outcome to the extension. Do not select a replacement recipient,
provision a Team, retry, persist the decision or advance a COT anchor.

The existing detached `forward` retains its current-routing and presentation
behavior. An extension that needs receipts records its decision, returns its
card callback response promptly, and calls the new operation from later work.
Its timer calls the same operation. There is no result callback hook.

## Greenfield ownership and adaptation

With only the user story, Feishu would own conversation addressing, binding
resolution, its command port and channel provenance. The extension would own
what the decision means, when to deliver it and what to retain after a result.
Core would own Team admission. This needs no plugin-host execution service.

Adapt the existing Feishu instance API and typed command client in place.
Do not make ordinary inbound routing the shared delivery engine: its fallback
and provisioning are different behaviors. Likewise do not use a chat-shaped
submission merely to obtain a receipt, because the current submitter claims
the message's COT anchor as a side effect.

## Public contract

Add this method to `FeishuInstanceApi`:

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

`target` is the actual target returned by `sendCard` or `readMessageRoute`,
which the extension may retain in its own state. Feishu does not add a durable
card-address ledger or require a fresh message lookup on every retry.
`expectedTeamName` is both the routing precondition and the only permitted
submission recipient; it is not a fallback preference.

The operation is for bound Teams. It does not expose arbitrary `invoke`, a
Dispatcher recipient, a provisioning mode or a recipient-fallback option.
Topic targets use the same effective binding resolution as `owner(target)`;
a topic inheriting its group's Team remains served by that Team.

Export the method's result type from the package root. Reuse the existing
`FeishuSubmitOutcome` vocabulary for actual command outcomes, excluding its
provisioning-only `unsubmitted` branch, and add a typed precondition branch:

```ts
type FeishuBoundTeamSubmitOutcome =
  | Exclude<FeishuSubmitOutcome, { status: 'unsubmitted' }>
  | {
      status: 'unsubmitted';
      reason: 'not_started' | 'closed' | 'binding_changed';
    };
```

The existing command-outcome parser remains the only conversion from a Core
submission result. Narrow its declared return type to the outcomes that its
command invocation can actually produce; do not write a second classifier.
Existing internal consumers can continue assigning that narrower result to
their existing broader outcome type.

`submitted`, `duplicate`, `stopped`, `failed`, `ambiguous`, explicit
`TEAM_NOT_FOUND`/`TEAM_CLOSED` rejection and an unknown invocation error retain
their current meanings. `duplicate` only establishes that this call did not
create another submission; it cannot establish that an earlier ambiguous
attempt executed. The extension, not Feishu, chooses its retry policy.

## Routing and invocation boundary

The operation checks delivery readiness, reads `routing.plan(target, null)`
and verifies `kind === 'bound'` and `teamName === expectedTeamName`.
A mismatch returns `unsubmitted/binding_changed` without invoking Core,
mutating routing or looking for another recipient.

After this check, compose the payload and invoke `commands.teamSubmit` with
that captured Team in the same synchronous turn, with no awaited lookup or
callback between the binding check and command invocation. There is no later
route read that can retarget this input. The check observes committed routing;
it does not wait for queued, not-yet-committed binding writes.

This is a routing precondition at invocation, not a transaction across routing
and Core. A rebind that commits after invocation cannot redirect or undo an
already admitted call. A Team closing concurrently is decided by Core; its
rejection is returned without Dispatcher fallback or stale-route reconciliation
from this operation. Existing event-driven route cleanup remains unchanged.

## Envelope and presentation

Feishu composes the provenance: `source: 'feishu'`, the target's chat id and,
for a topic, its thread id. Caller attributes can retain a clicker's identity
and business metadata, but cannot overwrite these channel-owned address fields.
The caller supplies faithful text and the stable source identity.

Use `CHANNEL_REMINDER` by default. An explicit `reminder` is an extension-owned
replacement in Core's existing single reminder slot, allowing a business
extension to preserve its existing model-visible instructions. This is not a
new Core field or a second channel envelope.

Separate the command payload from presentation: factor the submission payload
fields already consumed by `FeishuCoreCommands` from the existing
`FeishuSubmission` shape. The ordinary chat/document union continues to require
its proper presentation facts; the new operation supplies the payload without
inventing a chat anchor or disguising it as a document comment.

The new operation uses the same typed command client directly and does not
call `beginInboundSubmission`, move a standing COT anchor, open a new receipt
card or change input-display correlation as an incidental effect. Existing
`FeishuTeamSubmitter`, question settlement and `forward` keep their anchor
behavior. Any future change to extension-card COT placement is a separate
product decision.

## Lifecycle and concurrency

Readiness is owned by this Feishu lifecycle, not by a sibling channel, the
extension's business state or a Dispatcher-indexed port map.

The lifecycle adds one readiness fact for this new capability: inactive until
the bot's `start` succeeds, activated before extension `start` runs, and fenced
by the existing abort signal. Keep that fact in the existing lifecycle owner;
do not mirror it in the session, instance API and each extension. The lifecycle
owner activates input delivery; a derived readiness check distinguishes
`not_started` from `closed`. This does not change existing `isLive` semantics
or gate existing operations differently.

Check readiness synchronously and register the delivery promise with the
existing `lifecycle.track` in the same turn. No timer, deadline, serial queue,
new cancellation signal or retry is added. Independent calls may overlap.

Calls arriving after abort return `unsubmitted/closed`. Calls already invoking
Core remain tracked until the command settles and return its actual outcome,
including unknown errors; abort must not overwrite that result with a guessed
pre-admission refusal. Existing teardown aborts admission, drains tracked work,
closes extensions and then closes routing. An extension still stops its own
timers on the supplied signal and drains its own business journal in `close`.

## Change boundary and removal account

Expected implementation touches are inside `packages/channel/feishu-channel`:
the extension contract/root exports, instance API builder, session wiring,
existing lifecycle, typed submission payload/client and behavior tests.
Do not change `dreamux-types` plugin contracts, plugin-host API publication,
Core admission, transport API, config, persisted state or dependency topology.

Update the package guide, the Feishu-extension section of the channel domain,
the public behavior catalog and a Rush change note. The historical statement
that instance APIs have no delivery capability becomes a description of the
old boundary, not a reason to add a host workaround.

The downstream adaptation can delete sibling-port delivery registration,
started/stopped mirrors and lookup, plus its duplicated result classifier.
It cannot delete the entire bridge: other binding/cwd uses and old-journal
root discovery are separate responsibilities. Business click arbitration,
pending decisions, accepted/unknown facts, repaint debt and legacy migration
remain extension-owned. Local timer and concurrent journal defects do not
move into this upstream task.

No downstream implementation is included in this task. Removal is demonstrated
with an external-style test extension whose delivery succeeds without another
channel, and later verified against the actual downstream adaptation.

## Alternatives

| Alternative | Why this draft does not select it |
| --- | --- |
| Add an outcome callback to `forward` | Still has no timer entry and adds another completion-to-journal callback. |
| Expose current-card-owner delivery directly | Can redirect old decisions after rebind, unbind or Team rejection. |
| Expose arbitrary named-Team submission | Removes the conversation-ownership precondition. |
| Give the plugin host an execution/scheduler service | Adds a generic owner while extensions still need Feishu routing and presentation knowledge. |
| Generalize durable card rounds into Feishu or Core | Takes ownership of business deadlines, arbitration and recovery without a confirmed common requirement. |
| Reuse the ordinary chat submitter unchanged | Silently moves COT presentation and couples receipts to an anchor claim. |

## Verification plan

Use a real Feishu plugin/extension registry/session assembly with a controlled
bot and Core invocation boundary. Add a focused integration arm through real
Core with an isolated root and controlled runtime, to prove the typed command
payload and outcome contract. No live platform access is required.

| Scenario | Required observed result |
| --- | --- |
| Admitted click followed by asynchronous delivery | Callback response completes before the blocked command; later outcome is observed by the extension. |
| Extension timer without a sibling channel | Input reaches the expected Team through this Feishu session. |
| Init call, extension start call, close call | Before activation: `not_started`; during extension start: usable; after abort: `closed`. |
| Rebind/unbind/provisioning-eligible conversation | `binding_changed`; zero Core submits, zero Dispatcher delivery and zero provisioning. |
| Topic inherits its parent binding | Correct expected Team; no second explicit topic row is invented. |
| Binding changes after invocation starts | Never retarget the captured call; a later call sees the changed binding. |
| Expected Team missing or closed | Return Core rejection without fallback, provisioning or route mutation by this operation. |
| Submitted/duplicate/failed/stopped/ambiguous/error | Observe the actual typed result; no hidden second call or automatic replay. |
| Close during a blocked Core invocation | Teardown waits; call returns its eventual outcome, not guessed non-submission. |
| Two Feishu instances | Independent routing, lifecycle and invocation; closing one does not fence the other. |
| Stable anchor and existing forward | New delivery leaves the standing anchor unchanged; ordinary inbound/question/forward behavior retains its effects. |
| Same source after a new process | No crash-safe exactly-once claim; accepted submission, execution and external receipt remain distinct. |

Run the repository's Rush build, lint, test and `typecheck:tests` gates for the
affected closure after implementation, plus task/knowledge checks and
`git diff --check`. No runtime gates have been run for this draft.

## Review questions

Is the ownership narrower and simpler than a host service? Does explicit
target evidence suffice without a new card ledger? Does the readiness fact
belong in the existing lifecycle? Is a display-neutral payload separation
coherent, or does it leave two owners of actual submission? Challenge these
premises before extending the signature or adding another local guard.
