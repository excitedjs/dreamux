# Drop lifecycle-stop completion pushback

## Current state

- Goal: Retire pending completion delivery before TeamMate or Workflow lifecycle teardown so explicit stop, Team dissolve, host restart, and failed-start rollback do not push cleanup-induced results into an owner.
- State: `delivery`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/requirement.md)
- Frozen solution input: Requirement SHA-256
  `286ec6ccc55b25753a24ce0eee7696323d8b281166da0b0990ef5241f1f7d264`;
  baseline `origin/next` is `fffc3bd337f8ce28070fb8658fc30893e71730bb`.
- Final solution: [Technical solution](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/final.md),
  SHA-256
  `31935350993ec7391b56cb8b07cf18bb94e0387b70a5cce8e6116537f102dc68`.
- Solution review Issue: [#388](https://github.com/excitedjs/dreamux/issues/388)
- Solution workflow: TeamLeader-authored direct design with exactly three
  independent reviewers, selected by the operator on 2026-09-07.
- Design trail: [draft](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/draft.md),
  [lifecycle review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/lifecycle-review.md),
  [boundary review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/boundary-review.md),
  [verification review](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/verification-review.md),
  and [Fable architecture consultation](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/technical-design/reviews/fable-architecture-consultation.md).
- Implementation review: [Adjudication](implementation-review.md)
- Blockers: None. Final independent implementation review and Fable architecture
  review both returned `ACCEPTABLE` after the aggregate-construction fixes.
- Next action: Commit and push the approved change to draft PR #389, then run
  the feature-branch Alpha release workflow requested by the operator.
- Related tasks:
  - `builds-on`: [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — retains the general failed/stopped settlement path introduced before that refactor.
  - Historical behavior origin: [PR #149](https://github.com/excitedjs/dreamux/pull/149).
  - Lifecycle consolidation that made close use the common stop-and-deliver path: [PR #338](https://github.com/excitedjs/dreamux/pull/338).

## Development approval

- Status: Granted at `2026-09-07T22:10:55+08:00` by the operator's explicit
  approval response to the development question for Issue #388 and the current
  final solution.
- Approved artifacts: Requirement SHA-256
  `83f505e031f5a00236b42c808eb3fc954fbe3e0f290e9739ffa10a182543d04e`;
  final solution SHA-256
  `0fd4de0242e351459daaa208e5f1deabc6adba9956ee46a38e2d8accf5d10849`.
- Amendment approval: Granted at `2026-09-08T00:51:04+08:00` when the operator
  replied “继续” to the TeamLeader's explicit proposal to suppress pending
  Workflow terminal delivery for public `workflow_stop` and scoped `stopAll()`,
  preserve natural completed/failed delivery, and never retract started
  delivery. The same instruction was repeated after the review retry.
- Implementation-review correction approval: granted on 2026-09-08 through
  the operator's five explicit card rulings: aggregate fence semantics; discard
  pending TeamMate and Workflow completion during failed-start rollback; add
  only the main-path aggregate regression; synchronize requirement and product
  records; and refactor Workflow duplicate delivery bookkeeping in this change.
- Approved implementation boundary: Core TeamMate Turn delivery, Workflow Run
  terminal delivery, and deliberate lifecycle teardown; the behavior tests and
  knowledge updates enumerated by the final solution; and one patch Rush change
  file for `@excitedjs/dreamux`. Agent Runtime and Channel providers, public
  Command/MCP contracts, completion rendering/routing, and persisted config/state
  remain outside the boundary.
- Final architecture consultation: after implementation and all gates, the
  operator instructed, “你拉 fable 的时候，先跟他讲清楚现状，问题，然后向他咨询当前的解法是否是架构最优”. The Fable brief must therefore provide the
  pre- and post-PR #350 behavior, both TeamMate and Workflow delivery paths, and
  the lifecycle races before asking whether the chosen source-obligation design
  is architecturally optimal under the approved constraints. The consultation
  must specifically determine whether the delayed TeamMate admission and
  Workflow intent-versus-finalization interleavings are unavoidable asynchronous
  facts or symptoms of an unreasonable ownership/atomicity boundary, and require
  any alternative to name the mechanisms it removes as well as the state it adds.

## Delivery

- Pull request / CI / merge: [#389](https://github.com/excitedjs/dreamux/pull/389)
  opened as a Draft against `next` on 2026-09-07; the approved 2026-09-08
  aggregate-fence correction and Workflow obligation cleanup are implemented.
  Rush build, lint, test, `typecheck:tests`, the knowledge-base check, and
  `git diff --check` pass, and both final reviews are accepted. Commit, push,
  CI, Alpha delivery, and merge remain pending.
- Knowledge closeout: Current behavior and the operator-ratified correction are
  recorded; final review results and delivery metadata remain pending.
- Cleanup trail: `TeamService`, `TeammateCollection`, and `WorkflowRun` remain at
  or immediately below the 700-line gate. A later micro-refactor should extract
  leader materialization from `TeamService` as a real owner instead of buying
  future feature lines through compressed formatting or deleted rationale.
