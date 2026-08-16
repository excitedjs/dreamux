# Provider Runtime

This page is the stable contract for Dreamux provider loading and Agent Runtime
launch. It consolidates settled design from the provider, package-split, config,
runtime-activity, skill-injection, and CLI/onboard decisions.

Read this before changing provider loading, `agents[]`, runtime config,
runtime diagnostics, bundled skill injection, or runtime prompt plumbing.

## Current Shape

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

Source:

- `/packages/dreamux/src/registry/builtins.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`
- `/packages/dreamux/package.json`
- `/packages/agent-runtime/codex/package.json`
- `/packages/agent-runtime/claude-code/package.json`
- `/packages/channel/feishu-channel/package.json`

## Public Type Boundary

`@excitedjs/dreamux-types` is the provider-authoring contract. It exports
declarations only: provider descriptors, Agent Runtime contracts, Channel
contracts, turn shapes, and diagnostics. It does not export host stores, path
helpers, provider loaders, or runtime implementations.

Agent Runtime providers implement `AgentRuntimeProvider` and return one
`AgentRuntime` instance per launched agent. The runtime interface is
single-instance: start, resume, stop, channel/plain-text input, status,
checkpoint, last/context reads, capabilities, and optional `waitIdle()`.
Dispatcher orchestration verbs such as `spawn`, `send`, `close`, `list`, and
Team operations belong to Dreamux core services and MCP surfaces, never to the
runtime instance.

An accepted input returns one stable `RuntimeTurn` object with one terminal
outcome promise. A provider fold or steer into the active logical turn returns
the exact same object. Provider-native ids may exist inside the provider package,
but they do not cross the neutral boundary for host correlation.

`RuntimeAdmission.failed` is reserved for provider-proven pre-admission failure.
`ambiguous` means the native boundary may have been crossed and therefore cannot
be retried automatically. `AgentRuntime.stop()` fences new input synchronously
and does not resolve until every already-started input admission has settled and
can no longer return a newly accepted Turn.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux-types/tests/root-exports.test.ts`
- `/packages/dreamux-types/tests/no-host-types.test.ts`

## Config Contract

The operator config lives at `~/.dreamux/config.json`.

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

Channel providers may self-report an opaque `identity` for display/status. Core
stores the string but never interprets provider config fields such as a Feishu
app id.

Source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/config/config-helpers.ts`
- `/packages/dreamux/src/agent-runtime/external-provider.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`

## Runtime Create Context

Core launches every agent through `AgentRuntimeProvider.createRuntime(context)`.
The context is neutral:

- `identity.runtime_id` and optional `checkpoint_id`;
- provider-parsed `config`;
- launcher-supplied `cwd`;
- `systemPrompt` with optional `replace` and `append` forms;
- exactly the MCP server descriptors core selected for this role;
- effective `skillSources`, composed by core from required role roots and any
  authorized custom roots. Core stores custom roots as canonical absolute
  directories and guarantees each path is a skill root whose direct children are
  skill directories;
- optional feature-disable names such as `cron`;
- neutral logger, path, state, and environment injection seams.

Core should not call provider-specific factories, classes, or package imports
directly. The package-boundary guard rejects provider implementation imports and
provider-specific factory calls from core source.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/factory.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

## Logical Turn And Admission Contract

The runtime object is the provider-owned authority for native submission and
termination; Dreamux core never reconstructs runtime activity from callbacks or
native identifiers.

- One accepted logical input returns one `RuntimeTurn`.
- Native aliases folded into the logical input must converge before that object
  settles.
- The provider owns its private source-deduplication reservation. Concurrent use
  of one reserved source shares the same admission result.
- A source commits after acceptance or ambiguous post-admission failure. It is
  released only after a provider-proven pre-admission failure.
- Resident runtimes bound committed source ids with a FIFO window; pending
  reservations remain separate single-flight state and are never evicted before
  native admission resolves.
- `stop()` initiates provider teardown before waiting on startup, restart, or
  submission work that teardown is expected to reject.

Codex keeps app-server `turn.id` values inside its package. Claude Code keeps its
command UUIDs inside its stream-json adapter. Neither identifier is Dreamux
service state.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/agent-runtime/codex/src/turn-manager.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/source-reservation.ts`
- `/packages/agent-runtime/claude-code/src/rpc.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

