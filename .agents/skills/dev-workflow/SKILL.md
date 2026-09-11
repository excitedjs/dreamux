---
name: dev-workflow
description: TeamLeader-only Dreamux repository development workflow. Use only when the current agent is the Dreamux TeamLeader responsible for driving a feature, refactor, or bug fix from task discovery through requirement and solution agreement, explicit development approval, single-writer implementation, independent review, knowledge closeout, a GitHub PR to `next`, merge, and optional Team dissolution. Developer, solution, and review TeamMates do not load this skill; the TeamLeader gives them scoped identities and task artifacts.
---

# Dreamux Development Workflow

This skill is for the Dreamux TeamLeader only. Do not delegate the skill itself to
a TeamMate; delegate a role identity, task inputs, and an explicit output boundary.

Treat `next` as the integration trunk. Drive every development task toward a
reviewed, CI-green GitHub PR merged into `next`, as owned by
[`/.agents/domains/repository-operations-and-release.md`](/.agents/domains/repository-operations-and-release.md).

Treat the operator's description as an initial requirement, not as proof about
the current implementation and not as permission to edit code. Verify code facts,
challenge hidden assumptions, and keep the confirmed task record current so work
can survive context compression or transfer to another TeamLeader.

## Mandatory clarification of unsettled requirements

At every stage, if code or knowledge-base facts expose ambiguity, an inaccurate
description, or a possible scope wider than the operator has stated, use
`ask_human_question` to confirm and clarify **one issue at a time**. This duty also
applies to behavior the operator has not mentioned. Evidence reveals a question;
it does not authorize the TeamLeader to choose or extend the requirement.

Keep unresolved interpretations out of accepted requirements and out of the basis
for design, implementation, and review. Pause dependent work until the answer
arrives; continue independent, already authorized work. Do not reopen a decision
the operator has already settled or turn routine implementation choices within
that scope into new approval requests. Follow the concrete procedure in
[requirement-clarification.md](references/requirement-clarification.md).

The TeamLeader must remain alert to this failure throughout the task: imprecise
requirements compounded by the TeamLeader's overinterpretation propagate into
developer briefs, implementation, and review. More reviewers and passing tests
cannot repair an unconfirmed premise.

## Hard development gate

Do not modify product code, tests, configuration, scripts, migrations, generated
files, or other implementation artifacts before the operator explicitly approves
development against the final recorded requirement and technical solution.
Obtain that approval through `ask_user_question` or an equivalent interactive
question card: the development-authorization card must have been sent and the
operator must explicitly approve in response. Without that card and answer,
development is not authorized; ordinary chat agreement or a reviewer verdict
cannot substitute for them.

Before approval, allow only read-only investigation plus writes to the confirmed
task directory, the parent task README indexes required to discover it, and its
public GitHub solution-review Issue. Do not create a code
prototype or add temporary diagnostic code. An initial request such as "fix X" or
"implement Y" never grants development approval.

## Workflow

1. **Resolve the task lineage.** Discover prior work only through the hierarchical
   README indexes under `.agents/tasks/`. If the operator asks what a
   candidate did before choosing it, read only that candidate's final requirement
   and final technical solution to explain it. Confirm reuse before wider recovery.
   Ask before creating a new task. After the operator confirms creation, have the
   TeamLeader initialize the lean task record with the bundled script. Follow
   [task-discovery.md](references/task-discovery.md).

2. **Clarify and record the requirement.** After the task is confirmed, inspect
   current code and relevant historical design, challenge the operator with
   concrete evidence, and continuously write every accepted decision into the
   task. Separate desired behavior from implementation ideas. Do not discuss the
   technical solution as a substitute for requirement clarity. Follow
   [requirement-clarification.md](references/requirement-clarification.md).

3. **Design and review the technical solution.** Use the finalized requirement
   files in the task as the sole input. First apply an explicit remembered operator
   preference about solution workflow; otherwise have the TeamLeader classify the
   task and confirm the proposed path with the operator. Use the minimal-change fast path,
   a TeamLeader-authored solution with three independent reviewers, or a complex
   three-proposal consultation. Merge the result into one local final solution and,
   except on the minimal-change fast path, create or update one public GitHub Issue as the
   operator review surface. Follow
   [solution-consultation.md](references/solution-consultation.md).

4. **Obtain development approval.** Play back the final requirement, final
   technical solution, implementation boundary, and verification plan. Ask the
   operator through a development-authorization interactive card whether to enter
   development. Record the sent-card evidence and explicit approval in
   the task README before permitting any implementation write or starting any
   implementation TeamMate. Follow
   [development-approval.md](references/development-approval.md).

