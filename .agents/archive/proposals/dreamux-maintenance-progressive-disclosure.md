# Dreamux maintenance progressive disclosure and self-upgrade SOP

- **Status:** Implemented
- **Affects:** `packages/dreamux/skills/dispatcher/dreamux-maintenance/`, its
  model-facing tests, and repository rules/references that own the bundled
  maintenance and upgrade contract.

## Intent

Refactor `dreamux-maintenance` from a monolithic `SKILL.md` into a concise
operational entry point with one-level, task-routed references. Loading the
skill for a missing reply or daemon question must not also load every provider
schema, the complete Feishu access ledger, or the self-upgrade procedure.

Dreamux self-upgrade is part of maintenance. Give it one dedicated reference
that can carry a low-freedom, restart-safe SOP without turning every maintenance
task into an upgrade task.

Except for the explicitly requested self-upgrade procedure, this is an
information-architecture refactor. It does not change Dreamux runtime behavior,
CLI surfaces, or persisted formats.

## Required structure

Keep `SKILL.md` as the only always-loaded body. It owns:

- scope, authorization, and secret-safety boundaries;
- the common diagnostic sequence;
- a routing table with columns `Task`, `Read when`, and `Reference`;
- common reporting rules.

Every reference is one level below `SKILL.md`, linked directly from that routing
table, and owns one body of facts:

- `references/service-lifecycle.md`: serve/daemon lifecycle, missing replies,
  stuck turns, bundled-skill injection, and same-version restart cautions;
- `references/self-upgrade.md`: the complete managed-daemon Dreamux package
  upgrade, restart-resume, post-check, and original-channel reporting SOP;
- `references/config-envelope.md`: current `config.json` host envelope, path
  authority, provider opacity, and safe structural editing workflow;
- `references/builtin-codex.md`: only the current `builtin:codex` schema,
  defaults, overrides, and runtime meanings;
- `references/builtin-claude-code.md`: only the current
  `builtin:claude-code` schema, defaults, and runtime meanings;
- `references/builtin-feishu.md`: only the current built-in Feishu Channel
  credential schema. This reference is intentionally small: keeping credentials
  out of the generic envelope preserves provider-scoped loading and gives every
  built-in provider one schema owner;
- `references/feishu-access-v3.md`: current V3 shape, field ownership,
  trusted-chat and `/introduce` meanings, and the quiesced edit/ENOENT workflow.

Facts have one owner. Do not duplicate schemas or workflows between
`SKILL.md` and references. References do not link to deeper skill references.

## Self-upgrade contract

`references/self-upgrade.md` implements this exact two-phase SOP for a managed
Dreamux daemon. It runs only after explicit operator intent to upgrade. A
Dispatcher may take the self-resuming path only when every preflight below is
proven; otherwise it prepares a sanitized plan and hands the operation to an
independent operator/controller.

### Before restart

1. Require the operator to identify or confirm the current Dispatcher id and
   require an originating Channel message plus an available provider reply tool
   so phase two can report to the same Channel. If either fact is unavailable,
   stop and request it; never guess an id from process state or workspace paths.
2. Use an initial `dreamux doctor --json` only to discover the managed service.
   Treat `service.execStart[0]` as its launcher authority. Require
   `service.installed`, `enabled`, `loaded`, and `running` to be true, with a
   non-null service PID and captured service environment. Require
   no caller-environment config or provider conclusion from this discovery
   result. Run the exact launcher `doctor --json` again under the captured
   service environment. Require this second result's `configFile` to be the
   config under the captured `DREAMUX_CONFIG_DIR`; only this result is
   authoritative for the Dispatcher, providers, config, and later doctor calls.
3. Under the same managed environment, run the exact launcher `status`. Require
   a matching enabled/running Dispatcher row with a non-empty `thread_id`, and
   require the authoritative doctor result to name its Agent Runtime provider
   as `builtin:codex` or `builtin:claude-code`, whose owner contracts guarantee
   resume support; a non-empty thread alone is not proof for an external
   provider. Record the server `pid` and `uptimeSec`. Do not demand equality
   between the service PID and status PID: the service PID is the public CLI
   parent while `server.status` reports its server child. Instead, resolve the
   status PID's parent with the platform process table and require it to equal
   `doctor.service.pid`; otherwise fail closed because status and service have
   not been proven to describe the same managed instance.
