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
extra skill roots. Old identity records without that field read as an empty
list. Required bundled role roots remain code-owned and are recomposed at launch
rather than persisted.

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
