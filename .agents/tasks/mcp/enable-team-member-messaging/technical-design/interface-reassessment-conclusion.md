# Neutral-interface reassessment: source adjudication and choices

This records discussion under the operator's hold. It is not a replacement
implementation authorization or an independent implementation-review pass.
The completed consultation used product requirement revision 2. Current
revision 3 consolidates its accepted behavior with the separately clarified
managed-Team/request-reply boundary. The existing implementation has not been
changed by the reassessment.

## Consultation outcome

All three independent reassessment proposals and one cross-review appendix per
seat are complete in the assigned DeepSeek, MiMo, and Trae Seed proposal files.
All recommend the delivered dedicated result sink, while acknowledging that
requiredness, supported version combinations, and Core report organization are
separate questions. The TeamLeader adjudicates the arguments below rather than
adopting the recommendation by vote.

## What is necessary, and what is chosen

The baseline already defines `RuntimeSubmission.settled`, provider-owned
`RuntimeCompletion`, and shared completion identity for folded submissions.
These are retained capabilities, not inventions of this feature. A request
answer and an unsolicited native result are different facts.

Q1/Q1a require Core to receive observed normal/failed native results even when
no host submission exists. Baseline settlement has no handle for that case;
state is durable lifecycle/session reporting and activity is presentation.
Some new or deliberately changed result-delivery contract is consequently
necessary while that product coverage is retained. Its field name,
requiredness, transport, and Core consumer organization are design choices.

A dedicated push sink carrying the existing completion is narrower than
redefining activity as a delivery protocol, widening durable state, introducing
provider-originated admissions, or adding a pull buffer and ordering queue.
The strongest argument for it is the preserved meanings and limited affected
consumers, not the number of added lines. Reusing activity with a dedicated
result-bearing variant is mechanically possible; it must be evaluated as an
explicit contract replacement, not rejected merely because the old variant
has no result payload. It introduces display/delivery distinctions into a
contract previously devoted to presentation and broadens consumer changes.

The candidate adds synchronous terminal publication before settlement
continuations, shared identity across the two observations, and terminal-time
eligibility for native results. These are real semantic obligations. The last
timing effect was named in the final solution and authorization playback;
the subsequent hold questions the architecture without automatically erasing
that recorded approval or the product coverage decisions.

## Compatibility matrix

| Pairing / code role | Delivered required-field candidate |
| --- | --- |
| New host / updated conforming provider | Full native coverage, subject to documented owner availability and fences. |
| New host / older non-emitting provider | Extra property may be ignored; bound outcomes still work, unbound coverage is absent. Loading is not conformance. |
| Old host / updated provider | Baseline host supplies no `results`; delivered adapters invoke it without a guard. The first normal/failed terminal can throw before bound requests settle. This pairing is not compatible. |
| A pure context consumer | An added required inbound member need not require source edits if the consumer does not construct the context. |
| Any typed context constructor | A new required property requires supplying it. This includes Core/fixtures in the repository and any external constructor of the public exported type. |

The old-host/new-provider conclusion follows from baseline
`RuntimeGeneration.resolveLaunch` and the delivered provider/runtime wiring to
the bare calls in Claude `rpc.ts` and Codex `turn-manager.ts`. It is a source
derivation, not a new live test. Neither consultation consensus nor repository
inventory proves the absence of external public-context constructors.

There are two coherent interface-evolution policies:

### Policy A: coordinated host/provider upgrades

Keep `results` required, require the host contract that supplies it, and
document the compatible host/types/provider release range. Pure provider
consumers retain source compatibility; all context constructors must update.
An old host with the new adapter is explicitly unsupported; the delivered
implementation currently discovers the missing callback at terminal time.
Do not describe a minimum-version README sentence as runtime enforcement or
as two-way binary compatibility. Whether to fail earlier is a separate
implementation question paid for by this concrete version-skew scenario.

### Policy B: new providers retain old-host submission behavior

Make the public context member optional and call it when present. Define the
normative rule precisely: **when the host supplies the sink, a conforming
provider must publish every applicable native result in order**. Current Core
always supplies it; its native coverage does not become model-dependent.
An old host without it retains its old submission-settlement behavior rather
than throwing. New-provider/old-host and public-constructor source compatibility
are thus better than Policy A. No capability flag, registry, sequence number,
or mailbox is required by this shape.

