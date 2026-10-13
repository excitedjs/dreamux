---
name: dev-workflow
description: Dreamux repository development process for the TeamLeader. Defines task stages, mandatory interactive-card confirmation, development and review gates, durable task records, knowledge closeout, PR delivery to next, merge authorization, and optional Team dissolution.
---

# Dreamux Development Workflow

Keep the confirmed requirement, solution, authorization, and evidence in the task
record. Verify implementation facts against current source. Use
[engineering-whitepaper](../engineering-whitepaper/SKILL.md) for engineering
judgment and [repository operations](../../domains/repository-operations-and-release.md)
for build, CI, public-repository safety, and merge rules.

## Interactive-card gate

Every workflow stage transition and request for operator authority requires
`ask_user_question` or an equivalent interactive question card in the originating
conversation. Present the current stage, completed evidence, proposed next stage,
and the concrete decision. Ask one decision per question.

Wait for the operator's explicit response before changing the stage or performing
the action it authorizes. A sent, unanswered, expired, or declined card does not
authorize anything. Silence, automatic card selection, reviewer agreement, and
chat agreement without a sent card cannot replace the card and response. Disable
automatic selection when the card tool supports it.

Record the decision, time, and authorized boundary in the task README using
public-safe descriptions. Keep private channel metadata out of repository and
GitHub content. Preserve existing authorization while its scope remains unchanged;
routine implementation choices and in-scope edits do not need another card.

An unsettled product or scope decision requires its own card. Record the operator's
words verbatim or narrower, label unconfirmed interpretations, and pause dependent
work until the answer arrives. Continue independent work already authorized. A
material requirement, solution, or scope change stops implementation and returns
through the card gate to the earliest affected stage.

## Stages and exit conditions

| Task state | Required result before requesting the next stage |
| --- | --- |
| `intake` | Discover candidates through task README indexes; obtain a card choice to reuse or create the task. [Task discovery](references/task-discovery.md). |
| `clarification` | Record the desired behavior, scope, constraints, acceptance criteria, and resolved blocking questions; request requirement confirmation. [Requirement clarification](references/requirement-clarification.md). |
| `solution` | Record one final technical solution, implementation boundary, and verification plan; request solution confirmation. [Technical solution](references/solution-consultation.md). |
| `awaiting-development-approval` | Send a development-authorization card tied to the final requirement and solution; obtain explicit approval before entering `implementation`. [Development approval](references/development-approval.md). |
| `implementation` | Complete the approved change, inspect the whole diff, and record required local checks and coverage limits before requesting `review`. [Implementation](references/implementation.md). |
| `review` | Obtain independent review of the complete change against the approved requirement and solution; adjudicate findings and obtain operator rulings before corrections. Resolve accepted findings before requesting `knowledge-closeout`. [Implementation review](references/implementation-review.md). |
| `knowledge-closeout` | Reconcile the task, update affected knowledge owners, and validate the task before requesting `done`; pass the full KB check before PR submission. [Knowledge closeout](references/knowledge-closeout.md). |
| `done` | Work and records are ready for submission. Prepare the PR to `next`, wait for required CI, and obtain merge authority through a card. [PR and merge](references/pr-gate.md). |
| `blocked` | Record the concrete blocker and the stage to resume; obtain a card decision before resuming. |

Before development approval, allow only read-only investigation and writes to the
confirmed task directory, required parent README indexes, and its public
solution-review Issue. Do not modify implementation artifacts or create prototypes
or diagnostic code. A requirement or solution confirmation does not open the
development gate.

The task README is the sole task-state authority. Follow
[task records](references/task-records.md) for artifact layout, initialization, and
states that may land on the trunk. `done` records submission readiness; GitHub and
git own CI and merge status.

After the merge into `next` is confirmed and all required work is complete, offer
Team dissolution through a separate card. Dissolve only after explicit approval
and the worktree safety check. [Team dissolution](references/team-dissolution.md).

For work spanning several implementation stages, use the same gates for each
approved slice and keep its scope and remaining work current.
[Stage checkpoints](references/large-refactor-mode.md).
