# Global `dreamux` bin owns onboarding and serving

- **Status:** In progress
- **Date:** 2026-06-02
- **Affects:** public CLI surface, onboarding UX, service registration, Codex app-server runtime
- **PR / Issue:** [issue #18](https://github.com/excitedjs/dreamux/issues/18)

Runtime state, socket path, Feishu MCP transport, and workspace-skill uninstall
ownership details in this record are superseded by
[top-level-design](top-level-design.md). The single-bin, onboard, and
foreground `serve` decisions still stand.
Dispatcher `tm` packaging and dispatcher-skill install location are superseded
by [dispatcher-tm-packaging](dispatcher-tm-packaging.md).

Two service-management decisions below are **reversed by
[issue #78](https://github.com/excitedjs/dreamux/issues/78)**: there is now a
public `dreamux daemon install|uninstall|start|stop|restart` command group, and
`dreamux onboard` / `daemon install` now enable `loginctl enable-linger`
(best-effort) so a `systemd --user` service starts at boot without an
interactive login. See [the amendment](#amendment-issue-78-daemon-group--linger)
at the end of this record.

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
forms as compatibility contracts. The package also exports a `tm` wrapper
because the dispatcher skill depends on `@excitedjs/tm` as a direct dreamux
dependency.

`dreamux onboard` copies the bundled dispatcher Codex skill into the
dispatcher workspace-local Codex skill directory, collects dispatcher and
channel configuration, and registers a native service manager entry.
`dreamux serve` runs the existing server in the foreground and lets launchd or
systemd keep it alive.

The generated service environment must be self-sufficient. It must not rely on
interactive shell startup files such as `.zshrc` to make Node or Codex
available. During onboarding, dreamux selects a service Node, validates that it
satisfies the package's supported Node range, resolves the Codex executable to a
runnable path for managed service use, seeds `HOME` for clean user-service
probes, and renders those values into the user service environment.

The service Node is not the onboarding Node frozen unconditionally. Onboarding
prefers a stable system Node from a platform-aware candidate list (macOS covers
Homebrew under `/opt/homebrew` and `/usr/local`; Linux covers `/usr/local/bin`,
`/usr/bin`, `/bin`), accepting the first candidate that exists, is not bound to
a version manager, and satisfies `MIN_SERVICE_NODE_VERSION`. It falls back to
the onboarding Node (`process.execPath`) only when no stable candidate
qualifies. The candidate's own path — a stable symlink, never its `realpath` —
is what gets persisted, which keeps the volatile Homebrew Cellar path out of the
service; when the fallback Node is itself a Cellar path, onboarding best-effort
remaps it to the matching Homebrew `opt/...` symlink and otherwise persists it
unchanged. The fallback reproduces the original fragility when onboarding runs
under a version-manager Node, which is exactly what the `dreamux doctor`
stability advisory exists to surface. Selection and that advisory share one
async, injectable version-manager predicate (resolving symlinks before
matching nvm/fnm/asdf/volta markers, including the macOS fnm default under
`~/Library/Application Support/fnm/`) so they cannot drift apart.

There is no public `dreamux daemon ...` command tree. The daemon form is
foreground `dreamux serve` supervised by a native user-level service manager.
After `dreamux onboard` registers that service, operators use native
`launchctl` or `systemctl --user` commands for ongoing service start, stop,
status, and uninstall operations.
*(Reversed by issue #78 — see the
[amendment](#amendment-issue-78-daemon-group--linger).)*

Dispatcher app-server processes do not set `CODEX_HOME`; they use Codex's
global default home (`~/.codex`) for auth, config, and memory. The
The consumer is still the dispatcher agent: the dispatcher is the long-lived
Codex app-server, and its dispatcher skill is scoped to that agent's
workspace. Onboarding installs that skill by directly copying the
bundled `SKILL.md` into `<dispatcher cwd>/.codex/skills/dispatcher/SKILL.md`.

Skill installation, Codex global state, and app-server control state are
separate concerns: the dispatcher skill is workspace-local, Codex's own
auth/config/memory remain under the global Codex home, and dreamux app-server
control sockets live under dreamux-owned state with a short socket leaf.
dreamux does not generate or rewrite a Codex TOML config. Codex model/provider,
auth, memory, and other user settings follow the operator's local Codex
installation.

Service registration is user-level only for issue #18:
macOS LaunchAgent and Linux `systemd --user`. Root-scoped LaunchDaemons and
root-scoped systemd services are out of scope. Automatic
`loginctl enable-linger` was out of scope for issue #18 but is **now enabled
(best-effort) by issue #78** — see the
[amendment](#amendment-issue-78-daemon-group--linger).

Use commodity packages for commodity infrastructure:

- `yargs` for command parsing and help.
- `@clack/prompts` for the first-run wizard.
- `execa` for subprocess execution.
- `plist` for launchd plist generation.
- JSON parsing for dreamux config (`~/.dreamux/config.json`). Codex may still
  manage its own TOML config in its global default home; dreamux does not write
  TOML config files.

The dispatcher Codex app-server launched by `dreamux serve` must:

- run outside Codex's restricted-network workspace profile, or at minimum
  use a network-enabled permission profile
- use Codex's global default home, with no `CODEX_HOME` override
- load the dispatcher skill from `<dispatcher cwd>/.codex/skills/dispatcher/`
- have the dreamux package bin directory on `PATH`, so bare `tm` resolves to
  the package-local `@excitedjs/tm` wrapper
- use dreamux-owned state paths defined by
  [top-level-design](top-level-design.md) for control sockets
- keep Unix socket paths short enough for macOS and Linux `sun_path` limits

Onboarding must be path-transparent: every file path created or modified
by `dreamux onboard`, including the copied dispatcher skill and
service-manager registration, must be printed to the operator with its final
status.

## Consequences

- When implemented, this supersedes the package-bin part of
  [cli-and-package-naming](cli-and-package-naming.md):
  the npm package exposes `dreamux` and the dispatcher-required `tm` wrapper.
- `dreamux server start`, `dreamux-server`, and `server-ctl` are not
  compatibility surfaces for issue #18.
- Service registration is native and user-scoped:
  `~/Library/LaunchAgents/dev.excited.dreamux.plist` on macOS and
  `~/.config/systemd/user/dreamux.service` on Linux.
- `serve` should not daemonize itself. Service managers supervise the
  foreground process.
- Onboarding intentionally keeps Codex auth/config/memory in Codex's global
  default home while installing the dispatcher skill into the dispatcher's
  workspace-local `.codex/skills/dispatcher/` directory. All touched paths must
  be printed through the onboarding path ledger. App-server control sockets
  remain under dreamux runtime state.
- The `dreamux` launcher passes its resolved absolute path through
  `DREAMUX_BIN`; service generation uses that path so launchd and
  systemd execute the same global bin the operator invoked.
- The `dreamux` launcher honors `DREAMUX_NODE_BIN` when present, falling back to
  `node` for ordinary interactive and npm-bin use. Service generation sets
  `DREAMUX_NODE_BIN` (to the selected stable Node, see above) and a minimal
  `PATH` whose first entry is that Node's directory, so the service runs without
  sourcing shell rc files.
- `dreamux doctor` emits a non-fatal `warn`-severity advisory when the installed
  service `DREAMUX_NODE_BIN` resolves into a version manager. The advisory keeps
  the check `ok: true` so it never flips the doctor exit code — a version
  manager-bound but currently-runnable service stays green with a visible
  warning that points the operator to rerun `dreamux onboard`.
- Codex's global default home is intentionally reused, so login state, memory,
  and local Codex configuration follow the operator's machine. dreamux must not
  delete that home during uninstall.
- Dispatcher/channel registration should use the existing admin / repository
  source of truth for the first issue #18 implementation, not a second
  dispatcher config file.

## Alternatives considered

- **Keep the old three published bins:** rejected for issue #18.
  `dreamux-server` and `server-ctl` are internal delegated modules, not public
  compatibility surfaces. The only additional public bin is the dispatcher
  `tm` wrapper required by the bundled skill.
- **Use a separate Codex state root per dispatcher:** rejected. It drops the
  operator's Codex login state, memory, and local configuration. Dispatcher
  app-server processes use Codex's global default home instead.
- **Use the global Codex skill directory for the dispatcher skill:** superseded
  by [dispatcher-tm-packaging](dispatcher-tm-packaging.md). The dispatcher
  skill is workspace-local behavior.
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

## Amendment (issue #78): daemon group + linger

[Issue #78](https://github.com/excitedjs/dreamux/issues/78) reverses two
narrow decisions above. Everything else in this record stands.

- **A public `dreamux daemon` command group exists**:
  `daemon install|uninstall|start|stop|restart`. `start|stop|restart` are thin
  cross-platform wrappers over the native manager
  ([`/packages/dreamux/src/daemon/service-control.ts`](/packages/dreamux/src/daemon/service-control.ts));
  `install`/`uninstall` reuse the onboard service slice
  ([`/packages/dreamux/src/daemon/install.ts`](/packages/dreamux/src/daemon/install.ts)).
  `daemon uninstall` removes only the service unit; top-level
  `dreamux uninstall` still removes config/state/logs. Native `systemctl`/
  `launchctl` remain valid; the group is a convenience and the home of the new
  `restart` verb (which did not exist before).
- **`loginctl enable-linger` is enabled best-effort** by both `onboard` and
  `daemon install`, single-sourced in
  [`/packages/dreamux/src/onboard/service.ts`](/packages/dreamux/src/onboard/service.ts)
  (`enableSystemdLinger`). Failure (strict polkit / non-root) is non-fatal: it
  surfaces a warning with the manual fix. `dreamux doctor` now reports a
  `systemd linger` check.
- **`daemon restart --notify-resumed --dispatcher <id>`** drops a one-shot
  marker ([`/packages/dreamux/src/daemon/restart-intent.ts`](/packages/dreamux/src/daemon/restart-intent.ts),
  path via `restartIntentPath()`) *before* triggering the restart — durable if
  the caller is reaped during a self-update. The freshly started server loads
  and deletes the marker once, and injects a `Restart completed.` turn into each
  named dispatcher whose thread actually resumed. The injection happens after
  the dispatcher slot is ready (so the resumed turn can reply through Feishu),
  skips when a real inbound already woke the thread (there is no FIFO queue —
  `TurnManager.injectNotice` detects an in-flight inbound), and never fails the
  dispatcher start or the restart. Cold boots and crash auto-heals do not reach
  the injection path with a live marker.