4. Resolve `service.execStart[0]` and `command -v dreamux` to real paths.
   Compare the launcher with the package location under the current
   `npm root -g` and its `npm prefix -g`; reject an npm-linked package root or
   any prefix/launcher mismatch. Read the matched package root's
   `package.json.version`, then run both `dreamux --version` and the exact
   service launcher with `--version`. Require all three values to be the same
   valid semver and record it as the old version. The matched package manifest
   is authoritative, so an npm-linked checkout reporting `0.0.0` cannot pass.
5. Resolve the npm selector to an exact version before changing disk state:
   - when the operator names a version or dist-tag, resolve only
     `@excitedjs/dreamux@<requested>`;
   - when omitted, use `@excitedjs/dreamux@latest`, which is the latest stable
      release rather than `beta` or `alpha`.
   Use `npm view @excitedjs/dreamux@<requested-or-latest> version --json` to
   resolve the exact target semver; this step never installs a package. Equal
   is a no-op. A lower target is a
   downgrade and is always rejected by this SOP. A downgrade requires a
   separate independently reviewed recovery plan; explicit version selection
   does not opt into the forward-only algorithm.
6. Before overwriting the live service prefix, create a private temporary
   staging directory and capture the npm executable, global prefix, and an
   explicit isolated cache path.
   Run these two operand-complete commands:
   `npm pack @excitedjs/dreamux@<oldVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts`
   and
   `npm pack @excitedjs/dreamux@<targetVersion> --ignore-scripts --json --pack-destination <private-dir>/artifacts`.
   Validate each tarball's package name, manifest version, integrity output,
   changelog files, and bundled skill tree without executing target code. A
   top-level tarball alone is not rollback proof. Do not install either package
   or dependency closure until the staged target guidance is read and classified.
7. Extract the validated target tarball in staging. Read its
   `CHANGELOG.json`, its bundled `dreamux-maintenance/SKILL.md`, and the target
   owner references named by that root. The target version's current-only
   references are authoritative for its schema, defaults, meaning, and
   ownership; the running old version's references are used only to understand
   and preserve the old values. The changelog is complete
   and newest-first, so select `(oldVersion, targetVersion]` and order entries
   by semver from oldest to newest. Do not inspect only the newest entry or
   execute storage order. The `--json` flag used later changes only the output
   format and is not a range selector; range selection belongs to the reader.
8. Classify all applicable `BREAKING:`, `Review:`, and `Rebuild:` instructions
   before touching the live prefix, config, or state:
   - a live-safe operator-config action may stay in this self-resuming path only
     when the staged changelog and target owner references prove that the target
     can start safely with the untouched old config and with every planned
     intermediate config state;
   - any action that stops/quiesces the daemon or Dispatcher, modifies
     server-owned or mixed-ownership state, re-registers the service, changes
     the active recovery Channel/Dispatcher identity, or otherwise removes the
     current execution path cannot be performed by the current Dispatcher.
     Leave the live prefix untouched and hand an independent
     operator/controller this order: verified stage/inspect, rehearse both
     dependency closures exactly as specified in step 9, confirmed stop,
     post-stop re-read and owner-only backup, install the staged exact target
     with the rehearsed offline closure, apply migrations oldest-to-newest using
     the staged target owner references, run the target doctor in the captured
     service environment, then start and verify. On any post-stop failure,
     restore the backups, reinstall the staged old artifact with the rehearsed
     offline closure, run the old exact-launcher doctor, and restart the old
     service only when rollback is proven; otherwise keep the service stopped
     and report the independent recovery blocker. Do not enter the
     self-resuming phase.
