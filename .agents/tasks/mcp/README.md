# MCP Tasks

## Scope

- Model-facing tool and protocol capability tasks.

## Code signals

| Area | Current code signal |
| --- | --- |
| MCP servers | `packages/dreamux/src/mcp` |

## Child Scopes

- [Scheduler](/.agents/tasks/mcp/scheduler/README.md): Scheduler-backed MCP tools and their control-plane contracts.

## Tasks
- [MCP Protocol Conformance Rulings](/.agents/tasks/mcp/protocol-conformance/README.md) — `done`: Preserve the settled rulings behind the official-SDK MCP server replacement.
- [Refine the model-facing surfaces of the TeamLeader](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md) — `intake`: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used