Provider-native transcript formats, locator discovery, cursor envelopes, and
typed errors stay inside each runtime package. Both built-ins reuse
`/packages/dreamux-utils/src/transcript.ts` for provider-neutral digest checks,
bounded scan accounting, exact positional reads, path containment, rendering,
and output budgets; duplicating those security and determinism primitives in
each provider is not an accepted boundary.

## Codex Portable Output Schema

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
accepted native alias converges before the public `RuntimeTurn` settles.

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
- `/packages/agent-runtime/codex/tests/output-schema-codec.test.ts`
- `/packages/agent-runtime/codex/tests/turn-manager.test.ts`
- `/packages/agent-runtime/codex/tests/runtime-output-schema.test.ts`
- `/packages/dreamux/tests/codex-live.test.ts`

## Bundled Skills

Dreamux ships bundled skills under `/packages/dreamux/skills/`, but it does not
install them into dispatcher workspaces during `onboard` or runtime startup.
Core passes effective skill roots through `AgentRuntimeCreateContext`.

Current role gate:

- Dispatcher roles receive the dispatcher workflow and maintenance root.
- TeamLeader roles receive the Team workflow root.
- Ordinary TeamMate and team-member roles receive no bundled Dreamux skills.

The admin creation surface may add runtime-neutral custom roots for a
TeamMate, team member, or TeamLeader. Core persists only those additions on the
agent identity and recomposes them on every launch. TeamLeader composition
always retains the required bundled Team workflow root. This capability is not
part of MCP tool schemas or model-facing runtime discovery.

Runtime packages own engine-specific application:

- Codex sends the role-specific root through `skills/extraRoots/set`.
- Claude Code materializes a runtime-owned `.claude/skills/<name>` add-dir root
  and passes it with `--add-dir`.

Source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/teammate-collection/index.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Prompt Contract

The Agent Runtime prompt surface is `systemPrompt`. Core may supply both:

- `replace`: full role instructions for runtimes that replace their base prompt;
- `append`: ordered focused role guidance for runtimes that append to their
  native prompt.

Runtime adapters choose their supported native mechanism. Replacement support is
an adapter implementation fact, not a new capability bit. Dispatcher launches
provide both forms for the same role guidance; a replacement-native runtime must
not also append the same dispatcher guidance.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/base-prompt.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/agent-runtime/codex/tests/system-prompt.test.ts`

## Activity And Scheduling

`AgentRuntime.waitIdle?()` is the optional neutral activity hook. General core
consumers may treat an omitted hook as already idle. Durable Team dissolve is
the strict exception: every process-live TeamLeader or member writer must expose
`waitIdle()` before acceptance, because its shared worktree cannot otherwise be
proven quiescent. It is not a lifecycle status or a capability flag.

The scheduler races `waitIdle()` against its own maximum defer window before
injecting scheduled prompt input. Team dissolve waits for every captured live
writer without a normal-operation timeout and races that wait only against its
typed shutdown interruption. Restart notices do not use `waitIdle`; their
startup skip latch is about real inbound that raced during startup, not turn
activity.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`
- `/packages/dreamux/src/service/team-collection/dissolve-runner.ts`
- `/packages/dreamux/src/service/team-service/index.ts`
- `/packages/agent-runtime/codex/src/runtime.ts`
- `/packages/agent-runtime/claude-code/src/runtime.ts`

## Diagnostics And Onboarding

Providers own provider-specific diagnostics and onboarding. Core owns the host
envelope: config location, dispatcher id/cwd, selected provider refs, service
installation, and file ledger.

Provider diagnostics declare binary checks and run non-binary checks through a
neutral runner. `dreamux doctor`, `dreamux onboard`, and `dreamux daemon
install` derive provider binary checks from the provider capabilities instead
of branching on built-in refs.

Source:

- `/packages/dreamux-types/src/provider.ts`
- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux-types/src/channel.ts`
- `/packages/dreamux/src/cli/doctor.ts`
- `/packages/dreamux/src/onboard/`

## Decision Trail

- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Named agents config normalization](../decisions/agents-config-normalization.md)
- [Agent Runtime providers](../decisions/agent-runtime-provider.md)
- [Entity-owned TeamMate lifecycle and object Turns](../decisions/entity-owned-teammate-lifecycle-and-object-turns.md)
- [Provider references and Capability Registry](../decisions/provider-references-and-capability-registry.md)
- [Agent activity capability](../decisions/agent-activity-capability.md)
- [Channel provider](../decisions/channel-provider.md)
- [Providerized config and state compatibility](../decisions/providerized-config-state-compatibility.md)
