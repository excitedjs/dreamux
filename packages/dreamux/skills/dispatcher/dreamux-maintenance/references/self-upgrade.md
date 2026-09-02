# Managed-Daemon Self-Upgrade

Use this guide only after an explicit request to upgrade the managed Dreamux
daemon. It composes the installed package's existing install, changelog, doctor,
and notification-restart surfaces. Foreground `dreamux serve` requires an
external stop/start and is not covered here.

### 1. Install the requested version

Confirm the current Dispatcher id and retain the originating Channel message and
provider reply tool for the resumed report. Record the current `dreamux
--version` as `oldVersion`.

Use the same Node/npm environment and global prefix as the managed service. When
the operator does not name a version, use `latest`:

```text
npm install --global @excitedjs/dreamux@<requested-or-latest>
```

Require the install to succeed, then run `dreamux --version` again and record the
installed result as `targetVersion`. If installation or version resolution
fails, diagnose and fix it before continuing. Do not restart.

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

Use the root skill's Service lifecycle route if restart fails or the notice does
not arrive. Do not claim upgrade success without the resumed notice.
