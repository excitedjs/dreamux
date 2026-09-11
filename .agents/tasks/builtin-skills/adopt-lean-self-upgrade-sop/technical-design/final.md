# Final Technical Solution

Path: minimal-change fast path, selected by operator ruling. No proposal or
solution-review TeamMates, no GitHub solution-review Issue.

## Operator rulings (verbatim)

- "改成 builtin-skills 这个 domains"
- "整个就照抄……那边的就可以了" (the operator named an external source by name; the name is omitted here under the public-repository rule)
- "直接走一行简化路径就行，那个一行整的有点太绝对了，实际上是这种极简的变更"
- "你顺手把技能里边这个一行的描述改成那种极简变更描述吧"

The third and fourth rulings both apply to the development workflow's fast-path
criterion: this change is admitted to the fast path, and the criterion itself is
restated as a minimal-change test rather than a literal one-file test.

## Scope A — bundled maintenance skill

### A1. `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/self-upgrade.md`

Replace the whole file with the lean four-step guide:

1. **Install the requested version.** Confirm the Dispatcher id, retain the
   originating Channel message and provider reply tool, record `oldVersion` from
   `dreamux --version`, install into the managed service's own Node/npm
   environment and global prefix, default the selector to `latest`, re-read
   `dreamux --version` as `targetVersion`, and do not restart on failure.
2. **Read changelog and migrate config.** `dreamux changelog --json`, review
   `(oldVersion, targetVersion]` oldest-first, and apply each applicable config
   change through the target package's bundled `dreamux-maintenance` Task Routing
   owner reference. Do not continue while a required migration is incomplete.
3. **Repair until doctor passes.** `dreamux doctor --json` against the managed
   environment, repair and rerun until it passes, report and stop on an
   unrepairable blocker, never restart before doctor passes.
4. **Notification restart and report.**
   `dreamux daemon restart --notify-resumed --dispatcher <current-id>`. Treat the
   injected `Restart completed.` notice as the completion trigger, report
   `oldVersion`, `targetVersion`, changelog and migration work, the doctor
   result, and the restart result through the originating Channel with the
   provider reply tool. Route a failed restart or a missing notice to the root
   skill's Service lifecycle entry, and never claim success without the notice.

Header states the guide is for explicit upgrade intent only, that it composes the
installed package's existing install, changelog, doctor, and notification-restart
surfaces, and that foreground `dreamux serve` needs an external stop/start.

Deleted whole: preflight identity proofs, `npm pack` staging, the four private
rehearsal prefixes, the live-safe versus independent-quiesced classification, the
independent operator/controller handoff and its private-inventory transfer, the
restart-marker `ENOENT` protocol, the artifact-disposition matrix, and the
recovery section.

Mandatory substitution against the supplied text: the install command names
`@excitedjs/dreamux` and carries no `--registry` flag. This is the public-repo
red line in `CLAUDE.md`, not a partial adoption of the "copy whole" ruling.

### A2. `packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md`

Three upgrade-related passages only:

- authorization bullet — the supported path "installs the target, handles its
  changelog and config migrations, repairs doctor failures, and only then
  performs notification restart"; ordinary restart permission is still not
  upgrade permission;
- self-upgrade routing row — read-when becomes "an injected restart notice
  requires the resumed upgrade report";
- reporting bullet — "follow the four-step flow and original-Channel reporting
  contract in the self-upgrade reference".

The service-lifecycle routing row keeps `cron job stores`. Nothing else in the
routing table changes.

### A3. Knowledge owners

- `.agents/domains/dispatcher-skill.md` — the self-upgrade exception now reads
  "install the target, read its changelog and apply config migrations through
  routed owners, repair until doctor passes, then perform notification restart",
  carrying no release-specific schema or migration body.
- `.agents/domains/model-facing-writing.md` — the same exception paragraph states
  the four-step sequence and resumed-Channel reporting, and drops "private
  recovery ownership" and "staged old and target artifacts".
- `CLAUDE.md` — the maintenance-synchronization clause stops describing the
  exception as reading "a validated staged target's changelog" and describes it
  as reading the installed target's changelog and owning references. The strings
  the release-contract test locks (`references/self-upgrade.md`,
  `current-state-only`, `single owning reference`) are preserved.

