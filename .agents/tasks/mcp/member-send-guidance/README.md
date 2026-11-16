# Member send guidance

## Current state

- Goal: An ordinary member reports to its owner when the owner needs the
  information before the member's turn ends — not to narrate progress, and not
  to repeat what its own turn result already delivers.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/mcp/member-send-guidance/requirement.md)
- Final solution: [Two texts](/.agents/tasks/mcp/member-send-guidance/technical-design/final.md)
- Verification: [Checks and review](/.agents/tasks/mcp/member-send-guidance/verification.md)
- Blockers: None.
- Related tasks: [Enable proactive ordinary-member messaging](/.agents/tasks/mcp/enable-team-member-messaging/README.md),
  [Refine the model-facing surfaces of the TeamLeader](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md)

## Development approval

- On 2026-11-16 the operator approved both items in the bound conversation,
  after reviewing the measured transcript evidence recorded in
  [requirement.md](/.agents/tasks/mcp/member-send-guidance/requirement.md):
  「可以，我感觉1和2 可以做一下。」
- Authorized boundary: the ordinary-member communication statement in
  `service/agent/system-prompt.ts` and the `send` tool description in
  `service/agent/member-mcp.ts`, plus the tests and knowledge that describe
  them. No delivery, admission, receipt, or runtime-adapter change.

## Delivery

- Pull request: see the repository's PR for this branch.
- Knowledge closeout: [Model-facing writing](/.agents/domains/model-facing-writing.md),
  [Product catalog](/.agents/product/README.md).
