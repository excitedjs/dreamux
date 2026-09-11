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


# Verification — follow-up slice (issue #374)

## TeamLeader pre-review

| Command | Result |
|---|---|
| `rush build` | SUCCESS |
| `rush lint` | SUCCESS |
| `rush test` | SUCCESS, no failure |
| `rush typecheck:tests` | SUCCESS |
| `.agents/scripts/check.sh` | `KB OK`, exit 0 |
| `init_task.py check` | Task record OK |
| `gitleaks protect --staged` | no leaks found |
| `common/scripts/check-internal-content.sh` | exit 0 |

The anti-leak gate was run by hand. This machine sets `core.hooksPath` to an
external security-hook directory, so the repository's own
`common/git-hooks/pre-commit` never fires and the mandatory gate is silently
inert. Nothing about the machine's git configuration was changed; the hook's two
checks were executed directly against the staged content instead. This is a
repository-level gap — the gate CLAUDE.md calls mandatory can be bypassed by a
setting the repository never inspects — and was reported to the operator rather
than worked around quietly.

## Independent implementation review

One read-only reviewer, minimal-change fast path, one turn. One blocker, no
improvements. Accepted.

### Blocker — the product catalog re-promised a delivery the system cannot make

The first draft of the catalog entry said an upgrade "reports itself" and that
"the operator sees ... the restart outcome". That is the exact guarantee issue
#374's third scenario removed from the SOP.

`packages/dreamux/src/service/dispatcher-service/restart-notice.ts` returns early
unless `startContinuity() === 'resumed'`, and an injection failure only warns to
the log. So when resume or startup fails there is no turn, no notice, and no
Channel delivery. A catalog entry claiming otherwise would invite a future
implementer to satisfy it by adding the timer, retry, or recovery actor this task
exists to keep out.

Fix: the entry now names a *resumed* upgrade, qualifies the operator-visible
report with "Once the Dispatcher resumes", and states plainly that a Dispatcher
which never resumes reports nothing at all.

### Reviewer findings with no defect

All three named scenarios were walked against the new text and confirmed closed
before any mutation: scenario 1 halts on the launcher/PATH/prefix mismatch before
install, scenario 2 halts on the pre-install `npm view` comparison, and scenario
3's actor-less instruction is gone. No non-goal was reintroduced. Every command
and field the guide names was verified against current source, including
`service.execStart` and `service.environment` in the doctor JSON. The SOP is 86
lines and still four steps. Public-repository safety and the Rush change file
were clean.

## Residual risk

- A Dispatcher that never resumes after the restart reports nothing. That is the
  accepted fail-loud boundary named in issue #374, now stated in the product
  catalog rather than papered over.
