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
that can bind/listen and must use writable runtime control state.

## Decision

Design issue #18 around one published global bin, `dreamux`, with
`dreamux onboard` and `dreamux serve` as the canonical lifecycle commands.
There are no legacy global-bin users to protect, so the implementation does
not install `dreamux-server` or `server-ctl` and does not preserve old command
forms as compatibility contracts.

`dreamux onboard` installs the required Codex / Claude plugins, collects
dispatcher and channel configuration, and registers a native service manager
entry. `dreamux serve` runs the existing server in the foreground and lets
launchd or systemd keep it alive.

There is no public `dreamux daemon ...` command tree. The daemon form is
foreground `dreamux serve` supervised by a native user-level service manager.
After `dreamux onboard` registers that service, operators use native
`launchctl` or `systemctl --user` commands for ongoing service start, stop,
status, and uninstall operations.

Dispatcher app-server processes inherit the operator's existing `CODEX_HOME`
(or Codex's default `~/.codex`) instead of creating a separate Codex state
root per dispatcher. The `codexmux` consumer is still the dispatcher agent: the dispatcher is
the long-lived Codex app-server, and its `codexmux-dispatcher` skill is scoped
to that agent. Because Codex loads plugins from the `CODEX_HOME` the app-server
runs under, onboarding installs `codexmux` into the operator Codex home that the
dispatcher will inherit.

Plugin installation and app-server control state are separate concerns:
`codexmux` and Codex's own config/plugin cache remain under the operator
Codex home, while dreamux app-server control sockets live under
`<runtime_dir>/dispatchers/<id>/app-server-control/` with a short socket leaf.
dreamux does not generate or rewrite a Codex TOML config. Codex model/provider,
auth, memory, and other user settings follow the operator's local Codex
installation.

Service registration is user-level only for issue #18:
macOS LaunchAgent and Linux `systemd --user`. Root-scoped LaunchDaemons,
root-scoped systemd services, and automatic `loginctl enable-linger` are out
of scope.

Use commodity packages for commodity infrastructure:

- `yargs` for command parsing and help.
- `@clack/prompts` for the first-run wizard.
- `execa` for subprocess execution.
- `plist` for launchd plist generation.
- JSON parsing for dreamux config (`~/.dreamux/config.json`). Codex may still
  manage its own TOML config in the operator Codex home; dreamux does not write
  TOML config files.

The dispatcher Codex app-server launched by `dreamux serve` must:

- run outside Codex's restricted-network workspace profile, or at minimum
  use a network-enabled permission profile
- inherit the operator Codex home
- load `codexmux` from that inherited Codex home
- keep control sockets under `<runtime_dir>/dispatchers/<id>/app-server-control/`
- avoid `/tmp` sockets
- keep Unix socket paths short enough for macOS and Linux `sun_path` limits
- let `serve` create runtime control directories; the doctor must not require
  ephemeral `app-server-control/` state to pre-exist

Onboarding must be path-transparent: every file path created or modified
by `dreamux onboard`, including paths touched through Codex / Claude plugin
commands and service-manager registration, must be printed to the operator
with its final status.

## Consequences

- When implemented, this supersedes the package-bin part of
  [cli-and-package-naming](cli-and-package-naming.md):
  the npm package should expose only the `dreamux` global bin.
- `dreamux server start`, `dreamux-server`, and `server-ctl` are not
  compatibility surfaces for issue #18.
- Service registration is native and user-scoped:
  `~/Library/LaunchAgents/dev.excited.dreamux.plist` on macOS and
  `~/.config/systemd/user/dreamux.service` on Linux.
- `serve` should not daemonize itself. Service managers supervise the
  foreground process.
- Onboarding intentionally keeps Codex plugin and auth state in the operator
  Codex home that dispatcher app-server processes inherit; all touched paths
  must be printed through the onboarding path ledger. App-server control
  sockets remain under dreamux runtime state.
- The first implementation installs Codexmux from the public
  `excitedjs/dreamux` repository with sparse marketplace paths
  `.agents/plugins` and `codex-marketplace/plugins/codexmux`, using selector
  `codexmux@dreamux`.
- The first implementation installs Claudemux from the public
  `excitedjs/claudemux` marketplace, using selector
  `claudemux@claudemux`.
- The `dreamux` launcher passes its resolved absolute path through
  `DREAMUX_BIN`; service generation uses that path so launchd and
  systemd execute the same global bin the operator invoked.
- The operator's Codex home is intentionally reused, so login state, memory,
  and local Codex configuration follow the operator's machine. dreamux must not
  delete that home during uninstall.
- Dispatcher/channel registration should use the existing admin / repository
  source of truth for the first issue #18 implementation, not a second
  dispatcher config file.

## Alternatives considered

- **Keep the current three published bins:** rejected for issue #18. The
  explicit product requirement is a single global bin named `dreamux`.
- **Use a separate Codex state root per dispatcher:** rejected by PR #34. It
  drops the operator's Codex login state, memory, and local configuration.
  Dispatcher app-server processes now inherit the operator Codex home instead.
- **Use project-local cwd config for `codexmux`:** rejected for issue #18.
  Codex project config can affect some trusted-project settings, but plugin
  and marketplace declarations are user-level Codex config and the plugin
  cache is rooted in `CODEX_HOME`.
- **Support root-scoped service registration in v1:** rejected. The first
  implementation is user-level only and requires no root service setup.
- **Let `serve` daemonize itself:** rejected. launchd and systemd already
  own supervision, restart, logs, and status.
- **Run dispatcher app-servers under the restricted-network workspace
  profile:** rejected. It conflicts with the production requirement that
  the persistent app-server must bind/listen reliably.
- **Use `/tmp` for app-server sockets:** rejected. The dispatcher runtime
  needs private, owner-writable control state under dreamux runtime state.
- **Use Ink for onboarding:** rejected for now. `dreamux onboard` is a
  finite wizard, not a full-screen terminal application.
