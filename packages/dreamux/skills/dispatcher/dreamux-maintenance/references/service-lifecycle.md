# Service Lifecycle And Reply Diagnosis

This reference owns current serve/daemon lifecycle, missing-reply and stuck-turn
diagnosis, bundled-skill injection, runtime app-server readiness, and
same-version restart cautions.

## Server And Service

- `dreamux serve` is the foreground server entry point. The public
  `dreamux daemon install|uninstall|start|stop|restart` command group manages
  the user service; `serve` is not self-daemonizing.
- Check launchd or systemd only for service-lifecycle questions. Explain before
  changing units, linger, environment, or shell startup.
- Use `dreamux doctor` to inspect configuration, provider loading, service
  state, and runtime app-server readiness. Use `dreamux status` for current
  Dispatcher and process facts; neither command proves Channel delivery.
- Current durable state is under `~/.dreamux/state/`, volatile runtime files are
  under `~/.dreamux/run/`, and logs are under `~/.dreamux/logs/`. Use the path
  authorities reported by Dreamux instead of guessing alternate roots.

## Missing Replies And Stuck Turns

- For missing replies, distinguish Channel ingress, Dispatcher acceptance,
  runtime execution, TeamMate completion delivery, and Channel egress.
- For stuck turns, inspect the relevant runtime and Dreamux state before a
  restart. A restart does not prove that a turn completed or a reply was sent.
- Treat a successful submit as acceptance only. Confirm completion and then the
  provider-visible reply separately.

## Bundled-Skill Injection

Bundled skills are injected by role. Inspect the runtime skill-source config
and logs instead of copying bundled skills into a workspace. A missing skill is
an injection/source-readiness problem, not evidence that workspace installation
is required.

## Same-Version Restart Cautions

- A managed service may use
  `dreamux daemon restart --notify-resumed --dispatcher <current-id>`.
  Foreground `dreamux serve` needs an operator-coordinated stop/start and an
  external recovery path.
- Warn before renaming or disabling the current Dispatcher, removing its
  Channel, changing its Agent Runtime provider, or changing Channel
  credentials. Each can break the active recovery path.
- The caller may be reaped during a restart. Do not depend on the pre-restart
  turn to observe success; continue only from the injected restart notice or an
  independent operator's verification.
