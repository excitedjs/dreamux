# Greenfield design: reconciled ideal and adoption gap

Historical alternative: the TeamLeader's recommendation below was superseded on
2026-10-14 by [the source-informed ownership recommendation](source-informed-design.md).
The attributed event remains a design comparison, not an operator-approved choice.

This is the TeamLeader's design recommendation under the operator hold, not
an approved replacement implementation solution. Requirement revision 3 is
the product authority. Three independent proposals and exactly one cross-review
per seat have completed. No source/test/config changes or experiments were made.

## Recommended ideal

If the mechanism did not exist, use one Core reporting owner per Agent and
one authoritative native-turn event for turn-derived notifications. Keep
request answers as values, explicit messages as addressed input, and management
ownership out of the reporting rule. A member has a fixed result recipient;
a specifically requested TeamLeader input has a reply recipient. Neither is
an automatically traversed parent chain.

This combines the useful single-event direction from MiMo and Trae Seed with
a corrected request-registration contract. Their submitted handle-registration
proofs are incomplete; the correction below is a TeamLeader inference and is
not presented as independently validated code.

Do not optimize for preserving the current `RuntimeSubmission` signature or
the smallest diff. Also do not call a bigger rewrite better merely because it
replaces that signature: the precise removals and correspondence cost follow.

## Minimal ownership

| Owner | Responsibility |
| --- | --- |
| Actual Team/Dispatcher scope | Member namespace, roster, host-bound messaging capability and input admission fence. |
| Agent Core | Pending input records, value answers, explicit reply bindings, fixed member-result recipient, eligibility and all started notification delivery. |
| Runtime adapter | Native admission and input/turn correspondence; extraction/validation; once-only ordered native events; request outcomes without a turn. |
| Actual recipient and transport | Acceptance/availability, existing fencing, per-recipient serialization and delivery convergence. |

The same member delegate uses the actual scope's fenced inbox and peer
collection. Keep the two real services; do not add a common parent-service
wrapper or merge Dispatcher configuration/Team management into Team lifecycle.
The Dispatcher aggregate fence stays at its real owner, rather than disappearing
behind its contained Agent. Scope owner and contained recipient are distinct
facts even when both are exposed through a structural view.

## Correspondence must exist before the native call

The single-event ideal needs request correspondence, not completion identity.
Use an opaque Core-issued input id, allocated and bound to its request record
before invoking `runtime.submit`. It can also retain the public `turn_id`
receipt identity. It is not `sourceId`, an origin, a sender, a deduplication key
for the provider, or a Core-private receiver object.

Concrete proposed generator: keep Core's existing `randomUUID()` invocation-id
choice and use that one value as both input correlation and, upon submitted
admission, the existing `turn_id` receipt. Current `EntityTurn.id` is allocated
after admission; the ideal moves allocation/record binding before the native
call, inside the host-admitted, deduplicated input operation. A duplicate that
does not call the provider allocates no new invocation id. Having an id does
not prove native admission; unsuccessful admissions retire the temporary
record under their existing outcome rules. This is a design refinement, not
an implemented change or an operator-selected generation policy.

The adapter stores this opaque id alongside the native command/request it
already tracks and includes the answered ids in a native-turn event. Core can
resolve reply bindings immediately, including when the terminal precedes the
admission response. Its pending-input table replaces its existing turn records;
do not introduce a second global admission registry or a result-holding queue.

The provider still owns which inputs a native turn actually answers. An id
does not imply admission or folding. Refused/skipped inputs have no turn event;
ambiguous native submissions retain their admission result, with attribution
only where the adapter has authoritative evidence. Stop must converge started
admissions and accepted request outcomes; Core retains fail-loud proof rather
than waiting indefinitely on a nonconforming provider.

