# Managed-Daemon Self-Upgrade

Use this guide only after an explicit request to upgrade the managed Dreamux
daemon. It composes the installed package's existing install, changelog, doctor,
and notification-restart surfaces. Foreground `dreamux serve` requires an
external stop/start and is not covered here.

### 1. Install the requested version

Confirm the current Dispatcher id and retain the originating Channel message and
provider reply tool for the resumed report.

Resolve the managed service once with `dreamux doctor --json`. Treat
`service.execStart[0]` as the launcher the service actually runs, use its
captured environment for every later command, and record that launcher's
`--version` as `oldVersion`. Stop and report when that launcher, the `dreamux`
on this shell's `PATH`, and the package under `npm prefix -g` are not the same
install: onboarding pins the service to whichever launcher ran it, so upgrading
one copy and restarting another would report a version that is not running.

Resolve the exact target before changing anything. When the operator does not
name a version, use `latest`:

```text
npm view @excitedjs/dreamux@<requested-or-latest> version
```

Compare the resolved target with `oldVersion`. Equal is a no-op: report it and
stop. Lower is a downgrade this guide does not perform — report it and stop,
because the forward changelog range in step 2 would be empty and meaningless.
Only a higher target continues:

```text
npm install --global @excitedjs/dreamux@<resolved-target>
```

Require the install to succeed, then re-read the managed launcher's `--version`,
require it to equal the resolved target, and record it as `targetVersion`. If
installation or version resolution fails, diagnose and fix it before continuing.
Do not restart.

### 2. Read changelog and migrate config

Read the changelog from the installed target package:

```text
dreamux changelog --json
```

Review the entries after `oldVersion` through `targetVersion`, oldest first.
Handle every applicable upgrade action. For each applicable config change or
migration, use the target package's bundled `dreamux-maintenance` Task Routing to
load the owner reference, then update the managed config as that owner describes.
Do not continue while a required migration is incomplete.

### 3. Repair until doctor passes

Run the installed target against the managed environment:

```text
dreamux doctor --json
```

If doctor fails, use its concrete errors and the target package's bundled owner
reference to repair the config or environment, then rerun doctor. Continue until
doctor passes. If a blocker cannot be repaired, report it through the originating
Channel and stop. Do not restart until doctor passes.

### 4. Notification restart and report

Restart only after the target doctor passes:

```text
dreamux daemon restart --notify-resumed --dispatcher <current-id>
```

The new server injects `Restart completed.` into the resumed Dispatcher. Treat
that notice as the completion trigger and reply through the originating Channel
with the provider reply tool. Report `oldVersion`, `targetVersion`, the changelog
actions and config migrations completed, the passing doctor result, and the
restart result. Assistant text alone is not Channel delivery.

If the restart command itself fails while this turn is still alive, route to the
root skill's Service lifecycle entry. Once the restart is in flight this caller
may be reaped, so it claims nothing: the resumed notice is what reports the
upgrade.
