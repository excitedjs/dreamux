# Gate commit references in task records

## 1. Why a citation goes dead here

A task record is committed inside the pull request that delivers it. The
repository merges only by squash or rebase, so none of that branch's commits
reach `next`, and the commit the merge creates does not exist while the record
is being written. #413 met the same wall with states: the record cannot contain
its own merge.

A branch commit stays readable only while something keeps it. The branch is
deleted on merge. GitHub keeps `refs/pull/<n>/head` for the last pushed head of
each pull request, and with it that head's ancestors. It also serves some
commits by hash that no ref reaches, which no clone can fetch. A commit that was
never pushed is kept by nothing but the clone that made it.

Every piece of work a record describes already has an identifier GitHub keeps:
the pull request number, and where the exact pushed head matters, the review or
the Actions run, both of which record that head on GitHub's side.

## 2. The rule

A task record cites no commit of this repository by hash — branch commits and
trunk commits alike. A trunk baseline is written "`next` after #N merged", and a
script that needs the commit resolves it at run time with
`gh pr view N --json mergeCommit`.

One rule for every commit is a rule the check applies without knowing which
branch a commit is on. It supersedes a lesson #413 recorded: that record's
counting script pinned an immutable trunk commit rather than a branch name.
The script now names the pull request whose merge was the baseline, which is
just as immutable.

## 3. Detection

The rule joins `init_task.py check-all`, which `.agents/scripts/check.sh`
already runs, so no new gate is added.

- **Files.** Every file under `.agents/tasks/`, not only a record's README.
  Most citations were in `verification.md` files and reviews.
- **Lines.** Everything except a section under a `## Historical …` heading,
  the exemption #413 defined. Fenced blocks are read: a script pinned to a
  commit is still a citation. The label rule keeps skipping them, because a
  label inside an example is not structure. Both rules read one
  `classified_lines` pass, so a fence or a frozen heading means the same thing
  to each.
- **Candidates and resolution**, copied from upstream:
  `(?<![0-9A-Za-z])[0-9A-Fa-f]{7,40}(?![0-9A-Za-z])`, resolved in a single
  `git cat-file --batch-check` call with `GIT_NO_LAZY_FETCH=1`. Only an
  unambiguous commit object counts, so digests, blob hashes, hashes from other
  repositories, and hexadecimal that names nothing pass.
- **In flight.** `--allow-in-flight` skips the rule, as it skips the label rule:
  a working branch is a working copy, and `check.sh` never passes the flag.
- **Output.** One error per line, naming the file and line and saying what to
  cite instead.

A shallow checkout is not refused. The operator's clone is shallow, and it
still holds every commit made in it — the class only the author's checkout can
catch. The commits it lacks are ones CI resolves.

## 4. Where it runs

- **Author checkout.** Knowledge closeout already runs `check.sh` there. It is
  the only place a never-pushed commit is visible.
- **CI `kb` job.** `actions/checkout` with `fetch-depth: 0`, then
  `git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'`. Of the 104
  commit tokens found at the start of this task, a branches-and-tags clone
  resolves 55 and adding pull request heads resolves 96. The extra fetch
  measured about 6 seconds, well inside the job's 5-minute limit.

## 5. The rewrite

Run as a Workflow: one Sonnet node per file rewrote its citations, one Sonnet
node per file re-checked that rewrite against the diff and fresh lookups, and
one Opus node closed out the whole sweep. Every node was told:

- **PR #N's merge on `next`.** "`next` after #N merged", "the merge of #N", or
  the pull request, as the sentence needs.
- **Pushed commit on a pull request.** Cite the pull request. When the sentence
  depends on the exact head, as a review round or a CI result does, cite the
  GitHub review or Actions run whose commit is that head. If none exists,
  describe the round without a hash. Never invent an identifier.
- **Never-pushed commit.** State what it contained and cite the pull request
  that carried the patch. Delete any claim that it is preserved somewhere only
  one clone has.
- **A fenced script.** Resolve the commit at run time from the pull request
  number.
- **Out of reach.** Only citation lines change. Verbatim operator quotes stay
  byte-identical, no banned label is added, and nothing moves under a
  `## Historical …` heading to dodge the rule.

## 6. Deliberately not borrowed

| Upstream practice | Why not |
|---|---|
| Rejecting the deployment organization's URLs | Dreamux has one public home, and internal hosts are covered by `check-internal-content.sh`. |
| Scanning every maintained file | No file outside `.agents/` cites a commit, and the archive is frozen; there is no failure scenario to name. |
| Release tags as the evidence identifier | The release workflow publishes without creating git tags; the public repository has two tags, both from its first releases. There is no tag to cite. |
| An archived tree as the frozen exemption | The `## Historical …` section #413 defined is this repository's frozen unit, and the task tree has no archive. |

## 7. What changes elsewhere

- `task-records.md` states the rule beside "Write only facts that cannot expire
  on their own", and says which exemptions each rule has.
- `.github/workflows/ci.yml` gives the `kb` job full history and pull request
  heads, and the `kb` row of the CI gate table in
  `repository-operations-and-release.md` says so.
- #413's requirement and counting script name the pull request whose merge was
  their baseline.

## 8. Alternatives considered

**Reject only a commit that is not on `next`.** The draft of this design
recommended it: every citation it rejects is one a reader may fail to resolve,
and trunk baselines resolve for anyone with full history. It needs a second
idea in the rule — reachability from `next` — and an `origin/next` ref wherever
the check runs. The operator chose the upstream rule instead.

**Refuse a shallow checkout.** It would fail the author-side run in the
operator's own clone while adding nothing CI does not already cover.
