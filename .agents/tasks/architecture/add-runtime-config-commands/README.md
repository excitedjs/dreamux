# Add runtime config Commands

## Current state

- Goal: Add a Config Service that owns config.json at runtime and config Commands that let a Channel read and replace it; agents changes apply immediately, dispatchers changes after restart
- State: `clarification`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md)
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: Storage infrastructure scope under discussion with the operator.
- Next action: Inventory current persistence patterns, then settle the refactor scope in conversation.
- Related tasks: changes a configuration-ownership decision recorded in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
