# Trigger-aware delivery

## Current state

- Goal: A completion report must not cancel the response its recipient is
  writing. Only a person's message may interrupt work in progress.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/completion-routing/trigger-aware-delivery/requirement.md)
- Final solution: [Trigger-aware delivery](/.agents/tasks/completion-routing/trigger-aware-delivery/technical-design/final.md)
- Verification: [Checks and review](/.agents/tasks/completion-routing/trigger-aware-delivery/verification.md)
- Blockers: None.
- Related tasks: [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md), [Enable proactive ordinary-member messaging](/.agents/tasks/mcp/enable-team-member-messaging/README.md)

## Development approval

- On 2026-11-11 the operator authorized fully autonomous delivery in the bound
  conversation: implement, open a PR, obtain an independent review, publish an
  alpha build, and upgrade the running dispatcher to it. The operator fixed the
  delivery rule in the same exchange: only `user` may steer a turn in progress;
  every other trigger appends to a busy thread and starts a turn on an idle one.
- Authorized boundary: the neutral submission contract, the Codex and Claude
  Code provider adapters, Core's source-to-trigger mapping, the admission
  receipts that read it, and the owning knowledge.

## Delivery

- Pull request: see the repository's PR for this branch.
- Knowledge closeout: [Provider runtime](/.agents/domains/provider-runtime.md),
  [Dispatcher orchestration](/.agents/domains/dispatcher-orchestration.md),
  [Product catalog](/.agents/product/README.md).
