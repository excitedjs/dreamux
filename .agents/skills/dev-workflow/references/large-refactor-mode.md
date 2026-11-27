# Stage Checkpoints for Multi-Stage Work

Use the normal workflow and interactive-card gates for each approved implementation
slice. Keep the current slice, its approved boundary, completed evidence, remaining
work, and next decision in the task README.

Record operator rulings with their actual words, time, and the object each applies
to. Keep one rulings file when the requirement is too large to hold those decisions
clearly. Label inferences and confirm them before implementation or review uses
them as requirements.

At each stage boundary and after context recovery, read the current task artifacts
and applicable routes in [the KB entry point](../../../root.md). Check that the
recorded authorization still covers the next slice. Earlier approval does not
cover a materially changed requirement, solution, or scope.

Before advancing to the next slice, reconcile the completed slice with its
acceptance criteria, review dispositions, verification evidence, and affected
knowledge owners. Mechanical stage boundaries within an already-approved slice
(`implementation` -> `review` -> `knowledge-closeout` -> PR) advance directly;
use interactive cards only for the gates enumerated in `SKILL.md` (per-slice
solution/development authorization, unsettled scope decisions, review-finding
rulings, material re-approval, merge, and Team dissolution), presenting the
reconciled slice evidence in that card when authorizing the next slice.
