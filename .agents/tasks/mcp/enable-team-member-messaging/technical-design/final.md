# Final solution: proactive ordinary-member messaging

Selected on 2026-10-14 by the TeamLeader under the operator's delegated quality
ownership. Product authority: [requirement revision 3](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md).
Architecture comparison: [selection and source adjudication](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/architecture-selection.md).
The [revision 2 solution](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/revision-2.md)
remains historical. Authorization and execution evidence are owned by the task
README and verification.md, not inferred from consultant agreement.

## Outcome and scope

Ordinary Team members and Dispatcher-root members share member messaging to their
actual owner and same-collection peers. Their provider-observed normal and failed
native results report once to that owner, including unbound continuations. Managed
TeamLeaders have no such subscription: Dispatcher receives only the results of its
explicit team.create prompt/team.send requests. Workflow-controlled members remain
excluded from new tools and native reporting, retaining script result values.

No management-tree recursion, mailbox, quiet/work-drain aggregation, polling,
source-specific native routing, persisted category, input-ID event registry or
new delivery policy is added. Turn end is an observed result, not proof of task
success. Automatic results retain live-runtime delivery; explicit messages wake.

## Member capability and actual owner

TeamService and DispatcherService supply narrow structural views of their actual
owner inbox and collection. The inbox must retain its Team/Dispatcher admission
fence; a contained agent's unfenced submit is not a replacement. Owner descriptors
are lazy because a Team constructs its collection before publishing leader_name.
Keep completion-recipient identity stable: Team service and the existing contained
Dispatcher recipient. Do not fabricate a new recipient wrapper per observation.

The existing agent-module teammate MCP server gains the member scope:

| Tool | Input | Result |
| --- | --- | --- |
| send | { name, prompt } | Target and existing admission result; no waiting for answer |
| list | {} | Separate owner row plus peers, self excluded, closed peers included |

There is no model-supplied sender, intent or attributes parameter. Sender is bound
by the host at construction, with the existing task source and from attribute.
Existing owner-originated envelopes are unchanged. Target the concrete owner name;
otherwise resolve only within the actual peer collection. Self sends are refused.
Peer sends reuse existing reopen, busy admission and lock behavior. Owner-directed
messages use the fenced inbox without completionRecipient, so the message creates
no automatic reply loop or new upstream obligation. An existing explicit owner
request may still be answered by the turn that receives the message.

Both ordinary creation and materialization/reopen arm the capability. createLocked
explicitly disarms tools and native subscription; options shape cannot infer this.
Workflow finalization closes members before unlocking. A later ordinary reopen
re-arms from its construction path, without a persisted lineage flag.

## Runtime contract: native result plus per-input values

Keep the existing text-only submit, admission and per-input result-value contract.
A provider creates one immutable RuntimeCompletion C per selected native result
and uses the same C for every answered submission. Add the narrow leased callback:

```ts
interface AgentRuntimeCreateContext {
  readonly results?: AgentRuntimeResultSink;
}
type AgentRuntimeResultSink = (completion: RuntimeCompletion) => void;
```

Current Core always supplies the callback. When supplied, the provider must publish
each normal/failed selected native terminal once, synchronously in its terminal
finalization order, bound and unbound alike. Core's generation lease drops revoked
writes; the sink never throws or waits. Providers invoke the optional field with
an optional call; absence retains older host request behavior. Existing state and
activity seams retain their durable-state and presentation meanings.

Provider publication is not a second result production: it observes the same C
that the answered inputs receive. Claude computes command membership at its result
frame. Codex selects and publishes C directly in native terminal callback order,
independent of input association. Existing in-flight native admission snapshots
retain C until their acknowledgements retire; late positive admissions consume
that selected C even after failure or stop. No representative, admission
publication barrier, terminal queue or terminal mirror is needed. No native input
membership crosses the neutral seam. Do not derive outcomes from display text.

Interrupted native ends do not call results. Codex's bound interrupted submission
retains the selected completed/failed value, including null/partial output or codec
failure; Claude retains stopped. Unbound interruption remains silent. Connection
loss fails accepted inputs that have no observed selected answer; owner teardown
stops those inputs. An already selected answer remains an irreversible value for
late positive admission. Neither path manufactures a native completion or an
ambiguous-input reply.

## One Core notification owner

AgentService alone consumes native observations and submission settlements,
selects notification eligibility and passes result identity to the existing policy.
The native path uses the construction-bound ordinary recipient; the submission
path uses the actual reply recipient captured at the existing query point.

For ordinary members these are the same stable actual recipient. Managed leaders
have only explicit request recipients. The existing completion identity fold joins
several answered submissions and dual observation into one report. Separate results
remain distinct even when text is identical. Tokenless stopped/input-failed notices
retain their existing per-input meaning, without a fabricated fold identity.

