# Adopt the lean managed-daemon self-upgrade SOP

## Current state

- Goal: Replace the unrunnable staged/independent-operator self-upgrade SOP with the lean four-step procedure, and realign every knowledge owner that documents the old contract
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/technical-design/final.md)
- Solution review Issue: Not applicable; the operator ruled this onto the minimal-change fast path.
- Blockers: None.
- Next action: Commit the reviewed workspace and open the PR against `next`.
- Verification: [Verification record](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/verification.md)
- Related tasks: None.

## Development approval

- Status: Granted by the operator on 2026-09-02 with "开始开发吧", against the
  requirement and final solution linked above.
- Approved implementation boundary: the writable list in
  [the final solution](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/technical-design/final.md#implementation-boundary).
  No `packages/*/src` and no test file may change.
- Boundary extension: on 2026-09-02 the operator answered "1" to the reviewer's
  second blocker, adding `.agents/scripts/check.sh` to the writable set so the
  required knowledge gate could be made runnable on stock macOS bash.

## Delivery

- Pull request / CI / merge: Not started.
- Knowledge closeout: Complete. Owners touched and results:
  - `.agents/tasks/**` — this task record is the decision record: requirement,
    final solution, operator rulings, and verification.
  - `.agents/domains/dispatcher-skill.md`, `.agents/domains/model-facing-writing.md`
    — updated to the four-step contract.
  - `CLAUDE.md` — maintenance-synchronization clause updated to the installed
    target's changelog.
  - `.agents/product/README.md` — `N/A`: the catalog's upgrade entry owns
    fail-loud state handling on the 0.x line, which this change does not touch.
    The self-upgrade SOP is model-facing guidance, not a catalogued behavior.
  - `.agents/glossary.md` — `N/A`: no overloaded term added or redefined.
  - `.agents/root.md` — `N/A`: routing is unchanged; the existing row already
    lists the two live domain owners ahead of the archived specification.
  - `.agents/archive/proposals/dreamux-maintenance-progressive-disclosure.md` —
    `N/A` by design: it is the decision trail for what PR #311 chose, and this
    change is accountable to that history rather than entitled to erase it.
  - `.agents/CONTRIBUTING.md` / `.agents/domains/repository-operations-and-release.md`
    — `N/A` for the bash 3.2 constraint: it is stated in `check.sh` itself, where
    the next editor of that block will see it, and no domain page describes the
    script's internals.
