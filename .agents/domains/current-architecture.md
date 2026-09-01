# Current architecture

The map: one page that says how Dreamux is shaped and where each area's owner
page is. Summaries here are deliberately short — the owner page is
authoritative, and source wins over both.

## Process Model

`dreamux serve` runs one local Node process. The server owns admin IPC,
configuration loading, provider registries, durable state, and one
`DispatcherService` per enabled dispatcher. Each `DispatcherService` *has an*
agent: a contained `TeammateService` that owns the agent runtime lifecycle.
Dispatcher-only concerns — channel sessions, restart-notice injection, role MCP
assembly, completion routing, the neutral conversation projection — stay on
`DispatcherService`.

Key source:

- `/packages/dreamux/src/server.ts`
- `/packages/dreamux/src/service/dispatchers/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`

## Packages

Rush + pnpm monorepo; packages wire through pnpm `workspace:*` and install via
the rush path only.

| Package | Folder | Role |
|---|---|---|
| `@excitedjs/dreamux` | `/packages/dreamux/` | the host server |
| `@excitedjs/dreamux-types` | `/packages/dreamux-types/` | declaration-only provider-authoring contracts |
| `@excitedjs/dreamux-utils` | `/packages/dreamux-utils/` | shared provider/runtime utility helpers (transcript bounds, digest validation, positional reads, deterministic rendering, path containment) |
| `@excitedjs/agent-runtime-codex` | `/packages/agent-runtime/codex/` | built-in Codex Agent Runtime provider behind `builtin:codex` |
| `@excitedjs/agent-runtime-claude-code` | `/packages/agent-runtime/claude-code/` | built-in Claude Code Agent Runtime provider behind `builtin:claude-code` |
| `@excitedjs/feishu-transport` | `/packages/channel/feishu-transport/` | platform-I/O core; **sole** importer of `@larksuiteoapi/node-sdk` |
| `@excitedjs/feishu-channel` | `/packages/channel/feishu-channel/` | built-in Feishu Channel provider behind `builtin:feishu` |
| `@excitedjs/eslint-config` | `/packages/eslint-config/` | private shared ESLint flat config; single source of the sync-IO ban and the 700-line cap |

Inside `/packages/dreamux/src/`: `admin/` (socket transport), `channel/` and
`agent-runtime/` (generic provider catalogs/loaders), `command/` (the one
Command registry), `config/`, `mcp/` (stdio protocol owner), `platform/`
(paths, logging, sockets), `service/` (dispatcher/Team/TeamMate/Workflow
domains and their MCP delegates), `state/`, and `server.ts`. Public CLI:
`bin/dreamux`. Bundled skills ship under `skills/` and are injected at runtime
by role, never installed into workspaces.

Owner for install/build/test, change files, and release:
[Repository operations and release](repository-operations-and-release.md).

## Provider Seams

Two seams, three built-ins loaded through one registry/catalog shape
(`builtin:codex`, `builtin:claude-code`, `builtin:feishu`; external `npm:` refs
load through the same path):

- **Agent Runtime** — a provider factory creates a runtime handle with
  `start` / `submit({ text })` / `stop`; provider-private session state crosses
  the seam as an opaque serializable value; history reads use the neutral
  `readRecentActivity`. Owner: [Provider runtime](provider-runtime.md) —
  including configuration (`agents[]` / `dispatchers[]`), system prompts
  (replace/append), bundled-skill injection, and disabled runtime features.
- **Channel** — a provider implements session lifecycle, calls Core through
  one `invoke(command, payload)` port, subscribes to a dispatcher-scoped
  read-only event source, and may publish its own MCP tools. Message parsing,
  routing, binding, targets, Collaboration Spaces, and presentation are all
  Channel-internal. Owner: [Channel](channel/index.md).

Key source: `/packages/dreamux/src/registry/`,
`/packages/dreamux/src/agent-runtime/catalog.ts`,
`/packages/dreamux/src/channel/catalog.ts`.

## Command Registry And Admin Control Plane

One `CoreCommandRegistry` holds every Command definition; the owner-only local
`admin.sock` and a Channel's in-process `invoke` port are transport adapters
over the same registry — no per-adapter table, allowlist, or exposure flag.
Namespaces: `teammate.*`, `team.*`, `workflow.*`, `dispatcher.*`,
`scheduler.cron.*`, plus the transport Commands `mcp.describe` / `mcp.toolcall`.
Admin callers may pass validated `skill_sources` on `teammate.spawn` /
`team.create`; bundled role skills cannot be shadowed. The remaining
control-plane slices (events, protocol baseline, introspection, authentication)
are the one [active proposal](../proposals/admin-control-plane-surface.md).

Key source: `/packages/dreamux/src/command/`,
`/packages/dreamux/src/admin/socket.ts`.

## MCP Protocol Boundary

