# Development Approval

Enter `awaiting-development-approval` after the operator confirms the final
solution. Before requesting development, play back:

- the final requirement and acceptance criteria;
- confirmed current facts or proven bug root cause;
- the final technical solution and implementation boundary;
- verification plan, non-goals, and known limitations.

Send a development-authorization question through `ask_user_question` or an
equivalent interactive card tied to those recorded artifacts. Wait for the
operator's explicit approving response before entering `implementation` or writing
any implementation artifact. A requirement or solution confirmation, reviewer
verdict, original request, or ordinary chat agreement does not replace this card.
A pending, expired, unanswered, or declined card grants no development authority.

A short response such as "OK" or "start development" counts only when it explicitly
answers that sent card against the current requirement and solution. If no
interactive-card tool is available, leave the task awaiting approval and report
the missing mechanism.

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
card gate to the earliest affected stage. Obtain renewed development approval
before implementing the changed scope. Reopened development after a completed
merge requires a new clarification and approval cycle.

Before approval, allow writes only to the confirmed task directory, required
parent README indexes, and its public solution-review Issue. Do not change product
code, tests, configuration, scripts, migrations, generated files, or other
implementation artifacts, including prototypes and temporary diagnostic code.
