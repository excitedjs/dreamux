# Dispatcher Orchestration

This page is the stable contract for Dreamux's core orchestration model:
Dispatchers, Teams, TeamMates, completion routing, MCP projections, and
workspace ownership.

Read this before changing `service/`, TeamMate/Team MCP tools, completion
delivery, TeamLeader routing, or generated workspaces.

## Service Graph

`dreamux serve` is the process-level composition root. It builds a
`Dispatchers` collection. Each `DispatcherService` is one dispatcher-local
aggregate and owns:

- the dispatcher's contained agent (`TeammateService` with role `dispatcher`);
- a dispatcher-local `ChannelService`;
- the dispatcher-scope `TeammateCollection`;
- the per-dispatcher `TeamCollection`;
- one `CompletionRouter`;
- one `WorktreeManager`;
- one shared `AgentIdentityStore` + `AgentTurnsStore` pair (built at
  construction in `service/agent-entity/` and injected into the dispatcher
  agent, dispatcher-scope teammate collection, and each Team's collection /
  TeamService / member collection);
- the dispatcher scheduler.

`server.ts` should stay wiring-only. Per-dispatcher behavior belongs under
`/packages/dreamux/src/service/`.

Source:

- `/packages/dreamux/src/server.ts`
- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/agent-entity/`
- `/packages/dreamux/src/service/dispatchers/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/index.ts`

## Dispatcher Trust Domain

One dispatcher is one shared-context trust domain. All accepted turns submitted
to that dispatcher agent share the same runtime conversation unless a lower
layer explicitly routes them to a TeamLeader or TeamMate runtime.

Channel-originated turns are not persisted as an inbound queue. A server restart
drops queued or in-flight inbound work; durable recovery is through per-agent
turn records and read surfaces, not replaying channel events.

Visible channel communication remains provider-owned. Assistant text produced
by the dispatcher runtime is not automatically delivered back to a chat; the
agent must use an exposed channel tool such as the provider `reply` tool when it
has an eligible source message.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`

## Collection And Entity Pattern

The service layer follows a collection + entity pattern:

| Collection | Entity | Owns |
|---|---|---|
| `Dispatchers` | `DispatcherService` | dispatcher aggregate factory/cache |
| `TeamCollection` | `TeamService` | Team records, TeamLeader, members |
| `TeammateCollection` | `TeammateService` | named agent records and runtime lifecycle |

The dispatcher has an agent; it is not itself an Agent Runtime. A Team has a
TeamLeader agent; the TeamLeader is not stored in the members collection. This
keeps dispatcher-only concerns and Team-only concerns out of the reusable
`TeammateService` entity.

One service class belongs in one file or directory. A class with helpers gets a
directory whose `index.ts` is the class and sibling files are helpers.

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`

## Teammate Model

A TeamMate is a named, resumable agent, not a one-shot task. The current
dispatcher-facing tools are:

- `spawn`
- `send`
- `close`
- `history`
- `list`
- `status`
- `last`
- `get_capabilities`

`spawn` returns a concrete, never-reused name. Later `send`, `status`, `last`,
and `close` must use that concrete name. `send` reopens a closed TeamMate from
the runtime-native `session_id`; there is no standalone `resume` verb.

Read tools do not start or resume runtimes. `last` first checks the record, then
folds recent settled turns from that entity's `turn.jsonl`.

Source:

- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/src/service/teammate-collection/`
- `/packages/dreamux/src/service/teammate-service/`

## Roles And Visibility

Agent roles are:

- `dispatcher`
- `teammate`
- `team_leader`
- `team_member`

Visibility is enforced by physical state scope plus collection read chokepoints:

- dispatcher-scope `teammate.*` sees only dispatcher-owned ordinary TeamMates;
- TeamLeader-scope `teammate.*` sees only that Team's members;
- ordinary TeamMates get no peer lifecycle surface;
- a dispatcher inspects Teams through `team.*`, not `teammate.*`.

TeamLeader entities live at the Team root. Team members live under that Team's
`teammate/` collection.

Source:

- `/packages/dreamux/src/service/teammate-collection/read-helpers.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/platform/paths.ts`