5. **Implement with one writer and pass TeamLeader pre-review.** Except for the
   TeamLeader-only minimal-change fast path, directly start exactly one write-capable
   developer TeamMate using the [developer identity](references/developer-identity.md).
   Wait for Dreamux to push its completion without polling, with a one-hour one-shot
   recovery reminder. After implementation completes, have the TeamLeader inspect
   the whole diff, check requirement completeness, and run proportionate build,
   static, and test checks. Send failures back to the same developer TeamMate. The
   TeamLeader alone updates the task from its report. Route only a pre-review-ready
   workspace to independent implementation review. Follow
   [implementation.md](references/implementation.md).

6. **Run independent implementation review.** For the approved minimal-change fast path,
   start one separate read-only TeamMate for one review turn and skip the workflow.
   For every other path, run the shared `dynamic-workflow` skill's code-review method as one
   `workflow_run`, tuned by exactly two Dreamux deltas: the approved requirement and
   technical solution travel with the review scope, and one added finder checks the
   implementation against them. Have the TeamLeader adjudicate either result. Follow
   [implementation-review.md](references/implementation-review.md).

7. **Close task and repository knowledge.** After accepted review findings and
   local checks are clear, have the TeamLeader reconcile the task with the actual
   diff, record durable decisions, and align affected Dreamux knowledge owners with
   current code facts. Complete this knowledge closeout, set the task to `done`,
   then prepare the PR. Follow
   [knowledge-closeout.md](references/knowledge-closeout.md).

8. **Prepare the GitHub PR and wait for CI.** Commit and push the reviewed,
   knowledge-complete workspace with its completed task record, then open or update
   one GitHub PR targeting `next`. Wait for the repository's normal CI; do not run a
   second implementation review merely because the commit was pushed. Follow
   [pr-gate.md](references/pr-gate.md).

9. **Merge into `next`.** Merge only with operator authority under the repository's
   normal GitHub and squash-merge rules. Confirm the resulting commit on `next`.

10. **Offer to dissolve the Team.** Only after every required stage is complete and
    the merge into `next` is confirmed, ask the operator whether to dissolve the
    current Team. Never dissolve automatically. On confirmation, apply the worktree
    safety checks and lifecycle rules in
    [team-dissolution.md](references/team-dissolution.md).

## Taste and large refactors

Load [`engineering-whitepaper`](/.agents/skills/engineering-whitepaper/SKILL.md)
before designing, adjudicating, or reviewing any non-trivial change, and point
every developer, solution, and reviewer seat at it through its identity block.
It records the operator's standing taste — anti-defensive engineering, minimal
mechanism, recovery semantics, and collaboration rhythm — so those judgments do
not need to be re-litigated per task.

When a task is a multi-stage architecture refactor, additionally follow
[large-refactor-mode.md](references/large-refactor-mode.md): authority order at
kickoff, greenfield comparison, the operator rulings ledger, stage-boundary
knowledge re-supply, structural pre-review accounts, and reporting cadence.

## TeamLeader ownership

Load `teamwork` when composing a hand-down prompt for a TeamMate. The TeamLeader
owns task identity, requirement accuracy, factual adjudication, the final solution,
development authorization, authoritative `.agents/**` and GitHub updates, commits,
pushes, PR actions, and the final merge outcome. Technical consultation may
delegate only each seat's disjoint proposal or solution-review task file. TeamMate
agreement and vote count never replace TeamLeader judgment or an operator decision.

When drafting a developer handoff or follow-up, read
[TeamMate task briefs: good and bad cases](references/teammate-briefs.md) for
examples of concise task prompts, where to keep context, and how an over-prescribed
handoff can displace the actual requirement.

Every technical-solution consultant and implementation-review TeamMate carries the
common challenger identity from
[solution-identities.md](references/solution-identities.md) or
[reviewer-identities.md](references/reviewer-identities.md). Those blocks own the
posture: pass them, do not paraphrase them into a work prompt.

If the requirement, approved solution, or implementation scope changes materially,
stop implementation, update the task state, and return to the earliest affected
workflow step.

## Public-repository safety

All task, Issue, commit, and PR content must satisfy Dreamux public-repository
safeguards. Never copy private channel identifiers, internal URLs, sibling-repository
paths or names, or other private context into the repository or GitHub.
