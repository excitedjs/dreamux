# Adopt the lean managed-daemon self-upgrade SOP

## Current state

- Goal: Replace the unrunnable staged/independent-operator self-upgrade SOP with the lean four-step procedure, and realign every knowledge owner that documents the old contract
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/requirement.md)
- Final solution: [Final technical solution](/.agents/tasks/builtin-skills/adopt-lean-self-upgrade-sop/technical-design/final.md)
- Solution review Issue: Not applicable for the first slice (minimal-change fast
  path). The follow-up slice is specified by
  [issue #374](https://github.com/excitedjs/dreamux/issues/374), authored by the
  operator.
- Blockers: None.
- Next action: Await merge of the issue #374 follow-up PR; it closes that issue.
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
- Follow-up slice approved on 2026-09-04 with "开一个新的 pr ，修一下这个issue 的
  问题，pr 合入后给 issue 关掉", against the scenarios and non-goals in issue #374
  and the plan played back to the operator beforehand. Boundary:
  `references/self-upgrade.md`, `.agents/product/README.md`, this task record,
  and one Rush change file.

## Delivery

- Pull request / CI / merge: PR #370 merged into `next` as `4561f52`. Follow-up
  slice for issue #374 in progress; it opens a second PR from the same fork,
  because the pushing account has read-only access to the upstream repository.
- Knowledge closeout: Complete. Owners touched and results:
  - `.agents/tasks/**` — this task record is the decision record: requirement,
    final solution, operator rulings, and verification.
  - `.agents/domains/dispatcher-skill.md`, `.agents/domains/model-facing-writing.md`
    — updated to the four-step contract.
  - `CLAUDE.md` — maintenance-synchronization clause updated to the installed
    target's changelog.
  - `.agents/product/README.md` — updated by the follow-up slice. The first
    slice recorded this as `N/A` on the reasoning that the SOP is model-facing
    guidance; issue #374 overrode that, and the Channel-visible upgrade outcome
    is now a catalog entry pointing back here.
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
