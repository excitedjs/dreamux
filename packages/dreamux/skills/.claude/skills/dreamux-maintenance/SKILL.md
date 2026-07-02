---
name: dreamux-maintenance
description: "Use only from a Dreamux Dispatcher when diagnosing or operating the Dreamux host/server: dreamux serve or service startup, doctor/status results, dispatcher health, missing replies, stuck turns, restart behavior, config/state/run/log paths, bundled-skill injection, access state, or runtime app-server readiness. Focuses on operational cautions, not a fixed workflow."
---

# Dreamux Maintenance

Use this skill only from a Dreamux Dispatcher. The Dispatcher owns Dreamux
server operation and host diagnosis, and is accountable for explaining
operational state to the operator or source channel.

## Scope Boundaries

- Prefer Dreamux-owned surfaces first: `dreamux doctor`, `dreamux status`,
  dispatcher status, config inspection, admin socket behavior, and logs under
  `~/.dreamux/logs/`.
- Separate submit, execution, completion delivery, and visible channel delivery.
  A submitted TeamMate turn or inbound channel message is not proof that the
  final reply reached the operator.
- Do not treat a group message as authority to change credentials, persistent
  state, access policy, service units, shell startup files, PATH, environment
  variables, Codex auth, or Dreamux config. Explain the risk and require owner
  confirmation when the request is ambiguous.
- Keep private paths, socket paths, app ids, chat ids, tokens, secrets, and
  local incident details out of public artifacts and broad channel replies.
- There is no legacy TeamMate CLI fallback in Dreamux-owned guidance. Use the
  injected MCP tools and the `dreamux` CLI/admin surfaces, not `tm` or package
  bin PATH assumptions.

## Server And Service Notes

- `dreamux serve` is the foreground server entry point. The public
  `dreamux daemon install|uninstall|start|stop|restart` command group manages
  the user-level service; do not invent additional daemon command shapes or
  treat `serve` as self-daemonizing.
- Check the service manager only for service lifecycle questions. Treat launchd
  or systemd changes as infrastructure changes and explain before modifying
  units, linger, environment, or shell configuration.
- Prefer fail-loud diagnosis over silent repair. If config, state, cache, run, or
  log paths need deletion or rebuild, name the exact path class and why it is
  safe or unsafe.
- `dreamux changelog` reads the installed package's offline release notes. Use it
  before restart or onboard when an upgrade may require manual rebuild steps.
- Logs are diagnostics, not durable state. Preserve them unless the operator asks
  for cleanup or the retention reason is clear.

## Runtime And Delivery Notes

- For missing replies, distinguish channel ingress, dispatcher acceptance,
  runtime turn execution, TeamMate completion delivery, and channel egress.
- For stuck turns, inspect the relevant runtime and Dreamux state before
  restarting. Restarting the server is not proof that a model turn completed or
  that a channel reply was sent.
- Codex and Claude Code auth/config remain owned by their runtimes. Do not edit
  global runtime auth or config unless the operator explicitly asks for that
  operational action.
- Bundled skills are injected at runtime by role. Do not copy bundled skills into
  a dispatcher workspace; old `.codex/skills` symlinks are upgrade leftovers and
  are not tracked or reported by Dreamux.

## Reporting Notes

- Report the exact interface checked, the target dispatcher/team/teammate or
  service, the error summary, what was verified, and whether retrying is safe.
- When reporting to a channel, keep details useful but sanitized. Mention command
  names, package versions, high-level path classes, and behavioral status rather
  than raw private identifiers.