9. Before either path touches the live prefix, populate and prove the full old
   and target dependency closures without executing lifecycle scripts. Use the
   captured npm executable and the same explicit isolated cache for all four
   operand-complete commands, with four distinct private prefixes:
   - `<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-old-online> <staged-old-tarball>`;
   - `<npm-bin> install --global --ignore-scripts --cache <cache> --prefix <private-target-online> <staged-target-tarball>`;
   - `<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-old-offline> <staged-old-tarball>`;
   - `<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <private-target-offline> <staged-target-tarball>`.
   Validate both fresh offline prefixes' manifests, launchers, changelogs, and
   bundled skills. These exact tarballs, the isolated cache, and the rehearsed
   command shape form the target and rollback closure; failure stops the SOP
   before live-prefix mutation.
10. For every live-safe config action, use the staged target root routing table
    to resolve the reference(s) whose task/read condition owns config editing
    and each affected provider. Do not hard-code the current reference filenames
    into the generic SOP: a future target may rename or split them while keeping
    its route authoritative. The upgrade reference owns ordering/transaction
    boundaries, not schema or edit facts. This step is preparation only: resolve
    authoritative paths, plan each transformation oldest-to-newest, and create
    owner-only backups using the target owner's exact structural and
    atomic-write contract. Do not mutate config or state yet. Follow the staged
    changelog rather than embedding historical schemas in the skill.
    Before the first live-prefix or config mutation, transfer an exact inventory
    of the staging directory, isolated cache, rehearsal prefixes, backups,
    launchers, captured environment, exact managed-HOME restart-marker path,
    and rollback commands to an independently executing operator/controller
    through an operator-private path, and require acknowledgement. Do not expose
    private paths or secrets to a broad
    originating Channel. That independent controller owns the recovery material
    if the current Dispatcher disappears. If no such private handoff and
    acknowledgement can be established, execute the first step 17 outcome:
    remove only this run's exact scoped artifacts and backups, refuse the
    self-resuming upgrade, and stop. If an independent operator is reachable
    only through a non-private route, provide a sanitized independent-quiesced
    plan from step 8 but require that operator to stage its own recovery
    materials; do not retain or expose this run's private inventory.
11. Install the validated target tarball with the exact captured npm executable
    and the rehearsed isolated cache:
    `<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-target-tarball>`.
    Re-resolve both launcher paths, validate the matched manifest, and require
    the exact launcher and PATH command to report the target version.
    Re-run the installed `dreamux changelog --json` and require it to match the
    staged target changelog before mutating config. This creates a short,
    contained skew window in which the old daemon remains in memory while the
    live prefix holds the target. If installation or any identity/changelog
    check fails, immediately run
    `<npm-bin> install --global --offline --ignore-scripts --cache <cache> --prefix <captured-prefix> <staged-old-tarball>`,
    validate the old manifest/launchers and exact-launcher doctor, and do not
    restart. The rehearsed old closure, no-config-mutation boundary, and
    doctor-before-restart rule must be proven before installation. If the
    rollback attempt nevertheless cannot be proven, report through the original
    Channel and follow the final confirmed-stop handoff from step 12.
    An unexpected old-daemon exit during this skew window may reap the caller;
    the live-safe proof ensures the target can start on every intermediate
    config state, but the current Dispatcher then makes no success claim and an
    independent operator must finish verification. This residual process-exit
    risk cannot be removed without choosing the independent stopped path.
12. Apply the classified live-safe actions exactly once, oldest-to-newest, using
    the staged target owner references. On ambiguity or failure, restore every
    mutation from backup, reinstall the staged old artifact with the rehearsed
    offline closure, validate its manifest/launchers and exact-launcher doctor,
    and leave the old daemon running. If complete rollback cannot be proven,
    report the failure through the original Channel and hand an independent
    operator the exact launcher, captured environment, staged artifacts/cache,
    backups, and observed failure. Only that independent operator may use the
    rehearsed old closure's exact launcher to issue `dreamux daemon stop`,
    observe its result, and confirm quiescence before recovery. After confirmed
    stop, the independent operator removes only the transferred exact marker
    path under captured managed `HOME` and proves it is absent; only explicit
    `ENOENT` counts as absence, while any other stat/removal error remains
    unresolved. No old or target service may start until marker absence is
    proven; otherwise keep the service stopped. The current Dispatcher must not
    claim it can confirm the stop or cleanup that reaps it.
