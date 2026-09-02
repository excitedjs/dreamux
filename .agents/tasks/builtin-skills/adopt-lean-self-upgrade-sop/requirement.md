# Requirement

## Initial request

The operator reports that the bundled managed-daemon self-upgrade SOP
(`packages/dreamux/skills/dispatcher/dreamux-maintenance/references/self-upgrade.md`)
is too complex and essentially cannot be executed, and rules that it be replaced
with a lean four-step procedure the operator supplied verbatim.

## Current alignment

- Status: Confirmed with the operator; ready for development approval.

### Confirmed current behavior and evidence

`references/self-upgrade.md` is 363 lines and 18 numbered steps, added whole by
PR #311 and touched once since (PR #353 renamed one status field). Its four
load-bearing obstacles are facts of the text, not of the implementation:

- Step 10 requires transferring an exact inventory of staging directory,
  isolated cache, rehearsal prefixes, backups, launchers, captured environment,
  restart-marker path, and rollback commands to *an independently executing
  operator/controller* over an operator-private path, and requires an
  acknowledgement. Without that acknowledgement the SOP's own instruction is to
  clean up, "refuse the self-resuming upgrade, and stop".
- Step 8 classifies every action that stops or quiesces the daemon or Dispatcher
  as one the current Dispatcher may not perform, and hands it to the same
  independent operator.
- Step 6 and step 9 require two `npm pack` operations plus four global installs
  into four distinct private prefixes (online and offline, old and target)
  before the live prefix may be touched, purely to prove a rollback closure.
- Step 17 encodes a four-row artifact-disposition matrix keyed on outcomes that
  the preceding steps mostly cannot reach.

A Dispatcher is the only actor present when an upgrade is requested through the
Channel. The independent operator/controller the SOP depends on is not a role
this product defines or provisions, so the ordinary path terminates in refusal.

The commands the lean SOP needs all exist on the current CLI:
`dreamux changelog --json` (`packages/dreamux/src/cli/commands/changelog.ts`),
`dreamux doctor --json` (`packages/dreamux/src/cli/commands/doctor.ts`), and
`dreamux daemon restart --notify-resumed --dispatcher <id>`
(`packages/dreamux/src/cli/commands/daemon.ts`, which registers `--notify-resumed`,
repeatable `--dispatcher`, and `--announce`).

### Why the original rationale no longer holds

PR #311 introduced staging, rehearsal, and private recovery ownership to make a
self-resuming upgrade provably reversible. That defense is unpaid for under this
repository's standing rule that no validation, cap, retry, fallback, or recovery
path is added without a named concrete failure scenario: no such scenario was
recorded for the rehearsal prefixes or the independent-controller handoff, and
the defense's own precondition (a second executing actor) does not exist. The
cost is not verbosity — it is that the documented procedure cannot complete.

### Desired outcome

The bundled self-upgrade reference states one runnable four-step procedure:

1. install the requested version (default `latest`), recording `oldVersion` and
   `targetVersion` from `dreamux --version`;
2. read the installed target's changelog with `dreamux changelog --json`, review
   `(oldVersion, targetVersion]` oldest-first, and apply each applicable config
   migration through the target skill's routed owner reference;
3. run `dreamux doctor --json` and repair until it passes; never restart before
   doctor passes;
4. restart with `dreamux daemon restart --notify-resumed --dispatcher <current-id>`,
   then report `oldVersion`, `targetVersion`, changelog work, doctor result, and
   restart result through the originating Channel with the provider reply tool.

### Scope

- `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/self-upgrade.md`
  — replaced by the operator-supplied lean text.
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md` — the three
  upgrade-related passages only (authorization bullet, self-upgrade routing row,
  reporting bullet).
- `.agents/domains/dispatcher-skill.md` and `.agents/domains/model-facing-writing.md`
  — the sentences that document the staged/private-recovery contract.
- `CLAUDE.md` — the maintenance-synchronization clause that describes the
  exception as reading "a validated staged target's changelog".
- One Rush change file for `@excitedjs/dreamux`.
- `packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md` — also the two
  sentences that referred to a `private recovery` condition, which lost its owner
  when the staged SOP was deleted. Added during implementation review.
- `.agents/scripts/check.sh` — one `case` inside a process substitution, which made
  the required knowledge gate unrunnable on stock macOS bash. Pre-existing defect;
  the operator extended the boundary to cover it on 2026-09-02.
- `.agents/skills/dev-workflow/` — restate the fast path's eligibility as a
  minimal-change test instead of a literal one-file test. The operator ruled this
  change onto the fast path while stating the one-file rule is "太绝对", and
  separately asked that the rule's own wording be corrected in the same pass.

### Non-goals

- No change to any CLI, daemon, restart-marker, or config/state behavior. This
  task changes documentation and bundled skill text only.
- No change to the maintenance skill's non-upgrade references or to its
  current-state-only rule.
- No removal of the `cron job stores` routing text from `SKILL.md`; cron is a
  live capability of this package and is unrelated to the upgrade SOP.
- No rollback, staging, or independent-operator mechanism is preserved in a
  reduced form. The operator ruled the replacement is adopted whole.

### Constraints and invariants

- Public-repository red line: the reference must name `@excitedjs/dreamux` and
  must not carry any private registry URL, internal package name, internal
  hostname, or sibling-repository reference.
- `references/self-upgrade.md` remains the skill's single transition exception;
  every other reference stays current-state-only. The release-contract test
  `packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts` locks the
  `references/self-upgrade.md` name and the `current-state-only` phrase in
  `CLAUDE.md`; both survive.
- Foreground `dreamux serve` stays out of scope of the SOP and is stated as
  requiring an external stop/start.

## Acceptance criteria

- `references/self-upgrade.md` contains the four steps above and no staging,
  rehearsal, artifact-disposition matrix, or independent-operator handoff.
- Every command named in the reference exists on the current CLI.
- No internal identifier, private registry, or sibling-repository name appears
  anywhere in the change.
- `.agents/scripts/check.sh` passes, and `rush build`, `rush lint`, `rush test`
  are green.
- A Rush change file exists for `@excitedjs/dreamux`, typed `patch`, describing
  the simplified guide. Not breaking: no config, state, path, or CLI shape
  changes, so no `Rebuild:` note is required.
- The development workflow no longer gates its fast path on a file count, and
  still rejects a high-risk or decision-bearing change however small its diff.
  Nothing under `packages/` cites this wording, so it needs no change file.

## Decisions and unknowns

- Confirmed operator decisions:
  - "改成 builtin-skills 这个 domains" — the task lives under a new
    `builtin-skills` task domain rather than `architecture`.
  - "整个就照抄……那边的就可以了" (the operator named an external source by name; the name is omitted here under the public-repository rule) — adopt the supplied lean SOP whole; do not
    preserve any part of the staged procedure.
  - "直接走一行简化路径就行，那个一行整的有点太绝对了，实际上是这种极简的变更"
    — this task takes the fast path; the literal one-file criterion is too
    absolute for what the fast path is meant to admit.
  - "你顺手把技能里边这个一行的描述改成那种极简变更描述吧" — restate that
    criterion as a minimal-change description in the same change.
- Assumptions (labelled, not operator rulings): the public package name and the
  omission of a private registry flag are required substitutions under the
  repository's public-repo red line, not a partial adoption of the ruling.
- Blocking unknowns: none.
