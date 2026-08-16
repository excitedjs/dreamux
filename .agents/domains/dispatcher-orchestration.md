# Dispatcher Orchestration

This page is the stable contract for Dreamux's core orchestration model:
Dispatchers, Teams, TeamMates, completion delivery, MCP projections, and
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
- one stateless `CompletionDeliveryPolicy`;
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
| `TeammateCollection` | `TeammateService` | scoped construction/cache/reads vs. entity-owned lifecycle |

The dispatcher has an agent; it is not itself an Agent Runtime. A Team has a
TeamLeader agent; the TeamLeader is not stored in the members collection. This
keeps dispatcher-only concerns and Team-only concerns out of the reusable
`TeammateService` entity.

`TeammateService` is the sole command owner for one agent entity. It owns its
mutation admission, Workflow lock, runtime authority, in-process Turn objects,
terminal persistence, close single-flight, and retirement fact.
`TeammateCollection` owns scoped construction, canonical per-name
materialization, the exact-object cache subscription, roster queries, and reads.
It never enters close for cache bookkeeping and never owns a bulk runtime or
membership shutdown verb.

One service class belongs in one file or directory. A class with helpers gets a
directory whose `index.ts` is the class and sibling files are helpers.

Source:

- `/packages/dreamux/src/service/CLAUDE.md`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/runtime-owner.ts`

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

Every accepted logical input is retained as one entity-owned `Turn` object over
one provider-owned `RuntimeTurn`. Folds return the same object. Public receipts,
Workflow records, Channel contracts, and `turn.jsonl` do not expose an id merely
to re-find that in-process object. The strict version-2 archive writes one
terminal row only after the first immutable outcome wins.

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

- `/packages/dreamux/src/service/agent-entity/read-helpers.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/platform/paths.ts`

## Team Model

`team.create.name_prefix` is a label request, not a durable address. Core
allocates a concrete `team_name` with a 4–8 character random suffix, checks it
against the Team namespace's permanent name claims (including closed and
not-yet-materialized Teams), and never reuses it.
Generated TeamLeader, ordinary TeamMate, and Team-member names also use 4–8
character suffixes. The shared `AgentIdentityStore` checks persisted
dispatcher-global entity names before allocating each generated agent name and
creates identities with no-clobber writes. It does not keep transient
reservations or serialize separate creation operations.
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

TeamLeader-visible Team MCP exposes exactly scoped `dissolve`, `bind_channel`,
and `transfer_back`. `dissolve({ note })` derives the Team and current leader
generation from the MCP descriptor and maps to the existing `team.dissolve`
admin method; it cannot accept or override `team_name`. It durably accepts the
one TeamCollection-owned operation and returns `status: "closing"` before the
TeamLeader's runtime is stopped. Bind uses the same descriptor-bound generation
and can only create an unowned explicit route or repeat the exact same one;
dispatcher bind retains replacement semantics. Peer Team send remains future
work; TeamLeaders use their scoped TeamMate MCP to send to Team members.

`TeamCollection` owns the durable dissolve record, active-operation handle, and
one availability fence for all Team work. The fence covers Dispatcher send,
Channel delivery and route publication, TeamLeader member/workflow mutation,
Team scheduler mutation and final fire, and Team-member completion injection;
generation-checked reads remain available. Before acceptance it captures all
live leader/member writers, requires `waitIdle()` on each, and performs a
non-mutating worktree assessment. After durable acceptance it stops new work,
waits every captured writer idle, and repeats that assessment before logical
close.

Logical close transfers routes, closes Team-owned workflows/runtimes/scheduler
state, persists Team `status: "closed"`, and records the shared worktree as
`cleanup-pending` before deletion. The accepted handle exposes only its opaque
operation id, receipt, and `logicalClosed`; collaboration target close awaits
that milestone, while both Dispatcher and TeamLeader MCP return only the durable
accepted receipt. Terminal cleanup is observed from persisted Team read surfaces
and lifecycle logs. Dispatcher pre-acceptance validation has a 9-second
method-entry deadline under the normal 10-second admin timeout; `logicalClosed`
does not participate in the response. Operational cleanup failures retry in
background and after restart. Dirty/unmerged work retains the worktree and
requires user action; `cleanup: keep` and non-managed workspaces are terminally
retained. Clean `delete-on-close` cleanup performs no ref or history scan and
uses only non-forced `git worktree remove <path>`, preserving the managed branch
and commits. Branch/ref deletion is outside Team dissolve.
Shutdown interrupts cancellable idle waits and retry timers before admitted-task
drain, preserving the durable phase for startup recovery. After Workflow stop,
Team lifecycle callers canonically materialize every durable non-closed member
and invoke each entity's normal close; a cold cache is not proof that no member
needs lifecycle convergence.

`team.create` may include a first `prompt`; if omitted, the TeamLeader starts
idle and waits for later Team MCP `send` or bound-channel inbound. Team-owned
members share the Team workspace.

Source:

- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`

