# Technical Solution and Development Approval

Enter `solution` once blocking requirement questions are settled. Use the
recorded requirement and current source as the design inputs. Do not modify
implementation artifacts during this stage.

Record one authoritative solution at `technical-design/final.md` and link it
from the task README. It must identify:

- the owning components and intended behavior;
- the implementation boundary and non-goals;
- affected contracts, state, compatibility, and upgrade actions when applicable;
- verification against the acceptance criteria;
- unresolved decisions and known limitations.

Resolve factual disputes through source and evidence. Bring unresolved product,
architecture, compatibility, or scope decisions to the operator through a card;
record the ruling before treating it as accepted. If the requirement changes
materially, return to `clarification` before finalizing the solution.

When a public solution-review Issue is used, keep its body aligned with the
local final solution and link it from the README. The local file owns the
solution; the Issue provides a review surface.

## Approving the solution and authorizing implementation

Before entering `implementation` or writing any implementation artifact, play
back:

- the final requirement and acceptance criteria;
- confirmed current facts or proven bug root cause;
- the final technical solution and implementation boundary;
- verification plan, non-goals, and known limitations.

Send one interactive card (`ask_user_question` or equivalent) tied to those
recorded artifacts requesting approval of the solution and authorization to
enter `implementation`. Wait for the operator's explicit approving response. A
pending, expired, unanswered, or declined card, reviewer verdict, original
request, or ordinary chat agreement does not grant development authority.

A short response such as "OK" or "start development" counts only when it
explicitly answers that sent card against the current requirement and solution.
If no interactive-card tool is available, leave the task in `solution` and
report the missing mechanism.

After approval and before any implementation write, record in the task README:

- `State: implementation`;
- the approved requirement and solution links and implementation boundary;
- public-safe descriptions of the card and approving response, with their times;
- the next action.

Never record private transport identifiers or message URLs in the repository.
Approval survives context recovery while the requirement, solution, and scope
remain unchanged. In-scope edits, tests, and ratified review corrections do not
require another development-authorization card.

If those inputs change materially, stop implementation and return through the
card gate to the earliest affected stage. Obtain renewed approval before
implementing the changed scope. Reopened development after a completed merge
requires a new clarification and approval cycle.

Before approval, allow writes only to the confirmed task directory, required
parent README indexes, and its public solution-review Issue. Do not change
product code, tests, configuration, scripts, migrations, generated files, or
other implementation artifacts, including prototypes and temporary diagnostic
code.