## Team Model

`team.create.name_prefix` is a label request, not a durable address. Core
allocates a concrete `team_name` with a 4–8 character random suffix, checks it
against the Team namespace's permanent name claims (including closed and
not-yet-materialized Teams), and never reuses it.
Generated TeamLeader, ordinary TeamMate, and Team-member names also use 4–8
character suffixes. One dispatcher-shared `AgentIdentityStore` serializes
candidate reservation across those three creation paths, while a narrow
TeamStore projection keeps a Team record's pending `leader_name` occupied
before its identity exists.
Every later Team operation is addressed by the concrete `team_name` returned
from create. Dispatcher-visible Team MCP tools:

- `create`
- `send`
- `list`
- `status`
- `history`
- `dissolve`
- `bind_channel`
- `transfer_back`

TeamLeader-visible Team MCP exposes scoped `bind_channel` and `transfer_back`.
Bind derives the Team and current leader generation from the MCP descriptor,
and can only create an unowned explicit route or repeat the exact same one;
dispatcher bind retains replacement semantics. Peer Team send remains future
work; TeamLeaders use their scoped TeamMate MCP to send to Team members.

`team.create` may include a first `prompt`; if omitted, the TeamLeader starts
idle and waits for later Team MCP `send` or bound-channel inbound. Team-owned
members share the Team workspace.

Source:

- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`

## Completion Routing

Completion delivery is per-dispatcher and per-turn. A delivery-initiating action
(`spawn`, `send`, or team-create-with-prompt) registers:

```text
producerName:turnId -> initiator
```

The initiator is the dispatcher agent or a TeamLeader. When the producer's turn
settles, `CompletionRouter` forwards a completion envelope into the initiator's
`completionInput`, then clears the registration.

Key invariants:

- the key includes producer name because `turnId` is runtime-local;
- names stay dispatcher-global so `producerName:turnId` is collision-free;
- channel inbound and remote-control turns do not register, so they are recorded
  but not pushed;
- delivery is at-most-once;
- every terminal branch is cached, not only successful delivery;
- lost in-memory registrations after restart are acceptable because durable
  recovery is through `last`.

Source:

- `/packages/dreamux/src/service/completion-router/index.ts`
- `/packages/dreamux/src/service/teammate-service/turn-recording.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`

## Workspaces

Each dispatcher must declare an explicit `cwd`. Dreamux-managed work areas live
under that dispatcher workspace, never under `~/.dreamux`.

Current workspace paths:

```text
<dispatcher cwd>/.workspace/work/<name>/
<dispatcher cwd>/                # when dispatchers[].workspace.enabled is false
<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/
```

Omitting `repo` creates a plain work directory with `mkdir -p`; no git command
runs, so the dispatcher cwd need not be a git repository. Managed worktrees are
created only when the request explicitly asks for managed repo work.
`.workspace/` self-ignores with `*`.

Source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/`
- `/packages/dreamux/src/service/teammate-collection/agent-config.ts`

## MCP Boundaries

Dreamux-owned orchestration is exposed through MCP tools injected into runtime
roles:

- `teammate-mcp` for TeamMate lifecycle and reads;
- `team-mcp` for Team lifecycle and Team channel binding;
- `cron-mcp` for scheduled prompt-agent jobs;
- core-owned `channel-mcp` shims for provider-owned channel actions such as Feishu
  `reply`, `react`, and `list_chat_bots`.

Channel MCP descriptor rendering is a core-owned capability built in
`service/channel-service/mcp-descriptors.ts`; `dispatcher-service/mcp-descriptors.ts`
only composes the dispatcher-root aggregate (channel + team + teammate + cron).
The channel service never imports back from `dispatcher-service`, and provider
packages stay core-agnostic.

Nested dispatch is prevented by MCP injection and caller scope, not by a runtime
implementation check.

Source:

- `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/mcp/cron-mcp.ts`

## Decision Trail

- [Dispatcher-local aggregate](../decisions/dispatcher-local-aggregate.md)
- [Service architecture refactor](../decisions/service-architecture-refactor.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Server-hosted TeamMate](../decisions/server-hosted-teammate.md)
