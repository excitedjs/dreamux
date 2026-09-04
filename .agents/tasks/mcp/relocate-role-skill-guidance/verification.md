# Verification

Evidence for the implementation of [final.md](technical-design/final.md).
Commands ran in the Team workspace on the `dreamux/dreamux-fable` branch on
2026-09-02 (Asia/Shanghai).

## Implementation run

- The successful implementation run (9 disjoint writer
  lanes on the `claude` runtime → fidelity critic + build/typecheck/lint/
  focused-test/acceptance gates → bounded self-repair). All nine lanes
  settled with their files changed; no blockers. The round-1 critic found no
  `must` gap in the code, skills, docs, test, or change files; its one `must`
  (missing `verification.md`) is a TeamLeader artifact and is this file. All
  five gates passed in round 1 and again in round 2.
- The first implementation run was destroyed
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

## Review adjudication (2026-09-03)

Two reviews of the PR change set: the operator's GitHub review on the pull
request (nine inline items) and the internal code-review workflow (xhigh:
seven finders, 55 candidates, 39 verified, 2 refuted, 15 reported after the
synthesis step failed and the ranked list was returned unmerged). Each row is
finding → ruling → reason → operator-ruling conflict.

| # | Finding | Ruling | Reason | Conflicts with a ruling? |
| --- | --- | --- | --- | --- |
| G1 (P1) / I2 | TeamLeader prompt lost the generic visible-delivery rule (use the provider reply tool for progress, blockers, final status; assistant text is not delivery) | accept | Same sentence the Dispatcher prompt already carries; a role boundary, not a tool manual; external providers add no per-message reminder | No; the operator asked for it on the PR |
| G2 (P1) / I3, I4 | Public-artifact half of the confidentiality rule lost its owner; `reply.text` covers chat text only | accept | Add the Dispatcher's generic line to the TeamLeader prompt; keep `reply.text` | No |
| G3 (P1) | `force` descriptions claim discard/removal regardless of cleanup policy | accept | Verified `WorktreeManager.assessCleanup`: `cleanup: keep` returns terminal `kept` before any dirtiness check, so `force` only overrides a blocked `delete-on-close` removal | No |
| G4 (P1) | Task record publishes run ids and a Team name | accept | Public-repo red line on internal identifiers; replace with non-identifying labels in README and this file | No |
| G5 (P2) / I5 | Dispatcher replace prompt over-specifies channel tools ("reply, routing, and policy") | accept | Use the neutral wording of the append and TeamLeader prompts | No |
| G6 (P2) / I0, I1, I12, I13 | `repo.slug` default text wrong for Teams (`team-<team_name>`) | accept | Verified `runtime-registry.ts` passes `team-${teamId}`; state both defaults | No (the slug input itself is removed by the separate task) |
| G7 (P2) | README goal says behavioral rules move into prompts | accept | Requirement refinement 2 says the opposite; reword goal and index line | No |
| G8 (P2) | Task record not at closeout while the PR is presented | accept | The PR was opened early on the operator's instruction; complete closeout with the follow-up commit | No |
| G9 (P2) | No behavioral coverage of the TeamLeader prompt | accept | Build the TeamLeader through `createTeamLeaderAgent`/`restoreTeamLeaderAgentForTeam` with a fake agent-runtime provider that captures the launch context's `systemPrompt`; assert stable phrases; no private export, no source mirror | No |
| I6, I7, I9 | TeamLeader `dissolve` sentence dropped "through the visible reply path"; KB page claims it is there | accept | Five words restore the original; the KB claim then holds | No |
| I8 | Cron "prefer explicit titles and time zones" dropped | accept | Fold the preference into the `tz` and `title` property descriptions | No |
| I10, I11 | Feishu runtime refusal text still says "Ask the Dispatcher to move it" | accept, pending operator OK | Same banned wording as the description this change removed; one string in `routing/index.ts`, outside the approved boundary | Needs a ruling (asked 2026-09-03) |
| I14 | `spawn`/`send` completion clause unconditional | accept | Condition on a submitted turn: a `failed`/`stopped`/`ambiguous` receipt has no turn to push | No |
| refuted (2) | `cron` property vs tool sentence; `force` lost its guards | reject | Verifier refuted both with quotes; `force` keeps "only with the user's explicit confirmation" | — |

## Rebase and anti-leak gate (2026-09-03)

- Rebased onto `next` at the operator's request (three commits behind: the
  Feishu `ask_user_question` tool, the mandatory anti-leak gate, the runnable
  self-upgrade SOP); no conflicts. After the rebase: `rush update
  --bypass-policy` (the host's global `core.hooksPath` points at a
  machine-wide security hook, so Rush cannot install the repository hook and
  Rush's own documented bypass is used for the install step only), `rush
  build`, `rush typecheck`, `rush typecheck:tests`, `rush lint`, and the
  focused tests (dreamux: 7 files / 123 tests including
  `internal-content-scan.test.ts`; feishu-channel routing: 7) all passed.
- `common/scripts/check-internal-content.sh` over the tree: clean.
- gitleaks 8.30.1 installed with `common/scripts/install-gitleaks.sh`;
  `gitleaks git --config .gitleaks.toml` over this branch's commits: no leaks.
  Because the repository pre-commit hook is not wired on this host (global
  `core.hooksPath`), the hook script is run by hand against the staged
  changes before each commit instead of changing the host's hook setting.
