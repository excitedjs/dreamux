# Reference: state and paths

This is the current ownership map for Dreamux local files. It is a reference
page, not a decision record. For rationale, follow the linked decisions.

Path builders belong in `/packages/dreamux/src/platform/paths.ts`; volatile
runtime socket allocation belongs in
`/packages/dreamux/src/platform/runtime-sockets.ts`.

## Operator Config

The path reported by `dreamux config path` is the only Dreamux operator config
source. It is normally `~/.dreamux/config.json`, while `DREAMUX_CONFIG_DIR` may
relocate it.

It declares:

- `agents[]`: Agent Runtime provider configs, such as `builtin:codex` or
  `builtin:claude-code`.
- `dispatchers[]`: dispatcher id, explicit `cwd`, dispatcher-local
  `workspace.enabled`, configured `channels[]`, and `agentRuntime`.
- `dispatchers[].channels[]`: dispatcher-local channel id, Channel provider ref,
  provider-owned channel config, and optional core-owned
  `collaborationSpace.defaultBinding` policy for automatic collaboration-space
  binding.

Legacy top-level `workspace.enabled` is not accepted. Set
`dispatchers[].workspace.enabled` on each dispatcher instead; omitted dispatcher
workspace policy defaults to enabled.

`dreamux serve` fails loudly when the config is missing, when an enabled
dispatcher has no explicit `cwd`, or when providerized config cannot be parsed.
The operator fix path is to run `dreamux onboard` or rebuild the config by hand.

Key source:

- `/packages/dreamux/src/config/config.ts`
- `/packages/dreamux/src/config/collaboration-space-config.ts`
- `/packages/dreamux/src/config/config-helpers.ts`
- `/packages/dreamux/src/cli/commands/onboard.ts`
- `/packages/dreamux/src/onboard/run.ts`

## Dispatcher Workspace

Each dispatcher has an explicit `cwd`. Dreamux-managed TeamMate and Team work
areas live under that dispatcher workspace, not under `~/.dreamux`.

Current workspace paths:

- `<dispatcher cwd>/.workspace/work/<name>/`: default plain work directory when
  TeamMate or Team creation omits `repo` and
  `dispatchers[].workspace.enabled` is true.
- `<dispatcher cwd>`: direct plain work directory when TeamMate or Team creation
  omits `repo` and `dispatchers[].workspace.enabled` is false.
- `<dispatcher cwd>/.workspace/worktree/<repo-slug>/<slug>/`: Dreamux-managed
  Git worktree when the request explicitly asks for `repo: { mode:
  'managed' }`.

When the `.workspace/` boundary is used, it self-ignores with a `*` `.gitignore`
so generated work areas do not become repo content. Managed worktree creation
fails loud if the destination would live under `~/.dreamux`.

Key source:

- `/packages/dreamux/src/service/dispatcher-workspace.ts`
- `/packages/dreamux/src/service/worktree/workspaces.ts`
- `/packages/dreamux/src/service/worktree/manager.ts`
- `/packages/dreamux/src/service/worktree/paths.ts`
- `/packages/dreamux/src/service/team-collection/index.ts`

## Durable State

`~/.dreamux/state/` is durable state. It is not the Dreamux host config surface;
each document's owner defines whether any field can be maintained externally.

Important children:

- `~/.dreamux/state/<dispatcher-id>/identity.json`: the dispatcher agent's
  authoritative identity/lifecycle/runtime-session recovery record at the
  dispatcher *root* (not under `teammate/`), so the `teammate.*` read
  chokepoints never enumerate it. It may contain the provider-owned native
  session id plus nullable opaque `transcript_locator`; it contains no rolling
  conversation projection.
- `~/.dreamux/state/<dispatcher-id>/access.json`: dispatcher-local Feishu V3
  access state with mixed field ownership. `version` is Channel/schema-owned;
  `dm_policy` and `group.*` are operator policy; `allow_users` is shared between
  live pairing/Owner approval and a quiesced operator; `pending`,
  `observed_chats`, `warnings`, and `last_gate` are Channel runtime ledger.
- `~/.dreamux/state/<dispatcher-id>/chat-bots.json`: Feishu known/trusted peer
  bot store owned by the Feishu Channel provider.
- `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`: durable scheduled-task
  definitions owned by the scheduler service.
- `~/.dreamux/state/<dispatcher-id>/collaboration-spaces.json`: dispatcher-local
  collaboration-space bindings and target provisioning records, including the
  target-owned Team-dissolve operation/handoff correlation used while a target
  is closing. This is fully server-owned Dreamux core state, not Channel
  provider or operator state.
- `~/.dreamux/state/<dispatcher-id>/teammate/`: dispatcher-owned TeamMate
  entity directories. Each `identity.json` owns identity, lifecycle, worktree,
  intent, role guidance, and the provider-native session association. It may
  include `identity_prompt`; old records without it read as `null`.
