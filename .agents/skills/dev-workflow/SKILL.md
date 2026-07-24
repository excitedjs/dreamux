---
name: dev-workflow
description: The development process for changing the dreamux repo itself, for a TeamLeader coordinating TeamMates. Use when implementing any non-trivial change — a feature, a refactor, or a fix. Covers landing a spec, resident-panel review across spec, implementation, fixes, and exact final heads, opening a PR to the default branch, and the gate before the operator sees it.
---

# Dreamux Repo Development Workflow

The default flow for any non-trivial change to this repo. Start here; do not skip a
stage to save time — each skipped stage is a class of defect that reaches the
operator.

When an operator instruction materially conflicts with this workflow, stop before
deviating and ask whether the instruction is a one-off exception for the current
change or a standing amendment to this skill. A one-off exception applies only to
the current change through its final head and does not rewrite this workflow. A
standing amendment must update and review this skill before it applies by default;
the operator decides whether the current change proceeds under a one-off exception
or pauses until the amendment lands.

## Resident roster

Normally run with a resident TeamMate roster: three read-only reviewers with
complementary stable identities/focuses plus one developer (3-4 TeamMates total).
Use [reviewer-identities.md](references/reviewer-identities.md) as the bundled
static reference for the three reviewer identity texts and focus split.
Establishing a seat means reading that reference and passing the selected copyable
identity text to `teammate.spawn.identity`. Recovering an existing seat means
reusing its concrete name via `send`/recovery; `send` cannot change identity, so do
not respawn solely to retrofit wording. Reinforce focus in the task prompt if
necessary.

Reuse the same concrete TeamMate names across changes via send/recovery, using
existing TeamMate identity and PR/commit records. Do not spawn extra TeamMates or
fresh panels. The bundled reference is the sole documentation owner for resident
reviewer identities/focuses and is not a runtime registry; do not create additional
ad-hoc profile, roster, rationale, or other process-artifact registries. Any
operator-requested deviation from roster, authorship, or process-artifact rules is
a material conflict and must be classified under the one-off-versus-amendment guard
above before proceeding. If a seat is unavailable, pause and escalate to the
operator.

The developer owns implementation. Reviewers stay read-only. Choose the reviewer
panel before spec review. Identity/focus is stable and additive, never a substitute
for holistic review. Use heterogeneous runtimes where available, but do not rotate
concrete names just for heterogeneity.

The same panel reviews the spec, implementation, every fix, and the exact final
head. Approval attaches to an exact head and never carries forward.

## The loop

1. **Align, land a spec.** Talk to the operator until the requirement is
   unambiguous — play it back, surface the open decisions, and do NOT build on a
   fuzzy ask or an unsettled design decision. Write a short spec: intent, scope,
   hard constraints, acceptance, and what is explicitly OUT of scope.

2. **Spec review before any code.** Route the SPEC to the resident reviewer panel.
   They check completeness, design, scope, and fit with the repo's EXISTING
   architecture. Fold findings back into the spec before implementation.

3. **Implement to a PR.** Drive the implementation — a workflow orchestration if the
   runtime supports it, otherwise a dev TeamMate — and open a PR to the default
   branch. A dev TeamMate does NOT commit into the working tree on its own: under the
   single-writer rule the TeamLeader reviews the local diff and commits (never edit
   the tree while a dev TeamMate is live on it).

4. **Implementation review (author != reviewer).** Route the exact head to the
   resident reviewer panel — never the author, never self-review. Review the WHOLE
   change holistically (not a narrow "did it fix X"):
   - requirement fully landed;
   - no unrelated or unjustified scope expansion; creating or reshaping the owner
     capability that is the correct home for the requested behavior is in scope;
   - complexity/reuse/layering: no duplicate implementations, state machines, or
     helpers; no redundant abstractions, entities, DTOs, or capabilities; no
     accidental public API growth; shared owner capabilities are justified; package,
     layer, owner, and neutral seams are correct; tests protect contracts instead
     of mirroring implementation complexity;
   - correctness, lifecycle, concurrency, and failure behavior are sound;
   - tests are not weakened to pass, and public-artifact safety holds.

5. **Adjudicate and gate before the operator.** Reviewer severity is input, not the
   TeamLeader's verdict; the TeamLeader judges every finding. A blocker is cleared
   by fix plus exact-head re-review, or rejected with concise concrete rationale in
   the PR/commit summary. Record concise PR/commit rationale whenever rejecting any
   finding or deviating from either default. Escalate unsettled product-contract
   decisions to the operator. Send the PR to the operator ONLY after CI is green
   AND every accepted blocking finding is cleared.

6. **Fixes follow the same bar.** Any fix — review follow-up, regression, hotfix —
   is implemented by the developer and re-reviewed by the same panel at the new
   exact head. Rerun the step 5 gate after that re-review. Never self-approve.

## Review finding defaults

- Accept behavior-preserving, in-scope refactoring recommendations by default.
  Prefer simplification, glue removal, deletion or consolidation of duplication,
  ownership/layering corrections, and moving a fact or action to its single
  correct owner. Decline one only for a clear, concrete reason recorded in the
  PR/commit summary. Scope-expanding cleanup requires operator agreement or a
  tracked follow-up.
- Reject edge-case defensive recommendations by default. Accept one only for a
  clear, concrete reason recorded in the PR/commit summary, grounded in an
  operator request, observed failure or failing test, established production
  contract, or concrete proportionate production risk. Apply the same
  reject-by-default evidence standard to speculative new abstractions or
  entities. When a recommendation combines refactoring with edge-case defense,
  this second default governs the defensive portion; independently justified
  simplification or ownership benefits remain under the first default.
  Fail-loud invariants and load-bearing tests count as established contracts,
  not edge-case defensive machinery.
