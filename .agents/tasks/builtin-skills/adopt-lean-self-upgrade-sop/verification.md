# Verification

## TeamLeader pre-review

Commands, all from the repository root:

| Command | Result |
|---|---|
| `node common/scripts/install-run-rush.js build` | SUCCESS, 8 operations |
| `node common/scripts/install-run-rush.js lint` | SUCCESS, 7 operations, 1 no-op |
| `node common/scripts/install-run-rush.js test` | SUCCESS 4, SUCCESS WITH WARNINGS 3, NO OP 1, no failure |
| `npx vitest run tests/feishu-allow-chats-release-contract.test.ts tests/bundled-skill-sources.test.ts` | 13 tests passed |
| `.agents/scripts/check.sh` | `KB OK (146 files reachable from root.md)`, exit 0 |
| `shellcheck .agents/scripts/check.sh` | clean |
| `git diff --check` | clean |

`rush update` needed `--bypass-policy`: this machine sets `core.hooksPath` to an
external security-hook directory, and Rush refuses to install its own git hooks
while that is set. The flag only skips Rush's hook installation; no repository or
user git configuration was changed.

Leak gate: the complete diff plus every untracked file was scanned for internal
package scopes, private registry hosts, internal hostnames, and sibling-repository
names. Clean.

Link gate: every Markdown link in every changed or added `.md` file resolves, and
the new task is reachable from `.agents/root.md` through
`tasks/README.md` → `tasks/builtin-skills/README.md` → the task README.

## Independent implementation review

One read-only reviewer, minimal-change fast path, one turn. Two blockers, no
improvements. Both accepted by the TeamLeader.

### Blocker 1 — dangling private-recovery contract in the root skill (accepted, fixed)

The reviewer showed that deleting the staged SOP left two sentences in
`packages/dreamux/skills/dispatcher/dreamux-maintenance/SKILL.md` referring to a
`private recovery` concept no reference defines any more: the Common Diagnostic
Sequence stopped "when any required identity or private recovery condition is
unproven", and Secret Safety still listed `private recovery path` among the values
never to relay.

Trigger chain: explicit upgrade intent loads the root skill; the new SOP's first
step installs a package, which is a mutation; the mutation gate then demands a
condition that no owner defines, so the reader either refuses the upgrade or
reinvents the independent-recovery mechanism this task removed.

Fix: the mutation gate now restates authority, owner, verification, and any
recovery path the routed owner requires, and stops on a required identity or
owner-required condition. Secret Safety drops the orphaned item.

This deviates from adopting the supplied text verbatim, and the operator was told
so: the two lines are unchanged in the source this SOP came from, so the two
copies now differ. The deviation was taken because the dangling reference is
caused by this change's own deletion.

### Blocker 2 — the required `.agents/scripts/check.sh` gate could not run (accepted, fixed under an extended boundary)

`check.sh` failed to parse on stock macOS bash 3.2, so an acceptance criterion of
this task could not be met. The defect predates this change: the same failure
reproduces on the unmodified file at `HEAD`, and `bash -n` alone is enough to show
it. CI runs bash 5, which is why it was never visible there.

Root cause, established by minimal reproduction rather than inspection: bash 3.2
re-scans the body of a process substitution and reads a `case` pattern's closing
bracket as the end of the substitution. The same `case` parses correctly outside
`$( )` / `< <( )`. Only the `case` at the tail of check 4 sat inside a
substitution; the one in check 3 is in the main body and is unaffected.

Fix: that one `case` became a parameter-expansion prefix test with identical
semantics, and the constraint is recorded immediately above the block. The
explanatory comment had to sit outside the substitution — bash 3.2 also mis-scans
comments placed inside one, which the first attempt at this fix demonstrated.

The file was outside the approved boundary, so the TeamLeader stopped and asked.
The operator extended the boundary by choosing option 1 on 2026-09-02.

### Reviewer findings with no defect

Boundary, public-repository safety, CLI command and flag existence, and the Rush
change file were each checked and reported clean. The reviewer confirmed no
`packages/*/src` or test file changed.

## Residual risk

- The `independent operator` wording that remains in `references/feishu-access-v3.md`
  and `references/service-lifecycle.md` was deliberately left alone. Each states a
  fact its own owner still needs — a Dispatcher may not stop its own host and then
  keep patching, and a reaped caller cannot verify its own restart — and neither
  belongs to the deleted upgrade mechanism.
- The lean SOP has no rollback step. That is the accepted consequence of the
  operator's ruling, not an oversight: a failed install is diagnosed before any
  restart, and doctor must pass before the daemon is restarted at all.
