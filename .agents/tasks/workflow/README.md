# Workflow Tasks

## Scope

- Dynamic Workflow orchestration and its integration with shared TeamMate lifecycle capabilities

## Code signals

| Area | Current code signal |
| --- | --- |
| Workflow orchestration | `packages/dreamux/src/service/workflow-service/` |
| TeamMate container and roster | `packages/dreamux/src/service/teammate-collection/` |
| TeamMate entity lifecycle | `packages/dreamux/src/service/teammate-service/` |

## Child Scopes

## Tasks
- [Unify Workflow agents with TeamMate lifecycle ownership](/.agents/tasks/workflow/unified-teammate-lifecycle/README.md) — Define and implement owner-correct lifecycle boundaries so Workflow-created agents remain ordinary TeamMates in the shared collection and close through the TeamMate-owned lifecycle rather than Workflow-specific teardown logic
- [Harden native transcript contracts](/.agents/tasks/workflow/harden-native-transcript-contracts/README.md) — Turn the merged native-transcript non-leakage and receipt semantics into enforceable tests, repair stale knowledge/change notes, and fix bounded reader edge cases
- [Fix workflow_run input schema rejected by Anthropic-compatible clients](/.agents/tasks/workflow/fix-workflow-run-schema-anyof/README.md) — Restore workflow_run visibility to Claude Code (and any client that rejects top-level anyOf in tool input schemas) by removing the schema-level anyOf and expressing the script/scriptPath one-of in the description; server-side validation stays the authority.
