# Workflow Tasks

## Scope

- Dynamic Workflow orchestration and its integration with shared TeamMate lifecycle capabilities

## Code signals

| Area | Current code signal |
| --- | --- |
| Workflow orchestration | `packages/dreamux/src/service/workflow-service/` |
| TeamMate container and roster | `packages/dreamux/src/service/teammate-collection/` |
| TeamMate entity lifecycle | `packages/dreamux/src/service/teammate-service/` |

## Tasks
- [Unify Workflow agents with TeamMate lifecycle ownership](/.agents/tasks/workflow/unified-teammate-lifecycle/README.md) — `done`: Define and implement owner-correct lifecycle boundaries so Workflow-created agents remain ordinary TeamMates in the shared collection and close through the TeamMate-owned lifecycle rather than Workflow-specific teardown logic
