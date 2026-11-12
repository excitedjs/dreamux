# Operations and troubleshooting

[Documentation](README.md) / Operations and troubleshooting

Start with local setup diagnostics, then inspect the running server:

```bash
dreamux doctor
dreamux status
dreamux dispatcher list
```

`doctor` inspects configuration and provider setup. `status` and Dispatcher
queries require the server to be running and the CLI to use the same
`DREAMUX_ROOT`.

## CLI reference

Run `dreamux --help` or `dreamux <command> --help` for the installed version's
complete options.

| Command | Purpose |
| --- | --- |
| `dreamux onboard` | Create or update a Dispatcher and optionally install/start the user service |
| `dreamux serve` | Run the server in the foreground |
| `dreamux status` | Query running server status |
| `dreamux doctor [--json]` | Check local setup, optionally as JSON |
| `dreamux dispatcher list` | List configured Dispatchers through the running server |
| `dreamux dispatcher status --id <id>` | Inspect one Dispatcher |
| `dreamux config path` | Print the configuration path |
| `dreamux config show` | Show configuration with secret-like values redacted |
| `dreamux daemon install [--no-start] [--dry-run]` | Register or regenerate the user service; starts it by default |
| `dreamux daemon start` | Start the registered service |
| `dreamux daemon stop` | Stop the service |
| `dreamux daemon restart` | Restart the service |
| `dreamux daemon uninstall [--dry-run]` | Remove the service definition, retaining the Dreamux root |
| `dreamux changelog [--json]` | Read the installed package's release notes |
| `dreamux uninstall [--dry-run]` | Remove the managed service and the Dreamux root, including durable state |

Team, TeamMate, workflow, and schedule operations are exposed to agents through
MCP tools. The CLI's `mcp` command is launched by Dreamux itself; it is not a
manual setup step.

## Manage the service

On Linux, Dreamux uses a systemd user service. On macOS, it uses a launchd user
agent. On Windows, it uses a Task Scheduler task for the current account.
Onboarding normally registers and starts it. To install it later:

```bash
dreamux daemon install --dry-run
dreamux daemon install
```

