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
- core-owned `channel-mcp` shims for provider-owned channel tools
- Team and TeamMate MCP shims owned by Dreamux core

The first declared channel is the primary/default egress channel. A dispatcher
with multiple channel providers can route and egress by `channel_id`; with only
`builtin:feishu` wired today, normal configs have one Feishu channel.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/index.ts`
- `/packages/dreamux/src/service/dispatcher-service/mcp-descriptors.ts`
- `/packages/dreamux/src/service/channel-service/mcp-descriptors.ts`
- `/packages/dreamux/src/mcp/channel-mcp.ts`
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

## State, Cache, Run Files, And Logs

Path construction belongs in `/packages/dreamux/src/platform/paths.ts`. The
current ownership map is in [State and paths](state-and-paths.md).

High-level split:

- `~/.dreamux/config.json`: operator-owned config.
- `~/.dreamux/run/`: volatile run files and socket fallback root.
- `~/.dreamux/state/`: durable server-owned dispatcher, Feishu, Team, and
  TeamMate state.
- `~/.dreamux/cache/`: rebuildable cache such as completion spill files and
  Feishu attachments.
- `~/.dreamux/logs/`: server, runtime, and MCP shim logs.
- `~/.codex/`: Codex-owned global auth/config/memory, not Dreamux state.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`

## Bundled Skills

Dreamux ships bundled skills under `/packages/dreamux/skills/`. Core selects
skill sources by role:

- Dispatcher roles receive Dreamux workflow and maintenance skills; TeamLeader
  roles receive the Team workflow skill.
- Ordinary TeamMate and team-member roles receive none by default.
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
