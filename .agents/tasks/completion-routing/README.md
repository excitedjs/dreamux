# Completion Routing Tasks

## Scope

- Cross-provider completion delivery semantics: logical completion identity, at-most-once ordered push-back, and turn settlement contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| completion-router | `packages/dreamux/src/service/completion-router` |

## Child Scopes

## Tasks
- [Adopt provider completion token routing and settlement](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md) — `intake`: Replace the interim PR #342 settlement gate with the completion-token architecture: provider-owned logical completion identity, core at-most-once ordered completion delivery, and the Last completion boundary fix.