The installer resolves the service's Node executable and runtime binary paths.
If you move or replace those installations, rerun `daemon install` and check
`doctor`. Shell-only credentials and proxy variables do not automatically reach
the service; use [runtime environment configuration](configuration.md#environment-and-service-startup).

Linux installation attempts to enable user lingering so the service can remain
available after logout. If that fails, read the warning and the doctor result;
the host administrator may need to permit it.

Windows installation uses Password logon (run whether the user is logged on or
not), with limited privileges and a logon trigger for new tasks. A new task,
login-mode conversion or changed launch data opens a native Windows credential
dialog for the current account password, not a Windows Hello PIN. Cancellation
or a native error stops registration. The registering PowerShell process passes
the password directly to Task Scheduler; it never enters JavaScript, command arguments, environment,
Dreamux configuration or Task Data. The dialog does not require a terminal
TTY, and dry runs do not open it.
Only an existing Password task whose Task Data is ordinal-equal to the new
snapshot receives an action-only update without another prompt. Other updates
register Action and Data together through credentialed XML in the same
PowerShell process. Existing triggers, settings, description and run level are
retained; errors do not fall back to Interactive or S4U.

The Task Action invokes the published service entry. Task Data stores the
captured environment and business command (`environment` and `execStart`),
including the installation PATH. `DREAMUX_ROOT` is excluded from that snapshot:
the parent of the registered `<root>/state` WorkingDirectory supplies the root
for startup, status, control, logs and restart notices. Refresh the snapshot
with `daemon install`. The reported `unitPath` is the native Task.Path, not a
file to edit or delete.

Windows stop/restart forcibly terminate owned work rather than drain active
turns. Stop disables the task, reserves its root-hash Job, terminates members
and waits for their held process handles. It then calls Task.Stop and validates
that no Running/Queued instance remains before releasing the reservation and
restoring the previous enabled state. New tasks use `IgnoreNew`; restart
completes stop before one Run. Start/restart then require a registered-root
`server.status` response whose PID belongs to the service Job. `daemon status`
reports Scheduler state; `dreamux status` reports server facts, and neither
establishes that every provider is ready.

A restart issued inside the service reports handoff to a WMI-created external
controller invoking the published entry; that receipt is not a completed
restart. The controller performs the same checks and writes failures to the
registered root's `logs/daemon.stderr.log`. Only the new server consumes the
existing one-shot restart-intent notice at the registered root.

### Existing Windows alpha service

This service-format change requires one approved reinstall when upgrading from
the alpha service that generated `daemon.mjs`:

1. Keep the old version available. Use the original Windows account and original
   `DREAMUX_ROOT` from a terminal outside the service tree.
2. Run the old version's `dreamux daemon uninstall` and confirm success before
   upgrading. If it fails, stop; do not overwrite that task with a new install.
   If the old version is unavailable, first restore a usable old version.
3. Upgrade, then run `dreamux daemon install` and use the native credential dialog.

Do not delete config, state or logs. `daemon uninstall` removes only the service
installation; `dreamux uninstall` is the separate command that removes the root.
Native dialog interaction, saved-credential reuse and cross-session operation
have not been verified end to end in this revision; task queries and shadow
registration tests do not establish those behaviors.

### Restart notices

For an agent-assisted restart, the CLI can notify selected resumed Dispatchers:

```bash
dreamux daemon restart --notify-resumed --dispatcher main
```

Use your actual Dispatcher ID. This injects a restart notice into the agent; it
does not by itself post a Feishu message. Foreground servers are restarted by
stopping and rerunning `dreamux serve`.

## Find logs and state

Paths below are relative to `~/.dreamux`, or the root selected by
`DREAMUX_ROOT`.

| Path | Purpose |
| --- | --- |
| `config.json` | Operator configuration and local channel credentials |
| `logs/dreamux-server.log` | Host diagnostics |
| `logs/channel/<dispatcher-id>.log` | Channel diagnostics |
| `logs/codex-app-server/<dispatcher-id>.log` | Codex app-server output |
| `logs/daemon.stdout.log`, `logs/daemon.stderr.log` | Managed-service output |
| `state/` | Durable agent, Team, scheduling, and channel records |
| `cache/` | Rebuildable runtime/provider caches and attachment files |
| `run/` | Volatile admin socket, locks, and restart intent |

For the default root:

```bash
tail -n 100 "$HOME/.dreamux/logs/dreamux-server.log"
tail -n 100 "$HOME/.dreamux/logs/channel/main.log"
```

Replace `main` with your Dispatcher ID. Inspect logs locally before sharing
excerpts: agent output can contain repository content, paths, or private context.

Durable `state/` is not a generic cleanup target. Agent identity, native runtime
history, and repository files together matter for recovery. Do not repair
server-owned records by hand. `run/` and `cache/` are rebuildable only while no
server is using them; clearing them is not a remedy for malformed durable state.

## Upgrade deliberately

For an npm installation, install the intended release, read its notes, apply any
required manual action, and then restart:

```bash
npm install --global @excitedjs/dreamux@latest
dreamux changelog
# Complete any applicable release-note instructions before restarting.
dreamux daemon restart
dreamux doctor
dreamux status
```

Use `@beta` only when you intend to follow the prerelease channel. For a source
checkout, update your chosen branch and repeat the Rush install/build steps in
the [development guide](development.md).

A `BREAKING:` note describes an upgrade that cannot start until the stated
`Rebuild:` action is completed. Dreamux 0.x does not silently migrate
incompatible state. Read the notes before restarting the newly installed
version, and preserve any data the instructions say to keep.

## Understand restart behavior

Recorded Teams and agent identities can be reconstructed, and runtimes can
resume their native sessions when those records remain available. This is not
an exactly-once replay system:

- Unprocessed inbound messages and pending interactive questions are in memory
  and are lost on restart. Send the request again if needed.
- A native turn that was interrupted by process shutdown is not guaranteed to
  continue executing its old work.
- Active Dynamic Workflow scripts do not resume from their interrupted step.
- Missed cron runs are not replayed. Missed one-shot jobs are disabled.
- Ordinary member reports require a live owning runtime; they are not backed by
  a durable offline inbox.

After restarting, inspect the task's actual files and status, then give the
agent an explicit continuation request.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `dreamux` is not found | Verify the global npm bin directory is on `PATH`, or use the built source launcher. |
| Config file missing | Run `dreamux onboard`. `config path` shows the expected location. |
| Config mode error | Set the local config file to mode `0600`; the loader requires that exact mode on Unix. |
| Onboarding fails after writing files | Read its file ledger and diagnostic errors. Fix the runtime or configuration and retry; onboarding is not an automatic rollback. |
| `status` cannot connect | Start the service, inspect its stderr, and confirm CLI/server `DREAMUX_ROOT` agree. |
| Runtime works in a terminal but not as a service | Compare service user, runtime binary path, native authentication, and `extra_env`; shell exports are not automatically inherited. |
| Codex version is refused | Install Codex 0.137 or newer, then verify the service resolves the intended binary. |
| Bot receives no messages | Check the app is published, available to the user, connected through long-connection events, and has message permissions. Check channel logs. |
| Bot shows a pairing card but ignores the task | Complete owner/creator approval and resend the task. |
| Group messages are ignored | @-mention the bot; verify sender authorization and group access policy. |
| New topics do not create Teams | Confirm the group is a registered collaboration space in topic message format, has no whole-group Team binding, and the bot can read group information. |
| Card clicks fail | Check `card.action.trigger`, access authorization, and conversation-read permissions. Questions expire after 24 hours and do not survive restart. |
| `/stop` leaves workers running | It stops only the directly addressed agent. Ask the TeamLeader to close specific members when that is the intended action. |
| Team dissolution refuses cleanup | Inspect the reported worktree for uncommitted, untracked, or unmerged work; preserve or integrate it, then retry. |
| `doctor` passes but chat still fails | Doctor does not test live Feishu credentials, access state, platform permission coverage, or Claude authentication. Test an actual message. |

When filing an issue, include the Dreamux and runtime versions, operating
system, the failing command or user action, and a redacted error excerpt.

## Uninstall

To stop using the managed service while keeping configuration and history:

```bash
dreamux daemon uninstall --dry-run
dreamux daemon uninstall
```

`dreamux uninstall` has a larger scope: it removes the service and recursively
removes the Dreamux root, including configuration and durable state. Preview it
with `dreamux uninstall --dry-run` and preserve what you need before executing
it. Removing the global npm package is a separate package-manager operation.
