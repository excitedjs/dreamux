# Final technical solution

## Decision

Make the smallest change that directly expresses the operator's review posture.
Keep every existing reviewer, turn, workflow, and output contract unchanged.

## Changes

1. Strengthen the solution identity set and common implementation-review
   identity:
   - the TeamMate is an independent challenger, not a confirmer;
   - the solution reviewer and implementation reviewer treat TeamLeader proposals
     and implementations as evidence, not verdicts;
   - those reviewers reconstruct the user story, owner, and simplest coherent
     mechanism from the requirement and current source, while the solution author
     remains responsible for a complete proposal;
   - entropy reduction is a hard acceptance criterion even when behavior and
     tests pass;
   - uncontrolled mechanism growth triggers an architecture challenge before
     another local patch;
   - findings remain evidence-based and no finding is valid.
2. Keep solution-consultation work prompts task-specific: pass the common and
   seat identities intact, and put only task inputs, assigned outputs, write
   boundaries, and report contracts in the prompt. The solution-reviewer identity
   owns independent reconstruction before draft comparison. The solution-author
   identity keeps the complex proposal round independent without inheriting the
   TeamLeader's preferred owner or answer.
3. Point the TeamLeader's standing hand-down rule in `SKILL.md` at the two
   common identity blocks, which own the posture; `SKILL.md` does not restate
   it.

## Unchanged boundaries

- No new TeamMate, review round, finder, workflow state, or result schema.
- No change to the shared dynamic code-review method.
- No product or runtime behavior change.
- The TeamLeader still adjudicates findings and the operator still owns product
  and architecture decisions.

## Verification

- Validate the skill frontmatter with the existing skill-creator validator.
- Run the task checker, `.agents/scripts/check.sh`, and `git diff --check`.
- Use one ordinary read-only implementation review to check wording, ownership,
  and scope. It must not claim to prove the prompt's future effectiveness; that
  remains operator-observed.

## Rejected expansion

Do not add lens-specific seats, extra blind/comparison turns, a new architecture
finder, a sibling review workflow, or automated prompt-effectiveness tests in
this change. Those mechanisms exceed the operator's narrowed request.

Do not compose the common identity into the shared finders or the sweep either.
The shared method already owns architecture challenge through the cleanup
finder's simplification and Altitude angles. Composing the Dreamux identity there
would give the same responsibility two owners. The identity reaches the workflow
review through the requirement-fidelity finder and the fast path through its sole
reviewer.
