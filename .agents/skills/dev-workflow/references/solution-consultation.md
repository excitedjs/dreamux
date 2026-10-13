# Technical Solution Confirmation

Enter `solution` only after the operator confirms the recorded requirement through
the stage-transition card. Use that requirement and current source as the design
inputs. Do not modify implementation artifacts during this stage.

Record one authoritative solution at `technical-design/final.md` and link it from
the task README. It must identify:

- the owning components and intended behavior;
- the implementation boundary and non-goals;
- affected contracts, state, compatibility, and upgrade actions when applicable;
- verification against the acceptance criteria;
- unresolved decisions and known limitations.

Resolve factual disputes through source and evidence. Bring unresolved product,
architecture, compatibility, or scope decisions to the operator through a card;
record the ruling before treating it as accepted. If the requirement changes
materially, return to clarification before finalizing the solution.

When a public solution-review Issue is used, keep its body aligned with the local
final solution and link it from the README. The local file owns the solution;
the Issue provides a review surface.

Play back the final solution and request confirmation through the stage-transition
card before entering `awaiting-development-approval`. Solution confirmation does
not authorize implementation; continue with [development approval](development-approval.md).
