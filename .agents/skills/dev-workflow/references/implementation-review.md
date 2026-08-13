# Workflow Implementation Review

Use this review only after the TeamLeader pre-review passes. Route the approved
one-file fast path to one direct TeamMate review; route every other implementation
path to the workflow review.

## Establish the review input

Use the current Team workspace changes as the review target. Give every reviewer
the paths to:

- the current task README;
- the final operator-aligned requirement;
- the operator-approved final technical solution.

Also state briefly that the TeamLeader's compile, static, and unit checks passed.
Do not serialize or paraphrase the workspace diff into the prompt, and do not ask
review agents to repeat those checks. They read the current shared workspace and
the applicable repository guidance directly.

## Review the one-file fast path once

Load and follow `team-workflow`, then start exactly one separate read-only TeamMate
with the common identity and the one-file fast-path seat block from
[reviewer-identities.md](reviewer-identities.md). The TeamLeader authored this
implementation, so this reviewer must be a different agent.

Use one review turn. Do not start `workflow_run`, verifier voters, or a second
review round for this fast path. Have the TeamLeader adjudicate the returned
findings and handle any accepted correction through its own pre-review checks.

## Find through workflow perspectives

For every non-fast-path implementation, load and follow the shared `workflow` skill
and its code-review reference. Run one `workflow_run`; use their orchestration and
failure semantics, with the Dreamux-specific lenses and scoring rules below taking
precedence.

Start the three mandatory finders in parallel. Build each `identity` from the
common identity plus its seat block in
[reviewer-identities.md](reviewer-identities.md):

- architecture and module boundaries;
- simplicity and reuse;
- requirement fidelity and completeness.

Keep the finders blind to each other's output. Require every finding to include
its category, current-code evidence, consequence, and smallest justified
correction. A functional finding also needs a concrete unmet or incorrect user
scenario. An architecture or simplicity finding needs evidence and a simpler
alternative, not an invented runtime failure. Do not discard these two lenses as
generic quality concerns under the shared code-review false-positive defaults.

Use one synthesis agent to map every raw finding to a canonical finding or an
explicit duplicate. It may fact-check, classify, and deduplicate; it may not
silently discard a finding or decide the TeamLeader's verdict. Preserve all three
raw reviews in the terminal result.

## Verify with asymmetric confidence

Give every canonical finding three parallel verifier votes with distinct focus:

- whether the cited workspace facts are current and correct;
- whether the consequence follows from the final requirement, approved solution,
  or an established module boundary;
- whether the proposed correction is minimal rather than defensive expansion.

Use the workflow code-review 0/25/50/75/100 confidence scale, but score confidence
in the finding's evidence and consequence. Do not penalize architecture findings
merely because they do not describe a runtime failure. Require at least two settled
votes, then apply the category threshold:

- `architecture_or_simplification`: confirm at average 70 or higher, but only with
  current-code evidence and a simpler alternative;
- `functional_correctness`: confirm at average 80 or higher and require a concrete
  user-visible or acceptance-criterion scenario;
- `defensive_expansion`: first require an explicit final requirement, an existing
  supported contract, or an observed failure; otherwise reject it. With that
  evidence, confirm only at average 90 or higher.

Classify by the finding's content, not its originating seat. A new abstraction,
compatibility branch, state machine, or defensive mechanism proposed by the
architecture finder remains `defensive_expansion` unless the evidence gate proves
otherwise.

## Report for TeamLeader adjudication

Return the raw finder reports, canonical findings, every settled vote, confirmed
findings, unconfirmed findings, and coverage gaps. A failed mandatory finder or
fewer than two settled votes for a finding is visible incomplete coverage, never a
clean pass.

The synthesis report is advisory. The TeamLeader adjudicates every confirmed
finding against the final requirement and current code. Prefer accepting confirmed,
in-scope architecture, ownership, boundary, and simplification findings; record a
concrete reason when rejecting one. Reject defensive expansion by default unless it
passes both its evidence gate and confidence threshold. Vote count never replaces
the TeamLeader's verdict.
