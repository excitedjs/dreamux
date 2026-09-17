# Requirement

## Initial request

The operator asked, in a Claude Code session on 2026-09-17, verbatim:
"你现在去对照一下 https://github.com/deepseek-ai/deepseek-harness 这个仓库，看一下那边对于知识库的管理有没有什么新的建设。"

The comparison found that upstream had added a gate against commit references
since the snapshot #413 borrowed from, and offered either a research snapshot
or a proposal to port that gate, deciding first whether records cite commit
hashes or pull request numbers. The operator chose the proposal, verbatim:
"直接按b 来推进", and in the same message named the problem #413 solved as the
frame for it: "最主要的就是合入时才能转成merged，但实际上，合入的时候已经没有机会再转成 merged 了。"

## Upstream reference

Upstream is `deepseek-ai/deepseek-harness`, compared from the `master` snapshot
at the end of 2026-09-10 (its 1948 note files match the count
[#413's design](/.agents/tasks/architecture/pin-task-record-states/technical-design/final.md)
cites) to `master` on 2026-09-15 (the merge of upstream PR #4192). The note
format gates #413 ported did not change in that range.

Upstream added `scripts/verify-repository-references.ts` with the decision note
`2026-09-12-maintained-repository-references`:

- Maintained files cite release tags and pull request, run, or job identifiers
  as historical evidence, and relative links for current files.
- The gate collects every 7–40 character hexadecimal candidate, resolves all of
  them in one `git cat-file --batch-check` call with `GIT_NO_LAZY_FETCH=1`, and
  rejects only a candidate that resolves unambiguously to a commit object.
  Digests, blob hashes, and unrelated hexadecimal values pass.
- Vendored sources and archived notes are exempt. There is no exemption for
  fenced blocks.
- Upstream states the limit itself: an object absent from the checkout cannot
  match.
- The same gate also rejects URLs of upstream's deployment organization.

## Confirmed current behavior and evidence

Measured on `next` after #439 merged, 2026-09-17, over every tracked file except
generated changelogs and lockfiles. Hashes were resolved against the operator's
clone together with a full clone of the public repository that includes every
`refs/pull/*/head`, because the operator's clone is shallow.

- 178 distinct hexadecimal tokens of 7–40 characters appear. 104 resolve to a
  commit, naming 85 distinct commits.
- Every commit citation is under `.agents/`: 201 in the task tree and 10 in
  `.agents/archive/`. No package source, test, README, or workflow cites a
  commit.
- In the task tree, 13 citations sit under a `## Historical …` heading. The
  other 188 are on 167 lines in 77 files, 2 of them inside a fenced script.
  105 name a commit on `next`; 83, in 45 files, do not. Most are in
  `verification.md` files and solution reviews.
- 42 of the 85 cited commits are on no branch or tag the public repository has.
- The repository allows squash and rebase merges only, with merge commits
  disabled and branches deleted on merge. A branch commit therefore never
  becomes a trunk commit, and the trunk commit a pull request produces does not
  exist until the merge — which, as #413 established for states, the record
  merging with it cannot contain.
- What a later reader can resolve, of the 104 commit tokens:
  - a clone of branches and tags: 55;
  - also every `refs/pull/*/head` (307 refs; about 6 seconds of extra fetch):
    96;
  - of the remaining 8, GitHub still serves 6 by hash although no ref reaches
    them, and 2 are served nowhere because they were never pushed. Both of those
    are in `channel/align-codex-command-display`, whose Delivery baseline said
    the original task commit "is preserved on its implementation branch" — a
    branch that existed in one local clone and nowhere else.
- GitHub maps a pushed commit to its pull request
  (`repos/excitedjs/dreamux/commits/<commit>/pulls`), but not a commit that a
  later push removed from the pull request.
- The CI `kb` job checked out a single commit, so an object-database check
  there would have resolved almost nothing.
- The operator's own clone is shallow — 59 of the 231 commits on `next` — yet it
  holds every commit made in it, which are the commits no other checkout can
  see.
- [Knowledge closeout](/.agents/skills/dev-workflow/references/knowledge-closeout.md)
  already has the author run `.agents/scripts/check.sh` in their own checkout.
- #413's label rule already rejects `- Commit:` and `- Baseline:`. The citations
  above sit in prose or under other labels, such as `- Review baseline:`, which a
  label rule does not see.

## Desired outcome

A task record names work by pull request, review, or Actions run, never by
commit hash, and the knowledge-base check rejects a commit hash without reading
prose.

## Scope

- `.agents/skills/dev-workflow/scripts/init_task.py`: the rule, run by
  `check-all`, over every file of the task tree.
- `.github/workflows/ci.yml`: give the `kb` job full history and every pull
  request head.
- `.agents/skills/dev-workflow/references/task-records.md`: state the rule.
- Existing task records: rewrite every citation the rule rejects, including the
  measurement script in #413's verification.

## Non-goals

- The organization-URL half of upstream's gate. Dreamux has one public home:
  the GitHub URLs in tracked files name `excitedjs/dreamux`,
  `excitedjs/claudemux`, and third-party projects. Internal hosts are already
  `common/scripts/check-internal-content.sh`'s job.
- Scanning outside `.agents/tasks/`. Outside the frozen archive no file cites a
  commit, so there is no failure scenario to name there.
- A pre-commit hook change. The author-side run already happens at knowledge
  closeout.
- Rewriting `.agents/archive/` or `## Historical …` sections.

## Acceptance criteria

- `.agents/scripts/check.sh` fails, naming the file and line, when a line
  outside a `## Historical …` section, in any file of the task tree, contains a
  hash that resolves to a commit — including inside a fenced block.
- It passes a 64-character digest, a blob hash, hexadecimal that names no
  object, and a citation under a `## Historical …` heading.
- `check-all --allow-in-flight` does not apply the rule, as it does not apply
  the label rule.
- The `kb` job resolves the commits of other pull requests, not only the one
  under test.
- `.agents/scripts/check.sh` passes after the rewrite.

## Decisions and unknowns

- Confirmed operator decisions (Claude Code session, 2026-09-17, verbatim):
  - "直接按b 来推进" — draft and advance the port of upstream's commit-reference
    gate.
  - "1. A" — reject every commit hash, trunk commits included, as upstream does.
  - "2. 加" — the `kb` job also fetches every pull request head.
  - "3. 和上次一样就行。" — run the rewrite as #413's was: Sonnet nodes rewrite,
    Sonnet nodes re-check, Opus closes out.
- Assumptions: none outstanding.
- Blocking unknowns: none.
