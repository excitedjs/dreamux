# Greenfield comparison: TeamLeader working notes

These are source-reasoned hypotheses and falsification cases, not the final
solution, implementation approval, or an implementation review. The three
independent proposals and subsequent cross-review remain the selected path.

## Derive from the product first

The product needs three operations/facts without prescribing three services:
an explicit addressed message, the outcome answering an accepted input, and an
observed native result. A native result can answer several accepted inputs or
none. Receiving an input does not prescribe where its result is reported.

Core owns sender/address scope, input admission, intended conversational
recipients and shutdown. The provider owns native admission and correspondence
between its inputs and observed turns. The receiver owns whether input can be
accepted. Management ownership supplies no implicit recursive destination.

An ideal model separates two reasons for a model-directed result delivery:
ordinary members have a persistent result recipient; a managed TeamLeader has
only a recipient on a specifically requested response. Workflow consumes its
accepted input's outcome without an ordinary-member notification. These are
caller-owned bindings, not a general subscription tree or an owner-kind router.

The promising minimum is one reporting side-effect owner per producing agent:
it accepts provider result facts and submitted-input outcomes, determines
eligibility and actual destination, and tracks all deliveries it starts. A
submitted-input record answers its caller and proves settlement; it need not
also own a recipient, delivery policy, report promise and shutdown entry point.
The shared recipient transport can retain serialization, fencing and folding.
Two distinct observations do not require two reporting lifetimes.

This ideal deliberately supersedes R71's choice that EntityTurn calls the
delivery policy itself. R71 removed recipient suppliers and private-owner
delivery closures; a replacement must preserve those removals. It must also
preserve per-operation recipient lookup points, fail-loud unsettled-request
proof and convergence of actually started work. Relocating EntityTurn with
all its delivery state intact would not realize the proposed simplification.

## Current adoption gap

The delivered AgentService starts native reports through `nativeReports` while
EntityTurn owns selected completion, recipient, report task, owner query,
policy invocation and `ensureDelivery`. A single AgentService report owner can
remove those per-turn delivery responsibilities, retain a lightweight outcome
record, and converge started deliveries once. Native publication still enters
the recipient queue synchronously; request results remain consumable by scripts.

That is an internal report-ownership replacement, not a necessary public
runtime redesign. A dedicated native-result outlet preserves state, display
and request-answer meanings. An ideal correlated single-event contract is
also worth comparison, but it must account for terminal-before-admission races,
folded inputs and transport outcomes without silently introducing a second
admission registry, fabricated submission, or sequence queue.

The owner port question is separate. A single structural collection-owner view
may reduce duplicated options, but the Dispatcher's fenced input and actual
Agent delivery target are not interchangeable operations. Removing a forwarding
hop is valuable only when its admission policy moves to the correct real owner.

## Source-backed counterexamples for cross-review

### Completion-shaped settlement without a published native result

`agent-runtime/codex/src/turn-manager.ts:finalize` constructs a completion for
an interrupted terminal and settles its bound members, while explicitly
skipping `resultSink`. The bound settlement is not tokenless:
`codex-runtime.test.ts` at the partial-output interruption case asserts
`kind: completion`, `status: completed`, and the partial text, while no result
is published. This is existing behavior preserved by requirement revision 3.

Consequently, suppressing every completion-bearing settlement for an armed
member loses an existing bound interruption result. Equality of ordinary
recipient and collection owner does not prove the proposed payload partition.
A repair must state its added distinction and public representation, or retain
overlapping observation/settlement with identity folding. Do not manufacture an
unbound interruption report or change the result text/status to make a partition
look exhaustive.

### Folding remains beyond ordinary member reporting

Q5 retains specifically requested TeamLeader responses. Several accepted
Dispatcher submissions can fold into one native result. Their requested
responses must still be one delivered fact. Eliminating overlapping native and
submission reporting for members would not establish that shared completion
identity can disappear from the whole provider contract. Enumerate the remaining
consumers and any replacement representation; do not call a consumer unknown
when the accepted request-response story provides it.

### Fenced inbox is more than a forwarding hop

`DispatcherService.submitInput` executes inside `fence.admit`.
`DispatcherAgent.submitInput` directly calls `mustAgent().submitInput` without
that aggregate admission. The holder has access to its actual Dispatcher via
its options, so moving policy may be feasible, but deleting the service entry
and binding the holder is not byte-equivalent on its own. During shutdown the
aggregate admission can close while the contained Agent still runs.

### Request identity has a real public consumer

`service/team/requests.ts:teamSubmitResult` returns `turn_id` from
`admission.turn.id`. Simplifying a request record must not assume the id is
only private diagnostic state or silently remove the public receipt field.

### Old-provider support must match the actual selected route

In the delivered overlapping design, an older non-emitting provider retains
bound member reports through settlement. Under a native-only member design
that ignores completion-bearing settlement, it loses those ordinary-member
reports too. New-host/old-provider loading is neither coverage nor necessarily
the old bound-report behavior. Separate a greenfield paired-contract assumption
from the public transition matrix.

## Limits

No design choice is adopted from these notes, no implementation files were
changed, and no tests or live experiments were run. The root hypotheses must
be adjudicated against the three seats' complete designs rather than used as
their prescribed answers. Product scope, observation/interruption limits and
the operator hold remain unchanged.
