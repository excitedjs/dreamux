# Operator-delegated architecture selection

## Instruction and authority

On 2026-10-14 the operator stated:

> 我不确定之前重构的是否是架构最优啊。我感觉你们可以选一个最优方案

English rendering: "I am not certain the previous refactoring is architecturally
optimal. I think you can choose the best design."

The TeamLeader and reused solution seats must select a design, rather than ask
the operator to decide internal architecture. Requirement revision 3 is the sole
product authority. Earlier implementation, Promise/token refactoring, attributed
event proposals, and the latest source-informed recommendation are candidates
and evidence, not preservation requirements. The instruction authorizes design
selection; it does not explicitly resume implementation through the existing hold.

## Independent comparison

Derive the minimum model from the product before choosing an interface. Compare
at least these two complete designs, without assuming either is preferable:

1. Completion-valued per-input submissions plus native-result observation, with
   one Core reporting owner and explicit result-identity folding.
2. A single authoritative runtime outcome stream, with Core-owned per-input
   result Promises. Compare this complete replacement, not only an event added
   alongside the same provider settlement machinery. Account for what can really
   disappear from both Core and adapters and what new correspondence is required.

A different design is welcome when it is simpler and supplies all stated
behavior. Changing the neutral ABI and replacing earlier code are permitted
design options. Keeping a mechanism needs a present consumer and a comparison
against its alternative; removing it needs an end-to-end replacement of its
actual user capability.

## Mandatory falsification cases

- Several actual inputs fold into one result; queued inputs produce separate
  results even when their output text is equal.
- A normal/failed native result exists with no host input. Ordinary-member
  reports remain ordered across bound/unbound results.
- A native result arrives before its admission continuation. Show which Core
  record is already known at that instant, who owns it, and how rejection,
  ambiguous admission and close races retire it. Resolving an admission Promise
  does not synchronously run the Core continuation.
- Managed TeamLeaders have no ordinary result subscription. Several explicit
  Dispatcher requests answered by one leader result still produce one reply.
  An autonomous leader result produces no upstream reply.
- Scripts retain their per-input result values and current public receipt
  identity. Workflow-controlled members do not gain ordinary messaging/reporting.
- Bound Codex interruption currently returns partial text as a completed-shaped
  settlement without a native-result callback. Claude has a stopped outcome.
  Preserve these observable outcomes and do not expand unbound interruptions.
- Actual input/transport failure has no native turn to fabricate. Preserve its
  request outcome and distinguish it from a native failed terminal.
- Stop/close must fence new work, settle accepted inputs, fail loudly if the
  runtime did not converge, and wait for started delivery. Name any eligibility
  timing movement; distinguish operator behavior from incidental Promise hops.
- Real Team/Dispatcher scoped input fences survive shared messaging. Management
  ownership does not become recursive notification routing.

## Comparison method and deliverable

For each candidate enumerate authoritative records, lifetimes, identities,
cross-package duties, delivery paths, queueing and teardown. Distinguish facts
that remain necessary from removable mirrors or controllers. Score conceptual
cost and future-provider obligations, not historical compatibility or diff size
alone. Existing deployed interfaces do not win by default; a rewrite does not
win merely by being a rewrite.

Recommend one design and give its strongest counterexample. Include a concrete
public-interface sketch and the adoption classification (adaptation/replacement),
real deletions/additions, version-pairing consequences, and an acceptance mapping.
No mathematical claim of global optimality is required; select the strongest
design among the complete alternatives and explain the criterion.

First pass: independent, using current source and this product input. Do not read
another seat's new section or use the TeamLeader's latest recommendation as the
expected answer. Append only to the seat's already assigned proposal file.
Keep the new section proportional (target at most 900 words).

Then perform one cross-review of the three new sections. The TeamLeader will
adjudicate against source and record one selected architecture. Do not delegate
implementation, execute tests/prototypes, change product/config/script files,
or mutate Git or external applications during this selection.

The Codex/DSH read-only study is comparison evidence: Codex local commit
`fbc169827e9789f9e7ba2ed97c15e2021c3312bb`, DSH local commit
`ddefc45fbc7f8e46dd73185e68295696d1297887`. Their input receipts are not the same
per-input result-value interface that Dreamux scripts consume. Reuse concrete
source when useful; do not transplant their different product policies.
