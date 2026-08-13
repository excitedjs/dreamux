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

Ask an explicit question such as:

> Do you approve this requirement and technical solution and want the team to enter
> development?

The original request never counts as approval because it precedes investigation,
requirement convergence, and solution review. Agreement with a diagnosis, answer to
a product question, reaction, or instruction to continue investigating also does
not count.

A short response such as "OK", "approved", or "start development" counts only when
it directly answers the explicit development question against the current recorded
requirement and final solution.

## Record and enforce the scope

After valid approval and before any implementation write, update the task README
with at least:

- `State: implementation`;
- the approved requirement and solution links;
- the approved implementation scope;
- a public-safe, provider-neutral approval source description and time;
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

Before valid recorded approval, allow writes only to the confirmed task directory
and its public GitHub solution-review Issue. Prohibit changes to product code,
tests, configuration, scripts, migrations, generated files, and other
implementation artifacts. Prohibit implementation TeamMates and temporary
diagnostic code.
