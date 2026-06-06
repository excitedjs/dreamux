---
name: team-dev-workflow
description: Coordinate multi-teammate software development workflows from a Dreamux dispatcher, covering adversarial MR/PR review, design negotiation, merge readiness checks, cleanup, and unblocking a teammate. Use for coordination cycles, not ordinary single-repo edits.
---

# Team Development Workflow

Use this skill when the dispatcher is coordinating people or teammates around a
software change. It is methodology layered on top of the `dispatcher` skill:
`dispatcher` owns `tm` mechanics, while this skill owns review, design, merge,
and unblock workflow.

## Confirm Scope

Use this skill when:

- An MR/PR needs independent adversarial review before merge.
- A design direction is unsettled and two independent proposals should be
  compared.
- A reviewed MR/PR is ready to merge and the teammate/worktree/branch need
  cleanup.
- A teammate is blocked by git state, missing context, wrong base, or missed
  review comments.

Do not use this skill for a normal implementation request such as "fix this
bug" or "add this endpoint". Delegate that as one bounded repository task with
the `dispatcher` skill.

## Coordinator Posture

- Verify facts from the target repo and platform before deciding. Treat the
  user's framing adversarially: route embedded claims (a "regression", a review
  comment) into the brief as things to verify, not as settled premises.
- Do not edit target repo code from the coordinator context, and do not
  investigate it yourself. Hand the teammate the symptom and evidence, not your
  diagnosis. Delegate repo work to a teammate in that repo.
- Keep prompts short: intent, coordinates, hard constraints, and requested
  artifact. The `dispatcher` skill's `references/dispatch-task.md` has the full
  include / keep-out prompt checklist; reuse it for every brief here.
- When the target repo is public, explicitly forbid internal domains, tokens,
  private identifiers, and machine-local paths in commits, MR/PRs, and comments.
- Prefer one accountable teammate per branch or review thread; reuse it for
  follow-up rather than spawning duplicates.

## Scenario Routing

Read the matching reference before acting:

| Intent | Reference |
|---|---|
| Review an MR/PR or issue proposal adversarially | `references/review-cycle.md` |
| Compare two design directions before implementation | `references/design-negotiation.md` |
| Merge a reviewed change and clean up state | `references/merge-and-cleanup.md` |
| Dispatch or unblock a teammate | `references/dispatch-and-unblock.md` |

## Cross-Cutting Rules

- Reviewers must be independent from authors. Fresh context matters more than
  a specific vendor or model family.
- The author does not review or merge its own work.
- CI and merge mode are target-repo policy. Read the repo/platform rules before
  acting.
- Same-account automation may be unable to submit a formal approval or change
  request. In that case, use a top-level MR/PR comment with a clear verdict.
- A clean review means no blocking findings on the current head, with required
  checks green.
