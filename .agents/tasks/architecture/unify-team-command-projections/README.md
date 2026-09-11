# Unify Team command projections

## Current state

- Goal: One Team vocabulary across create, list, and status: one `status`
  meaning, one set of field names, no third create shape
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/unify-team-command-projections/requirement.md)
- Draft solution:
  [technical-design/draft.md](/.agents/tasks/architecture/unify-team-command-projections/technical-design/draft.md).
- Final solution:
  [technical-design/final.md](/.agents/tasks/architecture/unify-team-command-projections/technical-design/final.md).
- Solution review Issue: Not created.
- Solution review: Three independent reviews completed and adjudicated. Codex,
  Seed, and Trae-Claude converged on the same source-selection, member-count,
  manual-bind, and dead-path corrections; the final solution incorporates them.
- Review record:
  [draft](/.agents/tasks/architecture/unify-team-command-projections/technical-design/draft.md),
  [Codex review](/.agents/tasks/architecture/unify-team-command-projections/technical-design/reviews/review-codex.md),
  [Seed review](/.agents/tasks/architecture/unify-team-command-projections/technical-design/reviews/review-seed.md), and
  [Trae-Claude review](/.agents/tasks/architecture/unify-team-command-projections/technical-design/reviews/review-trae-claude.md).
- Blockers: None.
- Next action: None.
- Related tasks: Keeps the compact `team.list` decision recorded in
  [Refine the model-facing surfaces of the TeamLeader](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md)
  (its final solution: "`list` and `history` stay compact") and builds on the
  create receipt added by
  [Refine Feishu COT and binding cards](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/README.md).

## Development approval

- Status: Granted on 2026-09-07 by explicit operator approval after playback of
  the final requirement, review adjudication, solution, and verification plan.
- Approved requirement:
  [requirement.md](/.agents/tasks/architecture/unify-team-command-projections/requirement.md).
- Approved solution:
  [technical-design/final.md](/.agents/tasks/architecture/unify-team-command-projections/technical-design/final.md).
- Approved implementation boundary: The canonical Team summary contract and
  create/list/status production paths; Feishu automatic-provisioning and manual
  binding consumers; removal of superseded Team projection types, conversions,
  and the uncalled exact-name creation path; directly affected tests, product
  and architecture knowledge, and Rush change files. The same follow-up PR may
  include the separately frozen presentation-only correction for the three
  Feishu Card 2.0 route notifications. Persisted state, Team history, routing
  behavior, lifecycle semantics, and unrelated receipt APIs remain unchanged.

## Delivery

- Pull request: [PR #390](https://github.com/excitedjs/dreamux/pull/390),
  refs issue #383. The operator's review on 2026-09-09 reversed two choices of
  the initial implementation — closed output schemas and the full summary as
  every list row — and the delivered implementation applies that reversal.
- Implementation: Complete.
- Verification: [verification.md](/.agents/tasks/architecture/unify-team-command-projections/verification.md).
- Knowledge closeout: Completed 2026-09-07 and redone 2026-09-09 after the
  operator's review (create/status share the summary, list stays compact,
  schemas open); product behavior, Dispatcher
  orchestration, service topology, package-local service guidance, and Channel
  projection/call-count facts now describe the canonical summary.
