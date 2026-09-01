# MCP Scheduler Tasks

## Scope

- Scheduler-backed MCP tools and their control-plane contracts.

## Code signals

| Area | Current code signal |
| --- | --- |
| cron MCP server | `packages/dreamux/src/mcp/cron-mcp.ts` |
| scheduler service | `packages/dreamux/src/service/scheduler` |

## Child Scopes

## Tasks
- [Cron Foundation Record](/.agents/tasks/mcp/scheduler/cron-foundations/README.md) — `done`: Preserve the per-conversational-agent cron decision.
- [Remove cron run-now capability](/.agents/tasks/mcp/scheduler/remove-cron-run-now/README.md) — `done`: Remove the broken cron immediate-run capability and its complete dependency chain without compatibility aliases or unused code.
