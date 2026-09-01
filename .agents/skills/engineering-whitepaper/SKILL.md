---
name: engineering-whitepaper
description: The operator's standing engineering taste for system design, review, and collaboration. Load before designing, implementing, or reviewing any non-trivial change, and inject a pointer to it into every developer, solution, and reviewer seat identity. Self-contained and portable across repositories; it states preferences and their reasons, not repository facts.
---

# Engineering Whitepaper

This is the operator's standing engineering taste, extracted from real review
rulings. Every rule below was paid for by an actual correction; each carries one
compressed case. None of it is absolute: like any knowledge, a rule here can be
overridden by the operator, and if you believe a rule does not fit the current
scenario, raise that explicitly instead of silently ignoring it. What this
whitepaper removes is the need for the operator to restate the same judgment
again.

## 0. The root rule: entropy reduction

One motivation generates everything below. Most work on a long-lived system is
refactoring, and the point of refactoring is lowering complexity — so the
standing question for every change is its entropy delta.

**Entropy is what a maintainer must hold in their head to reason about the
system**: the count of concepts, entities, mechanisms, persisted facts, states,
special cases, and cross-layer hops. It is not line count and not duplication
count — two hundred lines of plain repetition are often lower-entropy than one
clever shared layer, because the repetition asks the reader to know one thing
and the layer asks them to know three.

Judge any change with three questions:

1. After it lands, does explaining the affected area take **fewer concepts**
   than before?
2. Does the next feature, provider, or reader need to know **less**?
3. What exactly did the change **remove**, and is every **addition** paid for
   by a requirement someone actually stated? A change that cannot list its
   removals is suspect; additions that outnumber removals need an explicit
   reason to exist.

Two ways of faking entropy reduction are banned by name:

- **Dedup by indirection.** Extracting a shared layer while both original
  sides keep their schemas and wiring adds a mechanism and removes nothing.
  *Case: a 691-line shared `operations` layer replaced 49 lines, net-removed
  almost nothing on either side, and was rejected on sight with "you added a
  third file?".*
- **Deletion as simplification.** Removing user-visible capability is not
  entropy reduction; it is a requirement change, and it belongs to the
  operator. *Case: deleting a container also deleted the user's binding flow —
  the capability had to move to its correct owner, not disappear.*

## 1. No mechanism without a named failure scenario

Before adding any validation, cap, retry, fallback, recovery path, allowlist,
policy table, or new entity, write down the concrete real scenario that
triggers it: what input, what concurrency, what interruption reaches this
branch. If you cannot name the scenario, do not write the code.

- Abstract risk is not a scenario. "The output could theoretically be huge" or
  "a document mentions validation" is not evidence; data already constrained
  upstream does not need a second fence downstream.
  *Case: a uniform JSON byte cap on all command outputs was proposed for a
  "possibly huge result" that no real producer could emit — rejected.*
- A finding that needs a compound trigger — an operation fails AND a re-check
  happens to observe a specific state AND the condition survives a restart —
  is theoretical hardening. Reject it yourself; do not forward it.
- Implementation scope is not access control. "This release only calls two of
  the commands" is expressed by not calling the others, never by an exposure
  policy, allowlist, or capability negotiation.
  *Case: an exposure policy over a unified command registry was rejected as
  pure over-defense; all commands stay uniformly reachable.*
- Do not give a grow-only durable structure an artificial total cap; a cap with
  no recovery path is a permanent deadlock. The inverse also holds: a structure
  that accumulates per entity for the process lifetime is unbounded by
  construction and must state its total bound. Deliberate retention is not an
  excuse — the memory consequence is the same.
  *Case: a 4096-entry idempotency ledger would have made a dispatcher unable to
  ever create a team again; separately, a per-entity ledger map grew without
  bound until it was collapsed into one bounded ledger.*
- Defensive code found during review is something to delete, not to make
  correct. When the operator strikes one defensive layer, strip the whole
  family in that pass — conceding one layer at a time forces the same ruling
  to be repeated three times.
  *Case: a failure-UUID correlation protocol was struck, then its sanitize
  template survived one more round, then the "core rephrases foreign errors"
  assumption survived another; all three were the same mechanism.*

## 2. Durable facts and recovery

The question that decides whether an intermediate state may be persisted:
**"what happens if it is lost?"** If the answer is "the system returns to an
already well-defined normal state", it stays in memory.

- Persisted owner facts are the only recovery input. What committed, happened;
  what did not commit, never happened. There is no implied transaction across
  independently owned records, and a failed aggregate operation does not roll
  back the durable side effects that completed before it failed.
- Do not add a compensating entity, persisted phase, recovery ledger, retry
  registry, generation, boolean mirror, or eager materialization merely to make
  a rare failure look as though the operation never started. Recovery happens
  on the next ordinary access through the normal materialization path, not in a
  catch block.
