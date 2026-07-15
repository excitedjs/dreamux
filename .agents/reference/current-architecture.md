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

The operator config is JSON at `~/.dreamux/config.json`.

Current file shape:

- `agents[]` declares named Agent Runtime configs.
- `dispatchers[]` declares dispatcher ids, explicit `cwd`, `channels[]`, and
  `agentRuntime`, which references an `agents[].id`.
- `dispatchers[].channels[]` entries carry a dispatcher-local `id`, a channel
  provider ref, provider-owned config, and optional Core-owned collaboration
  default-binding policy. A default binding may use static `repo` config or a
  trusted Channel-local logical repository resolver through
  `repositorySource: "channel"`.

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

The Channel seam also has an optional `task_channel_host_v1` capability. It is
separate from conversational `deliver`: a task-capable session receives a
Core-created scoped `ChannelTaskHost`, while conversational-only providers omit
the capability and remain unchanged. The public task ABI is exported only from
`@excitedjs/dreamux-types`; providers do not import Core services or stores.

Current built-ins:

- `builtin:codex` -> `@excitedjs/agent-runtime-codex`
- `builtin:claude-code` -> `@excitedjs/agent-runtime-claude-code`
- `builtin:feishu` -> `@excitedjs/feishu-channel`

Key source:

- `/packages/dreamux/src/registry/`
- `/packages/dreamux/src/agent-runtime/catalog.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/registry/builtins.ts`
- `/packages/dreamux-types/src/channel-task.ts`

See also [Channel runtime](channel-runtime.md) for Channel session, target, and
provider-tool details.

## Dispatcher Runtime

Each live dispatcher owns:

- one selected Agent Runtime instance
- a map of live Channel sessions keyed by dispatcher-local `channel_id`
- provider-owned channel MCP shims for channel tools
- Team, TeamMate, and collaboration-space MCP shims owned by Dreamux core
- a `TaskChannelHostCollection` when a configured or recoverable channel has
  durable task state

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

The product method namespaces are `teammate.*`, `team.*`, and
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
skill name so custom roots cannot replace the required Team workflow. The
stored roots are restored when that TeamMate, team member, or TeamLeader is
rebuilt. The MCP adapters neither advertise nor forward this parameter.

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

Dreamux core injects the generic `channel-mcp` shim and routes tool calls back
to the live Channel session or provider sessionless handler.

Read [Channel runtime](channel-runtime.md) first, then the domain contracts:

- [Feishu introduce](../domains/feishu-introduce.md)
- [Non-blocking dispatcher inbound](../domains/non-blocking-dispatcher-inbound.md)

## Task Channel Host

Strict task delivery is a Core admission path, not a conversational message.
It derives a canonical task target from dispatcher, channel, container, task,
and attempt identity; commits a durable receipt before provisioning; lazily
reuses the generic collaboration-space default-binding hook; provisions one
Team and managed worktree; and submits execution only through an Agent Runtime
that supports `durable_task_submission_v1`. There is no Dispatcher-agent or LLM
fallback.

`TaskHostStore` is the sole durable owner for task phase, binding/provisioning
checkpoints, runtime submissions and settlement ACKs, explicit business
terminal, finalizer progress, host events, stream ACKs, and tombstones. It uses
a checksummed per-channel transaction WAL plus rebuildable projections. The
generic collaboration route remains authoritative; task state keeps only the
derived claim/reconciliation checkpoint.

Core automatically derives host, task, Team, worktree, turn, and cleanup
telemetry from committed transitions. The Channel session consumes one scoped,
monotonic host event stream through its event sink. Replies, reactions, provider
tools, admin-socket polling, prompts, and TeamLeader discipline are not state
synchronization paths.

Fresh or incompatible provider cursors must stage a complete immutable paged
snapshot before the push sink can attach. Compatible cursors replay from the
last consecutive prefix. Session fences revoke superseded handles and late
sink acknowledgements. Startup discovers durable manifests before provider
session start, repairs provision/finalizer/ACK crash windows, and can finish
already-terminal cleanup without opening a provider transport.

Key source:

- `/packages/dreamux/src/service/channel-task-host/`
- `/packages/dreamux/src/service/dispatcher-service/channel-session-start.ts`
- `/packages/dreamux/src/service/task-runtime-submission.ts`
- `/packages/dreamux/src/service/team-collection/task-provisioning.ts`
- `/packages/dreamux-types/src/channel-task.ts`
- `/packages/dreamux-types/src/agent-runtime.ts`

Decision trail: [Provider-neutral Task Channel Host](../decisions/task-channel-host.md).

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
never self-built inside a collection (PR #282 owner-boundary fix).

Team lifecycle is addressed by `team_name`. Channel binding is a Team MCP
capability. The Team MCP is caller-scoped:

- dispatchers see lifecycle/read tools plus
  `send({ team_name, prompt, intent? })` to submit a turn to that Team's
  TeamLeader,
  `bind_channel({ team_name, channel_id?, meta })` and
  `transfer_back({ channel_id?, meta })`
- TeamLeaders see only scoped `transfer_back({ channel_id?, meta })`

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

Key source:

- `/packages/dreamux/src/service/agent-entity/`
- `/packages/dreamux/src/service/teammate-collection/`
- `/packages/dreamux/src/service/team-collection/`
- `/packages/dreamux/src/service/team-service/`
- `/packages/dreamux/src/service/channel-service/`
- `/packages/dreamux/src/service/channel-binding/`
- `/packages/dreamux/src/mcp/team-mcp.ts`

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
inactive targets. Stop/shutdown closes admission, drains both task sets, and
then sweeps every materialized Team runtime before closing the rest of the
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
`container` membership auto-bind without an explicit MCP call. Dissolve releases
Dreamux routing/provisioning ownership without deleting the external container
or dissolving already provisioned Teams, and it prevents implicit auto-rebind of
that known unbound space. Team cleanup still belongs to `TeamService.dissolve`
when a target lifecycle close or explicit Team operation dissolves that Team.

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
closed. Public target views expose a fixed failure summary; raw downstream
errors remain local diagnostics and are not returned through MCP/status views.

Scheduler ownership does not move into collaboration spaces. The dispatcher has
its dispatcher scheduler, and each `TeamService` owns the TeamLeader scheduler it
starts through the existing Team path.

Key source:

- `/packages/dreamux/src/service/collaboration-space/`
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
- `~/.dreamux/state/`: durable server-owned dispatcher, Feishu, Team, and
  TeamMate state, including per-channel task-host WALs and projections.
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

- Dispatcher roles receive Dreamux workflow and maintenance skills; TeamLeader
  roles receive the Team workflow skill.
- Ordinary TeamMate and team-member roles receive none by default.
- Additional roots supplied through admin creation are persisted with the
  agent identity. TeamLeader launch always prepends the required bundled role
  root before those additions; custom roots cannot replace or disable it.
- Core emits only role-specific skill roots (`skills/dispatcher/` and
  `skills/team-leader/`), never per-skill selector paths. Codex passes those
  roots directly to `skills/extraRoots/set` so root scanning cannot expose
  sibling skills from another role.
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
- Historical proposal:
  [plugin/provider architecture proposal](../archive/proposals/plugin-provider-architecture.md)
