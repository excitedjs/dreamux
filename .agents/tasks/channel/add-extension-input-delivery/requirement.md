# Requirement

## Initial request and confirmed scope

Enhance the upstream plugin capability before adapting a downstream card
extension. The operator approved this task's creation and the bounded scope
below on 2026-10-10 through an interactive question. The final signature and
implementation boundary are governed by the linked final solution and the
development authorization recorded in the task README.

## User stories

An extension author implements an interactive card for a Team. An admitted
person answers it; the extension records its business decision and acknowledges
the click promptly. Later work delivers that decision to the issuing Team and
observes the submission outcome, so the extension can distinguish its delivery
debt from its card repaint debt.

The same extension also produces input from its own timer without a click.
Both paths use the Feishu instance that owns the card. They do not require an
unrelated sibling channel to exist or expose its Core port.

If the card's conversation is rebound or unbound before delivery, the decision
must not go to a different Team, the Dispatcher Agent, or an automatically
provisioned Team. It must not silently be delivered to the old Team after the
ownership precondition is found to have changed.

## Inspected baseline behavior and evidence

The inspected upstream baseline is `next` after pull request #466.

- [The extension contract](/packages/channel/feishu-channel/src/extension.ts)
  provides tools, card actions, per-instance state, a lifecycle signal and
  instance operations. `forward` exists only on an action result. The instance
  API has no input-delivery operation.
- [Card actions](/packages/channel/feishu-channel/src/session/card-actions.ts)
  await the handler, return its response and detach any forward. Delivery
  outcomes are logged, not returned to the extension. Built-in question
  settlement already uses a shared path for clicks and expiry.
- [The inbound router](/packages/channel/feishu-channel/src/inbound/router.ts)
  selects the current recipient. An unbound conversation reaches the Dispatcher;
  provisioning can create a Team; a rejected bound delivery can fall back to
  the Dispatcher. Those are ordinary inbound semantics, not a fixed-recipient
  card-decision contract.
- [The submitter](/packages/channel/feishu-channel/src/session/submitter.ts)
  calls the typed Core client and claims a COT anchor for a chat submission.
  Obtaining a receipt through that path therefore also changes presentation.
- [The typed Core client](/packages/channel/feishu-channel/src/feishu-core-commands.ts)
  already interprets Core submission results.
- [The instance lifecycle](/packages/channel/feishu-channel/src/session/lifecycle.ts)
  tracks in-flight work and exposes abort and drain. Tracking is not a serial
  execution queue.
- [Core admission](/packages/dreamux/src/service/agent/admission.ts) deduplicates
  sources in a bounded process-local window. Both submitted and ambiguous
  results can commit a key; a later duplicate is not proof of successful
  execution. Restart does not preserve this ledger.

These are source findings, not runtime acceptance evidence for a new capability.

## Required behavior

1. A Feishu extension can deliver card-related input from both post-click work
   and its own time-driven work, and observe the result through one public
   instance capability. Click acknowledgement does not wait for runtime admission.
2. Feishu owns the current conversation routing check. Delivery is constrained
   to the expected bound Team; a changed or absent binding prevents submission.
   Team rejection does not trigger recipient fallback or provisioning.
3. The result distinguishes proven non-submission or refusal from submitted,
   duplicate and unknown outcomes. It must not collapse these into a boolean
   success. A result does not assert execution completion or user receipt.
4. The capability belongs to one Feishu instance and is usable after start.
   Close prevents new calls and drains calls already admitted to the instance.
   Cancellation is not interpreted as proof that Core accepted nothing.
5. Existing ordinary inbound, question-card and detached extension-forward
   behavior remains unchanged. This capability does not implicitly move COT
   presentation to the extension's card or suppress existing input-event display.
   Preserve extension-owned model-facing instructions during migration rather
   than silently replacing them with a new channel default.
6. The extension keeps ownership of click arbitration, deadlines, durable
   business state, retries, unknown-result policy and repaint recovery.

## Scope and non-goals

The scope is the Feishu extension's public instance capability, its
channel-owned implementation, exports, documentation and hermetic contract
verification. Exact parameter and outcome shapes belong in the final design.

Out of scope:

- a generic host executor, event bus, durable scheduler or card engine;
- extension business concepts, deadlines or a new Core-owned journal;
- a new Core idempotency ledger or crash-safe exactly-once guarantee;
- changes to existing access policy, callback authorization or ordinary routing;
- changing COT placement as an incidental effect of adding receipts;
- downstream timer, journal ordering, state-machine cleanup or legacy-state
  migration implementation;
- live bots, transport sessions, daemon operations or production tenants.

## Product-catalog impact

The [product catalog](/.agents/product/README.md) supplies these regression
boundaries:

| Existing behavior | Required treatment |
| --- | --- |
| Unbound input reaches the Dispatcher Agent | Preserve ordinary inbound; the new constrained operation is a distinct extension capability. |
| Unbinding leaves the Team alive | Preserve; an unbound card decision does not itself dissolve or create a Team. |
| A question the agent cannot answer becomes a card, and the turn ends | Preserve quick callbacks, access gating, actual-conversation routing and existing question expiry behavior. |
| Conversation-anchored activity display and newer inbound anchors | Do not change existing anchor selection or add an implicit anchor move for constrained extension delivery. |
| Plugins are opt-in through config; doctor lists plugins and extensions | Preserve contribution, load, diagnostics and API publication behavior. |

The eventual additive extension capability needs a public behavior entry when
its implementation and final semantics are approved; intake does not describe
it as an existing feature.

## Observable acceptance criteria

- A real plugin/session assembly admits a valid card click, answers promptly,
  and lets later extension work observe the delivery outcome.
- An extension timer can use the same capability without a card callback or
  an unrelated sibling channel.
- Rebinding, unbinding, missing/closed Team and a provisioning-eligible target
  produce no delivery to a replacement recipient, Dispatcher or new Team.
- Two Feishu instances use their own routing, Core port and lifecycle; neither
  leaks a call into the other instance.
- Close refuses new work before submission and drains admitted work without
  fabricating an outcome. Cover close during an outstanding Core invocation.
- Exercise submitted, duplicate, failed, stopped, ambiguous, explicit rejection
  and an unknown invocation failure without conflating their meanings.
- Existing ordinary inbound, question settlement and detached forward retain
  their routing and display effects. The new operation does not implicitly
  advance the COT anchor.
- A fresh process is not claimed to retain Core source deduplication. Delivery
  acceptance, execution completion and external message receipt remain separate.

Use isolated roots and controlled bot/runtime boundaries with real host,
plugin, session, routing and command paths. Do not replace all of those owners
with a hand-written success stub.

## Decisions and unknowns

- Confirmed: upstream capability work comes first; downstream adaptation follows.
- Confirmed: the operator approved task creation with the recorded scope.
- Confirmed: the operator selected a TeamLeader-authored draft followed by three independent reviews on 2026-10-10.
- Development authorization for the concrete final solution is recorded in the
  [task README](/.agents/tasks/channel/add-extension-input-delivery/README.md).
- Design work must settle the target evidence, expected-recipient check,
  outcome representation, lifecycle boundary and display-neutral submission
  path. Existing data should be reused rather than adding an opaque persisted
  card handle or second route authority.
- Solution review clarified preservation of existing model-facing instructions
  and input-event display; it did not introduce a new display or timer policy.
- Documentation-only investigation and solution review have no runtime
  verification result; they establish the capability gap and proposed contract,
  not implementation correctness.
