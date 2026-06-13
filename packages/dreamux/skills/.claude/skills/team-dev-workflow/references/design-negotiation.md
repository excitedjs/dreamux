# Design Negotiation

## Trigger

A design or architecture direction is unsettled, expensive to reverse, and has
more than one plausible path. This is for choosing an approach before
implementation, not for reviewing a finished MR/PR.

## Steps

1. Write one neutral input brief for all participants:
   - business need and observable facts
   - relevant repo paths, scripts, and constraints
   - candidate approaches as reference only, not a forced shortlist
   - required output shape
   - validation expectations
2. Dispatch two independent teammates in parallel with the same input brief.
   Ask each to write a v1 proposal to a file.
3. Wait for both v1 files and verify they exist before continuing.
4. Swap the v1 files. Ask each teammate to read the other proposal and write a
   v2 that states:
   - what it adopts
   - what it rebuts
   - its revised recommendation
   - remaining ambiguity
5. Hand both v2 proposals to the human intact. The coordinator does not
   synthesize a third proposal or preselect a winner.

## Closeout

The human receives two revised, independently argued proposals. If both v2s
converge, report the convergence as evidence; still keep both proposals
available.

## Anti-Patterns

- Do not tell either teammate about the other in the v1 round.
- Do not skip the v2 cross-read.
- Do not add a coordinator-authored compromise.
- Do not let a teammate spawn its own reviewers for this cycle.
