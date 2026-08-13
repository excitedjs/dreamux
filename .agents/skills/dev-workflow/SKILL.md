---
name: dev-workflow
description: TeamLeader-only Dreamux repository development workflow. Use only when the current agent is the Dreamux TeamLeader responsible for driving a feature, refactor, or bug fix from task discovery through requirement and solution agreement, explicit development approval, single-writer implementation, independent review, knowledge closeout, a GitHub PR to `next`, merge, and optional Team dissolution. Developer, solution, and review TeamMates do not load this skill; the TeamLeader gives them scoped identities and task artifacts.
---

# Dreamux Development Workflow

This skill is for the Dreamux TeamLeader only. Do not delegate the skill itself to
a TeamMate; delegate a role identity, task inputs, and an explicit output boundary.

Treat `next` as the integration trunk. Drive every development task toward a
reviewed, CI-green GitHub PR merged into `next`, as owned by
[`/.agents/reference/release-process.md`](/.agents/reference/release-process.md).

Treat the operator's description as an initial requirement, not as proof about
the current implementation and not as permission to edit code. Verify code facts,
challenge hidden assumptions, and keep the confirmed task record current so work
can survive context compression or transfer to another TeamLeader.

## Hard development gate

Do not modify product code, tests, configuration, scripts, migrations, generated
files, or other implementation artifacts before the operator explicitly approves
development against the final recorded requirement and technical solution.

Before approval, allow only read-only investigation plus writes to the confirmed
task directory and its approved solution-review surface. For an ordinary task that
surface is a public GitHub Issue. Under a security embargo, repository task files may
contain only a non-disclosing neutral summary and restricted details stay on the
approved private surface. Do not create a code prototype or add temporary diagnostic
code. An initial request such as "fix X" or "implement Y" never grants development
approval.

## Workflow

1. **Resolve the task lineage.** Discover prior work only through the hierarchical
   README indexes under `.agents/tasks/dreamux/`. If the operator asks what a
   candidate did before choosing it, read only that candidate's final requirement
   and final technical solution to explain it. Confirm reuse before wider recovery.
   Ask before creating a new task. Apply the security-embargo check before any
   public task write. After the operator confirms creation, initialize the lean task
   record only when its title, goal, and index entry are safe to publish; otherwise
   defer it. Follow
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
   task and confirm the proposed path with the operator. Use the one-file fast path,
   a TeamLeader-authored solution with three independent reviewers, or a complex
   three-proposal consultation. Merge the result into one local final solution. For
   an ordinary task, except on the one-file fast path, also create or update one
   public GitHub Issue as the operator review surface. Under embargo keep restricted
   details only on the approved private review surface while the normal local records
   retain sanitized requirement, solution, approval, and workflow state. Follow
   [solution-consultation.md](references/solution-consultation.md).

4. **Obtain development approval.** Play back the final requirement, final
   technical solution, implementation boundary, and verification plan. Ask the
   operator explicitly whether to enter development. Record a valid, sanitized
   approval in the task README before permitting any implementation write or
   starting any implementation TeamMate. Follow
   [development-approval.md](references/development-approval.md).

5. **Implement with one writer and pass TeamLeader pre-review.** For the one-file
   fast path or a task whose entire implementation surface is `.agents/**`, have the
   TeamLeader implement directly as the sole repository writer. For every other
   path, directly start exactly one write-capable developer TeamMate using the
   [developer identity](references/developer-identity.md).
   Only on that TeamMate path, wait for Dreamux to push its completion without
   polling, use a one-hour one-shot recovery reminder, and send failures back to the
   same developer. For TeamLeader-authored paths, proceed directly to TeamLeader
   pre-review and self-correction. Inspect the whole diff, check requirement
   completeness, and run proportionate build, static, and test checks. The
   TeamLeader alone updates the task from any developer report. Route only a
   pre-review-ready workspace to independent implementation review. Follow
   [implementation.md](references/implementation.md).