Remove EntityTurn's recipient, producer-rendering collaborators, owner callback,
selectedCompletion mirror, deliveryTask, startDeliveryIfReady and ensureDelivery.
Its public receipt ID, selected result and settled Promise remain a pure value/
convergence record. Consume settlement.completion directly in the settlement
reaction; retaining a second token mirror is unnecessary after delayed delivery
re-entry disappears. The request binding belongs to AgentService and is retired
with the accepted input's selected outcome, not its report's completion.

Keep the two eligibility instants explicit: native subscription at synchronous
publication, requested/input-only notification at settlement observation. Read
owesCompletion at the relevant boundary; do not revive a suppressed report.
Do not claim moving ownership makes these one clock. Normal/failed native order
is guaranteed; interruption and transport notices may interleave according to
existing settlement continuations. No universal order is added. The policy call and aggregate-fence/queue entry for
requested reports now occur directly in the settlement reaction, one microtask
earlier than EntityTurn's deferred policy call. This is an intentional boundary
movement, not byte-identical timing. A fence before queue entry drops the report;
a fence after entry does not retract it. Tests must preserve both cases.

Replace nativeReports plus per-input delivery joins with one AgentService-owned
InFlightWork set. Close/host stop fences new work, stops runtime, drains admission
continuations and accepted mutations, proves all accepted inputs selected an outcome,
then drains started reports. Keep the fail-loud unsettled-input proof and eviction.
Retiring input records must not lose joined report failures. Started deliveries are
not retracted by a later stop; rejected/revoked observations do not restart a runtime.

## Real deletions and tradeoffs

- Delete the per-input Core delivery controller and its second convergence lifetime.
- Retain one input-value record and one agent-owned delivery set, each with a real
  consumer. Do not hide the old controller behind another forwarding callback.
- Retain result identity folding: Promise resolution once is per input, not per
  native result. Provider reference discipline remains an explicit contract.
- Retain the delivered removal of Codex orphan bookkeeping and answered-only
  suppression of normal/failed native result creation.
- Remove Codex's obsolete representative, admission publication barrier,
  terminal-order queue and terminal mirror. Publish actual native facts when
  observed rather than salvaging a gated queue on failure.
- Do not merge Team and Dispatcher service lifecycles or remove their distinct
  aggregate fences merely to unify member tools.

A provider cloning C can duplicate a bound report; this is the strongest residual
risk. Contract and reference-identity/delivered-order tests are mandatory. A provider
omitting observation retains bound request delivery but loses unbound coverage and
can degrade mixed ordering. Neither optional nor required typing enforces emission.

## Compatibility, docs and release

New provider/old host retains per-input behavior when results is absent. New host/
old provider retains bound values/replies, but does not meet new background/report
ordering requirements. State this support matrix in types and both provider READMEs;
loading successfully is not conformity. No fallback or negotiation is added.

No persisted state/config format changes. Record ordinary minor change notes for
Core, types and both runtime packages using Rush; no BREAKING/Rebuild migration
claim. Correct member prompt and notification wording to state actual turn/output
facts, preserving header-only failed reports and existing owner envelopes.

## Verification and delivery acceptance

Verify the complete change after rebasing next, not only the final ownership move:

1. Both owner scopes: host-bound sender, owner/peer routes, explicit replies,
   self/cross-scope refusal, member receipt and roster.
2. Same-record/session closed peer reopen; Workflow tools/reporting exclusion and
   script settled values, with existing lock assertions preserved.
3. Folded and distinct equal-text results; mixed bound/unbound completed/failed
   actual delivery order through both real adapter collectors; same-C identity.
4. Early result before admission, late native association, failed/ambiguous/skipped
   admission, close races and accepted-input fail-loud convergence.
5. Managed leader autonomous silence and N explicit Dispatcher requests answered
   once, without recursive forwarding of member reports.
6. Bound Codex interrupted partial/null/codec outcome versus Claude stopped;
   no unbound interruption expansion or connection-level fabricated terminal.
7. Owner stop before/after observation and settlement, both close and host stop
   awaiting started delivery, and report failure propagation.
8. Optional callback absent and present, both compatibility directions, actual
   delivered results with it present.

Run Rush update, build, lint, test and typecheck:tests; anti-leak/content checks,
change-note verification and full KB checks. Independent review must inspect the
whole diff and altered tests against the product contract. Report authenticated
model/live acceptance separately from protocol replays; passing replay tests is
not live evidence. No production daemon restart or release is part of this task.

## Since this was recorded — 2026-10-22

The earlier optional-observer compatibility choice is superseded by the
[unified runtime event interface](/.agents/tasks/architecture/sync-codex-session-title-to-team-intent/technical-design/final.md).
Hosts and providers migrate together to its required `events` sink. Native result
ordering, completion identity, and owner delivery convergence remain unchanged.
The original compatibility section above preserves the earlier adoption rationale.
