# Workflow Implementation Review

Use this review only after the TeamLeader pre-review passes. Route the approved
one-file fast path to one direct TeamMate review; route every other implementation
path to the workflow review.

## Establish the review input

Use the current Team workspace changes as the review target. The review inputs are
the paths to:

- the current task README;
- the final operator-aligned requirement;
- the operator-approved final technical solution.

Also state briefly that the TeamLeader's compile, static, and unit checks passed.
Do not serialize or paraphrase the workspace diff or those artifacts into the
prompt, and do not ask review agents to repeat those checks. They read the current
shared workspace, the linked artifacts, and the applicable repository guidance
directly.

## Review the one-file fast path once

Load and follow `team-workflow`, then start exactly one separate read-only TeamMate
with the common identity and the one-file fast-path seat block from
[reviewer-identities.md](reviewer-identities.md). The TeamLeader authored this
implementation, so this reviewer must be a different agent.

Use one review turn. Do not start `workflow_run` or a second review round for this
fast path. Have the TeamLeader adjudicate the returned findings and handle any
accepted correction through its own pre-review checks.

## Run the workflow review

For every other implementation path, load and follow the shared `workflow` skill and
run one `workflow_run` carrying the code-review method it owns in
[code-review.md](/packages/dreamux/skills/shared/workflow/references/code-review.md).
Run it at the `xhigh` gear: the TeamLeader pre-review has already removed the shallow
defects and the one-file fast path already absorbs trivial changes, so the depth the
higher gear buys is what this last gate before merge into `next` is for.

That method is the review. Dreamux tunes it with exactly two deltas; its stages,
verdicts, grouping, report assembly, gear parameters, and failure semantics apply
unchanged, and picking the gear above selects one of those parameters rather than
adding a third delta. Both deltas close one gap: the scope stage resolves the diff
and never learns what the operator approved, so no shared angle can check the
implementation against it.

**The review inputs ride in the scope block.** Pass the three paths above and the
checks-passed note into the run, and add them to the shared scope block every later
agent reads as their own labeled entry rather than as the review target.

**One added finder: requirement fidelity.** Start it alongside the method's own
finders, with `identity` built from the common identity plus the requirement-fidelity
seat block in [reviewer-identities.md](reviewer-identities.md), which owns what it
checks. Give it the per-finder candidate budget the gear gives a correctness angle,
and ingest its candidates as correctness so they are verified and ranked with the
rest. Keep it a named Dreamux finder rather than an addition to the shared angle
list, so the shared method keeps sole ownership of its angles and gears.

## Adjudicate the result

The returned report is advisory. The TeamLeader adjudicates every finding against the
final requirement, the approved solution boundary, and current code, and records a
concrete reason for each finding it rejects. Prefer accepting confirmed, in-scope
architecture, ownership, boundary, and simplification findings. Reviewer output never
replaces the TeamLeader's verdict or an operator decision.

A run that reports partial coverage has not passed this gate. Rerun the missing
coverage or record the residual risk in the task before continuing.