13. Run the target package's exact launcher `doctor --json` in the captured
    managed-service environment. On failure, perform the same backup/package
    rollback and do not restart; if rollback cannot be proven, report and follow
    the final confirmed-stop handoff from step 12.
14. Trigger the exact target service launcher under the captured managed-service
   environment with
   `<exact-target-service-launcher> daemon restart --notify-resumed --dispatcher <current-id>`.
   Reconstruct the invocation so captured managed `HOME`, `PATH`,
   `DREAMUX_CONFIG_DIR`, and `DREAMUX_NODE_BIN` values override any caller or
   provider `extra_env` values; this keeps the restart marker, launcher, config,
   and service-control target in the same authority domain.
   This is the exact restart-resume capability. The command writes a one-shot
   marker before restarting; the new server consumes it once and injects the
   default `Restart completed.` notice into the named resumed Dispatcher. The
   caller may be reaped during restart, so it must not depend on seeing the
   command return successfully or continue post-checks in the pre-restart turn.
   If the restart CLI fails synchronously while the caller survives, whether
   during marker creation or later service control, enter one failure path.
   Only a service-control failure after marker creation causes the CLI to
   attempt best-effort removal; marker creation itself may fail before that
   cleanup path and can leave partial state. In either case, resolve the exact
   marker path under the captured managed `HOME` and verify it with an exact stat/read:
   only explicit `ENOENT` proves absence, while permission, I/O, or any other
   result remains unresolved. Only after ENOENT may the failure be treated as
   rollback-capable. If absence is proven, immediately
   restore config backups, reinstall/verify the staged old artifact, and report
   the failure through the original Channel. If marker absence or rollback
   cannot be proven, classify the operation as unresolved recovery, retain the
   scoped materials with the pre-acknowledged independent owner, and follow the
   final confirmed-stop handoff from step 12; do not close it as verified
   rollback or clean the recovery material.

Artifact disposition applies to every terminal path. A verified rollback before
restart performs step 17 immediately and then reports failure through the
original Channel; an unresolved recovery retains and transfers the scoped paths.

### After the injected restart notice

The injected `Restart completed.` notice, when an upgrade was in flight in the
resumed conversation, is the explicit trigger to continue with steps 15-18:

15. Re-run the exact service launcher plus PATH `dreamux` with `--version` and
    confirm both still resolve to the same target package and version.
16. Re-run the exact-launcher `doctor --json` under the captured managed
    environment, require the new service to be installed/enabled/loaded/running,
    and run exact-launcher `status`. Confirm the current Dispatcher is running,
    resolve the new status PID's parent, and require it to equal the new service
    PID. Report the new `pid` and `uptimeSec` and compare them with the
    pre-restart snapshot so a stale or unrelated server is not mistaken for
    success.
17. Dispose of artifacts by outcome:
    - any failure or refusal before the first live mutation and before private
      handoff acknowledgement, including a partial step 10 backup or missing
      private recovery owner, removes only this run's exact staging directory,
      isolated cache, rehearsal prefixes, and any backups already created, then
      stops; no unowned recovery material may remain;
    - a planned independent-quiesced operation with an acknowledged private
      operator path retains the material and transfers its exact private
      inventory before stop;
    - verified success or a fully verified rollback removes only the exact
      staging directory, isolated cache, rehearsal prefixes, and config backups
      created by this run;
    - no-notice or unresolved recovery retains the material with the independent
      owner who acknowledged it before step 11.
    Never use a broad or unresolved cleanup path, and never delete unresolved
    recovery material.
18. Reply through the same originating Channel surface. Report old and new
    versions, target selection (`requested` or `latest`), applicable changelog
    work and backup outcome in sanitized form, doctor result, new process
    status/uptime, and overall success or remaining blocker. Assistant text is
    not Channel delivery.

The reference must also state the recovery boundary: if the restart notice does
not arrive, the stopped/reaped Dispatcher cannot self-diagnose. An independent
operator must run `dreamux status`, inspect daemon logs, and contact the user.
Foreground `dreamux serve` is not silently treated as a managed daemon; it needs
an external stop/start and recovery path.

## Hard constraints

