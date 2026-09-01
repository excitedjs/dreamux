# Architecture Tasks

## Scope

- Cross-cutting architecture boundaries, public contracts, layering, and capability ownership.

## Code signals

| Area | Current code signal |
| --- | --- |
| Architecture contracts | `packages/dreamux-types/src; Core boundaries=packages/dreamux/src` |

## Child Scopes

## Tasks
- [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md) — `done`: Reduce Agent Runtime and Channel contracts to minimal Command-invocation and Core-event ports without reducing Channel's external-interaction responsibility. Merged as PR #350 (+#353, #356); decision record: [minimize-provider-boundaries](/.agents/decisions/minimize-provider-boundaries.md).