## Completion Routing

Completion delivery is captured by object and closure, not reconstructed through
a dispatcher-wide key. A delivery-initiating action (`spawn`, `send`, or
team-create-with-prompt) resolves its initiator before runtime admission and
attaches one closure to the entity-owned `Turn`. After the winning terminal row
and rolling projection commit, that Turn invokes the shared stateless
`CompletionDeliveryPolicy`.

Key invariants:

- the initiating action retains the target directly; there is no Turn id lookup
  map or terminal registry;
- channel inbound and remote-control turns do not register, so they are recorded
  but not pushed;
- one Turn starts at most one delivery task after durable persistence;
- completion preparation and each submission attempt are deadline-bounded;
- only an explicit provider-proven pre-admission failure may retry; a throw,
  timeout, or `ambiguous` admission is terminal and never replayed;
- completion delivery is process-local and is not replayed after restart;
  durable recovery is through `last` and Workflow/TeamMate records.

Source:

- `/packages/dreamux/src/service/completion-router/index.ts`
- `/packages/dreamux/src/service/teammate-service/turn-recording.ts`
- `/packages/dreamux/src/service/teammate-service/turn-coordinator.ts`

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
- `/packages/dreamux/src/service/agent-entity/agent-config.ts`

## MCP Boundaries

Dreamux-owned orchestration is exposed through MCP tools injected into runtime
roles:

- `teammate-mcp` for TeamMate lifecycle and reads;
- `team-mcp` for Team lifecycle and Team channel binding;
- `cron-mcp` for scheduled prompt-agent jobs;
- core-owned `channel-mcp` shims for provider-owned channel actions such as Feishu
  `reply`, `react`, and `list_chat_bots`.

All five scoped processes register their caller-bound catalogs through
`/packages/dreamux/src/mcp/server.ts`, the sole official stdio MCP transport
and protocol owner. It
serves exactly `2026-07-28`, `2025-11-25`, and `2025-06-18`, validates the same
JSON Schemas it advertises, and emits canonical `structuredContent` with exact
`content: []` for ordinary successes. Bound Team, TeamMate, and workflow tool
definitions may select one operation-local reminder text from a successfully
submitted projected result without changing that structured value. Domain
adapters retain tool visibility, descriptor-bound scope, admin-method mapping,
result projection, success-text selection, and public-error allowlists; the
admin control plane independently revalidates and authorizes every call.

Channel MCP descriptor rendering is a core-owned capability built in
`/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`;
`/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts` only
composes the dispatcher-root aggregate (channel + team + teammate + cron).
Built-in channels keep their provider id as the MCP server name. External
channels use the dispatcher-local channel id because an `npm:` provider ref is
not a valid MCP server name; the full provider ref remains in the shim's
`--provider` routing argument.
The channel service never imports back from `dispatcher-service`, and provider
packages stay core-agnostic.

Nested dispatch is prevented by MCP injection and caller scope, not by a runtime
implementation check.

Source:

- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/tool-catalog.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/mcp/cron-mcp.ts`

## Decision Trail

- [Dispatcher-local aggregate](../decisions/dispatcher-local-aggregate.md)
- [Entity-owned TeamMate lifecycle and object Turns](../decisions/entity-owned-teammate-lifecycle-and-object-turns.md)
- [Service architecture refactor](../decisions/service-architecture-refactor.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Server-hosted TeamMate](../decisions/server-hosted-teammate.md)
