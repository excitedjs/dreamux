# Reference: dispatcher skill

`/packages/dreamux/skills/` contains the bundled Dreamux skills that Dreamux
ships in the npm package for supported agent runtimes:

- `dispatcher` teaches dispatcher app-server sessions how to delegate product
  work to TeamMates. The default interface is the server-hosted TeamMate MCP:
  `spawn` creates a semi-resident TeamMate from a requested `name_prefix` and
  returns its concrete, never-reused `name` (issue #199 Slice 1 — `name_prefix`
  is only the requested label; all later calls use the returned `name`), `send`
  submits follow-up turns (and reopens a closed TeamMate when one is not live —
  there is no standalone dispatcher-facing `resume` verb; #155), and `close`
  stops one. `history` is a compact recovery search keyed by concrete name
  (filter by `name` / `status` / `agent_runtime` / `repo` / `grep` / `since` /
  `until`, paginate with `limit` / `cursor`; returns `{ items, next_cursor }`)
  — a recovery list, not a raw event timeline; `last` reads a TeamMate's most
  recent settled turn(s) (`turns` 1..5) by concrete name — working even for a
  closed TeamMate without starting a runtime — and
  `list`/`status`/`get_capabilities` read state without polling. The lifecycle
  `status` filter is kept; the public `history` surface no longer exposes the
  retired `state` / `close_status` filters, the Dreamux-made `session_id`,
  `id`/`team_id`, `display_name`, the machine-local cwd/worktree paths, or
  runtime `checkpoint` (issue #199 Slice 1). Issue #199 Slice 2 collapses the
  shared spawn/send/status/list output (`TeamMateRuntimeStatus`): `owner` is the
  sole ownership authority (no public `role`/`team_id`), `display_name` and the
  runtime `checkpoint` are gone, `session_id` now means the runtime-native thread
  id (early `null` acceptable), and the cwd/source/worktree family is reported
  through one compact `repo` view. The public work-directory INPUT for
  `spawn`/`team.create` is the matching optional `repo` object (`{ mode: reuse-cwd
  | managed, path?, base_ref?, branch?, slug?, cleanup? }`; omitted → a plain
  per-name work dir under the dispatcher workspace,
  `<dispatcher cwd>/.workspace/work/<name>/`, created with `mkdir -p` and NOT a
  git worktree, so the dispatcher cwd need not be a git repo — `reuse-cwd` runs
  in `path`, `managed` creates a git worktree; issue #199), replacing the old
  `cwd` / `repo_cwd` / `worktree` inputs. The obsolete `ctx` and
  `history_events` verbs were removed (issue #188). The
  `tm` CLI is the explicit fallback for legacy diagnostics
  ([provider architecture realignment](../decisions/provider-architecture-realignment.md)).
- `team-dev-workflow` covers multi-teammate review, design, merge, and unblock
  coordination.
- `team` MCP is injected for dispatcher-only Team Mode lifecycle, addressed by
  `team_name` (issue #182 PR-7/PR-8; concrete-key rename in #199 Slice 1):
  `create` a TeamLeader (with an optional `repo` object, same shape as
  `teammate.spawn`, replacing the old `repo_cwd`; #199 Slice 2). `create` starts
  the leader idle unless an optional `prompt` is supplied as its first turn;
  without a prompt no turn is fired at creation (the leader waits for a bound
  channel inbound or a later `send`), and creation never fabricates a default
  leader prompt. Inspect with
  `list` (compact rows) / `status` (the public `team_name`-keyed team view +
  leader/binding summary, no machine-local `repo_cwd`/`worktree`; #199 Slice 2) /
  `history` (a compact recovery search
  by `team_name` / `status` / `repo` / `grep` / `since` / `until`, returning
  `{ items, next_cursor }`; the retired `close_status` filter and the
  `team_id` / machine-local cwd/worktree rows are gone in #199 Slice 1), and
  `dissolve` a Team. The `create_group` (create-a-new-group) and raw `ledger`
  verbs were retired.
- Channel binding is on the **Team MCP**, not on the provider channel MCP:
  `bind_channel({ team_name, channel_id?, meta })` hands an existing channel
  target to a Team, and `transfer_back({ channel_id?, meta })` returns a bound
  target to the dispatcher. `channel_id` selects a configured dispatcher channel
  and defaults to the sole channel when unambiguous; `meta` is the provider
  selector (for Feishu group chats, `{ "chat_id": "..." }`). The removed
  `team.bind_group` / `team.transfer_channel_back` /
  `team.create.bind_group` surfaces have no aliases. Provider-owned tools such
  as Feishu `reply`, `react`, and `list_chat_bots` remain behind the `channel`
  MCP shim.
- `dreamux-maintenance` covers installed Dreamux diagnosis and safe operation.

They are not installed through Codex plugin marketplaces. Core injects them at
runtime by role (issue #209 slice 6): `bundledSkillSourcesForRole(role)` selects
the bundled skill sources for the Dispatcher and TeamLeader roles only (ordinary
teammate / team-member runtimes get none), the launcher passes them as the create
context's `skillSources`, and the runtime package applies them to its engine —
Codex via the app-server `skills/extraRoots/set` RPC (each `skill-dir` source's
parent becomes an extra skills root), Claude Code via `--add-dir` for compatible
sources. `dreamux onboard` and dispatcher startup no longer symlink skills into
`<dispatcher cwd>/.codex/skills`; an old symlink dir from a prior version is left
untouched (Codex lists the skill twice but does not fail) and is safe to delete.

Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home for auth, config, and memory. See
[the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md)
and [the npm package split record](../decisions/npm-package-split-and-channel-targets.md).

## Files

| Path | Role |
|---|---|
| `/packages/dreamux/skills/.claude/skills/<skill-name>/` | Bundled skill directory shipped in the npm package, injected at runtime by role |
| `/packages/dreamux/bin/tm` | Public wrapper that forwards to the package-local `@excitedjs/tm` executable |

## Runtime Boundary

[provider architecture realignment](../decisions/provider-architecture-realignment.md)
supersedes the older dispatcher/tm boundary for server-owned TeamMate state.
Two state owners are kept distinct in the skill:

- The Dreamux server owns TeamMate **agent state** behind the injected
  dispatcher-scoped `teammate` MCP — per-name records
  (`teammate/records/<name>.json`: identity + rolling recovery summary, the
  source for history/list/status) and a per-name turns archive
  (`teammate/turns/<name>.jsonl`, the only JSONL store: prompts plus the captured
  final assistant output that `last` returns) under
  `~/.dreamux/state/<dispatcher-id>/teammate/` (issue #199 Slice 3). The former
  `sessions.jsonl` session ledger and the persisted checkpoint object are gone;
  `session_id` is the runtime-native thread id. The persisted record still keeps
  the requested label internally; the `history` projection no longer surfaces it
  (issue #199 Slice 1).
- The Dreamux server owns Team **lifecycle state** behind the injected
  dispatcher-scoped `team` MCP under `~/.dreamux/state/<dispatcher-id>/team/`.
  TeamLeader and member agents remain TeamMate identities with role/owner
  metadata.
- `tm` owns live tm **session** state — teammate liveness, repository worktrees,
  and resumable session history — invoked through the command boundary.

The dispatcher reaches server TeamMate state only through the `teammate` MCP tools
and live tm sessions only through `tm`; it does not call `teammate.*` admin
methods directly. The MCP path uses the same `AgentRuntime` providers as
dispatchers; `tm` stays the path for isolated worktrees and legacy diagnostics.

## tm Strategy

`@excitedjs/tm` is a direct dependency of `@excitedjs/dreamux`, and the package
exports a `tm` bin wrapper. `dreamux serve` prepends the dreamux package bin
directory to dispatcher app-server `PATH`, so the dispatcher skills must invoke
bare `tm`.

Do not reintroduce `npx`, `npm exec`, plugin marketplace installation, or
`@excitedjs/tm@latest` in the dispatcher skill. The installed package version is
the compatibility boundary.

## Injection Strategy

Bundled skills are injected at runtime by role (issue #209 slice 6); the old
workspace-symlink installer is retired. Nothing is written into the dispatcher
workspace:

- core selects the bundled skill sources for the Dispatcher and TeamLeader roles
  only (`bundledSkillSourcesForRole`); ordinary teammate / team-member runtimes
  receive none
- the runtime package applies them on each (re)start: Codex sets the deduped
  parent roots via `skills/extraRoots/set` after initialize and before thread
  start/resume, reapplying after every app-server restart; Claude Code emits
  `--add-dir` for add-dir-compatible sources
- a Codex `skills/extraRoots/set` unsupported/method-missing response warns and
  continues skill-blind for older app-servers; real root-application errors
  still fail the start loud
- an old `<dispatcher cwd>/.codex/skills` symlink dir from a prior version is
  left untouched (Codex lists the skill twice but does not fail) and is safe to
  delete; startup neither creates nor recreates it
