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

Post-commit gate results: _pending_.

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

_pending: workflow `wf_3ec0137d-806` (six finders — correctness, architecture,
model-facing text, tests, requirement fidelity, public safety and records —
each finding verified by three lenses, majority refutes)._

## Skipped coverage and residual risk

- Not exercised live: a Claude Code TeamLeader started through the installed
  package from an existing adapter cache after the rename (needs the released
  package); the `channel-feishu` tool list as Claude Code shows it; one reply
  through the renamed server on each engine. These are the post-release
  acceptance probes of final.md §1 and §8.
- Description-driven skill loading is the engine's heuristic; whether a model
  associates `source="feishu"` with `channel_feishu` is empirical.
- The dispatch reminders are invisible on Claude Code (the engine drops MCP
  `content` text next to `structuredContent`); the description sentence is the
  only carrier there.
- External channel providers: the `npm:` id shape as a server-name segment is
  unverified on both engines; no such provider exists.