- Preserve every existing frontmatter trigger explicitly: `dreamux serve`,
  daemon startup, doctor/status results, Dispatcher health, missing replies,
  stuck turns, restart behavior, current config/state/run/log paths,
  bundled-skill injection, Feishu access policy, and runtime app-server
  readiness. Add Dreamux upgrade and post-restart recovery without replacing
  those concrete triggers with broader wording.
- `references/self-upgrade.md` is the sole transition guide in this skill. It
  owns only the generic SOP and reads concrete migration/rebuild actions from
  the validated staged changelog, then verifies the installed copy matches. It
  does not copy historical schemas, old-version detection tables,
  release-specific migration recipes, or delete/recreate shortcuts.
- Because `references/self-upgrade.md` exceeds 100 lines, place a concise table
  of contents at its top with links to preflight, staged inspection, execution,
  post-restart verification, and recovery sections.
- Every other reference remains current-state-only and contains no upgrade,
  migration, historical-format, `Rebuild:`, or delete/recreate guidance.
- Do not add `scripts/`; the workflow intentionally uses the installed CLI and
  npm rather than a second updater implementation.
- Do not add assets, auxiliary README/changelog files, or a second skill.
- Do not change runtime code, config/state schemas, public APIs, or CLI
  surfaces.
- Keep all skill content and repository documentation in English.

## Test migration and acceptance

1. `SKILL.md` is a concise entry point and routing map, not a schema catalog.
   Each routing row has one explicit read condition and one direct
   `references/<name>.md` target.
2. Retire `expect(skill).not.toContain('references/')` only for
   `dreamux-maintenance`. Keep the identical guard for monolithic
   `dispatcher-workflow`. Replace the retired assertion with a table-driven
   routing contract that locks all seven task/read-condition/reference mappings,
   requires each target exactly once, and proves the direct route-target set is
   a bijection with the actual files in `references/`. Assert that the complete
   shipped skill tree contains only `SKILL.md` plus those seven one-level
   references: no orphan/deeper reference, `scripts/`, asset, or auxiliary file.
3. Refactor the monolithic `dreamux-maintenance` test into auditable blocks:
   one entrypoint/routing test and one contract test per reference. Add helpers
   that read a named reference and enumerate the full skill tree. Move every
   existing factual assertion to its owner; delete or weaken none. The operator
   changed one contract deliberately: replace the obsolete blanket assertions
   forbidding `upgrade` and `dreamux changelog` everywhere. Do not keep those
   assertions green by hiding the required trigger/routing/SOP language.
4. Permit upgrade trigger and routing words in the frontmatter and `SKILL.md`.
   Positively test every preserved concrete frontmatter trigger plus the new
   upgrade and post-restart recovery triggers.
   Scan `SKILL.md` and every non-upgrade reference for actual skill-evolution
   history, old-version conditional procedures, copied release-specific
   migration/`Rebuild:` bodies, and delete/recreate shortcuts. Test
   `self-upgrade.md` separately for the exact ordered SOP, `@latest` stable
   default, discovery-only first doctor plus authoritative managed-environment
   second doctor, built-in resume-capable provider precondition,
   service-parent/server-child identity before and after restart,
   manifest/launcher/npm-prefix identity, linked-package rejection, pre-install
   exact target resolution without any install or live-prefix mutation,
   unconditional downgrade rejection, operand-complete
   exact-version `npm pack` commands, the four explicit same-cache/global/
   ignore-scripts online and fresh-prefix offline rehearsal commands, and the
   exact same-shape staged-target and staged-old global offline live-prefix
   commands. Lock target-skill extraction, staged-target
   owner-reference authority, old-reference preservation scope,
   staged-changelog classification plus installed-copy equality, reader-owned
   `(old,target]` oldest-to-newest range selection, the definition of live-safe
   across every intermediate start state, rollback for install/identity/config/
   doctor/service-control failures, original-Channel failure reporting plus an
   independent-operator-owned confirmed-stop handoff when rollback is
   unprovable, the documented unexpected-process-exit residual risk, and
   rollback-before-restart. Lock the
   route-derived staged-target config/provider owner references, the live-safe
   versus independent-quiesced branch and its
   stage-before-stop-before-install order, target-owner-reference loading,
   preparation-only backups plus acknowledged operator-private recovery
   ownership before the single mutation step,
   post-stop exact managed-marker removal with ENOENT-only absence proof before
   any independent recovery start, managed-environment doctor-before-restart,
   the exact-target-launcher
   `--notify-resumed --dispatcher <current-id>` command
   with captured managed environment overriding caller/provider values and the
   marker therefore rooted under managed `HOME`, the two-phase turn
   boundary, marker-write synchronous failure plus service-control failure's
   best-effort clearing, with exact managed-marker ENOENT-only absence
   verification for both, the injected notice
   as the continuation trigger,
   version/status/uptime post-check, the four-way artifact outcome table, scoped
   cleanup after pre-mutation failure or success/verified rollback, exact-path
   recovery-material retention with its pre-acknowledged independent owner on
   planned handoff/no-notice/unresolved failure, and
   the non-private-operator fallback that emits only a sanitized plan, requires
   the operator to stage fresh recovery material, and cleans rather than exposes
   this run's private inventory, plus
   original-Channel reply. Assert that it
   contains no hard-coded historical schema, old-version conditional branch,
   release-specific migration body, or delete/recreate shortcut.
   Also lock the self-upgrade reference's top-level table of contents and its
   five required section anchors.