- `~/.dreamux/state/<dispatcher-id>/team/<team-id>/record.json`: fully
  server-owned Team state. Its nullable `dissolve` fact is owned by
  `TeamCollection` and records the accepted operation, caller/generation,
  target handoff ids, first note/time, lifecycle phase, public-safe error,
  cleanup attempt count, and next retry time. Do not edit, clear, or synthesize
  this object manually; active and cleanup-pending phases are startup recovery
  responsibility.
- `~/.dreamux/state/<dispatcher-id>/team/`: the remaining Team durable agent,
  cron, workflow, and permanent name-claim records.
- `~/.dreamux/state/<dispatcher-id>/workflow/<run-id>/`: dispatcher-scope
  Dynamic Workflow `record.json` and append-only `journal.jsonl`.
- `~/.dreamux/state/<dispatcher-id>/team/<team-id>/workflow/<run-id>/`:
  TeamLeader-scope Dynamic Workflow records and journals.

Workflow records are version 1. A normal terminal transition writes
`completed`, `failed`, or `stopped`; startup first adopts an already-committed
terminal journal fact when present and otherwise converts a leftover `running`
record to `stopped`. Journals are server-written JSONL and are not replayed by
the current runtime.

Team `status` remains `starting | running | closed`; the nullable dissolve phase
is a separate fact. At logical close, a managed worktree can be
`cleanup-pending` while routes and runtimes are already durably closed. The Team,
TeamLeader, and Team members receive the same shared cleanup state before
physical cleanup, and terminal or retry results are propagated from the one
Team-owned operation.

TeamMate, team-member, and TeamLeader identities persist admin-supplied
`skill_sources` so runtime relaunch and process restart preserve authorized
extra skill roots. Stored paths are canonical absolute skill-root directories;
relative paths and unreadable/missing directories are rejected, duplicate roots
are collapsed, and direct child skill-name collisions are rejected at the admin
boundary. Old identity
records without that field read as an empty list. Required bundled role roots
remain code-owned and are recomposed at launch rather than persisted.

Legacy identity records that point at old under-state worktree paths are read
verbatim. Dreamux does not rewrite or delete them during ordinary startup.

Dreamux owns no per-Turn archive. A current-layout per-entity `turn.jsonl`
created by an older release is inert residue: Dreamux never creates, stats,
lists, opens, validates, repairs, migrates, warns about, or automatically
deletes it. Its presence, contents, permissions, type, or parseability cannot
block startup, reads, lifecycle operations, Workflow, Team dissolve, or
shutdown. Detailed conversation history is owned by the selected Agent Runtime
provider's native transcript; `last` performs a bounded cold read through the
neutral provider contract without persisting a copy or cursor in Dreamux state.

`access.json` is always under the fixed state path above, independent of
`DREAMUX_CONFIG_DIR`. Manual access maintenance requires an independent
operator to keep the owning Channel fully stopped across post-stop re-read,
exact owner-only atomic patch, current V3 validation, and restart. Preserve the
schema and runtime-ledger fields. If the file is absent after stop, initialize
from the full secure current default through a sibling `0600` temporary file;
create a missing state directory at `0700`.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/state/dispatcher-store.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/agent-entity/transcript-reader.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/collaboration-space/store.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`
- `/packages/dreamux/src/service/workflow-service/store.ts`
- `/packages/dreamux/src/service/workflow-service/journal.ts`
- `/packages/channel/feishu-channel/src/chat-bots-store.ts`

## Run Files

`~/.dreamux/run/` is volatile. It is safe to clear while no Dreamux server is
running.

Current run files:

- `admin.sock` and its lock.
- `restart-intent.json`.
- `sockets/` fallback root for runtime rendezvous sockets.

When available, `$XDG_RUNTIME_DIR/dreamux/sockets/` is preferred for runtime
sockets. Socket paths are random per start, live only in process memory, and are
not persisted to durable state.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/runtime-sockets.ts`
- `/packages/dreamux/src/admin/socket.ts`

## Managed Service PATH

`dreamux onboard` and `dreamux daemon install` generate a systemd user service
or launchd plist with an explicit `PATH` environment. The same effective PATH
resolves bare provider/agent binaries during service installation.

Order, built by `buildServicePath()` in
`/packages/dreamux/src/platform/paths.ts` (the single source of truth):

1. Stable Dreamux-owned dirs: selected Node bin dir, resolved provider bin dirs,
   dreamux bin dir.
2. Captured interactive-session `PATH` from the env the operator ran
   `onboard`/`daemon install` under, in its original order.
3. Fresh-install fallback dirs: `$XDG_BIN_HOME` when set, `$HOME/.local/bin`,
   portable platform system dirs (`standardExecDirs`), and the platform
   Homebrew candidate only when an async presence probe succeeds.

