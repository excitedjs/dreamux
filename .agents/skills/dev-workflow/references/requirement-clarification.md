# Requirement Clarification

## Work from evidence

After the operator confirms the task, inspect current code, relevant tests, runtime
evidence, and linked historical design. Treat the operator as authoritative about
desired outcomes, constraints, and product decisions. Verify claims about current
behavior, ownership, regressions, and architecture.

Do not route work solely from the label supplied by the operator:

- Treat a behavior as a bug only when an existing requirement, test, public
  contract, or accepted runtime behavior establishes the expected result.
- Treat an undefined or disputed expected behavior as requirement clarification,
  even when the operator calls it a bug.
- Treat work as a pure refactor only when observable behavior must remain unchanged
  and the concrete structural problem and completion boundary are explicit.
- Treat a refactor that changes observable behavior as a requirement change.

## Clarify the task, not the implementation

Use concrete discoveries to help the operator expose hidden constraints. Prefer a
question such as "the code does A, the prior task chose B, and your request implies
C; should the target be D?" over a generic questionnaire.

Converge on:

- one precise outcome statement;
- confirmed current behavior and evidence;
- desired behavior;
- scope and non-goals;
- hard product and operational constraints;
- observable acceptance criteria;
- blocking decisions, assumptions, and unknowns.

For a bug, report the observed behavior, basis for the expected behavior,
reproduction evidence, proven root cause, impact, task-lineage relationship, and
minimum repair boundary. Label an unproven cause as a hypothesis. A diagnosis does
not authorize a fix.

For a feature or refactor, challenge whether the requested mechanism is the actual
goal, whether an existing owner already provides the capability, what behavior must
change, what must remain stable, and how success will be observed. Do not accept
"cleaner", "more elegant", or "more general" as a sufficient refactor goal.

Before defining or redefining any user-visible capability's contract, write its
user story into the requirement: who uses it, in what scenario, expecting to see
what. Then check the current implementation against that story — the
implementation's behavior is not a contract basis, because it may never have
implemented the story. Diff the requirement against
[the product behavior catalog](/.agents/product/README.md) and list every entry
the task will touch; a touched entry is a requirement decision, not an
implementation detail. For multi-stage architecture refactors, also apply
[large-refactor-mode.md](large-refactor-mode.md) from this point on.

## Persist during the conversation

Continuously update `requirement.md` as decisions change. Do not wait until the end
of the conversation and do not rely on chat history. Preserve raw requirements when
exact wording matters, but keep the current alignment concise and authoritative.
Set the task README to `State: clarification`, link the requirement, and keep its
next action current. Follow [task-records.md](task-records.md); do not create a
second progress or open-questions file.

Record meaningful decision boundaries, corrections, evidence, and open blockers;
do not log every mechanical investigation step. Distinguish confirmed facts,
operator decisions, hypotheses, and unknowns.

Do not modify implementation artifacts, write a prototype, or insert diagnostic
code during clarification. Read-only investigation and task-document updates are
allowed.

Exit only when every unresolved question that could change the outcome, scope, or
acceptance criteria has been decided. Non-blocking uncertainty may remain when it
is explicitly recorded as an assumption, non-goal, risk, or follow-up.
