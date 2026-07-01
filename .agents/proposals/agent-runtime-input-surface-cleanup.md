# AgentRuntime input surface cleanup

- **Status:** Draft for review
- **Date:** 2026-07-01
- **Related PR:** [#272](https://github.com/excitedjs/dreamux/pull/272)
- **Affects:** `@excitedjs/dreamux-types`, Agent Runtime providers,
  dispatcher and TeamMate launch paths, scheduler delivery, completion routing,
  bundled skill injection

## Intent

Keep the provider-facing AgentRuntime contract minimal and neutral for external
coding-agent runtimes.

Dreamux core owns agents, teams, channel routing, scheduler triggers,
completion routing, identity records, MCP surfaces, and role-based feature
selection. A runtime provider owns how one native coding agent accepts a plain
text turn, how it renders channel-originated turns, how it mounts skills into
its native layout, and how it applies prompt customization. The create context
must therefore carry concrete capabilities and sources, not Dreamux topology
state.

This proposal tightens three seams:

- the runtime input methods;
- the bundled skill source shape;
- the runtime create context.

## Source facts

Current source does not yet match the desired boundary:

- `AgentRuntime.channelInput()` is documented as a channel/user turn and renders
  `InboundTurnInput` through `renderChannelInput()`
  (`/packages/dreamux-types/src/agent-runtime.ts`,
  `/packages/agent-runtime/codex/src/runtime.ts`,
  `/packages/agent-runtime/claude-code/src/runtime.ts`).
- `AgentRuntime.systemInput()` is a required provider method and
  `AgentRuntimeSystemInput.reason` currently distinguishes `restart-notice` and
  `scheduled` (`/packages/dreamux-types/src/agent-runtime.ts`).
- Both built-in runtimes route `reason: "scheduled"` back through
  `channelInput({ sourceId: "", text })`, which gives scheduled work the channel
  XML rendering path even though it did not come from a channel
  (`/packages/agent-runtime/codex/src/runtime.ts`,
  `/packages/agent-runtime/claude-code/src/runtime.ts`).
- `AgentRuntime.completionInput()` is currently optional and accepts a
  `CompletionEnvelope`, so external runtime providers must understand a Dreamux
  teammate-completion shape instead of a plain text turn
  (`/packages/dreamux-types/src/agent-runtime.ts`,
  `/packages/dreamux/src/service/completion-router/index.ts`).
- `TeammateService.submitPrompt()` uses `runtime.channelInput()` for ordinary
  MCP `send` / initial prompts that are not channel messages
  (`/packages/dreamux/src/service/teammate-service/index.ts`).
- `AgentRuntimeSkillSource.layout` exposes two layouts from core:
  `skill-dir` and `claude-skills-parent`. The latter encodes Claude Code's
  `.claude/skills` discovery shape in the shared contract
  (`/packages/dreamux-types/src/agent-runtime.ts`,
  `/packages/dreamux/src/agent-runtime/bundled-skill-sources.ts`).
- `AgentRuntimeCreateContext.role` exposes Dreamux structural topology to every
  runtime provider even though built-in runtimes do not consume it; core already
  uses the role before launch to choose MCP servers, disabled features,
  `systemPrompt`, and `skillSources`
  (`/packages/dreamux-types/src/agent-runtime.ts`,
  `/packages/dreamux/src/service/dispatcher-service/agent.ts`,
  `/packages/dreamux/src/service/teammate-service/index.ts`).

## Input Contract

The runtime contract should expose two turn inputs:

```ts
interface AgentRuntimeTextInput {
  text: string;
  sourceId?: string;
}

interface AgentRuntime {
  channelInput(
    input: InboundTurnInput,
    hooks?: InboundDeliveryHooks,
  ): Promise<AgentRuntimeTurnResult>;

  completionInput(input: AgentRuntimeTextInput): Promise<AgentRuntimeTurnResult>;
}
```

`completionInput` is the plain text turn input. It sends `text` as the native
turn body with no channel XML, no channel attributes, and no Dreamux envelope
object. The optional `sourceId` is correlation/dedupe metadata only; it must not
be rendered into the model-visible text unless the runtime has no other
correlation mechanism and documents that choice. When `sourceId` is supplied,
runtimes should use it for at-most-once turn acceptance/dedupe unless their
adapter has an equivalent provider-owned acceptance guard. The delivery target
must provide a stable `sourceId` for the same logical delivery across router
retries; it must not append retry counters that defeat runtime-side dedupe.

`channelInput` is only for messages that came from a ChannelProvider. It owns
rendering the neutral `InboundTurnInput` into the runtime's native
channel-message format, including the `<channel ...>` XML block used by the
built-in runtimes today. It is not a generic "submit a turn" helper.

Dreamux-owned prompts that are not channel messages use `completionInput`:

- `teammate.spawn` first prompts;
- `teammate.send`;
- `team.send` to a TeamLeader;
- scheduler-fired prompts;
- restart notices that are meant to start a model turn;
- rendered teammate/team-member completion notifications.

`systemInput` should not remain a provider-facing required method. A
Dreamux-owned text that should start a turn is just a plain text turn after core
has rendered it. Persistent role or identity guidance belongs in
`AgentRuntimeCreateContext.systemPrompt`, not in a per-turn system input.

`CompletionEnvelope` remains a core routing record, not a runtime provider
input. `CompletionRouter` can keep its at-most-once delivery policy, but the
delivery target entity (`TeammateService` for the dispatcher agent or
TeamLeader) should render the envelope to plain text before it calls
`runtime.completionInput({ text, sourceId })`. A submitted runtime turn maps to
accepted completion delivery; a stopped runtime maps to unsupported delivery; a
failed runtime submission maps to failed delivery. Duplicate acceptance should
be explicit and tested so router retries do not create repeated model-visible
notifications. `CompletionRouter` remains the authoritative at-most-once owner;
runtime `sourceId` dedupe is an adapter-level hardening layer, not the only
delivery guard.

## Skill Sources

Core should provide only concrete skill directories:

```ts
interface AgentRuntimeSkillSource {
  name: string;
  path: string; // directory containing SKILL.md
  source: 'dreamux-core' | string;
}
```

Every `path` is the skill directory itself. Core must not emit
`claude-skills-parent`, `.claude/skills`, `skills/extraRoots`, or any other
runtime-specific layout marker.

Runtime providers translate the same neutral sources into their native layout:

- Codex groups the parent directories of the provided skill dirs and sends
  those roots through its `skills/extraRoots/set` support.
- Claude Code creates a runtime-owned add-dir root that contains
  `.claude/skills/<name>` entries linked to the provided skill directories, then
  passes that root through `--add-dir`. The runtime package owns whether those
  entries are directory symlinks or another safe link/copy strategy.

The Claude-specific filesystem materialization must be idempotent, use
runtime-owned paths, and not mutate Dreamux's bundled skill source directory or
the user's workspace. A natural home is a provider-owned subdirectory under the
neutral `AgentRuntimePathContext.dispatcherDir(runtime_id)` path.

## Create Context

Remove `role` from `AgentRuntimeCreateContext`.

Dreamux structural role remains a core/service fact. Core may continue to store
and branch on dispatcher, TeamLeader, TeamMate, and team-member roles while it
constructs the launch context. By the time `createRuntime()` is called, the role
must already have been materialized into explicit provider inputs:

- `systemPrompt`;
- `mcpServers`;
- `skillSources`;
- `disableFeatures`;
- `cwd`, paths, state sink, environment injection, and config.

If a future runtime customization needs a fact that is not represented by those
fields, add a minimal explicit capability or create-context field for that fact.
Do not pass the whole Dreamux role as an escape hatch.

## Hard Constraints

- No provider-specific runtime decisions in Dreamux core.
- No channel XML rendering through `completionInput`.
- No channel-origin metadata on non-channel prompts.
- No `CompletionEnvelope` in the provider-facing runtime input method.
- No `systemInput.reason` discriminator in runtime providers.
- No runtime-specific skill layout values in core-emitted `skillSources`.
- No Dreamux structural role in `AgentRuntimeCreateContext`.
- No weakening of the existing reverse-completion at-most-once policy.
- No source-tree or workspace mutation for runtime-owned skill layout
  materialization.

## Acceptance

- `AgentRuntime.completionInput` is the generic required plain text input and
  returns `AgentRuntimeTurnResult`.
- `AgentRuntime.systemInput` and `AgentRuntimeSystemInput` are removed from the
  provider-facing contract, or left only as a private transitional adapter that
  core no longer calls.
- `AgentRuntime.channelInput` is used only for ChannelProvider-originated
  messages.
- MCP `spawn`/`send`, TeamLeader send, scheduler delivery, restart notice
  delivery, and reverse completion notification delivery use plain text
  `completionInput`.
- Restart notice delivery preserves both parts of the existing behavior:
  Dreamux core keeps the recovered-session claim, while the built-in adapters
  keep the startup race guard that suppresses a best-effort restart wake after a
  real inbound/channel turn has already been accepted. The race guard can live
  in the adapter's `completionInput` acceptance path or an equivalent core
  sequencing guarantee, but it is not a provider-facing restart reason, hidden
  discriminator, or public capability.
- Reverse completion delivery still preserves at-most-once semantics, spill-file
  handling for long outputs, and a clear fallback when the target runtime is
  stopped or cannot accept the turn.
- Core emits only direct skill directories in `skillSources`; the shared type no
  longer exposes `layout`.
- Claude Code runtime owns creation of a `.claude/skills` add-dir root from the
  neutral skill dirs. Codex runtime continues to derive extra skill roots from
  the same neutral sources.
- `AgentRuntimeCreateContext.role` is removed, and tests prove providers see
  only explicit launch inputs.
- Existing proposal text that still instructs scheduler delivery through
  `systemInput` or `channelInput` is marked superseded by this proposal before
  implementation is considered complete.
- External-provider runtime-handle validation treats `completionInput` as a
  required method and removes `systemInput` from required provider-facing
  methods; `CompletionRouter` maps `AgentRuntimeTurnResult` back to its
  accepted/unsupported/failed delivery outcomes.
- Focused tests cover the routing matrix: channel inbound uses `channelInput`;
  MCP/scheduler/restart/completion notifications use unwrapped
  `completionInput` on both built-in runtimes; skill source layouts remain
  provider-owned; runtime create contexts contain no role.

## Out Of Scope

- Renaming MCP tools or TeamMate public lifecycle concepts.
- Adding mutable post-launch system-prompt editing.
- Adding a role taxonomy for TeamMate identities.
- Modeling provider-native subagents, permissions, approval flows, sessions, or
  skill registries in Dreamux core.
- Changing `dispatcherCompletionSpillDir` / completion spill-file ownership.