Entries are de-duplicated while preserving first occurrence. Re-running
`daemon install` after switching nvm/pyenv/Homebrew environments regenerates the
service PATH. `runOnboard` and `runDaemonInstall` probe the optional Homebrew
candidate once and reuse the captured fallback list for provider resolution,
launch validation, and service-unit rendering. A Homebrew directory already in
the captured session `PATH` is preserved even when it is not added as a
Dreamux-supplied fallback.

`withServicePath(env, input)` returns a copy of `env` with `PATH` set to
`buildServicePath(input)`; it never mutates the caller's env or `process.env`.
`env`/`homeDir`/`platform` are passed explicitly by callers — the path builders
never read `process.env`.

The callers (`runOnboard` in `onboard/run.ts` and `runDaemonInstall` in
`daemon/install.ts`) resolve the *effective* values before persisting them into
`ServiceInstallAnswers`/`EffectiveOnboardAnswers`: `env` is
`options.env ?? process.env`, `homeDir` is `options.homeDir ?? homedir()`, and
the probed fallback list is captured from
`options.platform ?? process.platform`. In normal CLI use `options.env` is
undefined, so the ambient `process.env.PATH` is captured into the service unit.
Both the resolve-time PATH and the service-unit PATH use these same effective
values.

Resolve-time binary resolution uses `withUserLocalBinPath()` in
`/packages/dreamux/src/onboard/service.ts`, a thin wrapper that builds the
effective PATH from the captured session PATH + fallback dirs (no stable dirs,
since the Node bin is not yet selected at resolve time). The service-unit PATH
is rendered by `managedServicePath()` in the same module, which adds the stable
dirs and delegates to `buildServicePath()`. Both share the single source.

Key source:

- `/packages/dreamux/src/platform/paths.ts` (`buildServicePath`,
  `withServicePath`, `standardExecDirs`, `probeStandardExecDirs`, `userLocalBinDirs`,
  `systemExecDirs`, `dedupeExecDirs`)
- `/packages/dreamux/src/onboard/service.ts` (`managedServicePath`,
  `managedServiceEnvironment`, `withUserLocalBinPath`,
  `resolveServiceExecutable`)
- `/packages/dreamux/src/onboard/service-node.ts` (Node selection and
  version-manager detection)
- `/packages/dreamux/src/onboard/run.ts`
- `/packages/dreamux/src/daemon/install.ts`

## Managed Service Working Directory

Both the systemd unit and launchd plist use `stateRoot()`
(`~/.dreamux/state/`) as their working directory. `installUserService()` owns
creating that directory before either service manager registers or starts the
service, so `dreamux daemon install --start` works even when onboarding did not
previously create server state. Dry runs record the planned directory creation
in the transparent file ledger without changing the filesystem.

Key source:

- `/packages/dreamux/src/onboard/service.ts`
- `/packages/dreamux/src/onboard/ledger.ts`

## Cache And Logs

`~/.dreamux/cache/<dispatcher-id>/` is rebuildable cache:

- `spill/`: over-budget TeamMate completion payloads.
- `feishu-attachments/`: bounded inbound Feishu attachment downloads.

`~/.dreamux/logs/` is server-owned log output, split by component. Codex
app-server logs use `~/.dreamux/logs/codex-app-server/<dispatcher>.log`; Dynamic
Workflow lifecycle logs use `~/.dreamux/logs/workflow/<dispatcher>.log`; scoped
MCP process diagnostics use component directories such as `channel-mcp/`,
`team-mcp/`, and `teammate-mcp/`. MCP stdout is reserved for official stdio
protocol frames. Transport, schema, handler, and shutdown diagnostics go only
to those component loggers or stderr and are not persisted as MCP state.
Successful MCP envelopes are transient wire data rather than state: ordinary
calls carry exact `content: []` plus canonical object `structuredContent`, and
the conditional Team, TeamMate, or workflow success text is likewise never
persisted.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/platform/logger.ts`
- `/packages/channel/feishu-channel/src/provider.ts`

## External Homes

`~/.codex/` is Codex's own global home for auth, config, and memory. Dreamux
dispatcher app-server processes follow Codex there; Dreamux does not create
dispatcher-private `CODEX_HOME` directories for the MVP.

Dreamux bundled skills are injected at runtime by role. They are not installed
into dispatcher workspaces during `onboard` or runtime startup.

Key source:

- `/packages/dreamux/src/service/dispatcher-service/agent.ts`
- `/packages/dreamux/src/service/teammate-service/index.ts`
- `/packages/dreamux/src/platform/paths.ts`
- `/packages/agent-runtime/codex/src/skill-roots.ts`
- `/packages/agent-runtime/claude-code/src/args.ts`

## Related Docs And Decision Trail

- [State, config, and files](../domains/state-config-and-files.md)
- [Runtime run root](../decisions/runtime-run-root.md)
- [Providerized config and state compatibility](../decisions/providerized-config-state-compatibility.md)
- [Provider architecture realignment](../decisions/provider-architecture-realignment.md)
- [NPM package split and channel targets](../decisions/npm-package-split-and-channel-targets.md)
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
