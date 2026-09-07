# Provider Runtime

What: how Dreamux loads providers and launches an Agent Runtime for one role,
and exactly what crosses the neutral seam — provider refs and package
boundaries, operator config, the runtime create context (prompt, skills,
disabled features), the logical-turn and admission contract, activity reads,
and diagnostics.

## Ownership

Dreamux has two live provider seams:

- `agentRuntime` launches dispatcher, TeamMate, TeamLeader, and future
  team-member agents through one role-aware runtime contract.
- `channel` creates Channel sessions, resolves Channel targets, and owns
  provider-specific tools.

The built-in refs are stable aliases. Core resolves them to packages through the
same loader path as package-backed providers:

| Ref | Kind | Package |
|---|---|---|
| `builtin:codex` | `agentRuntime` | `@excitedjs/agent-runtime-codex` |
| `builtin:claude-code` | `agentRuntime` | `@excitedjs/agent-runtime-claude-code` |
| `builtin:feishu` | `channel` | `@excitedjs/feishu-channel` |

The host package, `@excitedjs/dreamux`, depends on the built-in provider
packages so a default install keeps the built-in path. Provider packages depend
on `@excitedjs/dreamux-types` and must not depend on `@excitedjs/dreamux`.

`@excitedjs/dreamux-types` is the provider-authoring contract. It exports
declarations only: provider descriptors, Agent Runtime contracts, Channel
contracts, turn shapes, and diagnostics. It does not export host stores, path
helpers, provider loaders, or runtime implementations.

Agent Runtime providers implement `AgentRuntimeProvider` and return one
`AgentRuntime` instance per launched agent. The runtime interface is
single-instance and has exactly three methods: `start`, `submit`, and `stop`.
Nothing is pulled from the handle — every runtime fact flows out through the
leased state and activity sinks Core supplied when it created the instance — so
there is no status, checkpoint, capability, or liveness method to call on it.
Everything that is a read rather than a live handle hangs off the provider
instead: config reading, onboarding, bin checks,
diagnostics, and the bounded `readRecentActivity` tail. Dispatcher orchestration
verbs such as `spawn`, `send`, `close`, `list`, and Team operations belong to
Dreamux core services and MCP surfaces, never to the runtime instance.

Providers also own provider-specific diagnostics and onboarding; Core owns the
host envelope around them — config location, dispatcher id and cwd, selected
provider refs, service installation, and the file ledger. Provider diagnostics
declare binary checks and run non-binary checks through a neutral runner, so
`dreamux doctor`, `dreamux onboard`, and `dreamux daemon install` derive
provider binary checks from provider capabilities instead of branching on
built-in refs.

Source:

- `/packages/dreamux/src/registry/builtins.ts`
- `/packages/dreamux/src/cli/doctor.ts`
- `/packages/dreamux/src/onboard/`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`
- `/packages/dreamux/package.json`
- `/packages/dreamux-types/src/provider.ts`
- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux-types/tests/no-host-types.test.ts`
- `/packages/agent-runtime/codex/package.json`
- `/packages/agent-runtime/claude-code/package.json`
- `/packages/channel/feishu-channel/package.json`

## Contracts

### Operator Config

The operator config is JSON at the path reported by `dreamux config path`:
normally `~/.dreamux/config.json`, relocatable with `DREAMUX_CONFIG_DIR`.

Current schema:

- `agents[]` declares named Agent Runtime configs. `agents[].id` is a
  config-internal alias, not a dispatcher id or path key.
- `dispatchers[]` declares dispatcher ids, explicit `cwd`, configured
  `channels[]`, and `agentRuntime`.
- `dispatchers[].agentRuntime` references an `agents[].id`; dispatchers carry
  no runtime config block.
- `dispatchers[].channels[]` entries carry dispatcher-local `id`, provider ref,
  and provider-owned config.

Config loading first loads the referenced Agent Runtime and Channel providers,
then validates provider-owned config through each provider's `readConfig`.
Provider config can be sync or async. Core rejects old top-level `codex`,
inline `dispatchers[].runtime`, missing `agentRuntime`, duplicate
`agents[].id`, duplicate dispatcher ids, duplicate channel ids, and duplicate
channel provider refs within one dispatcher. It does not silently migrate old
shapes.

Off Windows the config file must be mode `0600`. Any other mode is a loud load
failure that names the offending mode; the file is never repaired in place.

Channel providers may self-report an opaque `identity` for display/status. Core
stores the string but never interprets provider config fields such as a Feishu
app id.