Why the seats' proposed timing rules are insufficient: today's Codex
`submit` binds and drains a terminal before returning its asynchronous
admission value; Claude can publish before `acceptRequest`. Resolving a
Promise also does not run Core's continuation on the same stack. Thus
"registered by provider before acknowledgement" or "publish after admission
resolves" does not prove Core already knows that provider-created handle.
Prebinding a Core-issued id removes this gap by construction. Alternatively
a genuinely synchronous registration API could do so, but it would introduce
another public invocation stage that this design does not need.

## Public contract sketch

The sketch is deliberately a replacement contract, not runnable code:

```ts
type InputId = string; // Opaque invocation correspondence, issued by Core.

type AnswerOutcome =
  | { status: 'completed'; resultText: string | null }
  | { status: 'failed'; error: Error }
  | { status: 'stopped' };

interface RuntimeInput {
  readonly inputId: InputId;
  readonly text: string;
}

interface NativeTurnEvent {
  readonly terminal: 'completed' | 'failed' | 'interrupted';
  readonly outcome: AnswerOutcome;
  readonly answeredInputIds: readonly InputId[];
}

type RequestAnswer =
  | { kind: 'turn'; outcome: AnswerOutcome }
  | {
      kind: 'input'; // No observed native turn produced this answer.
      outcome: Exclude<AnswerOutcome, { status: 'completed' }>;
    };

interface RuntimeSubmission {
  readonly settled: Promise<RequestAnswer>; // A value channel, not a report trigger.
}

// A required leased, synchronous, non-throwing event sink on the ideal context:
// turnResults(event: NativeTurnEvent): void
// submit(input: RuntimeInput): Promise<RuntimeAdmission>
// Submitted admission still supplies the pure RuntimeSubmission value handle.
```

An event represents an observed terminal, while its outcome preserves the
answer selected by the adapter. Both are needed because Codex can observe an
interruption yet return completed partial text; Claude can return stopped.
`RequestAnswer.kind` distinguishes turn-backed answers from input-level
failure/stop without a turn. Merely classifying old values by
`completion` versus `failed/stopped` is not exhaustive.

The provider publishes one event per observed terminal in terminal order,
including interruptions, and gives turn-backed value answers for its answered
inputs. Unbound interruption remains non-notifying in Core. A connection-level
failure, refused input, or teardown does not manufacture a native-turn event;
accepted inputs can still receive input-level failure/stop values. Core's
generation lease drops retired publications; pure answer values still converge.

The public growth is explicit: opaque input correspondence, answered ids,
native terminal classification, and the answer's turn/input distinction. The
new provider author no longer needs to preserve completion-object reference
identity across two model-notification paths. It must faithfully publish native
events and attribute their answered inputs; neither obligation is enforced
merely by an available callback field.

## One notification decision, one lifecycle owner

On a native event, Agent Core computes an ephemeral set of recipients:

1. For a normal/failed terminal, include the ordinary member's fixed recipient,
   if that binding exists.
2. For an interrupted terminal, include that member recipient only when the
   event answered host inputs, preserving existing bound interruption reports.
3. Include the explicit reply recipients bound to the answered input ids.
4. Apply the producing Agent's eligibility and recipient fences. Deliver once
   to each distinct recipient, using the event's selected outcome for wording.

This is not an owner-kind switch. A managed TeamLeader has no fixed member
recipient; a Workflow member has neither an ordinary recipient nor a model
reply binding. Their pure request answers remain available. Root ordinary
members and Team ordinary members differ only in the recipient supplied.

Per-event recipient deduplication preserves N folded Dispatcher requests as
one TeamLeader reply. Native events enter the receiver queue in order; no
post-hoc completion-token folding or waiting for an unknown handle is required.

An input-level answer without a native turn is handled by the same reporting
owner, at the existing request-outcome boundary. Preserve each admitted input's
existing failure/stop news; do not coalesce unrelated tokenless answers as if
one native result existed. Value answers tagged `turn` never initiate a second
model notification. This still leaves a real request-level path; it is not
claimed that all facts have become native terminals or that every ordering
residual outside native events disappeared.

