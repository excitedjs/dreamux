# Pin the state a task record may carry on the trunk

## 1. The principle

A record is committed inside the pull request that delivers it, so it can never
contain the result of its own merge. One test decides whether a line belongs in
a task record at all:

> Can something outside this repository make this false while the file sits
> untouched?

If yes, the line is a snapshot, and a snapshot in a file that nobody is looking
at is indistinguishable from a fact. The record does not carry it. Whatever it
described — a merge, a CI run, a review — is already recorded by git or GitHub,
authoritatively, for free, and without ever going stale.

This reframes the reported problem. The states were not wrong; `review` was
true when it was typed. The mistake was writing down a fact with an expiry date
and then leaving the repository holding it.

## 2. What enforces it

`init_task.py` owns the states, so it owns the rule. It gained two things:

- `check-all`, which walks `.agents/tasks/**` instead of taking one named task.
  A per-task check only runs when someone remembers to run it for that task,
  which is exactly how a record reaches the trunk in a state nobody validated.
- `TRUNK_STATES = {intake, blocked, done}`, rejected unless `--allow-in-flight`
  is passed.

`.agents/scripts/check.sh` calls it as check 5 and never passes
`--allow-in-flight`. CI's existing `kb` job already runs that script, so the
rule became binding without a new CI job — and without touching
`.github/workflows`, which needs a push credential this workflow does not have.

A README is classified as a domain index or a task record by the headings only
one of them carries, never by depth: `mcp/scheduler` is a domain nested exactly
where a task record would sit. Anything that is not an index is checked as a
record, so a record whose format has drifted is answered with the specific
thing it is missing instead of being silently skipped.

## 3. Why the six middle states stay

They are correct on a working branch, which is a working copy. `review` is the
true state of a task under review; deleting it would remove a fact the
TeamLeader needs mid-task. The rule is about what may be *committed to the
trunk*, not about what may be written, so `--allow-in-flight` keeps them usable
where they are true and `check.sh` refuses them where they are not.

## 4. Why the index no longer carries a state

The state appeared twice for every task: once in the record and once in the
domain index entry. Two of the 35 copies already disagreed. Nothing can resolve
such a disagreement, because both files are equally plausible. Removing the
copy that no one owns leaves one authority, and a guard rejects any index entry
that backticks a state word so it cannot come back.

The index entry keeps the goal, which is also in the record. That duplication
is deliberate and safe under the test in §1: a goal does not expire.

## 5. Borrowed from upstream

The operator's instruction was "尽量把上游好的方式全都借鉴过来" (2026-09-11). The
upstream reference is the `.agents/notes/` system in `deepseek-ai/deepseek-harness`,
which this repository's workflow already borrows from.

| Upstream practice | How it lands here |
|---|---|
| A status whose values cannot go stale (`proposed` / `implemented` / `rejected`) | The same property, different shape: nine states stay, but only three may be committed to the trunk. Upstream notes have no working-branch phase to describe; our task records drive one. |
| "The status carries no dates and no parentheticals" | The `State:` line is matched anchored, so trailing prose fails the check rather than being tolerated. |
| No note records a PR number, merge commit, CI result, or merge date | The Delivery section keeps the pull request *link* and drops its *status*, the merge commit, the gate results, and the dates. |
| "Rewrite stale facts in place; do not append change history" | Adopted as a written rule in `task-records.md`. A record is the current state of one task; git holds the log. |
| A script enforces the closed set, and CI runs it | `check-all` wired into `check.sh`, which the `kb` job already runs. |
| One owner per fact — upstream keeps no central index precisely so a note owns its own rationale | The same principle, applied to the one field that was duplicated: the state now lives only in the record. |

## 6. Deliberately not borrowed

| Upstream practice | Why not |
|---|---|
| No centralized index at all | Task discovery here goes through the hierarchical README indexes, and the dev-workflow skill's first step depends on them. Upstream finds notes by filename convention; we would be removing the only discovery mechanism. |
| Lifecycle encoded in the directory path, cross-checked against the status | Tasks here are filed by capability domain, not by lifecycle. Moving a directory when a state changes would break every inbound link, and `check.sh` check 4 pins those from outside `.agents/` across the whole repository. |
| The first-proposed date in the filename | Slugs here are action-prefixed capability names used as stable link targets. A date in the slug would put an expiring-looking token into every link. |
| A frozen `archived/` tree with a hash manifest | Nothing here is frozen. `task-records.md` already exempts historical records from migration, which covers the same ground without a second mechanism and a manifest to maintain. |
| A whole-file uniform-format check | Records here legitimately differ: some carry an incident account, some a review adjudication, some an operator ruling ledger. Enforcing one shape would delete material the operator asked to keep. The check covers the fields that carry state, not the prose around them. |
| Cross-references must be relative markdown links | The convention here is repository-absolute `/.agents/...`. `check.sh` already resolves those (check 1) and pins them from outside the tree (check 4). Switching would churn every link in the knowledge base and buy nothing. |

## 7. Bringing existing records into compliance

The gate turns the seven non-compliant records red the moment it is added, so
the rules and the correction land in one pull request. Each of the seven was
verified against GitHub before its state was changed; the evidence is in
[the requirement](/.agents/tasks/architecture/pin-task-record-states/requirement.md).
