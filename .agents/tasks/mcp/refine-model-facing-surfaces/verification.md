# Verification

Evidence for the implementation of [technical-design/final.md](technical-design/final.md)
§3, gathered by the TeamLeader on 2026-09-06. Commands ran from the task
worktree, whose tree is `origin/next` (0d8098f1) plus this task's commits and
the merge of `origin/pr-369` (59b3614d).

## Implementation method

Per R24 and R25 the implementation ran as one ultracode workflow: nine writer
lanes over disjoint file sets in the shared worktree (eight code lanes on opus,
the knowledge-base/change-file/record lane on sonnet), then a gate loop (a
sonnet gate runner, an opus fixer, at most four rounds), then a fidelity critic
that diffed the tree against final.md item by item, with one opus fix pass and
a re-gate when it reported a must-fix. The first run died with the TeamLeader's
process at 03:13 after one lane had returned; the second run (08:59–10:40)
restarted every lane with the instruction to bring its files to the design's
target state without redoing or reverting finished work.

Lane-reported deviations, all accepted by the TeamLeader:

- `teammate-collection/index.ts` sits at the shared 700-line lint cap, so the
  §3.6 prompt join lives in a new sibling module `system-prompt.ts` (final.md
  §6 updated).
- `onboard/wizard.ts` is a fifth caller of `ChannelProviderCatalog.resolve`
  that final.md §2/§3.7/§6 had not counted; it adapts to the `{ id,
  implementation }` shape the way `onboardAgentRuntime` already does and drops
  its second registry lookup. `runnable-channel.ts` needed no edit (its
  structural resolver already returns `unknown`). Type-only; no behavior
  change; the design record and the task README carry the correction.
- `.agents/product/dynamic-workflow-usage.md` cited the shared skill's old
  path and was renamed with it (final.md §3.10 updated).
- `feishu-channel/tests/public-api.test.ts` and
  `dreamux/tests/package-boundary-guards.test.ts` name the reminder export,
  not its text, so only `feishu-message-budget.test.ts` changed a word (final.md
  §7 updated).
- The new `team-create-reminder.test.ts` covers a third case (a prompt-bearing
  `create` whose result is `existing` attaches nothing), the other half of the
  attachment condition §3.3 states.

## TeamLeader pre-review

The TeamLeader read the whole working diff (53 files) against final.md §3, §6
and §7 and the rulings, then changed:

- code comments in `dispatch-reminders.ts`, `completion-renderer.ts`,
  `completion-renderer.test.ts`, and `teammate-system-prompt.test.ts` that
  cited a ruling number bare now point at the task record;