The outcome record has a stable id, a selected outcome and a value promise.
It does not own a delivery policy, report task or `ensureDelivery`. Agent Core
tracks all reports it actually starts through one in-flight-work owner, proves
accepted inputs settled after runtime stop, and drains started delivery once.
Explicit sends still wake; automatic reports retain existing availability limits.

## Product case check

| Case | Ideal behavior |
| --- | --- |
| Member starts a build, later autonomously finishes | Two distinct native events report to its fixed recipient. |
| Peers exchange messages | Explicit content stays addressed; recipient member results report to that member's owner, never automatically to the sending peer. |
| Several Dispatcher requests answered by one leader turn | Answered ids select the same Dispatcher recipient; one event sends one reply. |
| Leader autonomous turns after that answer | No fixed recipient and no answered Dispatcher input; no upstream notification. |
| Codex bound accepted interruption | Interrupted event, answered ids and completed partial outcome: preserve its existing partial-result notice. |
| Claude bound accepted interruption | Interrupted event and stopped outcome: preserve its stopped notice. |
| Unbound interruption | No answered input and no ordinary interruption notification. |
| Connection failure without terminal | Input-level failed answers for admitted inputs; no fabricated native result. |
| Workflow member | Script consumes the value; no ordinary tools/report stream. |
| Owner stop / revoked generation | Suppression and convergence remain explicit; delivery already started is not retracted. |

These are design checks against source and requirement, not executed tests.

## Ideal versus delivered shape

| Area | Delivered | Recommended ideal | Gap |
| --- | --- | --- | --- |
| Reporting ownership | EntityTurn and AgentService each own delivery work | One Agent Core owner; input records are values/proof | Internal ownership replacement |
| Turn-derived notification | Native observation and N settlement paths folded by token | One authoritative event with answered input ids | Public contract replacement |
| Once-only mechanism | Completion-object WeakMap identity | Recipient set for this single event | Delete delivery-side completion identity folding |
| Correspondence | Provider-owned submission handle discovered after admission | Core-issued id prebound before invocation | New explicit seam fact; reuse existing request record identity |
| Interrupted partial answers | Completion value without result publication | Native classification plus selected answer outcome | Preserve behavior with an explicit representation |
| Member messaging/fences | Actual scoped owners and collection | Retain shared delegate and actual fenced scope | Adaptation, no manager hierarchy rewrite |
| Workflow/public receipts | Turn.settled and turn_id | Same public values/receipt identity | Preserve consumers |

Exact removals relative to delivered code: EntityTurn's report recipient,
selected completion token, delivery policy, owner-query/report task and
`ensureDelivery`; delivery-side completion WeakMap and `deliverRuntime` as a
token reconciliation entry; separate native-versus-bound delivery convergence;
cross-channel frozen-object identity as a notification invariant. Retain the
request record's settlement proof, recipient FIFO, existing admission ledger,
fences, state/activity channels, explicit messages and native protocol tracking.
Per-event recipient deduplication and input correspondence are real retained/new
mechanisms, not an assertion that identity or folding disappeared completely.

Identity-specific tests can change with the mechanism; their behavioral
acceptance (folded delivery once, preserved values, lifecycle/failure results)
must remain. Deleting those behaviors to obtain fewer tests is unauthorized.

## Cross-review adjudication

- Accept all seats' correction that the initial native-only/completion-value
  partition loses Codex bound interruption results.
- Accept the two result entitlements and one Core reporting owner. They do not
  by themselves prove either transport optimal.
- Accept the single-event direction, but reject the incomplete assertion that
  provider handle registration already establishes Core's reply binding.
- Reject that single-event correspondence is impossible because the old input
  carries text only. Greenfield can knowingly replace that interface; it must
  pay for correspondence explicitly, as above.
- Preserve the Dispatcher scope fence. It is not a redundant forwarding hop.
- Preserve Q5 folding, Workflow values and public turn_id. Delete the old
  mechanism only after supplying their concrete replacements.
