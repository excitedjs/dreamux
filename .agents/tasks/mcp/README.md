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
- [Relocate role skill guidance into MCP descriptions and role prompts](/.agents/tasks/mcp/relocate-role-skill-guidance/README.md) — `review`: Dispatcher and TeamLeader stop loading dispatcher-workflow and team-workflow every turn: tool knowledge moves into MCP tool and parameter descriptions, the pre-schema server map moves into the role prompts, and both skills stay bundled as optional TeamMate-collaboration methodology.
