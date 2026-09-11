# Development Approval

## Ask after solution review

Before asking for approval, make the confirmed task self-contained and current.
Play back to the operator:

- the final outcome and acceptance criteria;
- confirmed facts or proven bug root cause;
- the final technical solution;
- implementation scope and explicit non-goals;
- verification plan;
- non-blocking assumptions and known residual risks.

Send an explicit development-authorization question through `ask_user_question`
or an equivalent interactive-card tool, such as:

> Do you approve this requirement and technical solution and want the team to enter
> development?

**No sent development-authorization card means no development authorization.**
The card must refer to the current recorded requirement, final solution, and
implementation scope. Sending it alone is insufficient: wait for the operator's
explicit approval in response. A pending, expired, unanswered, or declined card
does not authorize development. A product-choice or solution-review card is not
a development-authorization card.

The original request never counts as approval because it precedes investigation,
requirement convergence, and solution review. Agreement with a diagnosis, answer to
a product question, reaction, or instruction to continue investigating also does
not count.

A short response such as "OK", "approved", or "start development" counts only
when it explicitly answers that sent development-authorization card against the
current recorded requirement and final solution. An ordinary chat confirmation
without that card does not count, even if it says to start. Neither a reviewer's
verdict nor the leader declaring the task approved replaces the card and answer.
If no interactive-card tool is available, leave the task awaiting approval and
report that the required authorization mechanism is unavailable; do not replace
it with a prose-only question.

## Regression Trap: reviewed requirements are not authorization

A leader started a developer after requirement confirmation and an independent
review, then had to stop when the operator clarified that development was not
authorized. A task-state declaration cannot supply the missing consent: check
for the sent development-authorization card and its approving response before
starting a developer or writing implementation artifacts.

## Record and enforce the scope

After valid approval and before any implementation write, update the task README
with at least:

- `State: implementation`;
- the approved requirement and solution links;
- the approved implementation scope;
- a public-safe, provider-neutral description of the sent development-authorization
  card, its time, and the operator's explicit approving response and time;
- `Next action: Enter development`.

Treat the task README as the visible current-state authority. A deeper progress log
may retain chronology but must not become a conflicting state source. Never record
a private message URL, channel name, channel identifier, or other transport
metadata in the repository.

Bind approval to the recorded requirement, solution, and implementation scope, not
to the task forever. Preserve it across context compression or handoff when those
inputs remain unchanged. Do not ask for approval for every line edit, in-scope test,
or review correction.

If the goal, product behavior, architecture, public contract, or implementation
scope changes materially, stop implementation, set
`State: awaiting-development-approval`, update the affected artifacts, and return
to the earliest affected workflow step. Reopened development after a completed
merge requires a new clarification and approval cycle.

## Enforce the pre-approval write boundary

Before valid recorded approval, allow writes only to the confirmed task directory,
the parent task README indexes required to discover it, and its public GitHub
solution-review Issue. Prohibit changes to product code,
tests, configuration, scripts, migrations, generated files, and other
implementation artifacts. Prohibit implementation TeamMates and temporary
diagnostic code.
