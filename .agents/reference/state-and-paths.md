# Reference: state and paths

This is the current ownership map for Dreamux local files. It is a reference
page, not a decision record. For rationale, follow the linked decisions.

Path builders belong in `/packages/dreamux/src/platform/paths.ts`; volatile
runtime socket allocation belongs in
`/packages/dreamux/src/platform/runtime-sockets.ts`.

## Operator Config

`~/.dreamux/config.json` is the only Dreamux operator-editable config source.

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

## Server-Owned State

`~/.dreamux/state/` is durable server-owned state. It is not an operator config
surface.

Important children:

- `~/.dreamux/state/<dispatcher-id>/identity.json` + `turn.jsonl`: the dispatcher
  agent's authoritative runtime recovery record at the dispatcher *root* (not
  under `teammate/`), so the `teammate.*` read chokepoints never enumerate it.
- `~/.dreamux/state/<dispatcher-id>/access.json`: dispatcher-local Feishu access
  gate state.
- `~/.dreamux/state/<dispatcher-id>/chat-bots.json`: Feishu known/trusted peer
  bot store owned by the Feishu Channel provider.
- `~/.dreamux/state/<dispatcher-id>/cron-jobs.json`: durable scheduled-task
  definitions owned by the scheduler service.
- `~/.dreamux/state/<dispatcher-id>/collaboration-spaces.json`: dispatcher-local
  collaboration-space bindings and target provisioning records. This is
  Dreamux core state, not Channel provider state.
- `~/.dreamux/state/<dispatcher-id>/teammate/`: TeamMate durable task ledgers.
  Each `identity.json` may include `identity_prompt`, the persisted append-only
  model-facing role guidance for that TeamMate; old records without it read as
  `null`.
- `~/.dreamux/state/<dispatcher-id>/team/`: Team durable ledgers and channel
  binding state.

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

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/state/dispatcher-store.ts`
- `/packages/dreamux/src/service/agent-entity/identity-store.ts`
- `/packages/dreamux/src/service/agent-entity/turns-store.ts`
- `/packages/dreamux/src/service/team-collection/store.ts`
- `/packages/dreamux/src/service/collaboration-space/store.ts`
- `/packages/dreamux/src/service/scheduler/store.ts`
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

## Provider Plugins

`~/.dreamux/plugins/` is Dreamux-owned, persistent, rebuildable installed
content for external `npm:` provider refs. It is not dispatcher state, volatile
run data, or provider-owned cache.

Each package has one encoded path segment with `metadata.json`, immutable
`versions/<version>/` generations, and non-importable `staging/<install>/`
directories. Generations are imported only through their local
`dreamux-import.mjs` bridge from the exact generation captured by the
config-level load session. `metadata.json` remains version 1 and records
`selected_version`, optional `candidate_version`, `last_check_completed_at`,
and optional `last_check_error`; missing candidate/error fields from older v1
documents default to null. A selected version is written only after a complete
strict provider/config load succeeds. Background updates publish only
candidates and never import provider code.

`dreamux serve`, `dreamux onboard`, and `dreamux daemon install` may materialize
missing packages during strict load; their `--dry-run` modes perform
installed-only no-write checks and fail explicitly for referenced missing npm
providers. `dreamux doctor` performs installed-only inspection and reports
unavailable plugins plus the last update error; `dreamux uninstall` removes the
plugin root without loading providers, after canonical path checks protect
HOME/cwd and operator Codex/Claude state from symlink-prefixed recursive
deletion targets. Each install attempt cleans its own staging directory, and a
later install prunes only package-local staging directories older than 24 hours;
published generations are retained.

Key source:

- `/packages/dreamux/src/platform/paths.ts`
- `/packages/dreamux/src/registry/provider-plugin-store.ts`
- `/packages/dreamux/src/config/provider-plugin-loading.ts`

## Cache And Logs

`~/.dreamux/cache/<dispatcher-id>/` is rebuildable cache:

- `spill/`: over-budget TeamMate completion payloads.
- `feishu-attachments/`: bounded inbound Feishu attachment downloads.

`~/.dreamux/logs/` is server-owned log output, split by component. Codex
app-server logs use `~/.dreamux/logs/codex-app-server/<dispatcher>.log`; MCP
shim diagnostics use component directories such as `channel-mcp/`, `team-mcp/`,
and `teammate-mcp/`.

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
