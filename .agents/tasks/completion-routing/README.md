# Completion Routing Tasks

## Scope

- Cross-provider completion delivery semantics: logical completion identity, at-most-once ordered push-back, and turn settlement contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| completion-router | `packages/dreamux/src/service/completion-router` |

## Child Scopes

## Tasks
- [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — `done`: Replace Claude request windows with resident-session settlement and correct native failure reporting, retaining background work and Core completion-token routing. Original delivery: PR #344.
- [Drop lifecycle-stop completion pushback](/.agents/tasks/completion-routing/suppress-owner-close-stop-pushback/README.md) — `delivery`: Retire pending delivery before TeamMate or Workflow teardown so explicit stop, Team dissolve, host restart, and failed-start rollback do not push cleanup-induced results; final implementation and architecture reviews are accepted.
