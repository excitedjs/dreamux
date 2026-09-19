# Add runtime config Commands

## Current state

- Goal: Add a Config Service that owns config.json at runtime and config Commands that let a Channel read and replace it; agents changes apply immediately, dispatchers changes after restart
- State: `clarification`
- Requirement: [Current requirement](/.agents/tasks/architecture/add-runtime-config-commands/requirement.md)
- Final solution: Not created.
- Solution review Issue: Not created.
- Blockers: None. The sequencing blocker cleared when the Dispatcher Command task merged (#444, 2026-09-18); the operator chose to continue this task in the same Team.
- Next action: Re-clarify the Config Service with the operator, who reopened it on 2026-09-19; the storage refactor scope is decided (every existing store moves onto a transactional store).
- Related tasks: changes a configuration-ownership decision recorded in [Minimize Core Provider Boundaries](/.agents/tasks/architecture/minimize-provider-boundaries/README.md); sibling request [Give the Dispatcher Agent its own Commands](/.agents/tasks/architecture/add-dispatcher-submit-command/README.md).

## Development approval

- Status: Not granted.
- Approved implementation boundary: None.

## Delivery

- Pull request: Not opened.
- Knowledge closeout: Pending.
