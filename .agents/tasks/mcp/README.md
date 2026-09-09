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
- [Refine the model-facing surfaces of the TeamLeader](/.agents/tasks/mcp/refine-model-facing-surfaces/README.md) — `done`: Reduce what Dreamux injects into a TeamLeader's context to the necessary minimum: identity and MCP server map in the prompt, factual reminders at the action, skills loaded only when the corresponding MCP is about to be used
- [Relocate role skill guidance into MCP descriptions and role prompts](/.agents/tasks/mcp/relocate-role-skill-guidance/README.md) — `review`: Dispatcher and TeamLeader stop loading dispatcher-workflow and team-workflow every turn: tool knowledge moves into MCP tool and parameter descriptions, the pre-schema server map moves into the role prompts, and both skills stay bundled as optional TeamMate-collaboration methodology.
- [Remove repo.slug from creation tools](/.agents/tasks/mcp/remove-creation-repo-slug/README.md) — `done`: Remove the repo.slug input from teammate.spawn and team.create while retaining automatic managed-worktree naming.
- [Strengthen dispatch reminders and uppercase compaction labels](/.agents/tasks/mcp/strengthen-dispatch-and-compaction-text/README.md) — `done`: Restore push-based dispatch guidance, display COMPACTED SESSION in both runtime projections, and add binding notification receipts