The trade-off is weaker compile-time pressure on context constructors to wire
the feature; current-Core tests must explicitly assert sink presence and
coverage. Optional property presence and optional emission when a sink is
provided are not the same policy. This variant has not been implemented or
tested. It does not solve new-host/old-provider missing native coverage; that
still requires an updated conforming provider under either policy.

The TeamLeader favors Policy B if independent provider upgrades or old-host
support are intended. Policy A is coherent for declared coordinated releases.
The operator's interface caution alone does not establish which support
policy applies, so no change is made on that inference.

## Core ownership is a separate comparison

The dedicated result seam does not force two Core notification owners.
Current code has `AgentService.observeRuntimeResult` and
`EntityTurn.startDeliveryIfReady`, with shared router folding. The three seats
correctly keep provider observation separate from Core recipient policy, but
do not fully compare those two Core lifetime owners.

| Shape | End-to-end organization | Main trade-off |
| --- | --- | --- |
| Delivered organization | Native facts report through AgentService; submitted outcomes report through EntityTurn. Each owns its delivery lifetime; the existing router folds identical results. | Smaller change from the R71 ownership design; two report initiators and two convergence locations remain. |
| Single AgentService report owner | Retain native publication and submitted settlement as inputs; EntityTurn represents request outcome and unsettled-stop proof. AgentService owns report eligibility, captured recipients, router calls, and started delivery convergence for both inputs. | Removes per-turn recipient/router/delivery side effects, but deliberately changes internal R71 ownership and needs full lifecycle verification. It is not unbound-only transport. |

The single-owner alternative must preserve legacy non-emitting-provider bound
reports, nonordinary owner submission obligations, Workflow return values,
tokenless stopped/failed outcomes, original recipient lookup points, and native
synchronous queue entry. Do not replace fail-loud unsettled-turn proof with
waiting indefinitely on all unanswered settlement promises. Retain the
retained-turn authority; track and drain actual started reports. Keeping two
legitimate observations does not establish a requirement for two side-effect
owners. Conversely, moving code into AgentService is not an entropy reduction
unless the per-turn delivery fields/entry/lifetime are genuinely removed.

History was checked in the R71 data-flow final solution: it deliberately had
EntityTurn query its actual Agent owner and invoke the bound policy after
removing recipient suppliers, retirement registries and callback wrappers.
The single-owner alternative must name that changed boundary and must not
restore any of the deleted plumbing. It is a source-reasoned alternative,
not an accepted, implemented, or independently validated replacement.

## Adjudication ledger

| Argument | Disposition and reason |
| --- | --- |
| Existing result vocabulary can remain | Accept: RuntimeCompletion and submitted settlement already exist; the feature needs a new delivery capability, not necessarily a replacement answer model. |
| Only a handful of neutral lines means a small contract change | Reject as architectural proof: ordering, shared identity, eligibility time, supported version pairs and author obligations matter more. |
| Required is source-neutral for all external code | Narrow: true for pure consumers, false for constructors of the public type. Repository searches cannot prove external constructors do not exist. |
| Optional has no mechanical compatibility benefit / makes provided-sink emission optional | Reject: guarded publication supports old-host/new-provider pairing, while the normative supplied-sink obligation can remain mandatory. |
| Required can enforce provider emission | Reject: field availability does not enforce calls, ordering, or reference identity. The registry only checks existing facade methods. |
| Activity can simply be reused without changing its contract | Reject: unchanged activity lacks the authoritative payload/identity; deliberate redesign changes consumer meanings and scope. |
| Shared identity is an entirely new requirement | Narrow: it already folds N submitted outcomes; sharing it with observation follows from the selected overlapping inputs. Two reporter objects are not thereby fundamental. |
| All single-owner alternatives are unbound-only plus sequencing | Reject: one Core report owner can consume both inputs without changing the dedicated transport or adding a sequence queue. |
| Every listed decision must be asked again | Reject: preserve actual prior product/approval evidence. Ask only the support-policy or architecture choice left unresolved by the hold, not every previously named consequence. |

Further work remains discussion and source-based solution reconciliation.
No implementation correction, independent implementation review, commit,
push, publication of a replacement final solution, or PR is authorized by
this document.
