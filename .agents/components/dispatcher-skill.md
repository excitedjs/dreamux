# Component: dispatcher skill

`/packages/dreamux/skills/` contains the bundled Codex skills that Dreamux
ships in the npm package:

- `dispatcher` teaches dispatcher app-server sessions how to delegate product
  work to TeamMates. The default interface is the server-hosted TeamMate MCP:
  `spawn` creates a semi-resident TeamMate and returns its concrete, never-reused
  name (issue #188 — the requested `name` is only a base slug / `display_name`;
  all later calls use the returned name), `send` submits follow-up turns (and
  reopens a closed TeamMate from its persisted checkpoint — there is no
  standalone dispatcher-facing `resume` verb; #155), and `close` stops one.
  `history` is the durable session-ledger search surface, `last` reads a
  TeamMate's most recent settled turn(s) (`turns` 1..5) from that ledger by
  concrete name — working even for a closed TeamMate without starting a runtime —
  and `list`/`status`/`get_capabilities` read state without polling. The obsolete
  `ctx` and `history_events` verbs were removed (issue #188). The `tm` CLI is the
  explicit fallback for legacy diagnostics
  ([provider architecture realignment](../decisions/provider-architecture-realignment.md)).
- `team-dev-workflow` covers multi-teammate review, design, merge, and unblock
  coordination.
- `team` MCP is injected for dispatcher-only Team Mode lifecycle, addressed by
  Team name (issue #182 PR-7/PR-8): `create` a TeamLeader (optionally binding an
  EXISTING Feishu group via `bind_group: { chat_id }`), inspect with `list`
  (compact rows) / `status` (one Team's detail incl. active bound group) /
  `history` (filterable recovery search), `bind_group` an existing group or
  `transfer_channel_back`, and `dissolve` a Team. The `create_group`
  (create-a-new-group) and raw `ledger` verbs were retired. TeamLeader member
  work still uses the caller-scoped TeamMate MCP.
- `dreamux-maintenance` covers installed Dreamux diagnosis and safe operation.

They are not installed through Codex plugin marketplaces. `dreamux onboard` and
dispatcher startup symlink the bundled skill directories into each dispatcher's
workspace-local Codex skill directory:

```text
<dispatcher cwd>/.codex/skills/<skill-name> -> <dreamux package>/skills/<skill-name>
```

Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home for auth, config, and memory. The bundled skills are
workspace-local because they belong to that dispatcher's command environment.
See [the dispatcher tm packaging decision](../decisions/dispatcher-tm-packaging.md).

## Files

| Path | Role |
|---|---|
| `/packages/dreamux/skills/<skill-name>/` | Bundled skill directory shipped in the npm package |
| `<dispatcher cwd>/.codex/skills/<skill-name>` | Workspace-local symlink installed for one dispatcher |
| `/packages/dreamux/bin/tm` | Public wrapper that forwards to the package-local `@excitedjs/tm` executable |

## Runtime Boundary

[provider architecture realignment](../decisions/provider-architecture-realignment.md)
supersedes the older dispatcher/tm boundary for server-owned TeamMate state.
Two state owners are kept distinct in the skill:

- The Dreamux server owns TeamMate **agent state** behind the injected
  dispatcher-scoped `teammate` MCP — concrete identities (with their requested
  `display_name`), runtime checkpoints, statuses, and the durable session ledger
  (prompts plus the captured final assistant output that `last` returns) under
  `~/.dreamux/state/<dispatcher-id>/teammate/`.
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

## Symlink Strategy

The runtime installer is intentionally symlink-only:

- correct symlinks are left unchanged
- stale or broken symlinks are replaced
- real user files/directories are not overwritten; startup logs a diagnostic
  and onboard reports the path as `skipped`. This includes an old hand-copied
  `dispatcher` directory — Dreamux no longer fingerprints and migrates it
  (issue #98); remove or rename it to let startup recreate the bundled symlink
- custom symlinks in these bundled skill slots are treated as replaceable
  Dreamux-managed links; use a real file or directory to opt out
- missing `.codex/skills` directories are created
- a missing dispatcher cwd is a startup error because it likely means the
  configured dispatcher path is wrong
- unsupported symlink platforms or permission errors fail loudly instead of
  copying bundled content
