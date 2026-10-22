# Technical design

## Ownership and history

Runtime observations and identity persistence have different delivery contracts.
A native title is an observation that the Team consumes, not a resume coordinate
whose persistence must fence the native runtime's start.

The first implementation mixed these responsibilities: a title callback crossed
Agent construction and the identity state store, then carried a lease assertion
back through Team service and storage. The operator requested an architecture
correction after reviewing that shape.

The earlier [data-flow ownership decision](/.agents/tasks/architecture/code-organization-refactor/technical-design/data-flow/final.md)
removed the same style of `onPersisted` forwarding. Its
[operator instructions](/.agents/tasks/architecture/code-organization-refactor/artifacts/data-flow-follow-up.md)
require owners to publish facts for their holders to observe, rather than
passing parent operations through child constructors. Native result reporting
subsequently established RuntimeGeneration's direct reference to its AgentService
owner. This design uses those existing ownership boundaries.

The [native-result design](/.agents/tasks/mcp/enable-team-member-messaging/technical-design/final.md)
made `results` optional so older hosts could retain request-only behavior. That
was an adoption choice, not a permanent operator requirement. This revision
replaces both observation fields together: retaining an alias or version-skew
fallback would preserve the two paths being removed. Built-in hosts and providers
move together; external integrations must adopt the new interface. Completion
identity, native ordering, and owner delivery convergence remain unchanged.

The TeamService line-limit signal also exposed two single-use indirections:
a roster snapshot helper and a worktree precheck wrapper. Their operations now
sit directly in the publishing and admission methods that own them. This deletes
two names without moving responsibilities or changing the lint rule. It does not
settle the larger file-cohesion question: TeamService's lifecycle/worktree
composition remains a micro-refactor candidate for operator prioritization.

## One runtime event interface

The required `AgentRuntimeCreateContext.events` sink replaces `activity` and
`results`. Its neutral `AgentRuntimeEvent` union contains the existing
`RuntimeActivity` variants plus:

- `{ kind: 'session.title.changed', title: string }`
- `{ kind: 'turn.result', completion: RuntimeCompletion }`

Delivery is synchronous, non-throwing, and without backpressure. Core gates the
whole stream once per runtime generation. AgentService handles each observation
at its existing owner: activities go to the conversation projection, results go
to its completion handling, and titles are published by its own EventEmitter.
No emitter is injected down from a parent and no global event bus is introduced.

The result event contains the exact completion object used by submission
settlements. Providers emit it at the same point as before: synchronously before
settlement, including native results without a host submission. Interruptions
and transport failures keep their existing distinction from native results;
`turn.ended` remains a display fact and never manufactures a completion.

The identity `state` sink remains separately durable and generation-fenced,
including its queued-write checks and fatal persistence failure semantics.
AgentRuntimeStateStore retains that responsibility and does not consume titles.

## Team consumption and write order

TeamService subscribes to the title event of its own leader, for both creation
and reconstruction. Ordinary members and the dispatcher have no Team-title
subscriber. The listener calls the existing `updateRecord({ intent: title })`
before returning, so the write enters the Team's existing FIFO queue during
synchronous event delivery. No second queue, Agent title field, or title cache
is needed. TeamRecordHandle has its ordinary patch interface; it receives no
runtime lease callback.

An event arriving after generation revocation is dropped before it reaches
AgentService. An event accepted before revocation is already in the Team queue
and may finish committing afterward. Any accepted newer title enters that same
queue later, so an older title cannot overtake it. Record release already drains
this queue. Host shutdown also drains the same record writer after stopping the
Team's runtime producers: shutdown retains live Team records and therefore does
not run their release path. This reuses the existing store drain without adding
title-specific tracking or a second queue.

There is no title replay or cold-read reconciliation. A notification dropped
during replacement, or a failed title write, can leave the prior topic displayed
until another native rename occurs.

The provider receives no title persistence acknowledgment. A failed Team write
leaves the prior committed intent intact and is logged by the Team; it does not
terminate the native runtime. These replace the first implementation's
durable-title acknowledgment, queue-time title lease rejection, and fatal title
write behavior. They are technical design choices, not quoted operator rulings.

The title event does not rewrite an existing leader identity's recovery intent.
If that identity is missing, the existing reconstruction path still uses the
current Team intent to create it. A final title accepted during teardown may
update a closed Team's intent; the existing closed-status protection remains.

## Providers, display, and compatibility

Codex translates its own thread's `thread/name/updated` into the neutral title
event. Missing, null, and blank native names are ignored in that provider. Both
built-in providers migrate their existing activity and result emissions to the
shared event sink; Claude gains no title support or title generation.

The existing Team-list projection and Feishu card already read TeamRecord.intent.
Once the queued write commits, a subsequent `/teams` shows it; previously sent
cards remain snapshots. The persisted record shape stays readable as before.

This consumer does not install a title producer. Dreamux's private app-server
does not automatically name its threads. A client must write a name through
that same instance for a native notification to arrive.

External providers must migrate from `context.activity` and `context.results` to
`context.events`. No dual-interface compatibility layer is retained. This is an
ordinary provider API change; package change notes name the required API
adaptation. No persisted-file migration is required.

## Verification

- Provider tests exercise own-thread title filtering and event delivery without
  an identity-state write; native protocol observation remains separately scoped.
- Core tests exercise ownership isolation, unchanged identity files, persistence
  and reconstruction, arrival ordering across revocation, late-event rejection,
  and logged write failure without stopping the runtime.
- Existing result identity, finalization ordering, background result, late
  admission, interruption, and stop/reopen tests remain behavioral contracts.
- Verify the existing Team-list/card projection and run build, lint, test,
  test typechecking, built CLI smoke, and the KB check. Review the complete
  revised diff independently; the first implementation's approval is not reused.