- After a failure, the goal is that the same operation can be retried and
  converge — not that the system pretends nothing happened. An in-memory object
  that no longer represents its durable record is discarded, not repaired.
- Second-order failure during ordinary reconstruction may fail loudly. Do not
  defend recovery from recovery.
  *Case: a failed team dissolve triggered eight hours of invented compensation —
  eager service rebuilds, an aggregate rollback error, then a phase check on
  the half-closed wrapper. The ruling: every fact already on disk counts, the
  next ordinary access rebuilds from disk, and the next dissolve retries the
  same idempotent close operations. All of the compensation was deleted.*

Ordinary startup recovery from current records, lazy materialization on cache
miss, a retryable operation releasing its promise fence, and fences against
real stale external writers are all normal — the test is whether the mechanism
derives from an authoritative fact and serves a real caller.

## 3. Minimal mechanism

- Interface convergence asks four questions of every field and method: who
  produces it? who consumes it? what user-visible capability is lost if it is
  deleted? can it be derived from facts that already exist? Anything that fails
  the four questions is deleted before the signature is locked.
- New entities carry the burden of proof. A new type, wrapper object, registry,
  phase field, or term must point at a scenario the operator actually asked
  for. If explaining your design requires introducing a noun the operator has
  never seen, that noun usually should not exist.
  *Case: "Leader wrapper" appeared in an explanation of a recovery path; the
  operator's response — "don't add entities for scenarios I never required" —
  deleted the concept and the code behind it.*
- Merging N methods is not a boundary reduction if the merged signature grows
  an N-valued discriminant. If the callee treats the branches identically, the
  taxonomy must not cross the seam.
- Deleting an abstraction must not spawn a bigger compensator. If the
  replacement is larger than what it replaces, stop and re-read the
  requirement — you are probably building a compensation mechanism.
  *Case: removing a resolve/query callback was "replaced" by a normalization
  type, a provenance store, and an opaque ref — three mechanisms for one
  deletion — and rejected with "you are all overthinking this".*
- Delete the concept, not migrate it. When every responsibility of a domain
  concept can be composed from a more basic concept plus caller-owned state,
  remove the concept itself — container, commands, events, persistence — rather
  than moving it to a new owner under a new name.
- Between designs with equivalent product semantics, the one with the least
  code wins. A design that needs cancel flags, checkpoints, or cleanup branches
  to hold together usually has the wrong semantics underneath.
- A parameter that takes the same value at every legal call site is not a
  parameter; promote it to an invariant.
- Design capability catalogs from what the owner can stably provide
  (capability-first), never by transcribing existing call sites — a one-to-one
  mapping of the old surface is an interface migration, not a design, and it
  permanently fixes the current caller's quirks into the common contract.
- Write the user story before the contract. The current implementation's
  behavior is not a contract basis: it may simply have never implemented the
  story.
  *Case: a progress-observation tool was being redesigned around "read completed
  turns" because that is what the code did; the actual story — observe a
  teammate mid-turn after forty silent minutes — was not implemented at all,
  and three reviewers argued details on top of the false premise.*

## 4. Existing design is evidence, not a verdict

Current code, historical decisions, and existing documents record how the
system got here and why. They are input to judgment, never a substitute for
it — and never a preservation order.

- Meeting an existing mechanism, ask three questions before reusing it: why
  does it exist? is the problem it solved real today? does it deserve to be in
  the final shape? "It is load-bearing", "it is deployed at scale", and "the
  document says so" are descriptions, not reasons.
- Before stating who should own something, reconstruct that boundary's history:
  find the commits and decisions that last moved it, and say which one you are
  following or superseding. An ownership conclusion reached before the history
  check is a guess.
  *Case: "the dissolve state machine belongs in the collection" was asserted,
  then reversed hours later by the very commits that had deliberately moved
  close semantics to the service — commits that were reachable the whole time.*
- Frozen requirement and design documents cover only what was modeled. When an
  implementation-level fact contradicts them, the conflict is a stop signal to
  surface, not a deviation to suppress; conformance to a stale document is not
  a defense.
- Agreement among several independent reviewers proves they share a premise,
  not that the premise is true. Before escalating a convergent conclusion,
  write down the one-sentence premise it rests on and verify that premise at
  the source.
  *Case: three reviewers from different runtimes independently reported the
  same "offline channel reconciliation gap"; all three had inherited the same
  false premise — the channel runs in-process and cannot be offline.*

## 5. Change anything — knowingly

Nothing in a codebase or knowledge base is absolutely authoritative. Fitting
the current product scenario, any design may be changed. What is prohibited is
the unknowing change:

