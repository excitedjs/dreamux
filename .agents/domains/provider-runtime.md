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

Dreamux ships bundled skills under `/packages/dreamux/skills/`. Which skill
covers what — and the tool surfaces those skills describe — is owned by
[bundled Dreamux skills](dispatcher-skill.md); this page owns the role gate and
how a root reaches an engine.

Current role gate, by root rather than by skill:

- Dispatcher roles receive `skills/dispatcher/` (holding `dispatcher-workflow`
  and `dreamux-maintenance`) plus the shared root.
- TeamLeader roles receive `skills/team-leader/` (holding `team-workflow`) plus
  the shared root.
- Both roles therefore receive the shared `workflow` root; ordinary TeamMate and
  team-member roles receive no bundled Dreamux skill.

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
bundled `team-workflow` and `workflow` names so custom roots cannot shadow
either required skill. This capability is not part of MCP tool schemas or
model-facing runtime discovery.

Runtime packages own engine-specific application:

- Codex dedupes the supplied roots and calls `skills/extraRoots/set` after
  initialize and before thread start/resume.
- Claude Code materializes a runtime-owned add-dir root containing a
  `.claude/skills/<name>` entry per skill under each supplied root, then passes
  that materialized root through `--add-dir`.

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
- The provider owns its private source-deduplication reservation. Concurrent use
  of one reserved source shares the same admission result.
- A source commits after acceptance or ambiguous post-admission failure. It is
  released only after a provider-proven pre-admission failure.
- Resident runtimes bound committed source ids with a FIFO window; pending
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
- `/packages/agent-runtime/claude-code/src/runtime-submissions.ts`
- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

### Claude Code Stream-Json Settlement

Both runtimes wait for every native submission folded into a logical turn to
converge, but they read convergence off different signals. Codex has a native
turn id per submission. Claude Code does not: these are the `claude`
stream-json wire facts, probed against a live resident session (2.1.231) rather
than inferred, and the repo has guessed them wrong twice.

- **Commands fold.** A message that arrives while the in-flight turn is inside a
  tool call is absorbed into that turn at the next query-loop boundary: the CLI
  issues `started` for each queued command, answers them together, and emits a
  **single** `result` (3 commands → 1 result, observed). A command that
  arrives between turns runs alone and gets its own `result`.
- **`result.user_message_uuid` is not a completion ledger.** A folded command's
  uuid never appears on any `result`, so counting one result per submitted uuid
  deadlocks. When several commands fold, the single result does not reliably
  carry the first-submitted uuid — a later uuid has been observed instead. It is
  usable only as a cross-talk guard.
- **An interrupt genuinely interrupts.** The running command goes
  `cancelled` and the CLI emits a `result` with `subtype:
  "error_during_execution"` and **no** `result` key and **no**
  `user_message_uuid`. "Missing uuid" therefore cannot mean "settle now" —
  that artifact would settle the turn on an interrupt.
- **`command_lifecycle` is the only 1:1 signal.** Every submitted uuid reaches a
  terminal state (`queued → started → completed | cancelled`), folded commands
  included. It is a top-level `type` (`{type, command_uuid, state, uuid,
  session_id}`); the `system`-subtype shape is only kept for older streams and
  fixtures.
- **Ordering between lifecycle and result is not stable.** Terminal states have
  been observed both before and after the result they belong to. Only eventual
  arrival may be assumed.

Consequently a logical turn settles when **every submitted command uuid has
reached a terminal lifecycle state and at least one `result` has been seen**,
carrying the last result seen (the aggregator is last-result-wins). A result
naming a uuid this turn never submitted is dropped rather than allowed to settle
another turn. Two escapes keep that gate from hanging: a build with no
`msg_lifecycle_v1` has no lifecycle signal at all and settles on its first
result; and a turn whose commands all ended without ever running (`cancelled`,
`discarded`, or a failed steer write) can never be answered and fails
immediately, because the idle deadline is not an acceptable backstop there — it
reaps the resident child, and unrelated stream lines re-arm it. A turn that did
run a command keeps waiting for its result, since terminality does not imply the
result has already been emitted.

Source:

- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/stream.ts`
- `/packages/agent-runtime/claude-code/tests/rpc.test.ts`

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
runtime stopped producing, once per native turn, with a completed, failed or
interrupted status and its own reason text when it has one. The sink is
generation-fenced, synchronous, display-only and fail-open — a write from a
revoked generation is dropped, and a throwing consumer never affects
settlement.

One native turn is one provider-native terminal: one Claude Code `result`, one
Codex `turn/completed`. A resident Claude Code execution window may legally
answer several commands in sequence and so reports one end per `result`. Where a
turn ends with no native terminal at all — a stop, a protocol loss, a rejected
run — the provider synthesizes an end, but only from the call that actually
settled a still-open submission. That guard is what makes an ordinary success
report exactly one end, and it is why no provider-side deduplication state
exists.

A native turn no Dreamux submission ever bound is not an exception: its items
display, and so does its end. Withholding it was tried and removed — a card
belongs to no turn (`feishu-cot-conversation-cards` rules 1 and 8: one anchor
and at most one open card, and a native-ended fact closes an open card, never
opens one, and is ignored when none is open), so an end has nothing to name and
a runtime has nothing to decide. What a provider still owes is at-most-once per
native turn; codex keeps that with a per-record flag, because the submission
check Claude Code's synthesis uses is not available for a turn that has none.

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