Source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/config/config-helpers.ts`
- `/packages/dreamux/src/agent-runtime/external-provider.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`

### Channel Provider Id As A Server-Name Segment

A channel provider's registration id is model-facing: `createChannelMcpDelegate`
names that provider's MCP server `channel-<provider>` and its MCP identity
`dreamux-channel-<provider>` (Claude Code renders that hyphenated name as-is;
Codex renders its tools underscore-joined, `channel_<provider>__…`). Naming is
total for builtin providers because `BUILTIN_PROVIDER_ID_PATTERN`
(`/^[a-z][a-z0-9-]*$/`, `registry/provider-ref.ts`) already constrains every
builtin id to a valid server-name segment on both engines. For `npm:`
providers the shared loader seeds `descriptor.id` from the raw ref (for
example `npm:pkg#export`), which no engine has been shown to accept as a name
segment, and `descriptor.id` is also the config-facing registry key, so there
is deliberately no sanitizer and no id change today — no external channel
provider exists to observe the failure against. This is a reserved, unsettled
name shape, not a bug: the first external channel provider author is who
settles it, and `channel/external-channel-provider.ts`'s doc comment carries
the same note at the source the author will actually read. `channels[].id`
(the dispatcher-local channel binding, distinct from the provider's own
registration id) is unaffected and keeps its existing meaning.

Source:

- `/packages/dreamux/src/registry/provider-ref.ts`
- `/packages/dreamux/src/channel/catalog.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`
- `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`

### Runtime Create Context

Core launches every agent through `AgentRuntimeProvider.createRuntime(context)`.
The context is neutral and immutable — prior session identity reaches `start`
only through it:

- `identity.runtimeId` plus `identity.sessionId`, the provider's own prior
  session id or `null`; the runtime publishes each new session id back through
  its leased state sink;
- provider-parsed `config`;
- launcher-supplied `cwd`;
- `systemPrompt` with optional `replace` and `append` forms;
- exactly the MCP server descriptors core selected for this role — already
  fully resolved, so an empty array means "no MCP servers";
- effective `skillSources`, composed by core from required role roots and any
  authorized custom roots;
- `disabledFeatures`, the neutral feature names to disable;
- neutral logger, path, state, and environment injection seams.

Core should not call provider-specific factories, classes, or package imports
directly. The package-boundary guard rejects provider implementation imports and
provider-specific factory calls from core source.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/factory.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

### System Prompt

`systemPrompt` is the single provider-facing prompt surface. It carries two
canonical forms:

- `replace`: full role instructions for runtimes that replace their native base
  prompt;
- `append`: ordered focused role-guidance fragments added on top of the native
  base prompt. Fragment order is significant.

An adapter selects at most one form: `replace` when present and supported;
otherwise `append` when present; otherwise, when only an unsupported `replace`
is present, prompt customization is left unchanged. Replacement support is an
adapter implementation fact, not an `AgentRuntimeCapabilities` field or an
MCP-discoverable feature.