- Unknown external-provider inventories affect adoption risk, not derivation
  of the ideal. No new product decision follows from that unknown alone.

## Adoption cost and limits

This is a larger neutral-interface replacement than the delivered result sink,
even though its Core reporting model is simpler. Both adapters must implement
the new input correlation, event classification/answer association and value
union together. An older non-emitting provider cannot be described as retaining
bound reports under this design; an old host/new provider pair is likewise not
compatible with the replacement contract. Version documentation is not a
runtime compatibility gate. Ordinary API change notes apply; no persisted-state
migration or upgrade-blocking `BREAKING:` note is implied.

The independent alternative is to consolidate AgentService reporting while
retaining the delivered two-input identity fold. That is a smaller internal
replacement, a valid adaptation/transition candidate, but does not achieve the
single-event ideal. Do not introduce a permanent hybrid or unsupported fallback
just to make both public contracts appear implemented.

Native-member eligibility remains terminal-time as previously recorded. A
uniform event-time rule for explicitly requested leader replies would move
their current settlement-time eligibility earlier as well. That additional
microtask-window consequence must be named in any adoption solution rather
than silently stretched from prior approval; preserving that old boundary
would require a request-specific scheduling choice. No implementation decision
on it is authorized by this conceptual comparison.

The strongest surviving risk is provider nonconformance: answering values but
omitting an event can lose even specifically requested model replies. Correct
correlation, one-event publication, both interruption forms, native order,
early-terminal admission races, managed-Team isolation, and shutdown convergence
require provider/Core behavioral verification after approval. No such new tests
or live model acceptance were performed in this discussion.

The operator requested the best shape from scratch; this is the recommended
ideal under the accepted behavior, not a claim of global optimality. Whether
to adopt the replacement now or evolve toward it remains distinct from that
design conclusion. The existing hold, uncommitted code and prior approved
solution remain intact until a concrete adoption solution is reviewed and
development is explicitly authorized again.

## Relationship to the earlier Promise/token refactor

On 2026-10-13, the operator asked:

> 那其实是推翻了之前做的：不再用 turn id 管理折叠，转而通过 promise 来确保多轮steer 后返回的 promise 只能 resolve 一次这个重构了？

This is a question about the replacement's scope, not approval to implement it.
The preceding task's [completion-token model](/.agents/tasks/completion-routing/adopt-completion-token-routing/technical-design/final.md)
and [resident-session replacement](/.agents/tasks/completion-routing/adopt-completion-token-routing/technical-design/session-submissions.md)
make two separate guarantees: each accepted input has its own one-shot
settlement; N inputs folded into one native result share one RuntimeCompletion
token, which Core uses to deliver that result once. Promise reference identity
is explicitly not a completion identity. The resident-session replacement
deleted the aggregate request-window Promise while retaining this token model.

The recommended greenfield event replaces the delivery-side completion-token
contract, not the one-shot settlement of each input. Three distinct Promise
objects can each resolve once and still trigger three `.then` callbacks; their
individual one-shot behavior does not provide cross-input notification dedup.
Under the ideal, an event names those three answered inputs and selects one
recipient set. The promises still each answer their own caller once.

Opaque input ids associate answers with callers; they are not native/display
turn ids or keys from which Core infers a fold. Provider-native evidence still
determines which inputs were consumed together and which remain queued. Two
separate events remain separate even when their output text is identical.
No initial/steer execution split, aggregate request window, or transcript-derived
completion is restored.

This protocol replacement is a design choice, not forced by Q1/Q1a. The smaller
single-AgentService-report-owner alternative can retain the existing submission
Promises, immutable completion identity and Core fold while adding unsolicited
native coverage. Compare request-correspondence authoring/state cost with the
removed completion-token fold honestly. Do not present the new contract as an
unchanged extension of PR #344 or the resident-session replacement.
