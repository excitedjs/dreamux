# Drop lifecycle-stop completion pushback

## Current state

- Goal: Retire pending completion delivery before deliberate TeamMate lifecycle teardown so close, Team dissolve, and host restart do not push cleanup-induced results into an owner that is done or stopping.
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md)
- Frozen solution input: Requirement SHA-256
  `d2b40d9b10451621d9c04463df29b8f0ad701f3163bb8f9276f1e7a2221e3961`;
  baseline `origin/next` is `fffc3bd337f8ce28070fb8658fc30893e71730bb`.
- Final solution: [Technical solution](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/final.md),
  SHA-256
  `4f3855ba1ec7546396b11f5443cfeef714c66b97de6adc41d6dd97e4b495d2f1`.
- Solution review Issue: [#388](https://github.com/excitedjs/dreamux/issues/388)
- Solution workflow: TeamLeader-authored direct design with exactly three
  independent reviewers, selected by the operator on 2026-09-07.
- Design trail: [draft](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/draft.md),
  [lifecycle review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/lifecycle-review.md),
  [boundary review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/boundary-review.md),
  and [verification review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/verification-review.md).
- Blockers: None.
- Next action: Operator review of the Draft PR, remote CI, and delivery
  verification.
- Related tasks:
  - `builds-on`: [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — retains the general failed/stopped settlement path introduced before that refactor.
  - Historical behavior origin: [PR #149](https://github.com/excitedjs/dreamux/pull/149).
  - Lifecycle consolidation that made close use the common stop-and-deliver path: [PR #338](https://github.com/excitedjs/dreamux/pull/338).

## Development approval

- Status: Granted at `2026-09-07T22:10:55+08:00` by the operator's explicit
  approval response to the development question for Issue #388 and the current
  final solution.
- Approved artifacts: Requirement SHA-256
  `d2b40d9b10451621d9c04463df29b8f0ad701f3163bb8f9276f1e7a2221e3961`;
  final solution SHA-256
  `4f3855ba1ec7546396b11f5443cfeef714c66b97de6adc41d6dd97e4b495d2f1`.
- Approved implementation boundary: Core TeamMate Turn delivery and deliberate
  lifecycle teardown, the behavior tests and knowledge updates enumerated by
  the final solution, and one patch Rush change file for `@excitedjs/dreamux`.
  Agent Runtime and Channel providers, public Command/MCP contracts, completion
  rendering/routing, and persisted config/state remain outside the boundary.

## Delivery

- Pull request / CI / merge: [#389](https://github.com/excitedjs/dreamux/pull/389)
  opened as a Draft against `next` on 2026-09-07; CI and merge are pending.
- Knowledge closeout: Complete locally; product, architecture, package-local,
  maintenance, task-index, and release records are aligned. Remote CI remains
  pending.
