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
where a task record would sit. Headings are matched as whole lines, because a
substring test reads `## Tasks completed` inside a record as the index heading
`## Tasks` — and since an index is checked far more loosely, that reading
silently exempts the record from the state rule. A file carrying both kinds of
heading is refused rather than resolved by precedence.

The direction of the fallback matters, and only one direction is safe.
Mistaking a record for an index is silent; mistaking an index for a record is
loud. So anything that is not clearly an index is checked as a record, and a
record whose format has drifted is answered with the specific field it is
missing instead of being skipped.

## 3. Why the six middle states stay

They are correct on a working branch, which is a working copy. `review` is the
true state of a task under review; deleting it would remove a fact the
TeamLeader needs mid-task. The rule is about what may be *committed to the
trunk*, not about what may be written, so `--allow-in-flight` keeps them usable
where they are true and `check.sh` refuses them where they are not.

## 4. Why the index no longer carries a state

The state appeared twice for every task: once in the record and once in the
domain index entry. Three of the 35 copies already disagreed. Nothing can resolve
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
| No note carries a delivery-status field. Pull requests are cited where they explain something — 16 of 1948 note files do — but never as a line reporting where the work stands | The Delivery section keeps the pull request *link* and drops its *status*, the merge commit, the gate results, and the dates. A link is a cross-reference; a status is a claim with an expiry date. |
| "Rewrite stale facts in place; do not append change history" | Adopted as a written rule in `task-records.md`. A record is the current state of one task; git holds the log. |
| A script enforces the closed set, and CI runs it | `check-all` wired into `check.sh`, which the `kb` job already runs. |
| One owner per fact — upstream keeps no central index precisely so a note owns its own rationale | The same principle, applied to the one field that was duplicated: the state now lives only in the record. |
| Proposal-era headings are *banned* in an implemented note (`## Proposal`, `## Plan`, `## Migration plan`, `## Acceptance criteria`) — the gate rejects the heading, never the prose | The mechanism that makes staleness checkable. Our equivalent closed token is the bullet label, so `- CI:`, `- Merge:`, `- Branch:`, `- Baseline:`, `- Commit:` and the composite `- Pull request / CI / merge:` are rejected outright. See §8. |
| Format tokens inside fenced blocks are stripped before the file's structure is read | Copied directly. An example in a code fence is not document structure, and reading it as such was a real bypass — see §8. |
| Gates skip the frozen `archived/` tree: a record of what was true then is not a claim about now | A section under a `## Historical …` heading is skipped by the label rule for the same reason. The tree stays in place; only the exemption is borrowed. |

## 6. Deliberately not borrowed

| Upstream practice | Why not |
|---|---|
| No centralized index at all | Task discovery here goes through the hierarchical README indexes, and the dev-workflow skill's first step depends on them. Upstream finds notes by filename convention; we would be removing the only discovery mechanism. |
| Lifecycle encoded in the directory path, cross-checked against the status | Tasks here are filed by capability domain, not by lifecycle. Moving a directory when a state changes would break every inbound link, and `check.sh` check 4 pins those from outside `.agents/` across the whole repository. |
| The first-proposed date in the filename | Slugs here are action-prefixed capability names used as stable link targets. A date in the slug would put an expiring-looking token into every link. |
| A separate `archived/` tree with a hash manifest and an append-only seal | The exemption it exists to grant is borrowed — a `## Historical …` section is skipped — without moving files into a second tree or maintaining a manifest. Nothing here is sealed, so nothing needs a hash to prove it unchanged. |
| A required section skeleton (`## Problem`, `## Decision`, `## Consequences`) | Upstream's note vocabulary is closed because it was mandated from the start. Ours is not: counted with this gate's own label rule over its own live lines, about 140 distinct bullet labels are in use across 36 records, most of them genuine one-off facts. The figure is rounded on purpose: the argument needs its order of magnitude, and an exact count would go stale the next time anyone edits a record. Requiring a skeleton would redden nearly every record for cosmetics. The *banned* half of the same gate transfers without that cost, and it is the half that catches staleness. |
| Cross-references must be relative markdown links | The convention here is repository-absolute `/.agents/...`. `check.sh` already resolves those (check 1) and pins them from outside the tree (check 4). Switching would churn every link in the knowledge base and buy nothing. |

## 7. Bringing existing records into compliance

The gate turns the seven non-compliant records red the moment it is added, so
the rules and the correction land in one pull request. Each was verified against
GitHub before its state was changed; the evidence is in
[the requirement](/.agents/tasks/architecture/pin-task-record-states/requirement.md).

Twelve more records passed the gate while still describing finished work in the
present tense, because what had expired in them was prose rather than the state.
They were corrected too. Several were not merely stale but false: PR #335 had
been merged for a month while its record said no merge had been performed, and
`adopt-lean-self-upgrade-sop` was `done` while its delivery said the pull
request had not started.

That gap is the honest limit of the check, and §8 states it rather than leaving
a reader to infer that a green gate means a clean tree.

## 8. Checking staleness without reading prose

The first version of this check read only the `State:` line and the index
entries, and its stated limit was that a record could still describe finished
work in the present tense and pass. That limit was real: nineteen records were
corrected by hand precisely because the gate could not see them.

The reasoning behind accepting that limit was wrong, and the operator said so —
"这个东西你也别自己偷偷搞了，你直接抄一下上游的作业" (2026-09-11). The argument had
been that catching stale prose needs a list of status phrases, and that such a
list cannot tell a live status from the same words quoted inside an operator
ruling. Both halves are true. The conclusion does not follow, because upstream
does not check prose at all.

`verify-agent-note-format.ts` bans `## Proposal`, `## Plan`, `## Migration plan`,
and `## Acceptance criteria` inside an implemented note. A heading is a closed
structural token: it is either present or absent, it cannot appear inside a
quotation, and rejecting one says nothing about the sentences under it. That is
how the gate reaches staleness without ever parsing a claim.

The same token here is the bullet label. A record does not say "the CI is still
running" in free prose — it writes `- CI:` and then says it. So the label is
what the check rejects, and only on a record being committed to the trunk:

    - Baseline:      - Branch:       - CI:          - CI / merge:
    - Commit:        - Current PR:   - Current next action:
    - Current repair baseline:       - Current repair branch:
    - Merge:         - Pull request / CI / merge:   - Pull request / merge:

Two exemptions come from upstream unchanged. Fenced blocks are stripped before
the file's structure is read, because a token inside an example is not
structure — reading it as structure was a live bypass, not a hypothetical one:
a record whose body contained `## Tasks completed` was classified as a domain
index and skipped the state rule entirely, exit code 0. And a section under a
`## Historical …` heading is skipped, for the reason upstream's gates skip
`archived/`: a record of what was true then is not a claim about now. That
heading is matched on a word boundary, not as a prefix — `## Historically
speaking …` must not be able to claim the exemption by accident, which is the
same fail-open shape as reading a heading by substring.

What is still not mechanically checked is a stale sentence inside an otherwise
live field — `- Knowledge closeout:` describing work as ongoing, say. The labels
cover where every recurring status actually lives, so the residue is small, but
it is not zero and the rule in `task-records.md` remains the authority.
