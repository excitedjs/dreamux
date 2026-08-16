# Unify Workflow agents with TeamMate lifecycle ownership

## Current state

- Goal: Define and implement owner-correct lifecycle boundaries so Workflow-created agents remain ordinary TeamMates in the shared collection and close through the TeamMate-owned lifecycle rather than Workflow-specific teardown logic
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/workflow/unified-teammate-lifecycle/requirement.md)
- Solution input revision: `requirement.md` SHA-256 `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`
- Consultation proposals:
  - [Entity lifecycle proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-entity.md)
  - [Event and dependency proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-events.md)
  - [Membership proposal](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/proposals/arch-membership.md)
- Focused simplification reviews:
  - [Entity ownership review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-entity.md)
  - [Membership and compatibility review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-membership.md)
  - [Event and race review](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/reviews/lock-native-id-events.md)
- Final solution: [Entity-owned lock and in-process Turn objects](/.agents/tasks/workflow/unified-teammate-lifecycle/technical-design/final.md), SHA-256 `ab3e27fbc6e6c46f4ae12ab60cc616b22b7a746bd9a62eb1f653024c9fb97e6d`
- Solution review Issue: [#337](https://github.com/excitedjs/dreamux/issues/337)
- Verification: [Current verification evidence](/.agents/tasks/workflow/unified-teammate-lifecycle/verification.md)
- Blockers: None for implementation or knowledge closeout. Two unchanged
  real-model Codex gates remain dependent on external model-service health and
  must be rerun by CI or another healthy authenticated environment.
- Next action: Prepare the pull request to `next` and wait for repository CI.
- Related tasks: Builds on public issue [#328](https://github.com/excitedjs/dreamux/issues/328). PRs [#329](https://github.com/excitedjs/dreamux/pull/329) and [#330](https://github.com/excitedjs/dreamux/pull/330) are competing historical inputs, not an accepted solution.

## Development approval

- Status: Granted.
- Source: Operator approval received in the active conversation at `2026-08-15T22:38:51+08:00`.
- Approved requirement: `requirement.md` SHA-256 `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`.
- Approved solution: `technical-design/final.md` SHA-256 `ab3e27fbc6e6c46f4ae12ab60cc616b22b7a746bd9a62eb1f653024c9fb97e6d`.
- Approved implementation boundary:
  - Replace Collection-owned Workflow membership and lifecycle verbs with entity-owned `TeammateService.lock()` and restricted handles.
  - Replace Dreamux service-layer Turn identifiers and reverse-lookup maps with canonical in-process `RuntimeTurn` / `Turn` objects and captured completion-delivery closures.
  - Apply the approved close-first Workflow, Team dissolve, and Server shutdown ordering.
  - Implement strict v2 single-row terminal Turn persistence, remove Turn IDs and unused Channel Turn events from public/persisted contracts, and add required breaking-change, maintenance, and architecture documentation.
  - Strengthen built-in runtime and supervised-child termination only as required by the common TeamMate close contract.
  - Preserve the final solution's explicit non-goals: no attach-existing API, Workflow replay, provider replay/fingerprint, cross-daemon durable resource lease, or generalized JSONL repair engine.

## Delivery

- Pull request: [#338](https://github.com/excitedjs/dreamux/pull/338),
  targeting `next`.
- CI: Passed on the reviewed implementation and delivery-record head:
  Rush change declaration, author metadata, Linux/macOS shellcheck, KB check,
  full-history gitleaks, and Linux/macOS Rush build/typecheck/lint/test.
- Merge: Not authorized or attempted.
- Independent implementation review: Complete; all 15 findings were accepted,
  repaired as 12 root-cause groups, and revalidated.
- Knowledge closeout: Complete. Current owners and the
  accepted decision are linked from
  [verification.md](/.agents/tasks/workflow/unified-teammate-lifecycle/verification.md#knowledge-closeout).
