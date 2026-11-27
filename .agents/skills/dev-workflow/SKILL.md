---
name: dev-workflow
description: Dreamux repository development process for the TeamLeader. Defines task stages, operator interactive-card gates, development and review rules, durable task records, knowledge closeout, PR delivery to next, merge authorization, and optional Team dissolution.
---

# Dreamux Development Workflow

Keep the confirmed requirement, solution, authorization, and evidence in the task
record. Verify implementation facts against current source. Use
[engineering-whitepaper](../engineering-whitepaper/SKILL.md) for engineering
judgment and [repository operations](../../domains/repository-operations-and-release.md)
for build, CI, public-repository safety, and merge rules.

Use Dreamux's strengths in development tasks and follow the `teamwork` skill to
collaborate appropriately with heterogeneous TeamMates.

## Interactive-card gate

Interactive cards (`ask_user_question` or an equivalent card in the originating
conversation) guard **real operator decisions and authority boundaries** — not
mechanical handoffs between in-flight stages:

1. **Ambiguous task selection** in `intake` (when a plausible candidate exists
   to reuse; clearly independent new tasks do not need a separate card).
2. **Unsettled product, behavior, or scope decisions** in `clarification` or
   `solution` (ask one decision per card; record the operator's words verbatim
   or narrower).
3. **Final solution confirmation and development authorization** at the end of
   `solution` (one card approves the final requirement, solution, and
   implementation boundary, and authorizes entering `implementation`).
4. **Review finding adjudication** in `review` when independent review raises
   findings that need an operator ruling before applying corrections.
5. **Material re-approval** whenever implementation or closeout reveals a
   material requirement, solution, or scope change.
6. **Merge authorization** after the PR targets `next` and required CI passes.
7. **Team dissolution** after the merge into `next` is confirmed.

Wait for the operator's explicit response before performing any action a gate
authorizes. A sent, unanswered, expired, or declined card does not authorize
anything. Silence, automatic card selection, reviewer agreement, and ordinary
chat agreement without a sent card cannot replace the card and response. Disable
automatic selection when the card tool supports it.

Record each decision, time, and authorized boundary in the task README using
public-safe descriptions. Keep private channel metadata out of repository and
GitHub content. Preserve existing authorization while its scope remains
unchanged; routine implementation choices, in-scope edits, and mechanical
transitions (`implementation` -> `review` -> `knowledge-closeout` -> PR) do not
require extra cards.

## Stages and exit conditions

| Task state | Required result before advancing |
| --- | --- |
| `intake` | Discover candidates through task README indexes; ask on a card if a candidate matches or ownership is ambiguous, otherwise initialize the new task and enter `clarification`. [Task discovery](references/task-discovery.md). |
| `clarification` | Record desired behavior, scope, constraints, acceptance criteria, and resolve blocking questions via cards; once clear, enter `solution`. [Requirement clarification](references/requirement-clarification.md). |
| `solution` | Record one final technical solution, implementation boundary, and verification plan; play back the final requirement and solution and obtain explicit approval on an interactive card before entering `implementation`. [Solution and development approval](references/solution-consultation.md). |
| `implementation` | Complete the approved change, inspect the whole diff, and record required local checks and coverage limits in `verification.md`, then proceed to `review`. [Implementation](references/implementation.md). |
| `review` | Obtain independent review of the complete change against the approved requirement and solution; adjudicate any findings and obtain operator rulings before applying corrections. Once no accepted blocking finding remains unresolved, proceed to `knowledge-closeout`. [Implementation review](references/implementation-review.md). |
| `knowledge-closeout` | Reconcile the task, update affected knowledge owners, pass `node .agents/scripts/check.mjs` and `git diff --check`, and set `done`. [Knowledge closeout](references/knowledge-closeout.md). |
| `done` | Work and records are ready for submission. Open or update the PR to `next`, wait for required CI, and obtain merge authority through a card. [PR and merge](references/pr-gate.md). |
| `blocked` | Record the concrete blocker and the stage to resume; obtain a card decision before resuming. |

Before the `solution` card explicitly authorizes `implementation`, allow only
read-only investigation and writes to the task directory, required parent README
indexes, and its public solution-review Issue. Do not modify implementation
artifacts or create prototypes or diagnostic code.

The task README is the sole task-state authority. Follow
[task records](references/task-records.md) for artifact layout, initialization,
and states that may land on the trunk. `done` records submission readiness;
GitHub and git own CI and merge status.

After the merge into `next` is confirmed and all required work is complete,
offer Team dissolution through a separate card. Dissolve only after explicit
approval and the worktree safety check. [Team dissolution](references/team-dissolution.md).

For work spanning several implementation stages, use the same gates for each
approved slice and keep its scope and remaining work current.
[Stage checkpoints](references/large-refactor-mode.md).
