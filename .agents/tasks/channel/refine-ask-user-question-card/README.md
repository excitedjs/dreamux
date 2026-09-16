# Refine the ask_user_question card

## Current state

- Goal: Keep a question card answerable for 24 hours, and let one card carry the explanation that precedes its questions
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/channel/refine-ask-user-question-card/requirement.md)
- Final solution: [Final solution](/.agents/tasks/channel/refine-ask-user-question-card/technical-design/final.md)
- Solution review Issue: [#435](https://github.com/excitedjs/dreamux/issues/435)
- Blockers: None.
- Next action: External implementation review of the pushed branch, then adjudicate each finding.
- Verification: [verification.md](/.agents/tasks/channel/refine-ask-user-question-card/verification.md)
- Related tasks: [Keep question-card replies in their topic](/.agents/tasks/channel/fix-question-card-topic-routing/README.md) owns where a settlement is routed; this task changes how long a round stays open and what its card shows. Follow-up: [#434](https://github.com/excitedjs/dreamux/issues/434) delivers settlements to the asker instead of through conversation routing.

## Solution path

The operator chose, on a question card on 2026-09-16, the TeamLeader-authored
solution reviewed externally instead of by three TeamMates — "我写方案，Devbox 评审
(Recommended)". Input: `requirement.md` as converged that day, after asker
ownership moved to #434.

The external review on #435 found no blocking issue and four additions, all
accepted; the adjudication is in the final solution. Development-authorization
cards so far: the first was answered with a question, whose answer moved the
expiry margin back from five minutes to one; the second expired unanswered; the
third was answered by setting the lifetime to 24 hours, which removed the margin.
The fourth was approved.

## Development approval

- Status: Granted 2026-09-16.
- Card: a development-authorization question card sent 2026-09-16 in the task's
  Feishu topic, asking whether the operator approves the current requirement and
  final solution (Issue #435: a 24-hour lifetime, the optional `text`
  explanation parameter, a restart dropping open rounds without notifying the
  model; changes limited to `@excitedjs/feishu-channel`, its documentation, and a
  change file) and wants the team to enter development.
- Approving response, 2026-09-16, the same day: "批准，进入开发 (Recommended)".
- Approved requirement: [requirement.md](/.agents/tasks/channel/refine-ask-user-question-card/requirement.md)
- Approved solution: [final.md](/.agents/tasks/channel/refine-ask-user-question-card/technical-design/final.md)
- Approved implementation boundary: `packages/channel/feishu-channel/` source
  and tests as the final solution describes; `.agents/domains/channel.md` and
  `.agents/product/README.md` at knowledge closeout; one Rush change file for
  `@excitedjs/feishu-channel`. Core, `dreamux-types`, and `feishu-transport` do
  not change.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