6. **Run independent implementation review.** For the approved one-file fast path,
   start one separate read-only TeamMate for one review turn and skip the workflow.
   For every other path, run three independent perspectives over the current
   workspace using the [default reviewer identities](references/reviewer-identities.md),
   then verify each finding through category-weighted votes. Preserve missing
   coverage and have the TeamLeader adjudicate either result. Follow
   [implementation-review.md](references/implementation-review.md).

7. **Close task and repository knowledge.** After accepted review findings and
   local checks are clear, have the TeamLeader reconcile the task with the actual
   diff, record durable decisions, and align affected Dreamux knowledge owners with
   current code facts. Embargoed facts stay out of public task and knowledge files.
   Complete this knowledge closeout before preparing the PR head. Follow
   [knowledge-closeout.md](references/knowledge-closeout.md).

8. **Prepare and gate the GitHub PR.** Push a reviewed, knowledge-complete
   preliminary head and open or update one GitHub PR targeting `next`. Record that
   stable PR handoff in the task, push the resulting candidate head, then route that
   exact head through final review and CI. Clear accepted findings before presenting
   it as ready. Follow [pr-gate.md](references/pr-gate.md).

9. **Merge into `next`.** Merge only with operator authority under the repository's
   normal GitHub and squash-merge rules. Confirm the resulting commit through the
   linked PR and `next`. Do not create a post-gate or post-merge repository write
   solely to mirror delivery facts.

10. **Offer to dissolve the Team.** Only after every required stage is complete, the
    linked PR confirms the merge into `next`, and the worktree is clean, ask the
    operator whether to dissolve the current Team. Never dissolve automatically. On
    confirmation, apply the worktree safety checks and lifecycle rules in
    [team-dissolution.md](references/team-dissolution.md).

## TeamLeader ownership

Load and follow `team-workflow` before using TeamMate or Team tools. The TeamLeader
owns task identity, requirement accuracy, factual adjudication, the final solution,
development authorization, authoritative `.agents/**` and GitHub updates, commits,
pushes, PR actions, and the final merge outcome. Technical consultation may
delegate only each seat's disjoint proposal or solution-review task file. TeamMate
agreement and vote count never replace TeamLeader judgment or an operator decision.

If the requirement, approved solution, or implementation scope changes materially,
stop implementation, update the task state, and return to the earliest affected
workflow step.

## Public-repository safety

All task, Issue, commit, and PR content must satisfy Dreamux public-repository
safeguards. Never copy private channel identifiers, internal URLs, sibling-repository
paths or names, or other private context into the repository or GitHub.

Treat a privately reported vulnerability as embargoed until the operator explicitly
authorizes a sanitized public disclosure boundary. The same applies to any other
information the operator marks as embargoed. While embargoed, do not create or
update a public Issue or PR, and do not place restricted reproduction,
affected-scope, or remediation details in any public task, branch, commit, or other
`.agents/**` artifact.

Use a draft GitHub repository security advisory or another access-controlled private
review surface explicitly confirmed by the operator only for restricted evidence,
reproduction, affected-scope, and remediation details. The task README remains the
sole workflow-state authority; its requirement, final solution, approval, blockers,
and next action must be sanitized and must state that the private reference is
withheld. If a truthful non-disclosing task, requirement, solution, or approval
cannot be maintained, stop before development rather than creating a parallel
private workflow. Start a TeamMate only when it can access the private details safely
within the operator-approved boundary. If no safe private surface is available, stop
and mark the task blocked.

Confirmation of the private surface, development approval, lifting the embargo, and
authorization to publish or merge are separate operator decisions. Development
approval never lifts the embargo. Sanitized task and knowledge writes may continue
while it is active; resume public Issue, PR, and wider disclosure only after the
operator explicitly confirms a sanitized boundary. Never copy restricted details
wholesale.
