# Managed-Daemon Self-Upgrade

This is the sole transition guide in this skill. Run it only after explicit
operator intent to upgrade a managed Dreamux daemon. It reads release-specific
actions from the validated staged target; it does not carry historical schemas
or migration recipes.

## Contents

- [Preflight](#preflight)
- [Staged inspection and classification](#staged-inspection-and-classification)
- [Execution before restart](#execution-before-restart)
- [Post-restart verification and reporting](#post-restart-verification-and-reporting)
- [Recovery and artifact disposition](#recovery-and-artifact-disposition)

A Dispatcher may take the self-resuming path only when every preflight is
proven. Otherwise prepare a sanitized plan and hand the operation to an
independent operator/controller.

## Preflight

### 1. Prove identity and the return Channel

Require the operator to identify or confirm the current Dispatcher id. Require
an originating Channel message and an available provider reply tool so phase
two can report to the same Channel. If either fact is unavailable, stop and
request it. Never guess an id from process state or workspace paths.

### 2. Discover, then re-read under managed authority

Use an initial `dreamux doctor --json` only to discover the managed service.
Treat `service.execStart[0]` as its launcher authority. Require
`service.installed`, `enabled`, `loaded`, and `running` to be true, with a
non-null service PID and captured service environment. Draw no
caller-environment config or provider conclusion from this discovery result.

Run the exact launcher `doctor --json` again under the captured service
environment. Require this second result's `configFile` to be the config under
the captured `DREAMUX_CONFIG_DIR`. Only this result is authoritative for the
Dispatcher, providers, config, and later doctor calls.

### 3. Prove the resumable managed instance

Under the same managed environment, run the exact launcher `status`. Require a
matching enabled/running Dispatcher row with a non-empty `session_id`. Require
the authoritative doctor result to name its Agent Runtime provider as
`builtin:codex` or `builtin:claude-code`, whose owner contracts guarantee resume
support; a non-empty session alone is not proof for an external provider.

Record the server `pid` and `uptimeSec`. Do not demand equality between the
service PID and status PID: the service PID is the public CLI parent while
`server.status` reports its server child. Resolve the status PID's parent with
the platform process table and require it to equal `doctor.service.pid`.
Otherwise fail closed because status and service have not been proven to
describe the same managed instance.

### 4. Prove package, launcher, and prefix identity

Resolve `service.execStart[0]` and `command -v dreamux` to real paths. Compare
the launcher with the package location under the current `npm root -g` and its
`npm prefix -g`. Reject an npm-linked package root or any prefix/launcher
mismatch.

Read the matched package root's `package.json.version`, then run both
`dreamux --version` and the exact service launcher with `--version`. Require all
three values to be the same valid semver and record it as the old version. The
matched package manifest is authoritative, so an npm-linked checkout reporting
`0.0.0` cannot pass.

### 5. Resolve an exact forward target before mutation

Resolve the npm selector to an exact version before changing disk state:

- when the operator names a version or dist-tag, resolve only
  `@excitedjs/dreamux@<requested>`;
- when omitted, use `@excitedjs/dreamux@latest`, the latest stable release
  rather than `beta` or `alpha`.

Use `npm view @excitedjs/dreamux@<requested-or-latest> version --json` to
resolve the exact target semver. This step never installs a package. Equal is a
no-op. A lower target is a downgrade and is always rejected by this SOP. A
downgrade requires a separate independently reviewed recovery plan; explicit
version selection does not opt into the forward-only algorithm.

### 6. Stage and validate exact old and target artifacts

Before overwriting the live service prefix, create a private temporary staging
directory and capture the npm executable, global prefix, and an explicit
isolated cache path. In the commands below, `npm` is that captured executable.
Run these two operand-complete commands:

```text
npm pack @excitedjs/dreamux@<oldVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts
npm pack @excitedjs/dreamux@<targetVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts
```

Validate each tarball's package name, manifest version, integrity output,
changelog files, and bundled skill tree without executing target code. A
top-level tarball alone is not rollback proof. Do not install either package or
dependency closure until the staged target guidance is read and classified.

## Staged Inspection And Classification

### 7. Read the staged target and select the full version range

Extract the validated target tarball in staging. Read its `CHANGELOG.json`, its
bundled `dreamux-maintenance/SKILL.md`, and the target owner references named by
that root. The target version's current-only references are authoritative for
its schema, defaults, meaning, and ownership. Use the running old version's
references only to understand and preserve the old values.

The changelog is complete and newest-first. Select `(oldVersion,
targetVersion]` and order entries by semver from oldest to newest. Do not
inspect only the newest entry or execute storage order. The `--json` flag used
later changes only the output format and is not a range selector; range
selection belongs to the reader.

### 8. Classify live-safe and independent-quiesced work

Classify all applicable `BREAKING:`, `Review:`, and `Rebuild:` instructions
before touching the live prefix, config, or state.

- A live-safe operator-config action may stay in this self-resuming path only
  when the staged changelog and target owner references prove that the target
  can start safely with the untouched old config and with every planned
  intermediate config state.
- Any action that stops or quiesces the daemon or Dispatcher, modifies
  server-owned or mixed-ownership state, re-registers the service, changes the
  active recovery Channel/Dispatcher identity, or otherwise removes the
  current execution path cannot be performed by the current Dispatcher.

For the second branch, leave the live prefix untouched and hand an independent
operator/controller this exact order:

1. verified stage and inspection;
2. rehearse both dependency closures exactly as specified in step 9;
3. confirmed stop;
4. post-stop re-read and owner-only backup;
5. install the staged exact target with the rehearsed offline closure;
6. apply actions oldest-to-newest using the staged target owner references;
7. run the target doctor in the captured service environment;
8. start and verify.

On any post-stop failure, restore the backups, reinstall the staged old
artifact with the rehearsed offline closure, run the old exact-launcher doctor,
and restart the old service only when rollback is proven. Otherwise keep the
service stopped and report the independent recovery blocker. Do not enter the
self-resuming phase.

### 9. Rehearse both complete dependency closures

Before either path touches the live prefix, populate and prove the full old and
target dependency closures without executing lifecycle scripts. Use the
captured npm executable and the same explicit isolated cache for all four
operand-complete commands, with four distinct private prefixes:

```text
<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-old-online> <staged-old-tarball>
<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-target-online> <staged-target-tarball>
<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-old-offline> <staged-old-tarball>
<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-target-offline> <staged-target-tarball>
```

Validate both fresh offline prefixes' manifests, launchers, changelogs, and
bundled skills. These exact tarballs, the isolated cache, and the rehearsed
command shape form the target and rollback closure. Failure stops the SOP
before live-prefix mutation.

### 10. Route target-owned preparation and transfer recovery ownership

For every live-safe config action, use the staged target root routing table to
resolve the reference whose task/read condition owns config editing and each
affected provider. Do not hard-code the current reference filenames into this
generic SOP: a future target may rename or split them while keeping its route
authoritative. This upgrade reference owns ordering and transaction boundaries,
not schema or edit facts.

This step is preparation only. Resolve authoritative paths, plan each
transformation oldest-to-newest, and create owner-only backups using the target
owner's exact structural and atomic-write contract. Do not mutate config or
state yet. Follow the staged changelog rather than embedding historical schemas
in this skill.

The current exact restart-marker path is
`<captured-managed-HOME>/.dreamux/run/restart-intent.json`, where
`<captured-managed-HOME>` is the managed `HOME` captured in step 2. Every
transfer, exact stat/read, removal, and `ENOENT` absence proof in this SOP uses
this one resolved path.

Before the first live-prefix or config mutation, transfer an exact inventory of
the staging directory, isolated cache, rehearsal prefixes, backups, launchers,
captured environment, that exact restart-marker path, and rollback commands to
an independently executing operator/controller. Use an operator-private path.
Require acknowledgement. Do not expose private paths or secrets to a broad
originating Channel. That independent controller owns the recovery material if
the current Dispatcher disappears.

If no such private handoff and acknowledgement can be established, execute the
first step 17 outcome: remove only this run's exact scoped artifacts and
backups, refuse the self-resuming upgrade, and stop. If an independent operator
is reachable only through a non-private route, provide a sanitized
independent-quiesced plan from step 8, require that operator to stage fresh
recovery materials, and clean rather than retain or expose this run's private
inventory.

## Execution Before Restart

### 11. Install the rehearsed target without scripts

Install the validated target tarball with the exact captured npm executable and
the rehearsed isolated cache:

```text
<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-target-tarball>
```

Re-resolve both launcher paths, validate the matched manifest, and require the
exact launcher and PATH command to report the target version. Re-run the
installed `dreamux changelog --json` and require it to match the staged target
changelog before mutating config.

This creates a short, contained skew window in which the old daemon remains in
memory while the live prefix holds the target. If installation or any
identity/changelog check fails, immediately run:

```text
<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-old-tarball>
```

Validate the old manifest/launchers and exact-launcher doctor, and do not
restart. The rehearsed old closure, no-config-mutation boundary, and
doctor-before-restart rule must be proven before installation. If rollback
cannot be proven, report through the original Channel and follow the final
confirmed-stop handoff from step 12.

An unexpected old-daemon exit during this skew window may reap the caller. The
live-safe proof ensures the target can start on every intermediate config
state, but the current Dispatcher then makes no success claim and an
independent operator must finish verification. This residual process-exit risk
cannot be removed without choosing the independent stopped path.

### 12. Apply live-safe actions exactly once

Apply the classified live-safe actions exactly once, oldest-to-newest, using
the staged target owner references. On ambiguity or failure, restore every
mutation from backup, reinstall the staged old artifact with the rehearsed
offline closure, validate its manifest/launchers and exact-launcher doctor, and
leave the old daemon running.

If complete rollback cannot be proven, report the failure through the original
Channel and hand an independent operator the exact launcher, captured
environment, staged artifacts/cache, backups, and observed failure. Only that
independent operator may use the rehearsed old closure's exact launcher to
issue `dreamux daemon stop`, observe its result, and confirm quiescence before
recovery.

After confirmed stop, the independent operator removes only the transferred
exact marker path,
`<captured-managed-HOME>/.dreamux/run/restart-intent.json`, and proves that same
exact path is absent. Only explicit `ENOENT` counts as absence; any other
stat/removal error remains unresolved. No old or target service may start until
marker absence is proven; otherwise keep the service stopped. The current
Dispatcher must not claim it can confirm the stop or cleanup that reaps it.

### 13. Run target doctor before restart

Run the target package's exact launcher `doctor --json` in the captured managed
service environment. On failure, perform the same backup/package rollback and
do not restart. If rollback cannot be proven, report through the original
Channel and follow the final confirmed-stop handoff from step 12.

### 14. Trigger the exact restart-resume capability

Trigger the exact target service launcher under the captured managed-service
environment with:

```text
<exact-target-service-launcher> daemon restart --notify-resumed --dispatcher <current-id>
```

Reconstruct the invocation so captured managed `HOME`, `PATH`,
`DREAMUX_CONFIG_DIR`, and `DREAMUX_NODE_BIN` values override any caller or
provider `extra_env` values. This keeps the restart marker, launcher, config,
and service-control target in the same authority domain.

The command writes a one-shot marker before restarting. The new server consumes
it once and injects the default `Restart completed.` notice into the named
resumed Dispatcher. The caller may be reaped during restart, so it must not
depend on seeing the command return successfully or continue post-checks in the
pre-restart turn.

If the restart CLI fails synchronously while the caller survives, whether
during marker creation or later service control, enter one failure path. Only a
service-control failure after marker creation causes the CLI to attempt
best-effort removal; marker creation itself may fail before that cleanup path
and can leave partial state. In either case, verify with an exact stat/read. Only
explicit `ENOENT` proves absence. That verification must use the same
`<captured-managed-HOME>/.dreamux/run/restart-intent.json` path; permission,
I/O, or any other result remains unresolved.

Only after `ENOENT` may the failure be treated as rollback-capable. If absence
is proven, immediately restore config backups, reinstall and verify the staged
old artifact, dispose of scoped artifacts under the verified-rollback outcome,
and report failure through the original Channel. If marker absence or rollback
cannot be proven, classify the operation as unresolved recovery, retain the
scoped materials with the pre-acknowledged independent owner, and follow the
final confirmed-stop handoff from step 12. Do not close it as verified rollback
or clean the recovery material.

## Post-Restart Verification And Reporting

The injected `Restart completed.` notice, when an upgrade was in flight in the
resumed conversation, is the explicit trigger to continue with steps 15-18.

### 15. Re-prove installed target identity

Re-run the exact service launcher plus PATH `dreamux` with `--version` and
confirm both still resolve to the same target package and version.

### 16. Re-prove service and Dispatcher identity

Re-run the exact-launcher `doctor --json` under the captured managed
environment. Require the new service to be installed, enabled, loaded, and
running, then run exact-launcher `status`. Confirm the current Dispatcher is
running, resolve the new status PID's parent, and require it to equal the new
service PID. Report the new `pid` and `uptimeSec` and compare them with the
pre-restart snapshot so a stale or unrelated server is not mistaken for
success.

### 17. Dispose of artifacts by outcome

| Outcome | Required disposition |
|---|---|
| Failure or refusal before the first live mutation and before private handoff acknowledgement, including a partial step 10 backup or missing private recovery owner | Remove only this run's exact staging directory, isolated cache, rehearsal prefixes, and any backups already created, then stop. No unowned recovery material may remain. |
| Planned independent-quiesced operation with an acknowledged private operator path | Retain the material and transfer its exact private inventory before stop. |
| Verified success or fully verified rollback | Remove only the exact staging directory, isolated cache, rehearsal prefixes, and config backups created by this run. |
| No notice or unresolved recovery | Retain the material with the independent owner who acknowledged it before step 11. |

Never use a broad or unresolved cleanup path, and never delete unresolved
recovery material.

### 18. Report through the original Channel

Reply through the same originating Channel surface. Report old and new
versions, target selection (`requested` or `latest`), applicable changelog work
and backup outcome in sanitized form, doctor result, new process status/uptime,
and overall success or remaining blocker. Assistant text is not Channel
delivery.

## Recovery And Artifact Disposition

- A verified rollback before restart performs the verified-rollback row of
  step 17 immediately, then reports failure through the original Channel.
- An unresolved recovery retains and transfers the exact scoped paths to the
  pre-acknowledged independent owner. Never expose them through a broad Channel.
- If the restart notice does not arrive, the stopped or reaped Dispatcher
  cannot self-diagnose. The independent operator must run `dreamux status`,
  inspect daemon logs, and contact the user.
- Foreground `dreamux serve` is not silently treated as a managed daemon. It
  needs an external stop/start and recovery path.
- On any rollback that cannot be proven, use the final confirmed-stop handoff
  in step 12. The independent operator owns stop confirmation, exact-marker
  cleanup with `ENOENT`-only absence proof, and recovery restart authority.
