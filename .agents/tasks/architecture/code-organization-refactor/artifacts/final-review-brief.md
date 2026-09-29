<!-- Review brief given on 2026-09-29 to three independent reviewers of [PR #455](https://github.com/excitedjs/dreamux/pull/455). Its findings were fixed on that PR under R68. Paths under .workspace/ were the reviewers scratch output and are not in the repo. -->

# Final review of PR #455: architecture anti-patterns

Branch `refactor/code-organization`, at the PR head of the review time, checked out in this
workspace. PR #455 targets `feat/plugin-system-mvp` (compare with
`git diff origin/feat/plugin-system-mvp...HEAD`). Package under review:
`packages/dreamux/src/**`, with `src/service/**` as the core.

Read-only review. Do not edit, commit, stash or push anything in the repo.
Write your report to `.workspace/refactor/r6-review/<your-name>.md` and
return its path plus a short summary.

## The operator's request (verbatim)

"对最终的代码进行 review ，重点找出我们最后修复的这几种架构反模式"

So the question is: in the final code, where do the anti-patterns the last
rounds removed still live (in the areas we touched, and in areas we did not)?
Also report any place where a fix itself introduced a new instance.

## The anti-patterns the last rounds fixed

The operator's rulings are recorded verbatim in
`.agents/tasks/architecture/code-organization-refactor/rulings.md`, section
"PR #455 review follow-ups (2026-09-28)", R57–R67. Read them first; they are
the standard. In short:

1. **A parent builds a child's internal resources and hands them in.**
   Example fixed: TeamService constructed the CronJobStore and passed it to
   SchedulerService (R60). Now the scheduler takes a path and builds its own.
2. **A parent performs a child's teardown steps instead of calling the
   child's verb.** Example fixed: Team dissolve deleted the cron store file
   itself; now `SchedulerService.destroy()` does it. Parents should trust the
   verbs of the services they hold (R61).
3. **A parent knows a child's files or persistence.** Example fixed: parents
   constructed `AgentIdentityStore` / `AgentEntityCollectionStore` and knew
   about `identity.json`; now an Agent is a directory to its parents and the
   agent module creates/opens/reads its own identity (R63).
4. **Lazy holder / rebuild glue.** Example fixed: the Team lazily rebuilt its
   leader, with `leaderBuild`, `leaderService()`, `isSafeToForget`; now the
   Team always holds its leader.
5. **Compensation / rollback without a real scenario.** Example fixed:
   reopen-on-failure in dissolve (R62/R67: precheck, write closed, serial
   destroy, worktree cleanup, never reopen).
6. **Pass-through methods and closures extracted only to cut line count**
   (R57, R58): a method whose body only forwards to another object, or a
   helper split out just to get under the 700-line lint limit.
7. **"Deduplicating" through a new indirection layer while both old sides
   survive**, and defensive code (validation, retries, fallbacks, caps) with
   no named failure scenario — the repo `CLAUDE.md` bans both by name.

## What to report

For each finding: file:line, which anti-pattern (1–7, or a new one you
name), the concrete evidence (who constructs/calls what), why it matters
for a maintainer, and the smallest change that removes it. Rank by how much
it costs a maintainer to reason about. Mark anything you inferred rather
than verified. Say plainly when an area is clean — a short honest report
beats a padded one. You may disagree with the rulings' framing if the code
gives you a reason; say so and give the reason.

Known and not to be re-reported: the Team still holds the worktree (the
operator deferred moving it to the leader); member worktrees reuse the Team
cwd; the missing unit tests (they come later, in another PR).
