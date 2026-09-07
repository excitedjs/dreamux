# Refine Feishu COT and binding cards

## Current state

- Goal: Bound plain-text COT tool results by line count, restore Team runtime context on binding cards, and complete superseded COT cards successfully
- State: `implementation`
- Requirement: [Current requirement](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/requirement.md)
- Final solution:
  [technical-design/final.md](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/final.md).
- Solution review Issue:
  [#383 Solution review: refine Feishu COT and route notification cards](https://github.com/excitedjs/dreamux/issues/383).
- Solution input revision: Final requirement after the operator selected paired
  UI set 2, English-only fixed copy, and the same set-2 detail treatment for
  the route-bound runtime-cwd section.
- Solution review: Three independent reviews completed. The final solution
  accepts the terminating-newline finding and the pre-final `TEAM_CLOSED`
  notification finding; no architecture disagreement remains.
- Review record:
  [draft](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/draft.md),
  [Codex review](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/reviews/review-codex.md),
  [Codex Ultra review](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/reviews/review-codex-ultra.md), and
  [Codex Medium review](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/reviews/review-codex-medium.md).
- Verification:
  [verification.md](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/verification.md).
- Blockers: None.
- Next action: Open a Draft PR, then complete the full repository gates and
  independent implementation review on the PR.
- Related tasks: Builds on
  [Feishu conversation-of-thought cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md).

## Development approval

- Status: Granted on 2026-09-07 by explicit operator approval after playback of
  the final requirement, solution, implementation boundary, and verification
  plan.
- Approved requirement:
  [requirement.md](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/requirement.md).
- Approved solution:
  [technical-design/final.md](/.agents/tasks/channel/refine-feishu-cot-and-binding-cards/technical-design/final.md).
- Approved implementation boundary: Feishu COT plain-text result truncation,
  superseded-anchor completion, canonical route-Team facts, the selected
  route-bound/unbind/dissolution Card 2.0 presentations, truthful pre-final
  route-ended notification selection, directly affected tests and knowledge,
  and required Rush change files. The operator subsequently required extending
  `team.create` with runtime ID and cwd so automatic provisioning does not issue
  a redundant `team.status`; no provider contract, persisted routing/config/state
  schema, Collaboration Space card, or existing route-removal/Dispatcher-
  fallback behavior changes.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Pending.
