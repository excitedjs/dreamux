# Unify Team command projections

## Current state

- Goal: Expose one canonical Team projection through create, list, and status
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
- Next action: Deliver the reviewed implementation through a pull request to
  `next`.
- Related tasks: Supersedes the separate list/status projection decision in
  [Refine the model-facing surfaces of the TeamLeader](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md)
  and builds on the create receipt added by
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

- Pull request / CI / merge: Pull request preparation is next; CI and merge are
  pending.
- Implementation: Complete in the approved follow-up workspace.
- Verification: [verification.md](/.agents/tasks/architecture/unify-team-command-projections/verification.md).
- Knowledge closeout: Completed 2026-09-07; product behavior, Dispatcher
  orchestration, service topology, package-local service guidance, and Channel
  projection/call-count facts now describe the canonical summary.