`.agents/root.md` and `.agents/archive/proposals/dreamux-maintenance-progressive-disclosure.md`
are deliberately untouched. The root routing row already lists the two live
domain docs before the archived specification, and the archive is a decision
trail whose value is recording what #311 decided; rewriting it would erase the
history this change is accountable to.

### A4. Rush change file

`common/changes/@excitedjs/dreamux/...json`, type `patch`. Not breaking: no
config, state, path, CLI, or persisted-format shape changes, so no `Rebuild:` or
`Review:` note.

## Scope B — development workflow fast-path criterion

Restate the fast path as a minimal-change test across
`.agents/skills/dev-workflow/`:

- `references/solution-consultation.md` — section becomes "Use the minimal-change
  fast path". The first eligibility bullet changes from "the expected
  implementation changes exactly one existing implementation file" to a minimal,
  mechanically direct change over a small surface the TeamLeader can hold in one
  review pass. The remaining bullets (no public contract, persisted data,
  migration, dependency, build configuration, security boundary, or compatibility
  behavior; no material technical choice requiring comparison) are unchanged,
  because they are what actually carries the risk. The closing guard is rewritten
  from "One file is necessary but not sufficient" to "A small diff is necessary
  but not sufficient", keeping the rule that a high-risk or decision-bearing
  change uses a reviewed path however small it is. The invalidation sentence
  keys on a material technical choice or an expansion beyond the approved
  boundary rather than on a second file appearing.
- `SKILL.md`, `references/implementation.md`,
  `references/implementation-review.md`, `references/reviewer-identities.md` —
  rename the path consistently and keep review proportionate to the approved
  minimal scope rather than to a file count.

No behavior, test, or shipped artifact depends on this wording; nothing under
`packages/` cites it, so Scope B needs no change file.

## Implementation boundary

Writable:

- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/self-upgrade.md`
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md`
- `.agents/domains/dispatcher-skill.md`
- `.agents/domains/model-facing-writing.md`
- `CLAUDE.md` (maintenance-synchronization clause only)
- `.agents/skills/dev-workflow/SKILL.md` and its `references/` files listed above
- one new `common/changes/@excitedjs/dreamux/*.json`
- this task directory

Out of bounds: all `packages/*/src`, all tests, `.agents/root.md`, the archived
proposal, every non-upgrade maintenance reference, and every other domain doc.

## Verification plan

- `.agents/scripts/check.sh` — link and orphan integrity after the doc edits.
- `node common/scripts/install-run-rush.js build`, `lint`, `test` — green.
- Targeted: `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts`
  and `packages/dreamux/tests/bundled-skill-sources.test.ts` still pass.
- Manual leak gate: the diff carries no internal package scope, private registry
  host, internal hostname, or sibling-repository name.
- Manual read: every command named in the new reference exists in
  `packages/dreamux/src/cli/commands/`.


## Corrections accepted during implementation review

Two blockers were accepted and applied; both are recorded with evidence in
[verification.md](../verification.md).

1. `packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md` — the mutation
   gate and the Secret Safety list still named a `private recovery` condition that
   no reference defines once the staged SOP is gone. Both now state only what a
   routed owner actually requires. This is a deliberate, reported deviation from
   adopting the supplied text verbatim.
2. `.agents/scripts/check.sh` — the required knowledge gate could not run on stock
   macOS bash 3.2. One `case` inside a process substitution became a
   parameter-expansion prefix test. The operator extended the implementation
   boundary to cover this file.


## Follow-up slice: issue #374 corrections

Path: minimal-change fast path, same as the parent slice.

- `references/self-upgrade.md` step 1 — resolve the managed service once from
  `doctor --json`, take `service.execStart[0]` as the launcher and its captured
  environment as the environment, read `oldVersion` from that launcher, stop on a
  launcher / `PATH` / `npm prefix -g` mismatch, resolve the exact target with
  `npm view` before installing, treat equal as a reported no-op and lower as a
  refusal, and require the managed launcher to report the resolved target after
  install.
- `references/self-upgrade.md` step 4 — Service lifecycle routing applies only to
  a synchronous restart failure while the caller survives; the unreachable
  no-notice promise is deleted.
- `.agents/product/README.md` — one entry under `Local state and upgrades` for
  the Channel-visible upgrade outcome, pointing at this task record.
- One Rush change file, `patch`.

Everything on the operator's non-goal list stays absent. No CLI, daemon, config,
or state behavior changes; `doctor --json`, `npm view`, and `npm prefix -g` are
existing surfaces this guide composes.
