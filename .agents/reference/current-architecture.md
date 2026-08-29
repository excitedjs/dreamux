# Reference: current architecture

This is the short current-state map. It is a reference page, not a decision
record. For rationale, follow the linked decisions and then verify behavior in
source before making changes.

## Process Model

`dreamux serve` runs one local Node process. The server owns admin IPC,
configuration loading, provider registries, durable state, and one
`DispatcherService` per enabled dispatcher. Each `DispatcherService` *has an*
agent: a contained `TeammateService` that owns the agent runtime lifecycle
(Phase 5, #233). The dispatcher-only concerns — channel sessions, restart-notice
injection, role MCP assembly, completion routing, and the neutral conversation
projection — stay on `DispatcherService`;
there is no separate `DispatcherRuntimeService`.

Key source:

- `/packages/dreamux/src/server.ts`
- `/packages/dreamux/src/service/dispatchers/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`

## Configuration

The operator config is JSON at the path reported by `dreamux config path`
(normally `~/.dreamux/config.json`; `DREAMUX_CONFIG_DIR` may relocate it).

Current file shape:

- `agents[]` declares named Agent Runtime configs.
- `dispatchers[]` declares dispatcher ids, explicit `cwd`, `channels[]`, and
  `agentRuntime`, which references an `agents[].id`.
- `dispatchers[].channels[]` entries carry a dispatcher-local `id`, a channel
  provider ref, and provider-owned config.

Current load behavior:

- Agent Runtime provider refs and Channel provider refs are loaded before config
  validation.
- Dispatcher channel ids must be unique within one dispatcher.
- A dispatcher may not declare the same channel provider ref twice.
- Old Feishu/Codex-specific config shapes fail loud with rebuild guidance.

Key source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/agent-runtime/external-provider.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`

## Provider Seams

Dreamux has two provider seams:

- `agentRuntime`: launches dispatcher, teammate, TeamLeader, and future member
  agents through one role-aware runtime interface.
- `channel`: creates channel sessions, resolves channel targets, and owns
  provider-specific MCP tools.

Built-in provider packages are loaded through the same registry/catalog shape as
external provider refs.

Current built-ins:

- `builtin:codex` -> `@excitedjs/agent-runtime-codex`
- `builtin:claude-code` -> `@excitedjs/agent-runtime-claude-code`
- `builtin:feishu` -> `@excitedjs/feishu-channel`

Key source:

- `/packages/dreamux/src/registry/`
- `/packages/dreamux/src/agent-runtime/catalog.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/registry/builtins.ts`

See also [Channel runtime](channel-runtime.md) for Channel session, target, and
provider-tool details.

## Dispatcher Runtime

Each live dispatcher owns:

- one selected Agent Runtime instance
- one built `ChannelInstance` per configured channel, held by dispatcher-local
  `channel_id`
- one in-process MCP delegate per tool surface, each owned by its own domain:
  Team, TeamMate, scheduler, workflow, and one per channel that publishes tools

The first declared channel is the primary/default egress channel. A dispatcher
with multiple channel providers can route and egress by `channel_id`; with only
`builtin:feishu` wired today, normal configs have one Feishu channel.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegates.ts`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`
- `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`

## MCP Protocol Boundary

There is one Agent-facing stdio entry, `/packages/dreamux/src/mcp/shim.ts`. It
knows an admin socket and an opaque lease token and nothing else: it asks
`mcp.describe` what to advertise, forwards every call to `mcp.toolcall`, and
branches on no tool name. The official-SDK runner in
`/packages/dreamux/src/mcp/server.ts` owns transport, protocol negotiation,
registration, schema validation, protocol errors, cancellation, and stdout
framing. It serves exactly `2026-07-28`, `2025-11-25`, and
`2025-06-18`; the modern revision uses discovery and the two legacy revisions
use initialization. Operational diagnostics stay on the supplied logger rather
than the MCP wire.

Each domain supplies an in-server delegate with a deterministic, caller-bound
tool catalog, frozen for one runtime generation. The delegate owns tool
visibility, metadata, schemas, the scope that model input cannot override,
public-error allowlists, and successful-result projection. Nothing in the lease
registry, the two transport Commands, the descriptor, or the shim knows which
domains exist — a Channel delegate is one implementation of that contract, not a
special case of it. The shared executor emits each ordinary successful object unchanged
as `structuredContent` with exact `content: []`, validates it against the
advertised output schema, and sanitizes unapproved handler failures. An
execution-only selector on a bound tool definition may add exactly one text
block without changing `structuredContent`; that selector is not advertised as
tool metadata or carried through provider descriptors. The admin socket remains
an independently validated product control plane and contains no MCP protocol
types or envelopes.

General completion-delivery and no-polling guidance lives in role prompts. The
narrow result-level signal is operation-local: submitted `team.create` /
`team.send` and `teammate.spawn` / `teammate.send` receipts, plus
`workflow_run` receipts with a non-empty `run_id`, carry one matching no-poll
reminder text block. Idle, failed, read, unrelated, and ordinary mutation
results carry no text.
`/packages/dreamux/src/service/mcp/dispatch-reminders.ts` owns those texts and
their reusable selectors; it never mutates structured results.

Key source:

- `/packages/dreamux/src/mcp/server.ts`
- `/packages/dreamux/src/mcp/shim.ts`
- `/packages/dreamux/src/mcp/catalog.ts`
- `/packages/dreamux/src/service/mcp/`
- `/packages/dreamux/src/service/mcp/dispatch-reminders.ts`

## Admin Control Plane

The owner-only local `admin.sock` is Dreamux's target external control-plane
entry point. Its current protocol is still the v0 one-request/one-response
NDJSON shape, so it is not yet a completed stable external protocol.

The socket is an adapter, not an owner. One `CoreCommandRegistry` holds every
Command definition, and both public adapters — `admin.sock` and an in-process
Channel's `invoke` port — bind that same registry, so a Channel gets no smaller
catalog and no private door. Each domain declares its own Commands beside the
code that owns the fact.

The current namespaces are `teammate.*`, `team.*`, `workflow.*`, `dispatcher.*`,
and `scheduler.cron.*`, plus the two transport Commands `mcp.describe` and
`mcp.toolcall`. There is no `collaboration_space.*` namespace and no
`channel.invoke_tool`: a Channel's tools are reached through its own MCP
delegate, and dispatcher declarations remain config-owned rather than mutable
through `dispatcher.add` or `dispatcher.remove`.

Admin callers may pass strictly validated `skill_sources` when calling
`teammate.spawn` or `team.create`. These are additional runtime-neutral skill
roots, not replacements for Dreamux's required role roots. Core requires each
custom root to be an existing readable absolute directory, persists its
canonical realpath, removes duplicate roots, and rejects direct-child skill
name collisions. TeamLeader creation also fences the bundled `team-workflow`
and shared `workflow` skill names so custom roots cannot replace required
coordination capabilities. The stored roots are restored when that TeamMate,
team member, or TeamLeader is rebuilt. The MCP adapters neither advertise nor
forward this parameter.

Key source:

- `/packages/dreamux/src/command/`
- `/packages/dreamux/src/admin/socket.ts`
- `/packages/dreamux/src/admin/protocol.ts`
- `/packages/dreamux/src/agent-runtime/skill-sources.ts`
- `/packages/dreamux/src/service/team-collection/commands.ts`
- `/packages/dreamux/src/service/teammate-collection/commands.ts`

## Channels And Feishu

The Channel provider owns provider-specific session behavior. The built-in
Feishu provider (`builtin:feishu`) lives in
`/packages/channel/feishu-channel/`; it owns long-connection handling, access
and mention gates, `/introduce`, peer-bot trust state, inbound formatting,
COT presentation state, target resolution, and its `reply` / `react` /
`list_chat_bots` tool surface.

The Feishu session classifies raw chat and sender identity exactly before bot
observation, `/introduce`, pairing, or delivery. V3 `group.allow_chats` is the
trusted-human-group list under either non-block group policy after the global
mention gate; an unlisted `follow-user` chat retains the `dm_policy` sender
path. `/introduce` remains sender-scoped and does not inherit that ordinary
delivery authority.

Core gives each channel that publishes tools one ordinary MCP delegate and asks
the provider's own capability to `describe` a catalog per caller, freezing it for
one runtime generation. The provider's neutral descriptor carries standard MCP
title, description, input schema, optional output schema, annotations, and
optional icon metadata without importing the MCP SDK. Core validates catalogs
and schemas, then forwards provider arguments and canonical results without
interpreting their fields, and runs no egress gate of its own: it neither
resolves a target out of a provider's tool arguments nor holds proof that a
message belongs to one. Every call carries the scope Core baked into the lease —
dispatcher id, channel id, and the caller — and the Channel owns its own access
rules. There is no sessionless Feishu tool; a channel's MCP capability is taken
from the built instance, which exists from creation rather than from connection.

Everything a Channel reaches Core through is the `ChannelCorePort`: the shared
Command invoker and one read-only, dispatcher-scoped event source. A Channel
names a Command, hands it a payload, and gets one answer; both public adapters
bind the same registry, so a Channel gets no smaller catalog and no private door.
The event source is live-session-only and best-effort, not a historical state
surface, and is revoked before session close on stop or failed start.

Core's neutral conversation projection is injected into the dispatcher agent
and team-scoped entity construction paths. It turns sanitized runtime
activity and EntityTurn lifecycle facts into display-only `turn.submitted`,
`turn.message`, `turn.tool_call`, and exactly-once `turn.settled` events. A
team-less dispatcher scope requires a frozen Channel origin; TeamLeaders and
Team members publish, while team-less dispatcher-spawned TeamMates do not. The
Feishu session consumes dispatcher and TeamLeader facts as
conversation-anchored COT cards: inbound messages are primary, while a
TeamLeader's latest same-target Reply receipt may anchor the next card and its
team-group binding notification is the pre-inbound fallback. Staleness fences
prevent late callbacks from reviving closed or replaced state, and dispatcher
state remains isolated per chat and turn. Projection and card I/O are fail-open
relative to turn admission, settlement, completion delivery, and shutdown.
Automatic received/in-progress reactions are removed; the explicit
model-facing `react` tool remains.

Read [Channel runtime](channel-runtime.md) first, then the domain contracts:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Feishu pairing access](../domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

## Teams And TeamMates

The Dispatcher Service owns TeamMate and Team state. TeamMates are named,
semi-resident agents. `spawn` creates one, `send` submits follow-up turns and
reopens closed agents, and read tools (`history`, `list`, `status`, `last`) do
not start a runtime.

Agent entity state — identity, runtime state, transcript read coordination, and
the shared types/name validation — lives in the neutral
`/packages/dreamux/src/service/agent-entity/` layer. It is path-based and
role-agnostic: `DispatcherService` builds one shared `AgentIdentityStore` at
construction and injects it into the dispatcher agent, the dispatcher-scope
`TeammateCollection`, and each Team's `TeamCollection` / `TeamService` / member
`TeammateCollection`. Collections never self-build the store (PR #282
owner-boundary fix). Detailed conversation history is not a Dreamux state
store: `TeammateCollection.last()` reads identity, resolves the selected
`AgentRuntimeProvider`, and delegates a bounded cold `readRecentActivity()`
without materializing an entity or starting a runtime. `list` and `history` apply the
same dispatcher/team role predicate as targeted reads before projecting any
physically discovered identity.

Team creation takes `name_prefix` and returns a concrete `team_name` with a
4–8 character random suffix. The Team's own `record.json` is the claim: publishing
it is an exclusive create, and that create is the whole acceptance protocol.
Before it the candidate name is free and a caller that loses the race chooses
another; after it the record owns the name for good, so closed and
not-yet-materialized concrete names are never reused. There is no separate claim
file. Generated TeamLeader, ordinary TeamMate, and Team-member names use the
same 4–8 character suffix contract. `AgentIdentityStore.allocateName()` checks
the persisted dispatcher-global entity namespace before selection; identity
creation uses an atomic no-clobber write. Agent naming adds no transient
reservation queue or permanent claim file.
Later Team lifecycle operations are addressed by that returned `team_name`.
Binding a conversation to a Team is not a Team capability at all: routing is the
Channel's own decision, made with that Channel's tools, so Team MCP has no
`bind_channel` and no `transfer_back`. The Team MCP is caller-scoped:

- dispatchers see `create`, `send`, `list`, `status`, `history`, and
  `dissolve({ team_name, note, force? })`;
- TeamLeaders see exactly one tool, `dissolve({ note, force? })`, which derives
  its Team from the MCP descriptor and accepts no Team selector. There is no
  `close` alias and no provider-specific branch.

Both dissolve forms answer `{ accepted, team_name, status: "submitted" }` and
never report the outcome. Peer Team send remains future work; TeamLeaders still
use their scoped TeamMate MCP to send to members.

Each `TeamService` directly builds and holds its TeamLeader `TeammateService`
through `/packages/dreamux/src/service/team-service/leader-agent.ts`, using the
same dispatcher-owned identity store, worktree manager, and
completion-delivery policy that its owning `TeamCollection` injects. The
per-team `TeammateCollection` is members-only: it spawns and caches team members
under `team/<team>/teammate/<name>/`, while the TeamLeader lives at the team
root and is never cached in the collection's entity map.

`TeammateService` is the sole lifecycle command owner for every dispatcher
agent, TeamMate, TeamLeader, and Team member. It owns mutation admission, its
process-local Workflow lock, raw runtime authority, in-process Turn objects,
terminal outcome selection, bounded completion delivery, close single-flight,
and committed retirement fact.
`TeammateCollection` owns scoped construction, canonical per-name
materialization, cache subscription, roster queries, and read projection. A
close fact lets the Collection remove only its own exact cached reference; the
Collection does not run entity close steps or a runtime-only shutdown sweep.

One accepted send is one provider-owned `RuntimeSubmission` plus one
entity-owned `Turn`. Providers create an immutable `RuntimeCompletion` at each
real native result boundary and settle the related submissions with it: folded
sends settle with the same completion object, queued sends settle with distinct
completions in provider order, and stop without an observed final result
settles as `stopped` with no completion. The first terminal outcome is
snapshotted into the object-owned latch, and delivery flows through the core
`completion-router`, which delivers at-most-once per producer, completion
token, and recipient while preserving provider order — never keyed by native
ids, completion text, or slot heuristics. Providers report live assistant/tool
activity through the submission's synchronous activity sink; transcripts remain
cold history only. Conversation-bearing entities may feed that activity into the
live, non-persistent conversation display projection. Dreamux persists no Turn
archive or rolling conversation projection. Service receipts, Workflow records,
completion routing, and identity state do not carry a Turn id for in-process
correlation; the Channel display event surface carries one process-local
`turn_id` solely to correlate a presentation with its lifecycle.

The runtime checkpoint persists the provider-owned session id plus an optional
opaque `transcript_locator`. Direct TeamMate `spawn` and `send` receipts expose
that validated canonical native path as `transcript_path`; list, status,
history, `last`, Workflow, Team, Channel, completion delivery, logs, and metrics
do not. `last` returns provider-neutral bounded message/tool blocks, an opaque
backward cursor, and truncation state. Existing per-entity `turn.jsonl` files
are inert residue: Dreamux does not create, stat, list, open, validate, repair,
migrate, warn about, or automatically delete them.

The two built-in transcript readers keep native schemas, discovery rules,
locator validation, cursor envelopes, and typed provider errors inside their
runtime packages. Neutral byte/hash/safety mechanics — fixed source/output
bounds, transcript digest validation, bounded discovery accounting, exact
positional reads, deterministic rendering, and lexical path containment — are
single-sourced in `/packages/dreamux-utils/src/transcript.ts`.

A Team's dissolve belongs to that Team, and it is a submission rather than a
persisted operation. `TeamService.dissolve` answers
`{ accepted, team_name, status: "submitted" }` as soon as the Team owns the one
background task that will stop it, close it, and reclaim its checkout; a second
submission joins the first, and a refused one can be asked again. Nothing about
the operation is written down, so a process that dies mid-dissolve simply leaves
an open Team whose children reopen lazily.

The Team holds one work fence, and the fence *is* the operation: it goes up the
moment a dissolve is submitted, before the first await, and refuses new work
rather than queueing it. From that point every admitted caller operation is
refused — Dispatcher and Channel send, TeamLeader member/Workflow mutation, Team
scheduler mutation and fire, member-completion injection — and permanently so
once the record says closed; reads stay available. A failure lowers the fence
again and the Team stays open.

Behind the receipt, `TeamClosing` runs one order. A Dispatcher-requested
dissolve calls the non-destructive `WorktreeManager.assessCleanup()` first,
while nothing has stopped, so a refusal costs the Team nothing; a TeamLeader
cannot ask that about itself, so it stops its members first and then asks while
still alive to be told. `force` overrides the refusal, never the question. Then
Workflow admission closes, the scheduler stops, members and the leader stop and
close, and the assessment repeats now that nothing is running — that second
answer is the only one a destructive reclaim may act on. The single record write
that commits `closed`, `closed_at`, the note, and the worktree fact is what makes
the Team closed; the Team's cron store is discarded only after it, and a failure
before it reopens admission instead.

Assessment checks only dirty and unmerged state; it does not enumerate refs or
walk repository history. `cleanup: keep` and non-managed outcomes are terminally
retained. Clean managed `delete-on-close` cleanup calls non-forced
`git worktree remove <path>` and preserves the managed branch and its commits;
branch/ref deletion is not part of Team dissolve.

Only the physical reclaim outlives the process. A checkout that could not be
removed is committed as `cleanup-pending` with the caller's
`worktree_cleanup_force` authorization, and startup scans closed records for that
pair and finishes each one from the record alone — no Team is materialized, each
reclaim is launched rather than awaited so a slow Git cannot hold up dispatcher
start, and a failure leaves the same pending fact for the next start instead of a
retry ledger. A host shutdown is not a dissolve: it releases the runtime
authority this process took and writes nothing durable.

Key source:

- `/packages/dreamux/src/service/agent-entity/`
- `/packages/dreamux/src/service/teammate-collection/`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`
- `/packages/dreamux/src/service/team-service/closing.ts`
- `/packages/dreamux/src/service/team-collection/worktree-cleanup.ts`
- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux/src/service/team-collection/mcp-delegate.ts`

## Dynamic Workflows

Dynamic Workflow is a caller-scoped background orchestration capability on the
existing TeamMate MCP. Each `DispatcherService` owns one dispatcher-scope
`WorkflowService`, and each `TeamService` owns one Team-scope service. A live
`WorkflowRun` owns its durable record, append-only journal, supervised runner
child, and every fresh TeamMate it creates.

The runner compiles one trusted top-level script dialect and evaluates a private
async closure in a `node:vm` context, communicating only over its parent IPC
channel. The workflow-service compiler uses the package's direct production
`acorn` dependency. The first statement must be one recursively plain literal
`export const meta`; imports, pre-meta executable statements, default exports,
and every other export are rejected. The remaining source is the executable
body, with original body line numbers preserved in runtime stacks. Metadata
accepts optional string `whenToUse` and phase objects shaped as
`{ title, detail?, model? }`; phase `model` is inert metadata and does not select
a runtime model. Unknown recursively plain literal metadata keys are accepted
and currently ignored.

The parent sends `run_start`, `agent_result`, and `abort`; the runner sends
`agent_start`, progress `emit` events, and one `run_result`. Agent submission
re-enters the owning dispatcher admission drain or TeamLeader generation lease.
Every Agent call records its materialization promise immediately, retains the
restricted locked TeamMate handle, and then retains the concrete `Turn` returned
by submission. Intermediate Agent results await that object directly; no settle
callback or Turn lookup map is involved. The run's terminal completion captures
the original caller and delivers through the shared completion-routing path.
`workflow_run` still creates the durable run and captures terminal delivery
before runner startup, so compilation, dialect, syntax, and metadata failures
become durable asynchronous failed runs after the immediate `{ run_id }`
receipt. The durable `script_hash` remains over original source.

`workflow_run.args` is an optional direct JSON value. MCP and admin pass the
received object, array, string, finite number, boolean, or `null` through
unchanged; omitted args reach the runner as `undefined`. A private
Workflow-service validator rejects non-JSON values, cycles, sparse/extended
arrays, and non-plain objects before durable run creation. Dreamux never parses
JSON-looking strings.

Every workflow-owned TeamMate receives an operation-owned workflow-role append
prompt at its creation boundary. `schema` remains a separate value passed
through the runtime-neutral `outputSchema` turn input. The run parses a
successful structured result once with `JSON.parse`; unsupported runtime
capability, an empty result, or invalid JSON after runtime-reported success
fails that individual `agent()` call loudly through `agent_result.error`.
Directly awaiting one of those errors rejects the workflow entry; `parallel()`
and `pipeline()` preserve their item-level `null` containment.

Workflow-service owns run-concurrency admission and rejects invalid values
before creating a durable run. The runner enforces bounded helper inputs
atomically before starting work, and the service enforces a bounded agent-call
lifecycle. Every pipeline stage receives
`(previousResult, originalItem, index)`. See
[Dynamic Workflow usage](dynamic-workflow-usage.md#53-exact-limits) for the
single user-facing owner of the exact numeric limits.

Natural terminal and explicit stop use one retryable close-first pipeline.
`workflow_stop` immediately fences Agent creation and runner messages, then
waits for bounded runner termination, joins every materialization, closes every
locked TeamMate handle, converges Agent results, commits the matching terminal
journal and record, unlocks members, runs bounded terminal delivery, and only
then returns the terminal status. A close or persistence failure keeps the run
non-terminal and retryable; it cannot report success while a borrowed runtime
remains live. Startup completes a running record from an already-committed
terminal journal fact when present and otherwise marks the interrupted run
stopped; Workflow execution and completion delivery are not replayed.

Key source:

- `/packages/dreamux/src/service/workflow-service/`
- `/packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`
- `/packages/dreamux/src/service/teammate-collection/index.ts`
- `/packages/dreamux/src/service/teammate-collection/mcp-delegate.ts`
- `/packages/dreamux-utils/src/supervised-child.ts`

## Collaboration Spaces

There is no Collaboration Space service in Core, and no Core state describing
one. A Collaboration Space is a Channel product flow: a registered container
whose child conversations are provisioned into Teams automatically. Only the
Channel knows what a container is, so the Channel owns the policy, the
provisioning, and the durable record of both.

For Feishu that means a registered topic group. Its policy and its installed
bindings live in the Channel's own routing document under the per-dispatcher
state root, and its four Dispatcher-only tools — `bind_collaboration_space`,
`unbind_collaboration_space`, `get_collaboration_space`, and
`list_collaboration_spaces` — are ordinary provider tools in the caller-scoped
Feishu catalog. Core sees only what any Channel does: `team.create` to make a
Team, `team.submit` to reach one, and the Team's own `team_name` coming back.

Provisioning is process-local by design. It runs as an in-memory sequence, holds
no saga, phase, outbox, or recovery cursor, and persists nothing until a binding
is actually installed. Losing the process loses the unfinished operation: a
restart recovers only the already-persisted Team records, Space policies, and
completed bindings, and runs no resume scan. A Team that was created but never
bound stays as an accepted orphan, and a first message that was not submitted
before the crash is lost — a later message follows the still-persisted Space
policy normally.

Unbinding a Space releases the Channel's routing and provisioning ownership. It
does not delete the external container and does not dissolve Teams that were
already provisioned; dissolving one of those is an ordinary `team.dissolve`.

`DispatcherService` owns one in-process `DispatcherCoreEventBus` and the Channel
event sources leased from it. Team, agent-identity, and turn owners publish only
allowlisted post-write DTOs through a narrow capability; routing produces no core
event, because routing is the Channel's own fact and Core has none to publish
back. Delivery is a dispatcher-wide live broadcast with no queue,
eventual-delivery guarantee, or historical query. Channel sessions receive no raw
bus or store, and every source is revoked before session close.

Scheduler ownership is unaffected: the dispatcher has its dispatcher scheduler,
and each `TeamService` owns the TeamLeader scheduler it starts.

Key source:

- `/packages/channel/feishu-channel/src/feishu-provisioning.ts`
- `/packages/channel/feishu-channel/src/routing/document.ts`
- `/packages/channel/feishu-channel/src/tools/space-tools.ts`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/legacy-state.ts`

## State, Cache, Run Files, And Logs

Path construction belongs in `/packages/dreamux/src/platform/paths.ts`. The
current ownership map is in [State and paths](state-and-paths.md).

High-level split:

- `~/.dreamux/config.json`: operator-owned config.
- `~/.dreamux/run/`: volatile run files and socket fallback root.
- `~/.dreamux/state/`: durable dispatcher, Feishu, Team, and TeamMate state;
  most documents are server-owned, while Feishu `access.json` has an explicit
  mixed field-ownership contract.
- `~/.dreamux/cache/`: rebuildable cache such as completion spill files and
  Feishu attachments.
- `~/.dreamux/logs/`: server, runtime, and MCP shim logs.
- `~/.codex/`: Codex-owned global auth/config/memory, not Dreamux state.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`

## Bundled Skills

Dreamux ships bundled skills under `/packages/dreamux/skills/`. Core selects
required skill sources by role and may compose authorized admin-supplied roots:

- Dispatcher roles receive dispatcher workflow and maintenance skills;
  TeamLeader roles receive the Team workflow skill. Both roles also receive the
  shared Dynamic Workflow skill.
- `dreamux-maintenance` uses progressive disclosure: a concise root routes to
  seven one-level owners for service lifecycle, the host envelope, three
  built-in provider configs, V3 Feishu access, and managed-daemon self-upgrade.
  The root and non-upgrade references are current-state-only. The upgrade owner
  is a narrow generic SOP that reads concrete actions from the validated staged
  target's changelog and routed references rather than embedding release
  history.
- Ordinary TeamMate and team-member roles receive none by default.
- Additional roots supplied through admin creation are persisted with the
  agent identity. TeamLeader launch always prepends the required bundled role
  root before those additions; custom roots cannot replace or disable it.
- Core emits role roots (`skills/dispatcher/` or `skills/team-leader/`) plus
  `skills/shared/`, never per-skill selector paths. Codex passes those roots
  directly to `skills/extraRoots/set` so root scanning cannot expose sibling
  role skills.
- Claude Code materializes a runtime-owned add-dir root containing
  `.claude/skills/<name>` entries for each skill under the selected root, then
  passes that materialized root through `--add-dir`.

Dreamux does not install bundled skills into dispatcher workspaces during
onboard or runtime startup.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Runtime Prompt Inputs

The Agent Runtime create context has one provider-facing prompt surface:
`systemPrompt`. It carries two canonical forms:

- `replace`: full role instructions for runtimes that replace their native base
  prompt.
- `append`: ordered focused role-guidance fragments to add on top of native/base
  instructions.

Runtime adapters select at most one prompt form from `systemPrompt`:

- if `replace` is present and the runtime supports replacement prompts, use
  `replace`;
- otherwise, if `append` is present, use the append flow;
- otherwise, if only `replace` is present and the runtime does not support
  replacement prompts, leave prompt customization unchanged.

Replacement prompt support is a runtime-adapter implementation fact, not a new
`AgentRuntimeCapabilities` field or an MCP-discoverable feature.

Dispatcher launches provide both `replace` and `append` as alternate canonical
representations of the same dispatcher role guidance. Replace-native runtimes
such as Codex use the full dispatcher prompt and do not also inject the
dispatcher append text, because that would duplicate the same role guidance.
Append-native runtimes that cannot use `replace` fall through to the focused
dispatcher append guidance.

Codex `replace` maps to `baseInstructions`, so Dreamux's dispatcher replacement
prompt must carry both the Dispatcher role contract and the non-coding parts of
Codex's current model-selected base prompt that would otherwise be lost. The
source to compare against is the current Codex model catalog entry
(`models-manager/models.json`, using the selected model's `base_instructions` /
`model_messages`; currently GPT-5.5 when that is selected or default), not an
older per-version prompt markdown file. The dispatcher replacement prompt keeps
personality/tone, simple terminal-request handling, planning-tool guidance,
review-answer shape, progress updates, unexpected-local-change and
destructive-command cautions, and concise final-answer behavior, while leaving
code-editing and frontend-production guidance out of the Dispatcher role.
Append-native runtimes keep their native base prompt, so their dispatcher append
guidance remains a short role delta.

Every TeamLeader receives one default append fragment identifying it as the
TeamLeader for that Dreamux Team. TeamLeader, TeamMate, and team-member identity
guidance from MCP `identity` is rendered from the persisted
`TeamMateIdentity.identity_prompt` and re-supplied as additional append-only
`systemPrompt.append` fragments on each runtime launch/relaunch that rebuilds the
create context: initial create/spawn, close/reopen, process restart, Team
rebuild, and runtime resume.
Prompt-policy ownership stays outside the generic `TeammateService` runtime
container. `TeamService` supplies the TeamLeader default and TeamLeader identity
fragments. Owned operations may supply host-private append fragments through
their collection creation options; Dynamic Workflow uses that capability for
its workflow-role contract without widening the public Agent Runtime ABI.
`TeammateCollection` is the single TeamMate/member entity-construction boundary:
it composes operation-owned append fragments first and the persisted
caller-provided identity fragment second, then supplies the ordered result in
the runtime create context. `outputSchema` remains a separate neutral turn
field, not prompt text.

Runtime adapters must implement selected `systemPrompt.append` semantics. Claude
Code folds append prompt fragments into `--append-system-prompt` before the
resident session is created, wrapping each fragment in its own
`<system-reminder>` block. Codex maps selected `systemPrompt.replace` to
`baseInstructions`; when append is selected, it renders each append fragment
inside its own `<developer-reminder>` block and supplies the joined prompt as
Codex `developerInstructions` on `thread/start`, `thread/resume`, and resume
fallback start.
Both built-in adapters escape XML text content inside each wrapper so one append
fragment cannot create or modify sibling blocks.

Dreamux-owned turns that are not channel messages use the provider-facing
`completionInput({ text, sourceId? })` plain text input. Channel-originated
messages are the only callers of `channelInput`, which is where runtime-specific
channel/XML rendering belongs. Runtime providers do not receive
`CompletionEnvelope` or a `systemInput` reason discriminator.

Key source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/provider.ts`

## Disabled Runtime Features

The Agent Runtime create context includes an optional neutral
`disableFeatures?: readonly string[]`. Core emits only neutral feature-group
names; each runtime maps the names it understands and ignores the rest.

Current names:

- `userInterrupt`: emitted for every agent at the shared
  `createTeammateService` construction boundary (core-wide rule). It disables the
  model-facing "ask the user a question" tool, which in a channel-only
  environment would wedge a turn waiting for an out-of-band answer. Claude Code
  maps it to the `AskUserQuestion` disallowed tool; Codex needs no code because
  its `request_user_input` tool only exists behind the
  `experimental_request_user_input` config feature, which Dreamux's authored
  launch config never sets. The guarantee is at the Dreamux-authored-args level
  on both runtimes: operator `extra_args` is a raw passthrough escape hatch that
  Dreamux does not police (an operator who deliberately re-enables the tool —
  Claude `--allowedTools`, Codex `-c experimental_request_user_input=true` — owns
  that choice), so this is symmetric, not a Codex-specific gap.
- `cron`: emitted only for dispatcher and TeamLeader launches, matching the
  roles that receive Dreamux's cron MCP. Claude Code maps it to native cron
  tool disallow args; Codex ignores it because Dreamux cron is an MCP
  descriptor, not a Codex-native feature.

Claude Code merges all requested features' tools into a single
`--disallowedTools` flag.

Key source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`

## Related Docs And Decision Trail

- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Entity-owned TeamMate lifecycle and object Turns](../decisions/entity-owned-teammate-lifecycle-and-object-turns.md)
- [Feishu COT conversation display](../decisions/feishu-cot-conversation-display.md)
- [Domain knowledge](../domains/README.md) for stable provider, channel,
  orchestration, state/file, scheduled-work, and repository contracts
- [Runtime run root](../decisions/runtime-run-root.md)
- [Agents config normalization](../decisions/agents-config-normalization.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
- Historical proposal:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
