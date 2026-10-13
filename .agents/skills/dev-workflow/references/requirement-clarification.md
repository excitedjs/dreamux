# Requirement Clarification

Enter `clarification` after the task-selection card is answered. Inspect current
source and relevant evidence. The operator decides desired behavior, scope, and
constraints; claims about current behavior and root causes require verification.

Keep `requirement.md` current with:

- the initial request and confirmed current behavior;
- desired behavior, scope, and non-goals;
- constraints and observable acceptance criteria;
- accepted operator decisions, assumptions, blockers, and unknowns.

Distinguish a proven bug from an undefined expected behavior and a refactor from a
user-visible behavior change. Check affected behavior against
[the product catalog](../../../product/README.md). Record the user scenario and
obtain operator confirmation for changes to that behavior.

When a discovery leaves a product or scope decision unsettled, use
`ask_user_question` or an equivalent interactive card in the originating
conversation. State the operator's words, the evidence that creates uncertainty,
and the consequences of the available choices. Ask one issue at a time; wait
before dependent work and record the response verbatim or narrower. Do not treat
an omission, design document, reviewer agreement, or passing tests as approval.

Routine choices within settled scope do not require repeated clarification.
Continuously reconcile accepted decisions into the current requirement; keep
unconfirmed interpretations labeled. Link the requirement and next action from
the task README according to [task records](task-records.md).

Allow only read-only investigation and authorized task-document updates here.
Request entry to `solution` through a requirement-confirmation card when every
blocking question affecting the outcome, scope, or acceptance criteria is settled.
Name any remaining non-blocking assumptions, risks, or follow-ups.
