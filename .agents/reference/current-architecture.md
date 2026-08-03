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
injection, role MCP assembly, completion routing — stay on `DispatcherService`;
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
- a map of live Channel sessions keyed by dispatcher-local `channel_id`
- provider-owned channel MCP shims for channel tools
- Team, TeamMate, and collaboration-space MCP shims owned by Dreamux core

The first declared channel is the primary/default egress channel. A dispatcher
with multiple channel providers can route and egress by `channel_id`; with only
`builtin:feishu` wired today, normal configs have one Feishu channel.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`

## Admin Control Plane

The owner-only local `admin.sock` is Dreamux's target external control-plane
entry point. Its current protocol is still the v0 one-request/one-response
NDJSON shape, so it is not yet a completed stable external protocol.

The product method namespaces are `teammate.*`, `team.*`, `workflow.*`, and
`collaboration_space.*`. Scheduler methods remain `scheduler.cron.*`, and
provider tool calls use `channel.invoke_tool`. No `mcp.*` aliases are
registered, and dispatcher declarations remain config-owned rather than
mutable through `dispatcher.add` or `dispatcher.remove`.

Dreamux-owned MCP shims call those canonical admin methods but retain ownership
of model-facing schemas, caller-specific visibility, and scope projection. The
admin registry independently enforces domain and caller safety; its errors use
product/control-plane wording rather than describing MCP visibility.

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

- `/packages/dreamux/src/admin/methods.ts`
- `/packages/dreamux/src/admin/params.ts`
- `/packages/dreamux/src/admin/socket.ts`
- `/packages/dreamux/src/agent-runtime/skill-sources.ts`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`
- `/packages/dreamux/src/mcp/team-mcp.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`

## Channels And Feishu

The Channel provider owns provider-specific session behavior. The built-in
Feishu provider (`builtin:feishu`) lives in
`/packages/channel/feishu-channel/`; it owns long-connection handling, access
and mention gates, `/introduce`, peer-bot trust state, inbound formatting,
reaction state, target resolution, and its `reply` / `react` /
`list_chat_bots` tool surface.

The Feishu session classifies raw chat and sender identity exactly before bot
observation, `/introduce`, pairing, or delivery. V3 `group.allow_chats` is the
trusted-human-group list under either non-block group policy after the global
mention gate; an unlisted `follow-user` chat retains the `dm_policy` sender
path. `/introduce` remains sender-scoped and does not inherit that ordinary
delivery authority.

Dreamux core injects the generic `channel-mcp` shim and routes tool calls back
to the live Channel session or provider sessionless handler.

Core also supplies optional session-scoped collaboration capabilities through
`ChannelRoutes`: synchronous ensure of an existing collaboration target,
exact-route delivery directly to its current TeamLeader, and a dispatcher-local
read-only core fact source. Providers cannot select repository/cwd/workspace
mode or claim dispatcher/channel authority through these methods. Exact
delivery never falls back to another target or the dispatcher agent, and the
fact source is live-session-only and best-effort rather than a historical state
surface. Every Channel session generation receives revocable strict-route and
event-source leases; stop or failed start revokes them before session close.