- Know what you are touching. Before landing a change, enumerate the
  user-visible behaviors it alters — a capability disappearing, an entry point
  narrowing, a default changing, an error becoming visible or invisible. A
  product-behavior change is a requirement decision for the operator, never a
  refactor side effect; deleting an owner is not the same as deleting the
  capability it carried, which usually moves to its correct owner instead.
  *Case: deleting a core-owned collaboration-space container silently deleted
  the user's "bind this topic group" flow with it; the ruling moved the
  capability to the channel and kept the deletion.*
- Know why it was the way it was. Read the recorded rationale; if it no longer
  holds under the current scenario, change the design and update the record in
  the same change.
- The operator's rulings bind until the operator changes them — and only at
  the scope they were given. Restate a ruling verbatim or narrower, never
  broader; a named entry point does not generalize into a category, and a
  ruling on one object does not extrapolate to its neighbor without asking.
  Anything recorded as a confirmed operator decision must be traceable to the
  operator's actual words; inferences are labeled as inferences and confirmed
  separately before any implementation or review cites them.
  *Case: an inferred "all channel input must carry a team name" was committed
  into the confirmed-decisions section four minutes after a narrower remark,
  deleted a real fallback path, and misled an independent auditor into
  retracting a correct regression finding.*

## 6. Keeping shape during long feature iteration

Architecture erodes through small features, not big rewrites. Watch for shape
signals and treat them as refactor triggers, not obstacles:

- A file tripping the max-lines gate is a smell detector firing, not a budget
  to duck under. The legitimate responses are exactly two: find the
  responsibility that wants its own owner and give it a real named module, or
  record the file as a micro-refactor candidate for the operator to schedule.
  Trimming comments, inlining whitespace, or exiling one or two small helper
  functions to satisfy the gate is itself a violation — surface it in review.
- Other signals worth the same treatment: a Deps object whose shape diverges
  from its symmetric peer (function-valued deps are usually a reverse
  dependency in disguise); a second implementation of a mechanism that already
  exists once; a callback threading through a third layer; a fix that must be
  repeated at more than one entry point (the entry points probably want to
  merge).
- When the same module draws review findings in two or more consecutive
  rounds, stop patching. The model is wrong, not the details: restate what the
  code is actually modeling, name what the previous rounds conflated, and take
  the root cause to the operator instead of the next patch.

## 7. Naming and tests

- Name a helper by the promise it gives its caller, not the technique inside:
  `deduplicate`, not `singleFlight`. Paired operations share symmetric names
  (`bind_channel` / `unbind_channel`). A lifecycle exists to fire hooks for
  other holders — that is an event emitter, never an object with phases of its
  own. A nullable promise field is itself the state: started, joinable,
  settled — do not put a boolean or phase enum beside it.
- Tests assert behavior, with real owners and observed outputs. A test that
  asserts where a constant is exported from, or mirrors source text — whether
  by string match or by AST extraction of a private method body — is a
  structure assertion: delete it, never bend tsconfig or add re-exports to
  appease it. Replacing a text mirror with an AST mirror is the same defect in
  new clothes.
- A guarantee that can only be demonstrated by fabricating a producer is
  defensive bookkeeping, not a contract. If the test must forge an error to
  show the branch, the branch should not exist.
- Do not weaken a load-bearing test to make a change pass; a green run produced
  by a rewritten assertion is circular evidence.

## 8. Working with the operator

- One item at a time. Present exactly one decision per message: the observed
  facts (with locations), the assumptions you added, the user-visible
  consequence, your recommendation with its reason. Wait for the ruling, echo
  it back with its item number, then present the next item. Never batch open
  questions, never reuse a ruling's wording on the item it was not aimed at.
- Lead with the outcome the operator cares about. "Did this find real
  defects?" comes before case counts and green gates; a defect report's first
  sentence is the user-visible symptom, not an architecture noun. A completion
  report explains the mechanism — which layer now owns which fact and why that
  is correct — not just that checks passed.
- Concrete over abstract, always. Describing code behavior means showing the
  real calls and their distinct side effects, not a covering verb like
  "restores" or "reopens"; explaining a conflict means laying out the two
  concrete paths side by side. Words like "keep", "restore", and "materialize"
  carry no meaning without a stated baseline and layer. Do not use a term of
  art the operator has not seen without defining it in the same message.
- Do not ask what you can derive. A question whose answer is already in the
  code, the history, or your own previous paragraph is analysis outsourcing;
  do the analysis and state the conclusion with evidence. When a question is
  genuinely the operator's — product intent, cost tolerance, compatibility
  policy — bring a recommendation and the consequence of each option anyway.
  When the answer follows from a principle the operator locked earlier in the
  same task, apply it, cite the ruling, and move on without reopening it.
