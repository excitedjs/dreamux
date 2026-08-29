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
- one shared `AgentIdentityStore` (built at construction in
  `service/agent-entity/` and injected into the dispatcher agent,
  dispatcher-scope teammate collection, and each Team's collection /
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
drops queued or in-flight inbound work; durable recovery is through identity,
provider-native transcripts, and aggregate-owned Workflow/Team records, not
replaying channel events.

Visible channel communication remains provider-owned. Assistant text produced
by the dispatcher runtime is not automatically delivered back to a chat; the
agent must use an exposed channel tool such as the provider `reply` tool when it
has an eligible source message.

Source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/channel-service/index.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`
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
terminal outcome/delivery convergence, close single-flight, and retirement
fact.
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

Read tools do not start or resume runtimes. `last` first checks the identity and
scope, then delegates a bounded cold read to the selected Agent Runtime
provider's native transcript. It materializes no entity and stores no transcript
copy, index, or cursor.

Every accepted send is retained as one entity-owned `Turn` object over one
provider-owned `RuntimeSubmission`. Providers settle submissions with immutable
`RuntimeCompletion` tokens created at real native result boundaries: folded
sends share one completion, queued sends settle with distinct completions in
provider order. Public receipts, Workflow records, Channel contracts, and
identity state do not expose an id merely to re-find that in-process object.
The first immutable outcome wins the object latch; delivery flows through the
core `completion-router`, at-most-once per producer, completion token, and
recipient. Dreamux persists no Turn archive or rolling conversation projection.

The runtime checkpoint stores the provider-native session id plus an optional
opaque transcript locator. Direct TeamMate `spawn` and `send` receipts expose
that validated native path when the association exists. `last`, history,
status, Workflow, Team, Channel, completion delivery, logs, and metrics do not.
A per-entity `turn.jsonl` left by an older release is inert no-touch residue and
cannot block startup or lifecycle behavior.

Source:

- `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`
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

TeamLeader-visible Team MCP exposes exactly one tool, a scoped `dissolve`.
`dissolve({ note, force? })` derives the Team from the MCP descriptor and cannot
accept or override `team_name`. No Team tool binds a channel: routing a
conversation to a Team is the Channel's own decision, made with that Channel's
tools. Peer Team send remains future work; TeamLeaders use their scoped TeamMate
MCP to send to Team members.

A dissolve is submitted, not awaited. Both surfaces answer
`{ accepted, team_name, status: "submitted" }` as soon as the Team owns the one
background operation that will stop it, close it, and reclaim its checkout, and
neither ever reports how that went — a TeamLeader dissolving its own Team should
expect to lose the response, because it is one of the runtimes being stopped. A
second submission joins the first rather than dismantling the same Team twice,
and a refused dissolve can be asked again.

The Team itself holds the fence, and the fence is the operation: it goes up the
moment a dissolve is submitted, before the first await, and refuses new work
rather than queueing it — dissolve is a stop-and-reclaim, not a drain. From that
point every caller operation the Team admits is refused (Dispatcher and Channel
send, TeamLeader member and Workflow mutation, Team scheduler mutation and fire,
member-completion injection), and permanently so once the record says closed;
reads stay available. A failed dissolve lowers the fence again and the Team stays
open, its children reopening lazily, because nothing durable was written.

Behind the receipt the order is fixed. A Dispatcher-requested dissolve calls
`WorktreeManager.assessCleanup()` first, while nothing has stopped, so a refusal
costs the Team nothing; a TeamLeader cannot ask that question about itself, so it
stops its members first and then asks while it is still alive to be told.
`force` overrides the refusal, never the question. Then Workflow admission
closes, the scheduler stops, members and the leader stop and close, and the
assessment is repeated now that nothing is running — that second answer is the
only one a destructive reclaim may act on. The single record write that sets
`status: "closed"`, `closed_at`, the close note, and the worktree fact is what
makes the Team closed; nothing after it may take that back, which is why the
Team's cron store is discarded only after it and why a failure before it reopens
admission instead.

What the close cannot finish is physical. A managed `delete-on-close` checkout
that could not be reclaimed is committed as `cleanup-pending` together with the
caller's `worktree_cleanup_force` authorization, and a later start finishes it
from the record alone: no Team is materialized, each reclaim is launched rather
than awaited so a slow Git cannot hold up dispatcher start, and a failure leaves
the same pending fact for the next start rather than a retry ledger.
Dirty/unmerged work retains the worktree and requires user action; `cleanup:
keep` and non-managed workspaces are terminally retained. Clean
`delete-on-close` cleanup performs no ref or history scan and uses only
non-forced `git worktree remove <path>`, preserving the managed branch and its
commits. Branch/ref deletion is outside Team dissolve.

A host shutdown is not a dissolve. It gives back the runtime authority this
process took — Workflows, then materialized members, then the leader — and
writes nothing durable, because a Team is closed by dissolve and never by a
process stopping. Only Agents this process actually materialized are reached: a
durable member nobody materialized is already idle, and starting one to stop it
would make a host sweep touch entities it never ran.

`team.create` may include a first `prompt`; if omitted, the TeamLeader starts
idle and waits for later Team MCP `send` or bound-channel inbound. Team-owned
members share the Team workspace.

Source:

- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`

## Completion Routing

Completion delivery is captured by object and closure, not reconstructed through
a dispatcher-wide key. A delivery-initiating action (`spawn`, `send`, or
team-create-with-prompt) resolves its initiator before runtime admission and
attaches one closure to the entity-owned `Turn`. After the winning terminal
outcome is selected, that Turn invokes the shared stateless
`CompletionDeliveryPolicy`.

Key invariants:

- the initiating action retains the target directly; there is no Turn id lookup
  map or terminal registry;
- channel inbound and remote-control turns do not attach a completion closure,
  so they are not pushed;
- one Turn starts at most one delivery task after outcome selection;
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
roles. Each surface is an in-server delegate owned by its own domain — Team,
TeamMate, scheduler, workflow, and one per channel that publishes tools (for
Feishu: `reply`, `react`, `list_chat_bots`, plus its routing and Collaboration
Space tools).

The role→delegate decision lives in one place. The Dispatcher Agent and a
TeamLeader get different sets because they are different callers, not because a
shared server filters by who is asking: a TeamLeader has no Team
`create`/`send`/`list`, its TeamMate and cron surfaces operate on its own Team,
and its Team surface is a single scoped `dissolve`.

There is one Agent-facing MCP descriptor shape for every server: the same
binary, the same `mcp` subcommand, the admin socket to reach, and an opaque
generation-scoped lease token in `env`. Nothing renders a caller flag or a
provider routing argument into a command line the model's runtime could read.
The token names no dispatcher, Team, or caller; what bounds the capability is
`admin.sock` file permissions, since a reader who cannot open the socket cannot
redeem a token and one who can already holds full admin authority.

`/packages/dreamux/src/mcp/server.ts` is the sole official stdio MCP transport
and protocol owner. It serves exactly `2026-07-28`, `2025-11-25`, and
`2025-06-18`, validates the same JSON Schemas it advertises, and emits canonical
`structuredContent` with exact `content: []` for ordinary successes. Bound Team,
TeamMate, and workflow tool definitions may select one operation-local reminder
text from a successfully submitted projected result without changing that
structured value. Each delegate retains tool visibility, descriptor-bound scope,
result projection, success-text selection, and public-error allowlists.

The channel service never imports back from `dispatcher-service`, and provider
packages stay core-agnostic.

Nested dispatch is prevented by MCP injection and caller scope, not by a runtime
implementation check.

Source:

- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/shim.ts`
- `/packages/dreamux/src/service/mcp/`
- `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/scheduler/mcp-delegate.ts`

## Decision Trail

- [Dispatcher-local aggregate](../decisions/dispatcher-local-aggregate.md)
- [Entity-owned TeamMate lifecycle and object Turns](../decisions/entity-owned-teammate-lifecycle-and-object-turns.md)
- [Service architecture refactor](../decisions/service-architecture-refactor.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [Server-hosted TeamMate](../decisions/server-hosted-teammate.md)
