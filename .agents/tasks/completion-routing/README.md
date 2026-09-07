# Completion Routing Tasks

## Scope

- Cross-provider completion delivery semantics: logical completion identity, at-most-once ordered push-back, and turn settlement contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| completion-router | `packages/dreamux/src/service/completion-router` |

## Child Scopes

## Tasks
- [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — `done`: Replace Claude request-window coordination with resident-session input and per-request settlement, retaining the background-turn repair and Core completion-token contract. Original delivery: PR #344.
