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

Codex plugin installation targets the dispatcher app-server's private
`CODEX_HOME`, not the operator's default global Codex home. The `codexmux`
consumer is the dispatcher agent: the dispatcher is the long-lived Codex
app-server, and its `codexmux-dispatcher` skill is scoped to that agent.
Because Codex loads plugins from the `CODEX_HOME` the app-server runs under,
`codexmux` must be installed into that same dispatcher-private home.

Plugin installation and app-server control state are different concerns, but
they intentionally share the dispatcher-private Codex home for issue #18:
`codexmux` lives under `<CODEX_HOME>/plugins/`, dispatcher Codex user config
lives in `<CODEX_HOME>/config.toml`, and app-server control sockets live under
`<CODEX_HOME>/app-server-control/` with a short socket leaf.

The dispatcher-private `config.toml` is independent. Codex does not inherit
missing values from the operator's global default Codex home. `dreamux
onboard` must generate a minimal dispatcher config containing the `codexmux`
plugin declaration, the network-enabled runtime config / approval / sandbox
settings required for the persistent app-server, and any required model /
auth contract. For Codex 0.135, permission-profile fallback is
`default_permissions` plus `[permissions.<name>] network = { enabled = true }`,
and `serve` must validate the final effective values after `-c` CLI
overrides. It must not copy the operator's whole global Codex config and must
not modify that global home in this design slice.

Service registration is user-level only for issue #18:
macOS LaunchAgent and Linux `systemd --user`. Root-scoped LaunchDaemons,
root-scoped systemd services, and automatic `loginctl enable-linger` are out
of scope.

Use commodity packages for commodity infrastructure:

- `yargs` for command parsing and help.
- `@clack/prompts` for the first-run wizard.
- `execa` for subprocess execution.
- `plist` for launchd plist generation.
- The existing `smol-toml` parser for dreamux config.

The dispatcher Codex app-server launched by `dreamux serve` must:

- run outside Codex's restricted-network workspace profile, or at minimum
  use a network-enabled permission profile
- receive a dreamux-managed private runtime `CODEX_HOME`
- load `codexmux` from that private `CODEX_HOME`
- keep control sockets under `<CODEX_HOME>/app-server-control/`
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
- Daemon registration is native and user-scoped:
  `~/Library/LaunchAgents/dev.excited.dreamux.plist` on macOS and
  `~/.config/systemd/user/dreamux.service` on Linux.
- `serve` should not daemonize itself. Service managers supervise the
  foreground process.
- Onboarding intentionally keeps daemon-specific Codex plugin and permission
  state in the dispatcher-private Codex home; all touched paths must be
  printed through the onboarding path ledger.
- The operator's default global Codex home remains outside this design's
  write set, so daemon-specific high-risk settings do not leak into the
  user's daily interactive Codex configuration.
- Dispatcher/channel registration should use the existing admin / repository
  source of truth for the first issue #18 implementation, not a second
  dispatcher config file.

## Alternatives considered

- **Keep the current three published bins:** rejected for issue #18. The
  explicit product requirement is a single global bin named `dreamux`.
- **Install `codexmux` only into the operator's default global Codex home:**
  rejected. The dispatcher, not the `tm` teammates, consumes the
  `codexmux-dispatcher` skill, and the dispatcher app-server loads plugins
  from the `CODEX_HOME` it runs under. Installing only into the global home
  would leave the private dispatcher app-server unable to see `codexmux`.
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
  needs private, owner-writable control state under its own Codex home.
- **Use Ink for onboarding:** rejected for now. `dreamux onboard` is a
  finite wizard, not a full-screen terminal application.
