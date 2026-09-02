# Verification

Evidence for the implementation of [final.md](technical-design/final.md).
Commands ran in the Team workspace on the `dreamux/dreamux-fable` branch on
2026-09-02 (Asia/Shanghai).

## Implementation run

- Workflow `run-2e69c695-1f27-403a-a814-2b5965a913f2` (9 disjoint writer
  lanes on the `claude` runtime → fidelity critic + build/typecheck/lint/
  focused-test/acceptance gates → bounded self-repair). All nine lanes
  settled with their files changed; no blockers. The round-1 critic found no
  `must` gap in the code, skills, docs, test, or change files; its one `must`
  (missing `verification.md`) is a TeamLeader artifact and is this file. All
  five gates passed in round 1 and again in round 2.
- The earlier run `run-27f7158a-ca05-4865-a395-1f8963ced47a` was destroyed
  by the workspace incident recorded in the task README and its edits were
  discarded; nothing from it survives in the tree.

## Gate results (workflow, round 2)

| Gate | Command | Result |
| --- | --- | --- |
| build | `node common/scripts/install-run-rush.js build` | exit 0 (incremental cache hits after a full round-1 build) |
| typecheck | `… typecheck` then `… typecheck:tests` | exit 0, 7 operations succeeded each |
| lint | `… lint` | exit 0, 7 operations succeeded |
| focused tests | `packages/dreamux`: mcp-tool-descriptions, bundled-skill-sources, mcp-public-failures, mcp-delegate-catalog, mcp-protocol-conformance; `packages/channel/feishu-channel`: feishu-routing-tools | 117 tests passed in dreamux; feishu file passed |
| acceptance | `git diff --check`; no `Load \`dispatcher-workflow\`` / `Load \`team-workflow\`` under `packages/dreamux/src`, `packages/dreamux/skills`, `.agents/domains`; no "before using" in either skill description; both change files present; both `SKILL.md` present; worktree and `final.md` present | all exit 0 |

## TeamLeader pre-review

- Whole diff read against final.md §2–§7: role prompts carry the quoted map;
  every input property of the `teammate` (both callers), `team` (both
  callers), and `cron` catalogs is described; §3.3 tool-level edits present
  including the operator's `react` ruling; both skills rewritten as
  methodology with the §4 descriptions; §5 docs and `dev-workflow`
  references updated; new test and both change files present with the right
  types.
- One follow-up sent to the `team-catalog` writer: Dispatcher `team.history`
  `since`/`until` carried the same sentence; now lower/upper bound wording
  as in the `teammate` catalog.
- TeamLeader-owned closeout edit: `model-facing-writing.md` "Current source
  owners" gains `service/mcp/tool-metadata.ts` and
  `teammate-collection/mcp-tool-descriptors.ts`.

## Full suite

- `node common/scripts/install-run-rush.js test` (full, live Codex tests
  included), run in the TeamLeader's own turn at 18:51: 6 packages passed;
  `@excitedjs/dreamux` reported one failure, `team-dissolve-contract.test.ts
  > FORCE WORKTREE SEMANTICS > force refuses a worktree identity whose path
  is not actually registered to the source repo` — "Test timed out in
  5000ms". The host was running the review-free tail of the workflow plus
  six Codex app-servers at the time. Re-run alone at 19:02:
  `npx vitest run tests/team-dissolve-contract.test.ts` passed 20/20, that
  test in 4597 ms against its 5000 ms budget. The test exercises git worktree
  registration and does not read any file this task changes; recorded as a
  host-load timing sensitivity, not a regression.
- The `since`/`until` follow-up on the Dispatcher `team.history` tool landed
  after the run (`mcp-tool-descriptions.test.ts` 7/7 re-run by the writer).

## Known limitations

- `.agents/scripts/check.sh` does not parse under this host's system bash
  3.2 (`case` pattern with `continue`, line 222); it runs in CI on Linux.
- The manual step "start a Team and read the TeamLeader system prompt in the
  runtime log" is replaced by the static read of `teamLeaderSystemPrompt`
  and the acceptance grep; the next Team this branch launches shows the map
  in its runtime log.
