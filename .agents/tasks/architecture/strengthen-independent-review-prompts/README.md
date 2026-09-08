# Strengthen independent review prompts

## Current state

- Goal: Ensure Dreamux solution and review TeamMates independently challenge framing, ownership, and simpler alternatives instead of inheriting the TeamLeader's proposed answer
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/architecture/strengthen-independent-review-prompts/requirement.md)
- Final solution: [Minimal identity and prompt correction](/.agents/tasks/architecture/strengthen-independent-review-prompts/technical-design/final.md)
- Solution review Issue: N/A — operator selected the minimal-change path.
- Blockers: None.
- Next action: Wait for the requested pull request's normal CI and operator
  re-review.
- Related task: [Completion-delivery lifecycle fix](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/README.md).
- Related evidence: GitHub PR #389 and its replacement PR #391 exposed the
  shared-premise review failure.

## Development approval

- Status: Granted by the operator on 2026-09-08 after narrowing the solution to
  the minimal change: “你先简单做”.
- Approved implementation boundary: `.agents/skills/dev-workflow/**` plus this
  task record. No domain or product knowledge change is authorized.

## Delivery

- Pull request: [#392](https://github.com/excitedjs/dreamux/pull/392), targeting
  `next`.
- CI / merge: Review comments addressed; CI and operator re-review are pending;
  merge remains operator-owned.
- Verification: [Completed verification](/.agents/tasks/architecture/strengthen-independent-review-prompts/verification.md).
- Knowledge closeout: Complete; no product, domain, or release owner changed.