Dispatcher launches supply both forms as alternate representations of the same
role guidance, so a replace-native runtime must not also inject the dispatcher
append text. Codex maps `replace` to `baseInstructions`, which means the
dispatcher replacement prompt must itself carry the non-coding parts of Codex's
model-selected base prompt that would otherwise be lost: personality and tone,
simple terminal-request handling, planning-tool guidance, review-answer shape,
progress updates, unexpected-local-change and destructive-command cautions, and
concise final-answer behavior — while leaving code-editing and frontend
guidance out of the Dispatcher role. The comparison source when refreshing it is
the current Codex model catalog entry (`models-manager/models.json`, the
selected model's `base_instructions` / `model_messages`), not an older
per-version prompt markdown file. Append-native runtimes keep their native base
prompt, so their dispatcher append guidance stays a short role delta.

Identity guidance is append-only and additive rather than an alternate
representation. Every TeamLeader receives one default fragment identifying it as
the TeamLeader for that Team; TeamLeader, TeamMate, and team-member identity
guidance is rendered from the persisted `TeamMateIdentity.identity_prompt` and
re-supplied as `systemPrompt.append` fragments on every launch that rebuilds the
create context — initial create/spawn, close/reopen, process restart, Team
rebuild, and runtime resume.

Prompt policy stays outside the generic `TeammateService` runtime container.
`TeamService` supplies the TeamLeader default and identity fragments; owned
operations may supply host-private fragments through their collection creation
options, which is how Dynamic Workflow injects its workflow-role contract
without widening the public Agent Runtime ABI. `TeammateCollection` is the
single TeamMate/member entity-construction boundary: it composes
operation-owned fragments first and the persisted caller-provided identity
fragment second, then supplies the ordered result. `outputSchema` remains a
separate neutral turn field, not prompt text.

Adapters apply the selected append form natively. Claude Code folds append
fragments into `--append-system-prompt` before the resident session is created,
wrapping each fragment in its own `<system-reminder>` block. Codex renders each
fragment inside its own `<developer-reminder>` block and supplies the joined
result as `developerInstructions` on `thread/start`, `thread/resume`, and the
resume fallback start. Both escape XML text content inside each wrapper so one
fragment cannot create or modify sibling blocks.

Dreamux-owned turns that are not channel messages use plain text input; the
provider receives no `CompletionEnvelope`, no source discriminator, and no
rendering instruction.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/service/teammate-collection/index.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/codex/src/runtime-support.ts`
- `/packages/agent-runtime/codex/tests/system-prompt.test.ts`
- `/packages/agent-runtime/claude-code/src/provider.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`

### Bundled Skills And Injection

Dreamux ships bundled skills under `/packages/dreamux/skills/`. What each skill
is for is owned by [bundled Dreamux skills](dispatcher-skill.md); this page owns
the role gate and how a root reaches an engine.

Current role gate, by root rather than by skill:

- Dispatcher roles receive `skills/dispatcher/` (holding `dispatcher-workflow`
  and `dreamux-maintenance`) plus the shared root.
- TeamLeader roles receive `skills/team-leader/` (holding `teamwork`) plus
  the shared root.
- Both roles therefore receive the shared `dynamic-workflow` root; ordinary
  TeamMate and team-member roles receive no bundled Dreamux skill.

Core emits those role roots, never per-skill selector paths, so root scanning
cannot expose a sibling role's skills.

The admin creation surface may add runtime-neutral custom roots for a TeamMate,
team member, or TeamLeader. Core persists only those additions on the agent
identity and recomposes them on every launch, and TeamLeader launch always
prepends both required bundled roots ahead of the persisted additions.
Normalization canonicalizes each custom root to an existing readable absolute
realpath, collapses duplicate roots, and rejects a root whose direct-child skill
name collides with another root's. For TeamLeader creation, required-source
normalization includes both the role-specific and shared roots, reserving the
bundled `teamwork` and `dynamic-workflow` names so custom roots cannot shadow
either required skill. This capability is not part of MCP tool schemas or
model-facing runtime discovery.

Runtime packages own engine-specific application:

- Codex dedupes the supplied roots and calls `skills/extraRoots/set` after
  initialize and before thread start/resume.
- Claude Code materializes a runtime-owned add-dir root containing a
  `.claude/skills/<name>` entry per skill under each supplied root, then passes
  that materialized root through `--add-dir`. The root is keyed by the set of
  source roots, so one set of roots always maps to one directory; its manifest
  records the child skill inventory found under each root, and a start whose
  inventory differs from the manifest (an in-place upgrade that renamed a
  bundled skill, a custom root that changed) rebuilds the view and swaps it
  into the same path. A source root that cannot be read fails the start with
  an error naming the source and its path.

`dreamux onboard` and dispatcher startup do not install bundled skills into a
workspace. They are package-shipped runtime injection sources only.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/agent-runtime/skill-sources.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/team-collection/create-request.ts`
- `/packages/dreamux/src/service/team-collection/commands.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/service/teammate-collection/index.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

### Disabled Runtime Features

The create context carries a required neutral
`disabledFeatures: readonly string[]`. Core emits only neutral feature-group
names; each runtime maps the names it understands and ignores the rest.

Current names:

- `userInterrupt`, emitted for every agent at the shared `createTeammateService`
  construction boundary. It disables the model-facing "ask the user a question"
  tool, which in a channel-only environment would wedge a turn waiting for an
  out-of-band answer. Claude Code maps it to the `AskUserQuestion` disallowed
  tool; Codex needs no code because its `request_user_input` tool exists only
  behind the `experimental_request_user_input` config feature, which Dreamux's
  authored launch config never sets. The guarantee is at the
  Dreamux-authored-args level on both runtimes: operator `extra_args` is a raw
  passthrough escape hatch Dreamux does not police, so an operator who
  deliberately re-enables the tool owns that choice. The gap is symmetric, not
  Codex-specific.
- `cron`, emitted only for dispatcher and TeamLeader launches, matching the
  roles that receive Dreamux's cron MCP. Claude Code maps it to native cron tool
  disallow args; Codex ignores it because Dreamux cron is an MCP descriptor, not
  a Codex-native feature.

Claude Code merges all requested features' tools into a single
`--disallowedTools` flag.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/agent-runtime/host-context.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/team-service/leader-agent.ts`
- `/packages/dreamux/src/service/teammate-service/runtime-owner.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`

### Regression Trap: background origin is not completion ownership

A Claude background task can start a native follow-up with no submitted command,
then receive explicit requests midway through that turn. The command lifecycle
that admits those requests determines the result's submitted group; the original
trigger and the result's single user-message UUID do not describe that whole
group. Filtering all task-notification results drops valid steered answers.

Native result/activity handling must work without a submission. No submitted
group means no request settlement, not a process failure. A merely queued request
must not be settled by a prior background result through a sole-pending fallback.
Normal completed lifecycle frames may precede their shared result, so they do not
erase its started group. Core continues routing shared completion tokens to the
recipients captured on each submitted request.

Source: `/packages/agent-runtime/claude-code/src/rpc.ts`,
`/packages/agent-runtime/claude-code/src/runtime-session.ts`,
`/packages/agent-runtime/claude-code/src/runtime.ts`,
`/packages/dreamux/src/service/completion-router/index.ts`.

### Regression Trap: a native state is not a user capability

Claude reports cancelled after native API and setup failures. Treating that
word as an operator cancellation hid errors, even though the Claude provider has
no user cancellation entry point. Do not invent a product action or its compatibility
machinery from a protocol label. The current failure and settlement rules are
defined in [Claude Code settlement](#claude-code-stream-json-settlement).

### Logical Turn And Admission

The runtime object is the provider-owned authority for native submission and
termination; Dreamux core never reconstructs runtime activity from callbacks or
native identifiers.

- One accepted input returns one `RuntimeSubmission` handle whose settlement
  resolves to a provider-owned immutable `RuntimeCompletion` created at the real
  native result boundary; one real native result settles every submission it
  covers.
- A provider fold or steer into the active logical turn settles with the exact
  same completion object; a queued input settles with a distinct completion in
  native order.
- Native aliases folded into the logical input must converge before the shared
  completion settles.
- Core owns the source-deduplication reservation, not the provider: the seam
  carries only text, so a provider has no source identity to deduplicate with,
  and one Dispatcher-wide `AdmissionLedger` reserves `[entity, source id]`
  before the runtime is called. Concurrent use
  of one reserved source shares the same admission result.
- A source commits after acceptance or ambiguous post-admission failure. It is
  released on every other outcome — `failed`, `stopped`, `skipped`, or a throw
  before the provider seam — so a genuine retry still works.
- Core's one ledger — Dispatcher-wide so it outlives an entity service object
  that is deleted and rematerialized on reopen or retire — bounds committed
  source ids with a FIFO window (`ADMISSION_SOURCE_WINDOW`); pending
  reservations remain separate single-flight state and are never evicted before
  native admission resolves.
- `RuntimeAdmission.failed` is reserved for provider-proven pre-admission
  failure. `ambiguous` means the native boundary may have been crossed and
  therefore cannot be retried automatically.
- `stop()` fences new input synchronously, initiates provider teardown before
  waiting on startup, restart, or submission work that teardown is expected to
  reject, and does not resolve until every already-started input admission has
  settled and can no longer return a newly accepted Turn.

Codex keeps app-server `turn.id` values inside its package. Claude Code keeps its
command UUIDs inside its stream-json adapter. Neither identifier is Dreamux
service state.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/agent-runtime/codex/src/turn-manager.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/runtime-activity.ts`
- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

### Claude Code Stream-Json Settlement

One resident session accepts every input through the same submit path. RPC owns
one table of unanswered requests: the settlement resolver, native admission
resolver and, while capability is unknown, a deferred write. Requests are
registered before writing so early native evidence cannot outrun registration.
The runtime owns process continuity and durable state; it has no second request
registry, initial/steer branch or enclosing execution-window promise.

Admission resolves on a successful write callback or positive native evidence.
A proven failure before writing is failed admission; an unconfirmed write is
ambiguous and must not be retried automatically. Concurrent inputs wait for
lifecycle evidence when capability is unknown, and are rejected when it is
unavailable. Existing single-input compatibility remains supported.

At each native result, RPC associates and settles the requests it answers:

- Commands observed as started participate until the applicable result. Normal
  completed lifecycle frames may precede or follow the result and do not gate
  the next input. The consumed set also tracks native internal commands, so a
  queued cancellation can be distinguished from consumed work being cancelled.
- An exactly matching submitted user_message_uuid is additional positive
  evidence, including no-start compatibility. A foreign or absent UUID never
  vetoes consumed requests, and origin is never a routing filter.
- With lifecycle evidence, an empty group stays empty. A merely queued request
  is not answered by an earlier background result. The lifecycle-less fallback
  applies only to a written single input and a result with no UUID.

RPC removes answered requests before callbacks, creates one immutable completion
using the pinned session/structured-output contract, and settles those requests
with the same object. Core retains captured recipients and completion-object
identity deduplication. A result with no related request still reports activity
and its native end, creates no request completion, and leaves the process alive.

Native cancelled is not proof of a user stop; it also follows hard failures.
The Claude provider has no user cancellation entry point. Consumed commands retain
their result membership through cancelled so that either native ordering preserves
the actual result. An unconsumed cancelled request fails with its named protocol
state, as do refusal/discard. There is no aggregate window drainage. Explicit
runtime stop settles outstanding requests, fences late activity and converges
pending admissions. Actual transport loss fails outstanding requests and
retains its cause through cleanup, including admission racing with that cleanup.

Text aggregation belongs to the resident stream. Each result consumes its text.
Cancelling consumed work clears canceled text so a later empty answer cannot
inherit it; cancelling an unconsumed queued request does not clear current text.
Every native error result reports a failed end, even when text and input UUID
are absent. No broad interrupt-artifact guard may discard it: an error subtype
or is_error: true establishes failure, including API errors carried in the
success arm. Native errors, API error text and terminal_reason supply diagnostic
details. A setup error can omit both started and UUID evidence; its failed end
retains the details, but a later named cancelled request fails with its protocol
state. The adapter does not guess that an unbound result belongs to that request.

The configured max-idle timer exists while requests await settlement and resets
on native stream activity. It clears as soon as no request remains; a late
completed frame is not required. A genuinely silent outstanding request still
fails and triggers process teardown. Pure background work arms no such timer.

Custom ClaudeCodeSession factories implement submit returning RuntimeAdmission,
with settlement owned by the session. The spec supplies sessionId and optional
outputSchemaEnabled; the exit callback carries its Error. Protocol result
callbacks retain commandUuids and command_lifecycle for observation. The public
interrupted variant remains available for independently established interruption;
cancelled alone no longer emits that boundary. Direct ClaudeCodeStreamRpc
consumers also use submit, fail and stop; its options require sessionId and its
timeout callback receives the failure Error. Protocol callbacks alone do not
settle requests. This is a breaking Claude extension-seam change; the neutral
runtime ABI is unchanged.

Evidence boundary: live CLI 2.1.231/2.1.263 captures show fold/queue and both
completed/result orders. Observed task-notification folds omit both result UUID
echo fields despite answering explicit requests. The installed 2.1.263 schema
marks command_lifecycle as internal; the public SDK reference does not define
that contract. No-start fixtures are compatibility coverage, not an observation
of that build. A fresh real 2.1.263 CLI probe against a controlled local API
confirmed success/is_error: true/api_error followed by cancelled, with no cancel
request sent. External queued cancellation is not a current Dreamux user
capability. Exceptional tool-result ordering and cancellation interleavings
retain evidence gaps; deterministic coverage is not a universal ordering guarantee.

Source:

- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/runtime-session.ts`
- `/packages/agent-runtime/claude-code/src/runtime-activity.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/types.ts`
- `/packages/agent-runtime/claude-code/tests/rpc.test.ts`
- `/packages/agent-runtime/claude-code/tests/runtime-background.test.ts`

### Claude Code Stream-Json Envelopes On The Display Line

The display line reads three stdout envelopes and nothing else
(`ClaudeActivityLine`): `assistant`, whose text blocks are the model's words and
whose `tool_use` blocks are its tool calls; `user`, whose `tool_result`
blocks are what those tools returned, correlated to the call by `tool_use_id`;
and the `system` envelope with subtype `compact_boundary`, which becomes the
one-line `Compacted session` message described below.
A `user` envelope on stdout is the CLI's own, never the operator's: stdin input
is not echoed back (Dreamux does not pass `--replay-user-messages`), so a text
block there is context the CLI injected into its conversation — observed on
2.1.259, the `Skill` tool's result is only `Launching skill: <name>` and the
whole SKILL.md body follows as a separate `user` line with no field marking it
as injected. None of that text is displayed. Every other stdout line — `init`,
`command_lifecycle`, control traffic, every other `system` notice,
`stream_event`, `rate_limit_event` — is excluded from Core display activity.
RPC still uses protocol events for lifecycle, session setup and control handling,
and exposes its Claude-specific observation callback. Incoming lines also
refresh the idle deadline while requests remain unanswered. Core displays the operator's
own input through `teammate.input`, not through this line.

Source:

- `/packages/agent-runtime/claude-code/src/types.ts`
- `/packages/agent-runtime/claude-code/src/runtime-activity.ts`
- `/packages/agent-runtime/claude-code/src/tool-display.ts`
- `/packages/agent-runtime/codex/src/tool-display.ts`
- `/packages/agent-runtime/claude-code/tests/runtime-activity.test.ts`

History: the 2026-09-03 ruling 「所有的 user 消息都隐藏即可」 in
[split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md);
the wire evidence and the deferred divergences (Remote Control response field
names, a subagent's tool calls shown as the agent's own, unconsumed `system` subtypes)
are frozen in
[claude-code-stream-json-protocol](/.agents/research/claude-code-stream-json-protocol.md).

Provider-native history formats, session discovery, cursor envelopes, and typed
errors stay inside each runtime package's own `src/activity/`. Both built-ins
reuse `/packages/dreamux-utils/src/activity-scan.ts` for provider-neutral
digests, bounded scan accounting, exact positional reads, and path containment;
duplicating those security and determinism primitives in each provider is not an
accepted boundary. That module owns mechanism only and no record shape, and it
does not bound Core's output — Core re-validates each returned page against its
own record, cursor, and byte budgets in
`/packages/dreamux/src/service/agent-entity/activity-reader.ts`.

### Codex Portable Output Schema

Dreamux core passes the neutral `AgentRuntimeTextInput.outputSchema` unchanged.
`@excitedjs/agent-runtime-codex` privately compiles it for Codex strict
structured output; no Codex branch, retry loop, or schema validator exists in
core.

The accepted portable vocabulary is intentionally narrow:

- one non-null closed root object;
- nested closed object schemas and arrays with exactly one `items` schema;
- `object`, `array`, `string`, `number`, `integer`, `boolean`, and `null`;
- exactly `[T, "null"]` for nullable values, with no other unions;
- `description`, primitive-value `enum`, and numeric `minimum` / `maximum`.

Every object property is required on the Codex wire schema. An originally
optional non-nullable property gains `null` in its wire type (and enum when
present). The private restoration plan recursively removes only those optional
`null` placeholders. Required nullable fields remain present as `null`.

Compilation validates and clones the input. Open objects, schema-valued
`additionalProperties`, optional-nullable properties, tuples, missing or
ambiguous types, non-null unions, references/composition/conditionals,
unsupported bounds, unknown keywords, and other unsupported shapes return
`UnsupportedAgentRuntimeFeatureError` with `feature: "outputSchema"` before
pending submission accounting or `turn/start`. Errors include the schema path;
constraints are never silently dropped.

Each active Codex turn slot owns either no codec or one authoritative private
codec. Its fingerprint canonically covers both the wire schema and restoration
plan. Compatible structured followers may fold into the active turn; a different
fingerprint or structured/unstructured mixing fails before another
`turn/start`. The codec remains private to the canonical active slot, and every
accepted native alias converges before the public submission settles.

Restoration runs once, behind the existing pending-turn mutual-exclusion guard,
before `onTurnCompleted`. A successful restoration is the only structured text
seen by `CodexRuntime.recordCollectedTurn()`, so `lastResult` and completed
settlement use the neutral restored JSON. Parse or shape restoration failure does
not call `onTurnCompleted` or mutate `lastResult`; it selects one ordinary failed
runtime outcome with no assistant text. Submission failure, stop, app-server
teardown/restart, and late completion clear or discard in-memory codecs through
the same turn lifecycle and never restore or settle twice.

Each collector owns and unregisters exactly one Codex notification handler.
Normal completion and terminal failure close it automatically; rejected
`turn/start`, runtime stop, and direct `runTurn` cleanup dispose it explicitly.
An abandoned collector therefore cannot buffer a later turn or accumulate
handlers on the resident Codex client.

Source:

- `/packages/agent-runtime/codex/src/output-schema-codec.ts`
- `/packages/agent-runtime/codex/src/events.ts`
- `/packages/agent-runtime/codex/src/rpc.ts`
- `/packages/agent-runtime/codex/src/turn-manager.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/codex/tests/codex-events.test.ts`

### Activity Reads And Scheduling

Activity crosses the seam in two forms only, and neither is a liveness signal:
the provider pushes `RuntimeActivity` values into the activity sink Core leased
it, and `readRecentActivity` answers a bounded cold read of a session's recent
tail. The cold read never materializes an entity or starts a runtime, so a
closed teammate stays readable, and it is required to produce records for a turn
that is still in progress.

`RuntimeActivity` carries **no submission**. A provider folds any number of
Dreamux submissions into one native turn, so an activity cannot honestly name
the submission that caused it, and inventing one made a display pick an
arbitrary member — and, when no member could be picked, drop the fact entirely.
The agent is the subject, and it is known before any submission binds. The union
has three members: `assistant.message`, `tool.call`, and `turn.ended` — the
runtime stopped producing, with a completed, failed or interrupted status and
its own reason text when it has one. A context compaction is published through
the same union as an `assistant.message` reading `Compacted session` — Claude
Code on its `system`/`compact_boundary` envelope, Codex on the completion of
its `contextCompaction` item — and the summary is not: Claude Code puts it on
the wire as a synthetic `user` envelope whose content is one string (dropped
with every other `user` text), Codex never emits it (its `contextCompaction`
item carries only an id, and codex-core records the compaction output into
history without an event). Operator ruling, 2026-09-04: 「我不要正文，正文太长了，
只显示压缩发生了即可。claude code 的网页上只显示了 Compacted session，我只需要这一
行字即可。」 and, on the shape, 「我觉得没必要给他单独加一个新的 activity 类型，你直接在
provider 里，多推一个 assistant message，内容就这一行。」 The sink is
generation-fenced, synchronous, display-only and fail-open — a write from a
revoked generation is dropped, and a throwing consumer never affects
settlement. That guard is Core's (`createConversationProjection`'s `guarded`
wrapper); the sink never throws, and a provider calls it bare.

A `tool.call` carries, beside the tool's name and its classified `action`,
three display facts the runtime owns because only it knows its tool
vocabulary: `summary`, the one line its own UI labels the call with,
`invocation`, the call in the caller's own notation, and `items`, what the
call is about, one entry each. `items` holds only what the provider's
protocol already carries as structured members — today Claude Code's
`file_path` and `notebook_path` inputs, Codex's `fileChange.changes[].path`
and the `path` of a parsed `read` command action — and is empty for
everything else; no provider recovers an item from a label or an output by
parsing (ruling: 「两边自己去按照自己的协议，把能拆分出来的 file item 拆出来，
拆不出来的就不管了」). The member is named for the list, not for files, so a
runtime whose protocol names other discrete things for a call lists those
(ruling: 「那我推荐你给改成 items，不要固定叫 files，限制了其他用法」). Each
provider derives them in one module, `src/tool-display.ts`, the only place in that runtime that knows a
built-in tool's field names. Claude Code reads the input schemas
`@anthropic-ai/claude-agent-sdk` declares in `sdk-tools.d.ts`: a `Bash` call
is its `description`, else the command's first line, with the `command` as
invocation; file tools are their path; searches their pattern or query;
`Agent` its description with the prompt as invocation; `Skill` its name.
Codex follows the TUI's own exec, patch and web-search cells: a uniformly
parsed command is the files it read, the paths it listed, or `query in
path`, otherwise the command's first line, always with the command as
invocation; a patch is its paths with the diffs codex prepared as invocation;
a `webSearch` item, which carries no tool name and was dropped before, is a
`web_search` row. Anything outside those tables — every MCP tool — reports
`null` and displays as its name. Core sanitizes both facts exactly as it does
arguments and results.

A normal native turn ends at its provider-native terminal: Claude Code `result`
or Codex `turn/completed`. A resident Claude session can answer several inputs
in sequence and reports one end per result. Native cancelled alone supplies no
separate display terminal; it may precede or follow the failure result. Where a
turn ends with no native terminal at all — a stop, a protocol loss, a rejected
run — the provider reports one end from that teardown without asking whether a
turn was open: codex from `TurnManager.stop()` and from the first protocol
failure, Claude Code from `stop()` and from the fence, each for a live child
only, and from an unexpected resident-child exit before any stop. The gate is the native session's
existence, not a display fact: Core stops a runtime whose start failed before it
revokes the generation, so a teardown end reported with no child would close the
card ahead of Core's own failed end carrying the start error. A state write that
fails after the native session is up (Claude Code's `session` and `ready`
writes, codex's `markReady`) is the one failure past that gate: the state
fence's own teardown reports an interrupted end ahead of Core's failed one, a
double fault with no gate added for it. What the push-back line still owed never
said whether the provider was working, and the provider keeps no display-side
answer of its own either (operator ruling, 2026-09-03: 「cot 相关的部分，在
provider 应该是完全无状态的」, recorded in the
[split-streaming-display-from-pushback
requirement](/.agents/tasks/architecture/split-streaming-display-from-pushback/requirement.md)).

A native turn no Dreamux submission ever bound is not an exception: its items
display, and so does its end. Withholding it was tried and removed — a card
belongs to no turn (`feishu-cot-conversation-cards` rules 1 and 8: one anchor
and at most one open card, and a native-ended fact closes an open card, never
opens one, and is ignored when none is open), so an end has nothing to name and
a runtime has nothing to decide. The same rule is why a provider holds no
at-most-once state: a teardown end after a turn already reported its own
terminal reaches a consumer with nothing open, which ignores it. The only
deduplication is the native stream's own — the codex collector reports each
turn's terminal once (`rememberTerminal`), and one Claude Code `result` is one
end.

The sink is optional because its absence must not break a provider, but the
consequence is real and is not a Core fallback: a provider that never emits
`turn.ended` leaves a presentation whose only terminal is that fact — the Feishu
COT card — open forever. Core does not derive one from settlement, because
settlement is per submission and a native turn is not. Core emits its own
`turn.ended` only for an input **no runtime ever accepted**, where no provider
could ever report one. A provider that wants its work presented live must emit
the terminal itself.

Scheduling asks no question either. A due cron fire is submitted immediately
through its owner's ordinary admission gate; whether the runtime folds that
input into a turn already running or starts a new one is the runtime's own
decision, made where it is already made. There is no defer window and no
scheduler-owned race.

Stopping is a fence plus a convergence, not a wait for quiet. Core's own stop
paths converge what was already admitted — drain admissions, wait out ordinary
mutations, and settle and deliver retained turns — so an accepted turn states
its facts while the subscriptions carrying them are still attached. Team
dissolve is a stop-and-reclaim built on exactly that, never a drain: it refuses
new work rather than queueing it.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/agent-entity/activity-reader.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/service/team-service/closing.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Invariants

- **The dependency direction is one-way.** A provider package must not depend on
  `@excitedjs/dreamux`, and Core must not import a provider implementation or
  call a provider-specific factory. Both directions are guarded by
  `/packages/dreamux/tests/package-boundary-guards.test.ts` and
  `/packages/dreamux-types/tests/no-host-types.test.ts`.
- **There is no neutral idle capability.** Nothing in Core asks a runtime
  whether it is busy, and no seam read may be reinterpreted as one.
- **Core is the sole authority for prompt state.** The whole `systemPrompt`
  bundle is reconstructed from durable Dreamux state and re-supplied on every
  runtime-context creation. A provider must never persist it or become its
  authority, so any future append source that cannot be rebuilt from existing
  Dreamux state has to be persisted by Core before it is handed to an adapter.
- **An append fragment is load-bearing input, not decoration.** Dispatcher
  `replace` / `append` are two representations of one guidance and an adapter
  applies at most one; identity guidance has no `replace` twin, so an adapter
  that cannot apply the selected append form must fail loud rather than launch
  the agent without it. Codex's version gate exists for exactly this reason:
  doctor surfaces an unsupported build instead of letting prompt customization
  degrade silently at runtime
  (`/packages/agent-runtime/codex/src/version.ts`).
- **Codex does not persist `developerInstructions` for the life of a thread.**
  `resolveThread` computes the instruction params once and sends them on
  `thread/start`, on `thread/resume`, and on the mid-life fresh-thread fallback
  alike; dropping the resume re-send would silently lose every append fragment
  on reconnect. Treat the re-send as load-bearing when evaluating a Codex
  protocol bump (`/packages/agent-runtime/codex/src/runtime.ts`).
- **Provider-native identifiers do not cross the neutral boundary.** They may
  exist inside a provider package, but Core never correlates on them.

History: [/.agents/tasks/architecture/README.md](/.agents/tasks/architecture/README.md)
