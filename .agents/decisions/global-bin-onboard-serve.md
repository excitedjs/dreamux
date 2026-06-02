# Global `dreamux` bin owns onboarding and serving

- **Status:** In progress
- **Date:** 2026-06-02
- **Affects:** public CLI surface, onboarding UX, service registration, Codex app-server runtime
- **PR / Issue:** [issue #18](https://github.com/excitedjs/dreamux/issues/18)

## Context

Issue #18 asks for a globally installed `dreamux` to expose one bin named
`dreamux`, and for that bin to perform all install, management, onboarding,
and serving work. The current package still publishes `dreamux`,
`dreamux-server`, and `server-ctl`, and the current `dreamux` CLI is a
hand-written router.

The existing runtime is still the right base: `/packages/dreamux/src/server.ts`
starts all enabled dispatchers, and `/packages/dreamux/src/dispatcher/runtime.ts`
owns one long-lived Codex `app-server` child per dispatcher.

A recent Codex 0.135.0 root-cause check found that dispatcher app-servers
cannot run under Codex's restricted-network workspace profile in production:
bind/listen can be blocked, and `/tmp` control socket handling is unsafe for
this shape. The production dispatcher app-server must run with a profile
that can bind/listen and must use a private writable `CODEX_HOME`.

## Decision

Design issue #18 around one published global bin, `dreamux`, with
`dreamux onboard` and `dreamux serve` as the canonical lifecycle commands.

`dreamux onboard` installs the required Codex / Claude plugins, collects
dispatcher and channel configuration, and registers a native service manager
entry. `dreamux serve` runs the existing server in the foreground and lets
launchd or systemd keep it alive.

Use commodity packages for commodity infrastructure:

- `yargs` for command parsing and help.
- `@clack/prompts` for the first-run wizard.
- `execa` for subprocess execution.
- `plist` for launchd plist generation.
- The existing `smol-toml` parser for dreamux config.

The dispatcher Codex app-server launched by `dreamux serve` must:

- run outside Codex's restricted-network workspace profile, or at minimum
  use a network-enabled permission profile
- receive a dreamux-managed private `CODEX_HOME`
- keep control sockets under `<CODEX_HOME>/app-server-control/`
- avoid `/tmp` sockets

Onboarding must be path-transparent: every file path created or modified
by `dreamux onboard`, including paths touched through Codex / Claude plugin
commands and service-manager registration, must be printed to the operator
with its final status.

## Consequences

- When implemented, this supersedes the package-bin part of
  [cli-and-package-naming](cli-and-package-naming.md):
  the npm package should expose only the `dreamux` global bin.
- `dreamux server start` can remain as an in-binary compatibility alias,
  but new docs and service units should use `dreamux serve`.
- Daemon registration should be native and user-scoped by default:
  `~/Library/LaunchAgents/dev.excited.dreamux.plist` on macOS and
  `~/.config/systemd/user/dreamux.service` on Linux.
- `serve` should not daemonize itself. Service managers supervise the
  foreground process.
- Onboarding must not silently mutate the operator's default interactive
  Codex home. The default Codex plugin install target is the private
  dreamux-managed `CODEX_HOME` used by the dispatcher app-server.
- Dispatcher/channel registration should use the existing admin / repository
  source of truth for the first issue #18 implementation, not a second
  dispatcher config file.

## Alternatives considered

- **Keep the current three published bins:** rejected for issue #18. The
  explicit product requirement is a single global bin named `dreamux`.
- **Let `serve` daemonize itself:** rejected. launchd and systemd already
  own supervision, restart, logs, and status.
- **Run dispatcher app-servers under the restricted-network workspace
  profile:** rejected. It conflicts with the production requirement that
  the persistent app-server must bind/listen reliably.
- **Use `/tmp` for app-server sockets:** rejected. The dispatcher runtime
  needs private, owner-writable control state under its own Codex home.
- **Use Ink for onboarding:** rejected for now. `dreamux onboard` is a
  finite wizard, not a full-screen terminal application.
