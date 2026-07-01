# TeamMate identity system prompt

- **Status:** Draft
- **Date:** 2026-07-01
- **Related PR:** [#271](https://github.com/excitedjs/dreamux/pull/271)

## Context

The AgentRuntime contract now keeps Dreamux core behind neutral runtime inputs.
`AgentRuntimeCreateContext.systemPrompt` is the launcher-supplied role prompt
surface used by the dispatcher agent. It already exposes both canonical prompt
forms:

- `replace`, for runtimes that replace their native base prompt.
- `append`, for runtimes that append focused role guidance to an existing native
  prompt.

That dispatcher launch prompt is process/role setup. It should stay separate
from per-agent role guidance that a dispatcher or TeamLeader supplies through
MCP lifecycle tools when creating a TeamLeader or TeamMate.

Ordinary TeamMates, Team members, and TeamLeaders are shaped by their MCP tool
set, launch role, `intent`, and first-turn `prompt`, but callers cannot declare
a stable working identity such as "architecture reviewer", "functional
reviewer", or "performance reviewer".

That missing surface matters most in Team workflows: the TeamLeader needs to
spawn peers with distinct responsibilities, and the dispatcher needs to create a
TeamLeader with an explicit collaboration identity. A first-turn prompt is the
wrong home for that identity because it is task input, not persistent role
guidance, and it is not replayed when a closed agent is reopened from its saved
runtime checkpoint.

The current `AgentRuntimeSystemInput.reason` type also names
`runtime-control`, but current production code never emits that reason and both
built-in runtimes treat unknown reasons as generic system input. The literal is
a stale reserved value, not a current contract.

## Intent

Add a minimal, provider-neutral TeamMate identity capability:

- `teammate.spawn` accepts an optional `identity` string for dispatcher-created
  TeamMates and TeamLeader-created Team members.
- `team.create` accepts an optional `identity` string for the TeamLeader created
  by that Team.
- Dreamux persists the identity on the TeamMate identity record so restart,
  Team rebuild, close/reopen, and runtime resume keep the same role guidance.
- Dreamux converts the identity into a focused system-prompt injection triggered
  by the MCP create/spawn action. It is applied after the runtime is available
  and before the first user/channel turn, not as launcher role prompt content.

## Contract

`identity` is model-facing role guidance for the agent. It is distinct from:

- `name_prefix` / `team_name`, which address the concrete agent or Team.
- `intent`, which is the durable recovery subject.
- `prompt`, which is turn input.
- `AgentRuntimeRole`, which is Dreamux's structural role
  (`dispatcher`, `teammate`, `team_leader`, or `team_member`).

The public input is intentionally a single optional string. Dreamux does not
define role enums such as `architect` or `performance_reviewer`; those are caller
language, not core taxonomy. If provided, `identity` is trimmed before storage
and must remain non-empty; omitted means no identity prompt, while `""` or
whitespace-only input is rejected instead of persisted as an empty prompt block.

On the persisted `TeamMateIdentity` record the field is `identity_prompt:
string | null`. The different storage name avoids `identity.identity` call sites
while keeping the public MCP input short. Existing records without the field read
as `null`.

For TeamLeaders, `intent` and `identity` remain independent inputs persisted on
separate record fields: `intent` is the recovery subject, and `identity_prompt`
is model-facing role guidance.

When present, the stored identity is rendered as a Dreamux-owned append-style
prompt block that tells the runtime this is persistent role guidance for the
session and not the current task request. The identity block is a delta on top
of the runtime's native coding-agent prompt; it must not be treated as a full
replacement base prompt.

Dispatcher launch continues to use `AgentRuntimeCreateContext.systemPrompt`.
TeamLeader and TeamMate identity guidance must not use that launch prompt
surface. Instead, Dreamux core should call a neutral runtime system-prompt
injection surface from the MCP lifecycle action (`team.create` or
`teammate.spawn`) after the runtime starts or resumes and before the initial
prompt is submitted. The runtime adapter owns how to apply that injection:

- an append-native runtime may fold the injected guidance into its native append
  prompt before the resident session is created;
- a runtime with a native model-history injection path may inject a
  developer/system item without starting a user turn;
- a runtime that cannot represent system-prompt injection safely must fail
  loudly before the first user/channel prompt is submitted.

The injection must not be routed through `channelInput`, first-turn `prompt`,
`intent`, `name_prefix`, or `team_name`. It also must not be routed through
`AgentRuntimeCreateContext.systemPrompt`, because that would conflate
dispatcher/process-level launch prompt with per-agent MCP-created identity
guidance.

For this feature, the load-bearing prompt content is append-only. A
replace-native adapter must not pass the bare identity delta as
`baseInstructions` / replacement text, because that would erase its native
coding-agent instructions.

When omitted, current behavior is unchanged: no TeamMate, Team member, or
TeamLeader system prompt is injected just because the agent was created.

## Hard constraints

- No provider-specific checks in Dreamux core. Core renders a neutral identity
  prompt delta and runtime adapters decide how to inject it without weakening
  their native base prompt.
- `AgentRuntimeCreateContext.systemPrompt` remains the dispatcher launch role
  prompt surface. TeamLeader and TeamMate identities are injected by the MCP
  create/spawn action through a separate runtime injection surface.
- No prompt smuggling through `prompt`, `intent`, `name_prefix`, or free-form MCP
  descriptions.
- No closed role enum. Future identities remain caller text.
- No state-loss on reopen. The identity must live in
  `TeamMateIdentity.identity_prompt`, and old records without the field read as
  `null`.
- No read-surface expansion unless it is needed for correctness. Status, list,
  history, and last can remain focused on lifecycle and recovery facts.
- Public artifacts must not contain internal ids, secrets, private hosts, or
  machine-local paths beyond reviewer-only operational context.

## Acceptance

- `AgentRuntimeSystemInput.reason` no longer lists `runtime-control` as a known
  reason in `/packages/dreamux-types/src/agent-runtime.ts`, and stale source
  proposal text is updated or marked historical in:
  `.agents/proposals/agent-runtime-lifecycle-contracts.md`,
  `.agents/proposals/scheduled-tasks.md`, and
  `.agents/proposals/scheduled-tasks-technical-design.md`. Historical changelog
  entries remain unchanged, and generated `dist/` declarations are updated only
  by the normal build.
- `teammate.spawn` exposes optional `identity` in both dispatcher and
  TeamLeader-scoped tool schemas and forwards it through MCP/admin/service
  layers.
- `team.create` exposes optional `identity` and applies it to the TeamLeader.
- Provided `identity` input is trimmed, blank input is rejected, and the trimmed
  value is persisted.
- The persisted TeamMate identity record writes `identity_prompt` for new agents
  and tolerates missing identity data in existing records.
- Runtime launch for TeamMates, Team members, and TeamLeaders no longer passes
  identity guidance through `AgentRuntimeCreateContext.systemPrompt`.
- The MCP create/spawn path injects identity system-prompt content only when an
  identity is present, after runtime start/resume and before the initial prompt.
- Dispatcher launch remains covered: dispatcher role prompts still provide the
  full replacement prompt for replace-native runtimes and the focused append
  prompt for append-native runtimes.
- Focused tests prove schema exposure, admin forwarding, persistence/read-back,
  old-record read compatibility, MCP-triggered system-prompt injection, and the
  negative guarantee that identity guidance is not smuggled into initial-turn
  `channelInput` text, launch `systemPrompt`, or lifecycle read surfaces.
- Focused tests also cover at least one replace-native runtime path and prove
  that enabling identity does not reduce its launch prompt to the bare identity
  delta or fail the default runtime path solely because the identity is
  append-only.
- `team.create` identity applies only to the created TeamLeader record. Team
  members do not inherit it; a TeamLeader assigns each member's identity through
  that member's own `teammate.spawn` call.

## Out of scope

- Adding identity to dispatcher launch `systemPrompt`.
- Adding arbitrary mutable system-prompt editing tools after creation.
- Adding identity mutation after creation.
- Adding identity to `send`, scheduler jobs, channel input, or completion
  delivery. Scheduled jobs on a running teammate implicitly inherit that
  runtime's existing identity prompt; this spec adds no per-job override.
- Adding display-name, roster taxonomy, or Team role-management concepts.
