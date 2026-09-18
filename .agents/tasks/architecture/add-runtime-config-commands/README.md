# Add runtime config Commands

## Current state

- Goal: Add a Config Service that owns config.json at runtime and config Commands that let a Channel read and replace it; agents changes apply immediately, dispatchers changes after restart
- State: `blocked`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md)
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: Sequenced after [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md) merges (operator ruling, 2026-09-17); the storage infrastructure scope is not yet settled.
- Next action: After the Dispatcher Command task merges, settle with the operator whether the storage infrastructure refactor is its own task and which stores move onto it.
- Related tasks: changes a configuration-ownership decision recorded in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
