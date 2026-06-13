---
name: dreamux-maintenance
description: Diagnose and operate a Dreamux installation. Use when the user asks about dreamux serve or daemon startup, dispatcher status, missing replies, stuck turns, restart behavior, Codex app-server readiness, logs, config, or workspace-local bundled skills.
---

# Dreamux Maintenance

Use this skill for operational diagnosis of an installed Dreamux host. Keep the
work factual: read the current config, status, logs, and command help before
explaining a failure or taking action.

## Safety

- Do not edit `~/.dreamux`, `~/.codex`, service units, shell startup files, or
  environment variables without explaining the reason first.
- Do not paste bot IDs, tokens, private chat IDs, internal hostnames, or
  machine-local paths into public issues, PRs, or commits.
- Prefer diagnostics and restart commands that preserve state. Do not remove
  state or logs unless the operator explicitly asks.
- Do not copy bundled skills into a dispatcher workspace. Dreamux injects them
  at runtime by role: a Dispatcher/TeamLeader runtime is handed the bundled skill
  sources and the runtime applies them to its engine (Codex via
  `skills/extraRoots/set`, Claude Code via `--add-dir`). Onboard and startup no
  longer write `<dispatcher cwd>/.codex/skills`.
- An upgraded dispatcher may still have an old `<dispatcher cwd>/.codex/skills`
  symlink dir from a prior version. It is harmless — Codex simply lists each
  bundled skill twice — and is safe to delete; Dreamux neither needs nor recreates
  it.

## Quick Triage

1. Identify the host mode:
   - foreground: `dreamux serve`
   - service-managed: `dreamux daemon start`, `dreamux daemon stop`, or
     `dreamux daemon restart`
2. Read setup health:

```bash
dreamux doctor
```

3. Inspect the server and dispatcher:

```bash
dreamux status
dreamux dispatcher list
dreamux dispatcher status --id <dispatcher-id>
```

4. Inspect config without exposing secrets:

```bash
dreamux config path
dreamux config show
```

5. Read only the relevant logs from `~/.dreamux/logs/`:
   - `dreamux-server.log`
   - `codex-app-server/<dispatcher-id>.log`
   - `codex-app-server/<dispatcher-id>.stderr.log`
   - `feishu-channel/<dispatcher-id>.log`
   - `feishu-mcp/<dispatcher-id>.log`
   - `teammate-mcp/<dispatcher-id>.log`

## Common Symptoms

| Symptom | First checks |
|---|---|
| Dispatcher does not start | `dreamux doctor`, dispatcher cwd exists, Codex auth exists. |
| Inbound accepted but no reply | Dispatcher status, Codex app-server log, whether the turn is still active. |
| Restart did not announce recovery | `dreamux daemon restart --notify-resumed --dispatcher <id>` was used, and the dispatcher resumed an existing thread. |
| TeamMate MCP fails | The `teammate` MCP server is injected into the dispatcher runtime; check `teammate-mcp/<dispatcher-id>.log` and that `~/.dreamux/state/<dispatcher-id>/teammate/` is readable. |
| `tm` not found inside dispatcher (fallback path) | The tm CLI is the labeled local-execution fallback. Confirm the Dreamux package `bin/` directory is on dispatcher process `PATH`; rerun `dreamux doctor`. |
| Skill changes did not appear | Bundled skills are injected at runtime by role. Restart the dispatcher so it re-applies the skill roots (Codex `skills/extraRoots/set`); confirm the dispatcher's role is Dispatcher or TeamLeader (ordinary teammates get none). |
| Bundled skill missing for a teammate | Expected: only Dispatcher and TeamLeader runtimes receive bundled skills; ordinary teammate / team-member runtimes get none by default. |
| Old `.codex/skills` symlinks present after upgrade | Harmless leftovers from a prior version (Codex lists each bundled skill twice). Safe to delete `<dispatcher cwd>/.codex/skills`; Dreamux no longer creates or needs it. |

## Log Maintenance

Dreamux does not auto-prune logs (no automatic retention in 0.x). Pruning is a
deliberate operator action:

- A **7-day retention** is acceptable; delete logs older than that when disk
  matters. Logs hold only diagnostics, never durable state.
- **Zero-byte log files are always safe to delete.** Empty runtime child
  stdout/stderr logs are now removed automatically when the child shuts down
  cleanly, so they no longer accumulate one-per-start; what remains under
  `~/.dreamux/logs/` are files that actually captured startup/crash output.
- The whole `~/.dreamux/logs/` tree is rebuildable: it is safe to clear while no
  `dreamux serve` is running; it is recreated on the next start.

Prune manually, e.g. (run only while the server is stopped):

```bash
find ~/.dreamux/logs -type f -mtime +7 -delete   # drop logs older than 7 days
find ~/.dreamux/logs -type f -empty -delete       # drop any leftover empties
```

## Turn Mechanics

For questions about active turns, steering, background commands, and repeated
responses after compaction, read `references/codex-turns.md`.

## Upgrade Flow

Dreamux is in 0.x and does not ship automatic schema migrations. Incompatible
config/state is handled by fail-loud + an explicit rebuild, not by silent
conversion. `dreamux changelog` reads the *installed* package, so the order is:
install the new package, run `dreamux changelog`, handle any breaking/rebuild
notes, and only then restart or re-register.

1. Install the new package, then read the changelog it ships:

```bash
dreamux changelog          # CHANGELOG.md (human-readable)
dreamux changelog --json   # CHANGELOG.json (machine-readable)
```

   `dreamux changelog` reads the *installed* package — run it after installing
   the new version, not before. It cannot show notes for a version you have not
   installed yet.

2. Act on any breaking/rebuild notes before starting the new version:
   - Rebuild or move aside config/state files the changelog calls out (for
     example a Feishu `access.json` that is no longer schema-compatible — it
     holds access grants and is not auto-migrated, so it must be recreated).
   - Do not expect old permissions or recovery state to be inferred; the
     changelog states exactly what to recreate.

3. Only after the changelog actions are done, complete the upgrade:

```bash
dreamux daemon restart
# or, for first install / re-registration:
dreamux onboard
dreamux daemon install
```

## Restart Policy

- If only the service wrapper changed, use `dreamux daemon restart`.
- If a dispatcher is busy, prefer observing status first; restarting can drop
  in-memory pending work.
- To announce a controlled restart to resumed dispatchers:

```bash
dreamux daemon restart --notify-resumed --dispatcher <dispatcher-id>
```

## Closeout

Report:

- commands run
- relevant status or log evidence
- whether the issue is config, permissions, Codex app-server readiness,
  dispatcher turn state, or product behavior
- the smallest safe next action