Read [Channel runtime](channel-runtime.md) first, then the domain contracts:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Feishu pairing access](../domains/feishu-pairing-access.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

## Teams And TeamMates

The Dispatcher Service owns TeamMate and Team state. TeamMates are named,
semi-resident agents. `spawn` creates one, `send` submits follow-up turns and
reopens closed agents, and read tools (`history`, `list`, `status`, `last`) do
not start a runtime.

Agent entity state — identity, turn archive, runtime state, and the shared
types/name validation — lives in the neutral
`/packages/dreamux/src/service/agent-entity/` layer. It is path-based and
role-agnostic: `DispatcherService` builds one shared `AgentIdentityStore` +
`AgentTurnsStore` pair at construction and injects it into the dispatcher
agent, the dispatcher-scope `TeammateCollection`, and each Team's
`TeamCollection` / `TeamService` / member `TeammateCollection`. Stores are
never self-built inside agent collections (PR #282 owner-boundary fix).

Team creation takes `name_prefix` and returns a concrete `team_name` with a
4–8 character random suffix. Core publishes a fully written
`name-claim.json` in the Team namespace through an atomic no-clobber hard link
before any Team or collaboration-target side effect; the claim survives restart
and dissolve, so closed and not-yet-materialized concrete names are never
reused. Generated TeamLeader, ordinary TeamMate, and Team-member names use the
same 4–8 character suffix contract. `AgentIdentityStore.allocateName()` checks
the persisted dispatcher-global entity namespace before selection; identity
creation uses an atomic no-clobber write. Agent naming adds no transient
reservation queue or permanent claim file.
Later Team lifecycle and routing operations are addressed by that returned
`team_name`.
Channel binding is a Team MCP capability. The Team MCP is caller-scoped:

- dispatchers see lifecycle/read tools plus
  `send({ team_name, prompt, intent? })` to submit a turn to that Team's
  TeamLeader,
  `bind_channel({ team_name, channel_id?, meta })` and
  `transfer_back({ channel_id?, meta })`
- TeamLeaders see exactly `dissolve({ note })`, scoped
  `bind_channel({ channel_id?, meta })`, and
  `transfer_back({ channel_id?, meta })`. TeamLeader bind can claim only an
  unowned target (or return the exact explicit binding idempotently); it cannot
  replace another owner or consume a collaboration-managed route. Self-dissolve
  derives both Team and leader generation from the MCP descriptor and maps to
  the same `team.dissolve` admin method as Dispatcher
  `dissolve({ team_name, note })`; it accepts no Team selector. There is no
  `close` alias or provider-specific branch.

`channel_id` defaults to the dispatcher's sole configured channel and is
required only when the dispatcher has more than one configured channel.
`meta` is provider-owned selector input; the active channel provider's schema
and results define the selector shape. Peer Team send remains future work;
TeamLeaders still use their scoped TeamMate MCP to send to members.

Each `TeamService` directly builds and holds its TeamLeader `TeammateService`
through `/packages/dreamux/src/service/team-service/leader-agent.ts`, using the
same dispatcher-owned identity store, turns store, worktree manager, and
completion router that its owning `TeamCollection` injects. The per-team
`TeammateCollection` is members-only: it spawns and caches team members under
`team/<team>/teammate/<name>/`, while the TeamLeader lives at the team root and
is never cached in the collection's entity map.

`TeamCollection` owns the single durable Team dissolve lifecycle. An accepted
operation is stored on the Team record before its receipt, carries the first
note, requester/generation, target handoffs, phase, public-safe error, attempt
count, and next retry time, and projects one process-local handle with separate
`logicalClosed` and `completed` milestones. `Team.status` stays
`starting | running | closed`; dissolve phase and worktree cleanup are separate
facts. Active same-generation requests join the stored operation, while a stale
TeamLeader generation cannot join it.

The same `TeamCollection` availability fence gates Dispatcher send, bound and
strict inbound delivery, route publication, TeamLeader member/workflow
mutations, Team scheduler mutations and final timer fire, and member-completion
injection back into the leader. Reads use a generation-checked read lease and
remain available while closing. Acceptance captures the TeamLeader plus every
live member runtime that can write the shared worktree and requires each to
provide the neutral `waitIdle()` capability. It closes workflow admission and
stops the Team scheduler before returning, waits for all captured writers, and
then repeats the non-destructive `WorktreeManager.assessCleanup()` preflight.

`TeamService` owns resource shutdown and propagation of the one shared worktree
identity to leader and members; `WorktreeManager` alone assesses and removes a
managed worktree. Logical close durably commits routes/runtimes closed and
`cleanup-pending` before physical deletion. Clean deletion failures retain
durable retry responsibility with bounded exponential backoff; dirty,
unmerged, unique-commit, keep, and non-managed outcomes are never force-deleted.
Dispatcher projection has a 9-second decision/result budget and an explicit
12-second MCP admin timeout; TeamLeader self-dissolve returns its durable
accepted receipt without awaiting self-termination.

Startup restores active Team fences, materializes every live writer, rechecks
idle, and resumes persisted dissolve/cleanup phases before publishing normal
Team, collaboration, Channel, workflow, or scheduler work. Shutdown interrupts
cancellable dissolve idle waits and retry timers before admitted-task drain,
but drains an active physical cleanup attempt. Interruption settles only the
process-local milestones with a typed recoverable result and leaves the durable
phase and cleanup responsibility for restart.

Key source:

- `/packages/dreamux/src/service/agent-entity/`
- `/packages/dreamux/src/service/teammate-collection/`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`
- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux/src/service/channel-binding/`
- `/packages/dreamux/src/mcp/team-mcp.ts`

## Dynamic Workflows

Dynamic Workflow is a caller-scoped background orchestration capability on the
existing TeamMate MCP. Each `DispatcherService` owns one dispatcher-scope
`WorkflowService`, and each `TeamService` owns one Team-scope service. A live
`WorkflowRun` owns its durable record, append-only journal, supervised runner
child, and every fresh TeamMate it creates.

The runner evaluates a trusted inline ES module in a `node:vm` context and
communicates only over its parent IPC channel. The parent sends `run_start`,
`agent_result`, and `abort`; the runner sends `agent_start`, progress `emit`
events, and one `run_result`. Agent submission re-enters the owning dispatcher
admission drain or TeamLeader generation lease. Each newly spawned TeamMate has
its settle route injected before runtime start, so intermediate completions
return only to the owning run. The run's single terminal completion uses the
shared `CompletionRouter` with the original caller as initiator.

`schema` is passed through the runtime-neutral `outputSchema` turn input. The
run parses a successful structured result once with `JSON.parse`; unsupported
runtime capability fails the individual `agent()` call loudly. Normal terminal
runs wait for in-flight turns, silently close and evict their owned TeamMates,
and then evict the live run entity. `workflow_stop` reserves `stopped` and
returns immediately while that natural-settle finalization continues in the
background. Dispatcher/server shutdown instead kills the runner, persists the
terminal run without waiting for agent turns, and leaves owned runtime cleanup
to the following collection-wide force-stop sweep. Startup marks durable
`running` records as `stopped`; journal replay and run resume are not
implemented.

Key source:

- `/packages/dreamux/src/service/workflow-service/`
- `/packages/dreamux/src/service/dispatcher-service/dispatcher-workflows.ts`
- `/packages/dreamux/src/service/teammate-collection/index.ts`
- `/packages/dreamux/src/mcp/teammate-mcp.ts`
- `/packages/dreamux-utils/src/supervised-child.ts`

## Collaboration Spaces

`CollaborationSpaceService` is a dispatcher-local control-plane facade for
externally created provider containers that Dreamux binds to worktree policy. It
does not have an agent runtime, does not wrap `TeammateService`, and is not a
Channel provider implementation. Space-level MCP/admin behavior stays in the
facade; target accept/provision/close state transitions live in the contained
`CollaborationTargetLifecycle`. That target worker uses the dispatcher's existing
`ChannelService` plus single dispatcher-level `TeamCollection` to provision Teams
for channel targets. Accepted background lifecycle work is tracked by
`CollaborationSpaceService`; `DispatcherService` separately tracks direct
inbound delivery/provisioning promises. Startup resumes durable `creating`,
`failed`, and `closing` target records and releases stale managed claims left on
inactive targets before any Channel session starts, so start-time strict
operations cannot race pending-target repair. Stop/shutdown closes admission,
drains both task sets, and then sweeps every materialized Team runtime before
closing the rest of the
service graph. Already accepted provisioning rechecks the shutdown fence before
Team creation, TeamLeader readiness, and route claim side effects. If a Team
create was already in flight when the fence rose, provisioning closes that new
Team before its drained promise settles. A create failure after leader launch
also stops that leader before propagating the failure. `TeamCollection` retains
ownership of partially booted services that never reached its live cache, so
shutdown can retry failed create-time cleanup. Team/member/leader stop sweeps
attempt every materialized runtime and aggregate failures instead of failing
fast after the first provider error.

The dispatcher-only `collaboration_space` MCP exposes `bind`, `dissolve`,
`status`, and `list`. Binding registers an existing external container and a
worktree policy; `repo` is optional and omitted repo follows that dispatcher's
default workspace policy. It does not call provider Channel MCP to create the
external space. A dispatcher channel may also enable core-owned
`collaborationSpace.defaultBinding` so unknown provider containers with neutral
`container` membership auto-bind without an explicit MCP call.
Collaboration-space dissolve releases Dreamux routing/provisioning ownership
without deleting the external container
or dissolving already provisioned Teams, and it prevents implicit auto-rebind of
that known unbound space. Explicit Team dissolve and collaboration target close
both join the TeamCollection-owned durable lifecycle; `TeamService` owns only
the accepted operation's logical resource close.

Binding is one process-writer-serialized store transition: the unbound check,
container uniqueness, next generation, and complete policy write commit
together. A generation never names two policies. Collaboration target records
are the durable provisioning intent, while the channel binding remains the
authoritative live route. Managed bindings carry an opaque target-generation
`claim_id`; explicit Team binds clear it. The binding store is v3; v2 rows that
already have `(channel_id, target_key)` are reused as explicit routes with
`claim_id: null` only when no open collaboration target shares that route key.
If such an overlap exists, startup/doctor fails loud because the old row could
be either explicit or collaboration-managed. Older rows without route keys still
fail loud. Provisioning, reconciliation, and explicit Team route mutation share a
`(channel_id, target_key)` lock, so intent detach and route replacement cannot
cross. Explicit bind commits the
authoritative replacement before detaching collaboration intent, so a rejected
bind leaves the managed claim intact. Reconciliation releases only the matching
claim, preserves an explicit replacement even when it uses the same Team owner
tuple, and reclaims a missing route only while the original Team is actually
routable. Route publication also holds a TeamCollection route lease. Every Team
close path raises the matching closing fence, detaches all matching collaboration
intent, transfers every owned channel route, and only then dissolves the Team;
a waiting bind or repair therefore cannot publish a route to the Team being
closed. A target-owned close persists an opaque generation handoff, accepts or
joins the Team dissolve under the target lock, releases that lock while waiting
for Team-wide quiescence, and marks the target closed only after
`logicalClosed`. The Team record can hold multiple target handoff ids; the
route sweep reacquires each target lock and checks the exact handoff against the
authoritative Team record, so mismatches detach normally. Public target views
expose a fixed failure summary; raw downstream errors remain local diagnostics
and are not returned through MCP/status views.

Strict Channel ensure and exact delivery stay on this same owner graph. Ensure
reuses `acceptAndProvisionTarget` and returns only after the active/bound target,
running Team, ready leader, local workspace, and exact claimed route agree.
Exact delivery validates the current Team/leader/claim under the existing target
and Team route fences before calling `TeamService.deliverToLeader`. Neither path
creates a new target owner, remote close surface, retained submission state, or
dispatcher-agent turn. The dispatcher gives each session start a fresh strict
route lease; revocation makes old closures return `dispatcher_unavailable`
without reaching those owners. Failed-start rollback revokes first, closes and
drains admission, then uses the existing materialized-Team runtime sweep while
leaving durable Team and target facts intact.

`DispatcherService` also owns one in-process `DispatcherCoreEventBus` and the
Channel source leases created from it. Team, identity, turn, channel binding,
and collaboration-space services remain the fact owners and publish only
allowlisted post-write DTOs through a narrow capability. Binding route events
are emitted after the channel-binding store returns a real atomic transition,
and collaboration-space events are emitted after the space store returns its
transition. Binding events intentionally use the same dispatcher-wide live
broadcast as other core events; the endpoint snapshot carries the provider ref
and opaque provider-owned metadata so the matching provider can filter and
address the notification. Bound route events are the only core events that
include the TeamLeader runtime id and runtime cwd. Channel sessions receive no
raw bus or store, and sources are revoked before session close. The bus retains
no state and provides no queue, eventual-delivery guarantee, or historical
query.

Scheduler ownership does not move into collaboration spaces. The dispatcher has
its dispatcher scheduler, and each `TeamService` owns the TeamLeader scheduler it
starts through the existing Team path.

Key source:

- `/packages/dreamux/src/service/collaboration-space/`
- `/packages/dreamux/src/service/dispatcher-core-events/`
- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/mcp/collaboration-space-mcp.ts`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`

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
container: `TeamService` supplies the TeamLeader default and TeamLeader identity
fragments, while `TeammateCollection` supplies only caller-provided TeamMate or
team-member identity fragments.

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
  `TeammateService.createAndStart` gate (core-wide rule). It disables the
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
- [Domain knowledge](../domains/README.md) for stable provider, channel,
  orchestration, state/file, scheduled-work, and repository contracts
- [Runtime run root](../decisions/runtime-run-root.md)
- [Agents config normalization](../decisions/agents-config-normalization.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
- Historical proposal:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