5. Keep provider-neutral `dispatcher-workflow` isolated from Feishu and
   maintenance details.
6. Change the repository config/state synchronization rule from the exact
   `.../dreamux-maintenance/SKILL.md` path to the whole skill folder and its
   owning reference. Deliberately update the exact-path assertion in
   `feishu-allow-chats-release-contract.test.ts`; do not preserve green by
   leaving the stale rule text.
7. Update the following current-contract owners in the same change:
   `CLAUDE.md`, `.agents/root.md`,
   `.agents/reference/dispatcher-skill.md`,
   `.agents/reference/model-facing-writing.md`, and
   `.agents/reference/current-architecture.md`, plus
   `.agents/domains/repository-operations-and-release.md` and
   `.agents/decisions/feishu-allow-chats-trust-semantics.md`, which currently
   place every release transition outside the skill. They must describe
   progressive disclosure and the narrow generic self-upgrade SOP exception to
   the otherwise current-state-only maintenance references. Add the draft to
   the active proposal index while it is active; after implementation, mark it
   implemented, move it to the proposal archive, update archive/index/decision
   links, and leave no implemented proposal in the active list.
8. Add a Dreamux Rush change describing the shipped progressive-disclosure
   refactor and managed-daemon self-upgrade SOP.
9. Tests also enforce owner scope: the root has no provider schema or complete
   workflow body, provider references do not contain another provider's field
   catalog, and lifecycle/config/access workflows appear only in their named
   owner. These are stable contract markers rather than exact prose snapshots.
10. Run the skill validator, focused skill/model-facing tests, full
    `rush update`, `rush build`, `rush lint`, test typecheck, and `rush test`,
    plus `.agents/scripts/check.sh`, `rush change --verify`, and
    `git diff --check`. All pass before push.
11. Before final approval, run two fresh-context, plan-only forward evaluations
    with a Dispatcher that is not shown the expected answer: one ordinary
    missing-reply diagnosis that should route only to the relevant lifecycle
    reference, and one upgrade request where an independent operator is
    reachable only through a non-private route. Give the evaluator synthetic
    private path, environment, and backup sentinels; it must refuse the
    self-resuming path, plan exact scoped cleanup with no orphaned backup, emit a
    sanitized step-8 plan that requires the operator to restage its own recovery
    material, and reproduce none of the private sentinels. The evaluator must not
    execute any command or mutate state; record the observed reference selection
    and plan outcome for review.

## Out of scope

- New Dreamux commands, update APIs, validation capabilities, or live state
  mutation APIs.
- Runtime changes to restart intent, Codex, Claude Code, Feishu, Dispatcher,
  `dreamux --version`, `dreamux changelog`, `dreamux doctor`, or
  `dreamux status`.
- Config/access version changes or automatic migrations.
- A general redesign of the other bundled skills.
