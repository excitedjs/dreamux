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

External `npm:` refs are not ambient Node imports. Strict config loading routes
them through one Dreamux-owned local plugin-store load session, captures one
exact generation per package for the whole attempt, and imports runtime and
channel providers from that immutable generation. Loading fails loud when no
generation-local importer is available. Builtin refs bypass the plugin store and
keep resolving to packages shipped with Dreamux.

Source:

- `/packages/dreamux/src/registry/builtins.ts`
- `/packages/dreamux/src/registry/provider-loader.ts`
- `/packages/dreamux/src/registry/provider-plugin-store.ts`
- `/packages/dreamux/src/config/provider-plugin-loading.ts`
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
- `/packages/dreamux/src/config/provider-plugin-loading.ts`
- `/packages/dreamux/src/agent-runtime/external-provider.ts`
- `/packages/dreamux/src/channel/external-channel-provider.ts`

## External NPM Plugin Store

`npm:<package>[#export]` provider refs use `~/.dreamux/plugins/`, a
Dreamux-owned persistent but rebuildable store. Each package has metadata, an
immutable `versions/<version>/` generation, and non-importable staging dirs.
The store prepares one package once per strict load session across Agent Runtime
and Channel refs, verifies the installed package identity/version, writes
`package-lock.json`, and imports through the exact generation captured by that
session. The generation-local `dreamux-import.mjs` bridge ensures Node import
conditions are resolved from inside that generation.

The generic provider loader remains kind-neutral. It resolves builtin refs to
bundled packages and uses the ordinary importer only for those builtin/test
paths. For `npm:` refs it requires an explicit generation-local
`importNpmModule`; without one, loading fails loud instead of falling back to an
ambient package that happens to be resolvable from the Dreamux process.

Metadata is owned by `JsonDocumentStore` with warn-and-rebuild corruption
policy. Version-1 metadata records `selected_version`, optional
`candidate_version`, `last_check_completed_at`, and optional
`last_check_error`; older v1 documents without the candidate/error fields parse
with null defaults. `selected_version` means a complete provider factory,
contract, and provider `readConfig` strict load succeeded. A selected complete
generation starts offline without querying npm.

The running server starts one single-flight updater after `Server.start()`;
persisted check timestamps enforce the four-hour interval across restarts. The
updater resolves npm `latest`, publishes/reuses an immutable generation, and
records only `candidate_version`; it never imports provider code or changes
`selected_version`. Background lookup/install failures are logged, preserve
selected and candidate generations, record the settled check time, and expose
`last_check_error` through doctor. Aborting shutdown records neither time nor
error.

Strict materializing loads prefer a candidate, otherwise selected, otherwise
perform first-use npm lookup/install. They commit candidates only after the
whole provider/config attempt succeeds. If a candidate-backed serve or daemon
load fails but every package still has a selected generation, config loading
rejects that candidate pointer and retries once with a fresh selected-only
registry/config snapshot, surfacing the rejection warning. First-use failures
with no selected generation fail loud and retry immediately on the next explicit
start; the four-hour gate constrains only the background updater.

Inspection is a separate no-write API. It returns available/unavailable plugin
diagnostics and never fabricates provider implementations or a pseudo
`DreamuxConfig`.

Command modes:

- `serve`, post-write `onboard`, and `daemon install` use strict materializing
  load. First materialization blocks config loading and startup; serve/daemon
  may apply the selected-only fallback for a rejected update candidate.
- `onboard --dry-run` and `daemon install --dry-run` use installed-only
  no-write loading. They do not materialize, run npm, or create plugin-store
  files; a referenced missing `npm:` provider is reported as an explicit
  dry-run diagnostic/error.
- Pre-merge `onboard` reads existing config in installed-only mode, so dry runs
  and reruns over a missing old `npm:` provider do not mutate the plugin store.
- `doctor` uses installed-only inspection and reports missing/unusable plugins
  plus persisted update errors without synthesizing runnable providers.
- `uninstall` uses the config-owned raw inspection path in warning-only mode;
  it never loads or installs providers and removes `~/.dreamux` plus any
  external config directory as containment-aware targets. Recursive deletion
  targets are checked through the platform canonical-path capability so
  symlink-prefixed paths cannot physically overlap HOME/cwd protections or
  operator Codex/Claude state.
- Builtin refs perform zero plugin-store calls in every mode.

Source:

- `/packages/dreamux/src/registry/provider-plugin-store.ts`
- `/packages/dreamux/src/registry/provider-loader.ts`
- `/packages/dreamux/src/config/provider-plugin-loading.ts`
- `/packages/dreamux/src/config/raw-envelope.ts`
- `/packages/dreamux/src/config/raw-inspection.ts`
- `/packages/dreamux/src/cli/server.ts`
- `/packages/dreamux/src/cli/doctor.ts`
- `/packages/dreamux/src/onboard/run.ts`
- `/packages/dreamux/src/onboard/uninstall.ts`
- `/packages/dreamux/src/daemon/install.ts`
- `/packages/dreamux/tests/provider-plugin-store.test.ts`
- `/packages/dreamux/tests/global-config.test.ts`
- `/packages/dreamux/tests/doctor.test.ts`
- `/packages/dreamux/tests/uninstall.test.ts`

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
- neutral logger, path, state, and environment injection seams;
- optional `onTurnSettled` callback.

Core should not call provider-specific factories, classes, or package imports
directly. The package-boundary guard rejects provider implementation imports and
provider-specific factory calls from core source.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/factory.ts`
- `/packages/dreamux/tests/package-boundary-guards.test.ts`

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

`AgentRuntime.waitIdle?()` is the optional neutral activity hook. Runtimes that
omit it are treated by core as always idle. It is not a lifecycle status and it
is not a capability flag.

The scheduler is the current consumer. It races `waitIdle()` against its own
maximum defer window before injecting scheduled prompt input. Restart notices do
not use `waitIdle`; their startup skip latch is about real inbound that raced
during startup, not turn activity.

Source:

- `/packages/dreamux-types/src/agent-runtime.ts`
- `/packages/dreamux/src/service/scheduler/service.ts`
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
- [Provider references and Capability Registry](../decisions/provider-references-and-capability-registry.md)
- [Agent activity capability](../decisions/agent-activity-capability.md)
- [Channel provider](../decisions/channel-provider.md)
- [Providerized config and state compatibility](../decisions/providerized-config-state-compatibility.md)