One Agent-facing stdio shim (`/packages/dreamux/src/mcp/shim.ts`) knows an
admin socket and an opaque lease token, asks `mcp.describe`, forwards to
`mcp.toolcall`, and branches on no tool name. The official-SDK server
(`/packages/dreamux/src/mcp/server.ts`) owns transport, negotiation (exactly
`2026-07-28`, `2025-11-25`, `2025-06-18`), schema validation, and framing.
Every tool surface is an in-server delegate owned by its domain under
`src/service/`; successful objects appear unchanged as `structuredContent`
with exact `content: []`, and submitted create/send/workflow receipts may carry
one operation-local reminder text
(`/packages/dreamux/src/service/mcp/dispatch-reminders.ts`). The failure
contract — `StatedFailure` three-part rendering, native messages passed
through, no sanitized catch-all — is owned by
[Model-facing writing](model-facing-writing.md). Settled MCP rulings:
[/.agents/tasks/mcp/protocol-conformance/requirement.md](/.agents/tasks/mcp/protocol-conformance/requirement.md).

## Teams, TeamMates, And Completion Routing

The Dispatcher Service owns TeamMate and Team state; `TeammateService` is the
sole lifecycle command owner for every conversational agent, and Collections
own construction, caching, and eviction. A Team's `record.json` is the sole
existence, name, and idempotency authority; dissolve is a submission whose
receipt says `submitted`, with the durable close as its commit boundary and
`cleanup-pending` worktree reclaim as the only fact that outlives the process.
One accepted send is one provider-owned `RuntimeSubmission` plus one
entity-owned Turn; completions deliver at-most-once per recipient through the
completion router. Owner:
[Dispatcher orchestration](dispatcher-orchestration.md); construction and
ownership map: [Service topology](service-topology.md); role-visible MCP tool
surfaces: [Dispatcher skills](dispatcher-skill.md).

## Channels, Feishu, And Collaboration Spaces

The built-in Feishu provider owns long-connection handling, access and mention
gates, `/introduce`, pairing, inbound formatting, target resolution, COT
presentation, and its tool surface. A Collaboration Space is a Channel product
flow (provision a Team per managed chat/topic via ordinary `team.create`);
provisioning is process-local and volatile by design. Core sees `team.create`,
`team.submit`, and the `team_name` coming back — it holds no binding table and
publishes no routing event. Owners: [Channel](channel/index.md),
[Built-in Feishu Channel](channel/feishu-channel.md); access state:
[Feishu pairing access](feishu-pairing-access.md); inbound gating:
[Non-blocking dispatcher inbound](non-blocking-dispatcher-inbound.md).

## Dynamic Workflows

Dynamic Workflow is a caller-scoped background orchestration capability on the
existing TeamMate MCP. Each `DispatcherService` owns one dispatcher-scope
`WorkflowService`, and each `TeamService` owns one Team-scope service. A live
`WorkflowRun` owns its durable record, append-only journal, supervised runner
child, and every fresh TeamMate it creates.

The runner compiles one trusted top-level script dialect and evaluates a
private async closure in a `node:vm` context, communicating only over parent
IPC. The first statement must be one recursively plain literal
`export const meta`; imports, pre-meta statements, and other exports are
rejected. Phase `model` is inert metadata. `workflow_run.args` is an optional
direct JSON value validated before durable run creation; Dreamux never parses
JSON-looking strings. Every workflow-owned TeamMate receives an
operation-owned workflow-role append prompt; `schema` passes through the
neutral `outputSchema` turn input, and a successful structured result is
parsed exactly once. `workflow_run` creates the durable run and captures
terminal delivery before runner startup, so compilation failures become
durable asynchronous failed runs after the immediate `{ run_id }` receipt.

Natural terminal and explicit stop use one retryable close-first pipeline that
returns only after terminal persistence and delivery; startup completes a
running record from a committed terminal journal fact or marks it stopped —
execution is never replayed. The exact numeric limits are user-facing and owned
by [Dynamic Workflow usage](../product/dynamic-workflow-usage.md#53-exact-limits).

Key source: `/packages/dreamux/src/service/workflow-service/`,
`/packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`.

## State, Cache, Run Files, And Logs

Path construction belongs in `/packages/dreamux/src/platform/paths.ts`. The
ownership map is in [State, config, and files](state-config-and-files.md).
High-level split: `~/.dreamux/config.json` (operator-owned), `run/` (volatile),
`state/` (durable server-owned documents; Feishu `access.json` has an explicit
mixed-ownership contract), `cache/` (rebuildable), `logs/`; `~/.codex/` is
Codex-owned and not Dreamux state.

## History

Every area summary above links its owner page; each owner page ends with a
History pointer into [the task tree](/.agents/tasks/README.md), where the full
derivation and operator rulings live. The map itself has no separate decision
trail.