- the `@excitedjs/dreamux` change file: the deleted prompt rules are described
  as owned once by the nearest surface or dropped (not "every consequence is
  now a reminder"), and the reminder sentence describes the consequence rather
  than "the operator's own wording";
- final.md §6, §3.10 and §7 for the deviations above.

## Gates

Run by the workflow's gate agent after the last source change, read from the
`==[ SUCCESS` / `==[ FAILURE` summary blocks:

| Gate | Result |
|---|---|
| `rush build` | green (8 operations) |
| `rush lint` | green (7 operations, eslint-config no-op) |
| `rush test` | green; `codex-live.test.ts` ran against codex 0.153.4 (`DREAMUX_SKIP_LIVE_CODEX` unset) and observed the `channel-feishu` server in `mcpServerStatus/list` |
| `rush typecheck:tests` | green (6 operations, 2 no-op) |
| `.agents/scripts/check.sh` | `KB OK (166 files reachable from root.md)` |
| `rush change --verify` | cannot pass in an uncommitted tree: rush enumerates change files from the committed diff against the target branch and reads them from disk, and #369's two files are deleted but still in HEAD. Run after the commit with `--target-branch origin/next --no-fetch`; result recorded below. |
| leftover check | old skill directories absent; `team-workflow` absent from `packages/dreamux/{skills,src,README.md}`, `.agents/domains`, `.agents/skills` |

Post-commit gate results (after the review fixes below, tree at the closeout
commit): `rush build` green (8 operations), `rush lint` green (7), `rush test`
green (`codex-live.test.ts` 9 passed against codex 0.153.4), `rush typecheck:tests`
green (6), `.agents/scripts/check.sh` `KB OK`, `rush change --verify
--target-branch origin/next --no-fetch` lists the three change files and
passes, `git diff --check` clean. One intermediate run failed `rush build` on an
unescaped apostrophe the TeamLeader had introduced in the `team.create`
description while applying finding 3; fixed before the final run.

## Probes on the built artifact

From `dist/` after the final build:

- `DREAMUX_DISPATCHER_BASE_INSTRUCTIONS` "# Dispatcher Role" and
  `DREAMUX_DISPATCHER_APPEND_INSTRUCTIONS` print the §3.2 text verbatim.
- `BUNDLED_SKILL_NAMES` is `dispatcher-workflow`, `dreamux-maintenance`,
  `dynamic-workflow`, `teamwork`; the bundled roots hold `teamwork` and
  `dynamic-workflow` only.
- `TEAMMATE_DISPATCH_SUCCESS_REMINDER` prints the §3.3 text.
- Claude skill view (§3.9): against a copy of the live
  `~/.dreamux/cache/claude-code` (three version-1 roots, each linking
  `team-workflow` and `workflow`) and this tree's skill roots, the built
  materializer produced a new root keyed `df6045d712c5e271a520f64b` with a
  version-2 manifest listing `shared:dynamic-workflow` and
  `team-leader:teamwork`, linked `teamwork` and `dynamic-workflow`, left the
  three old roots untouched, and returned the same root on a second call. The
  probe's source roots are this worktree's, so it shows fresh materialization
  and non-revalidation of old roots; the same-root, renamed-children case is
  covered by `claude-code/tests/skill-materializer.test.ts`.
- Codex: the live test above observed `channel-feishu` as the server name.

## Independent implementation review

Run through Dreamux's own `workflow_run` in the Team's daemon (the code-review
method of the `dynamic-workflow` skill at the `xhigh` gear; R26: nodes on the
`codex` and `seed` runtimes, alternating): a scope node, seven finders (angles
A–E, one merged cleanup finder, one fidelity finder that checks the tree
against the requirement and the design), one verifier per source location
with the three-state ladder, a sweep, and a synthesis. A first attempt through
the TeamLeader's own engine-side workflow tool died twice with the TeamLeader's
process before any finder returned; the daemon-side run is the one recorded
here.

Stats: 8 candidates, 8 verifier groups, 6 verified, 6 confirmed, 0 refuted.
The cleanup finder returned no usable result and two verifier groups (one at
`skill-adapter.ts:140`, one on the Seed design-review file) returned none, so
their candidates were dropped; a follow-up single reviewer covered the cleanup
angles and re-read the dropped location (below).

Findings and TeamLeader adjudication:

1. This record cited an engine-side workflow run id. Accepted: replaced by
   non-identifying wording (the repository forbids committing internal
   identifiers).
2. The new reserved names collide with a pre-existing custom skill named
   `teamwork` or `dynamic-workflow` passed through `team.create`
   `skill_sources`: creation rejects it, and a Team created before the release
   fails loudly at its Claude Code TeamLeader's next start (`duplicate Claude
   skill name`; reproduced by the verifier against `dist/`). Accepted as an
   upgrade note in the `@excitedjs/dreamux` change file (fail-loud plus a
   manual rename). No code: every rename of a reserved name changes the reserved
   set, and no operator scenario names such a custom skill.
3. The `repo` descriptions of `teammate.spawn` and `team.create` promised a
   fresh directory unconditionally while `workspace.enabled: false` reuses the
   dispatcher's own directory (reproduced against `dist/`; the qualifier had
   lived in the old `dispatcher-workflow` skill and was lost in #369). Accepted:
   the four descriptions now state the policy.
4. This record listed the pre-PR live probes of final.md §8 as post-release
   acceptance. Accepted: see "Live probes" below.
5. `localeCompare` in the sorts that feed the Claude adapter key made the key
   locale-dependent (reproduced by the verifier: en_US and sv_SE give two keys
   for one skill set, and the first root is never reused). Accepted: both sorts
   use code-point order.
6. `model-facing-writing.md` lacked the pre-query visibility facts §3.10
   requires (Codex lists no Dreamux MCP tool before an `ALL_TOOLS` search;
   Claude Code shows tool names up front). Accepted: added.

Cleanup angles follow-up (single codex reviewer, read-only, over
`origin/next..HEAD` plus the working tree): one confirmed finding — the new
`mcp-tool-descriptions.test.ts` re-implemented `isPlainObject` from
`@excitedjs/dreamux-utils` under another name; accepted, the test imports the
package helper. Four candidates refuted by the reviewer with evidence: the
apostrophe build break (already fixed in the tree), a repeated inventory read
per runtime start (the materializer runs once per start and reads the roots in
parallel), symlinked child skills being skipped (the `isDirectory` filter is
unchanged from `origin/next`), and provider-named servers colliding within one
dispatcher (config rejects a repeated provider; session lookup still keys on the
channel id). No higher-cost simplification, efficiency, or layering finding.

## Live probes (final.md §8, before the PR is ready)

R27 waived the Claude Code half of this gate after the probe below had
already run; the PR does not wait for it.

- Codex: `codex-live.test.ts` runs a real codex against the Dreamux MCP shim
  with a fake Feishu backend; it observes `channel-feishu` in
  `mcpServerStatus/list` with its `reply` tool and drives one reply through
  it. Covered by the gate run.
- Claude Code: a one-off vitest probe (kept outside the repository) booted a
  real `Server` from this build with the fake Feishu backend of the codex-live
  test and the real `claude` binary (2.1.260, `--model opus`), with the adapter
  cache pre-seeded by a copy of the live one (three version-1 roots whose
  children are `team-workflow` and `workflow`). One inbound message asked the
  Dispatcher to report, through `channel-feishu`, its `mcp__channel*` tool
  names, its skill names, and the server names its instructions list. The reply
  arrived in the fake backend through `channel-feishu` and read: `TOOLS:` the
  eleven `mcp__channel-feishu__*` tools including `reply`; `SKILLS:` the
  operator's user-level skills plus `dispatcher-workflow`,
  `dreamux-maintenance`, `dynamic-workflow` (no `workflow`); `SERVERS:`
  `teammate, team, cron, channel-feishu`. The cache gained a fourth root with a
  version-2 manifest linking those three skills; the three old roots were left
  untouched. The probe drove the Dispatcher role (dispatcher and shared roots),
  not a TeamLeader: the harness has no TeamLeader path without a live channel
  binding, and the TeamLeader root goes through the same materializer and the
  same `--add-dir` mechanism (the same-root, renamed-children case is
  `skill-materializer.test.ts`; the team-leader/shared roots against the copied
  cache are the dist probe above). Not exercised: a TeamLeader started through
  the installed package after an in-place upgrade — the post-release probes of
  final.md §1.

## Alpha acceptance (2026-09-06)

On the operator's order the release workflow published
`@excitedjs/dreamux@0.24.0-alpha.gffd8b4b7feab` from the PR branch; the
operator upgraded his own Codex Dispatcher to it in place and had it create a
Claude Code Team without a repo, bound to the work group. The TeamLeader
answered the acceptance probes of final.md §1 in the group:

- Identity line and server map: verbatim the §3.1 text.
- Skill list: `teamwork` and `dynamic-workflow` present, the old names absent
  — an in-place upgrade over an existing adapter cache, so the §3.9 adapter
  identity re-materialized the view.
- Skills loaded on the turn: none; the stated reasons cite the load triggers
  of the new descriptions.
- Channel server: `channel-feishu` with its six TeamLeader tools.
- Reminders: the channel reminder verbatim and nothing else from Dreamux.
- It checked the workspace and dissolved the Team itself.

The Codex Dispatcher on the same alpha confirmed the version and the
`channel-feishu` name and tools, declined to quote the envelope, reminder,
prompt, or tool descriptions, and reported loading `dispatcher-workflow`
"for the channel reply" on that turn although the skill's description says it
is needed for no other tool — the description-driven loading heuristic below.

A second round on a Codex TeamLeader (a Team without a repo, bound to the
same group): it summarized rather than quoted its identity line and server
map (TeamLeader; `teammate`, `team`, `cron`, `channel-feishu`), listed
`teamwork` and `dynamic-workflow` among its skills with the old names absent,
loaded neither of them, named `channel-feishu` with its six tools (calling
`reply` as `mcp__channel_feishu__reply`, Codex's underscore rendering),
confirmed `source="feishu"` as the first attribute of the inbound `<channel>`
block, summarized the channel reminder's meaning, and dissolved the Team. It
loaded the operator's user-level `lark-im` and `lark-shared` skills "because
the task asked for a reply through Feishu": the same Codex habit as the
Dispatcher's, this time on a user skill rather than a Dreamux one.

## External review of #380 (ryanxiang7, 2026-09-06)

The reviewer read the whole source change and left seven inline comments and
one general one. Each was verified against the source before being reported
to the operator; the operator ruled on items 2–7 (R28–R33), and items 1 and 8
were applied as reported.

1. The `@excitedjs/dreamux` change note described an upgrade blocker (two
   reserved skill names) without leading with `BREAKING:` or carrying
   `Rebuild:` — confirmed; the note now leads with `BREAKING:` and carries
   `Rebuild:`, the shape of the workflow skill's own note; the claude-code
   note was rewritten for the stable directory (item 4).
2. The Team-scoped workflow agent was told its TeamLeader receives its output,
   which is false for a workflow agent and competes with the workflow
   contract — confirmed; R28. The workflow agent now receives only the
   membership sentence (`system-prompt.ts`; `teammate-system-prompt.test.ts`).
3. The `dissolve` description told every TeamLeader to inspect the workspace,
   while Core blocks a dissolve only for a managed delete-on-close worktree —
   confirmed; the first fix scoped the wording, the operator ruled that the
   leader cannot know which case it is in and must be told at start (R29).
   The TeamLeader prompt now carries a workspace sentence built from the Team
   record's worktree identity (`leader-agent.ts`, `team-service/index.ts`),
   and the description refers to it (`mcp-delegate.ts`;
   `team-leader-prompt.test.ts` covers the three cases).
4. The version-2 adapter key opened a new directory per inventory and never
   removed the old ones (unbounded growth on every upgrade) — confirmed; R30
   asked for one stable directory. The key is the root set again; the manifest
   carries the inventory; a mismatch rebuilds beside the root and swaps it in,
   removing the stale tree (`skill-adapter.ts`, `skill-materializer.ts`;
   `skill-materializer.test.ts`, five cases including the version-1 root and
   the concurrent malformed target).
5. Every managed worktree defaulted to `keep`, so the default `dissolve`
   never removed anything — confirmed; R31 changed the default to
   `delete-on-close` (`worktree/manager.ts`, the `cleanup` description in
   `tool-metadata.ts`; product README, the dispatcher-orchestration page, and
   the maintenance skill's service-lifecycle reference updated; change note
   carries the new default). The Team runtime registry also carried a
   fallback request `{ mode: 'managed', slug, cleanup: 'keep' }` for a
   `repoCwd` without a worktree request; both callers derive the pair from
   `repoWorktree()` together, the managed-by-default policy lives there, and
   the fallback would have pinned the old default, so it is removed.
6. `team.create.prompt` lacked `minLength: 1` — confirmed (an empty string
   submitted an empty first turn with the Team reminder); the operator asked
   what it meant (R32), the fix stood.
7. Two tests pinned `source` as the first attribute of the envelopes although
   nothing depends on the position — R33 ruled the order is not a contract;
   the two assertions now check presence (`channel-input-format.test.ts`,
   `feishu-settlement-envelope.test.ts`), the design, the channel page, and
   the feishu-channel change note no longer say "first".
8. (Unanchored, in the review body.) The live proposal
   `.agents/proposals/admin-control-plane-surface.md` still named the bundled
   skill `team-workflow` — confirmed; it names `teamwork` now. Archived
   proposals keep the historical names.

Gates after the round (working tree with all eight fixes, 2026-09-06 15:20):
`rush build`, `rush lint`, `rush test`, `rush typecheck:tests`,
`.agents/scripts/check.sh` (KB OK), `rush change --verify --target-branch
origin/next --no-fetch`, `git diff --check`: all green. Focused suites:
`team-leader-prompt`, `teammate-system-prompt`, `mcp-tool-descriptions`,
`channel-input-format` (dreamux), `skill-materializer` (claude-code, five
cases), `feishu-settlement-envelope` (feishu-channel).

## Post-merge correction (R34, 2026-09-06)

Reading the report of the review round, the operator ruled that the
TeamLeader prompt's workspace sentence must name only the worktree and its
cleanup mode, and that everything about dissolving belongs in the `dissolve`
description alone: a leader that starts work should not meet the word
"dissolve" in its prompt, since it may not need the concept for a long time.
`teamWorkspaceSentence` now renders `Your Team's workspace <path> is a managed
git worktree (cleanup: delete-on-close).` (or `(cleanup: keep)`, or `is a
reused directory (cleanup: keep).`); the `dissolve` description defines what
each mode means at dissolve. `team-leader-prompt.test.ts` pins the three
sentences and asserts the prompt does not mention dissolving outside the
server map's `team` entry.

The review of #382 (ryanxiang7) raised two non-blocking notes. The R34 quote
carried a literal `\n` and straight inner quotation marks — normalized. And
the Dispatcher could not see a Team's cleanup mode (verified in
`read-model.ts`, `team-view.ts`, `types.ts`: the three projections carry only
`worktree_cleanup` = `cleanup_state`, `managed-active` for every open managed
worktree; the `TeamListRow` comment pointed to `team.status` for a
`worktree_mode` it did not carry). R35 added `worktree_mode` and
`worktree_cleanup_mode` to `TeamView` (`team-view.test.ts` pins both for a
managed delete-on-close worktree and a reused directory); the `team.status`
output schema is an open object, so no schema change. Gates on the follow-up
branch: see the PR.

## Skipped coverage and residual risk

- Description-driven skill loading is the engine's heuristic; whether a model
  associates `source="feishu"` with `channel_feishu` is empirical. On the alpha,
  Claude Code followed the triggers exactly; Codex respected the bundled
  skills' triggers on its TeamLeader turn but loaded a skill for a plain
  channel reply on both of its turns (`dispatcher-workflow` as Dispatcher, the
  user-level `lark-im` as TeamLeader); recorded, not acted on.
- The dispatch reminders are invisible on Claude Code (the engine drops MCP
  `content` text next to `structuredContent`); the description sentence is the
  only carrier there.
- External channel providers: the `npm:` id shape as a server-name segment is
  unverified on both engines; no such provider exists.
