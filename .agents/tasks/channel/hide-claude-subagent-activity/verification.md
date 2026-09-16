# Verification

## Wire evidence (2026-09-16)

Two probes against Claude Code 2.1.272 with the flags Dreamux uses for the
resident session (`--print --input-format stream-json --output-format
stream-json --verbose`, bypass permission mode), not through Dreamux itself:

- Background subagent (the model's default choice): subagent `thinking`,
  `Bash` `tool_use`, `tool_result`, and text envelopes, each carrying the
  spawning `Agent` call's id in `parent_tool_use_id`; the text arrived after the
  main turn's `result`. Main-agent envelopes carried `null`.
- Foreground subagent (`run_in_background: false`): the subagent's prompt as a
  `user` text block, its `Bash` `tool_use` and `tool_result`, all carrying the
  call's id; no subagent text.
- The main session transcript file held no record with `isSidechain` or a
  `parent_tool_use_id`; the subagent transcript was a separate file under
  `subagents/`.

## TeamLeader implementation check (2026-09-17)

Baseline: `origin/next` at `bc7d769d`.

Diff against the final solution:

- §1: `emitStreamActivity` returns after the `compact_boundary` branch when
  `line.raw['parent_tool_use_id'] != null`, before any block is read.
- §2: the function's doc comment states that a subagent's envelopes are not
  reported and the main agent's own `Agent` call stays.
- §3: one test fires a main `Agent` call, subagent `user` text, `assistant`
  `tool_use`, `user` `tool_result`, and `assistant` text envelopes carrying the
  call's id, then the main `Agent` result, and asserts exactly the two main
  `Agent` rows, the result row still named `Agent`. With the filter line
  removed, the test fails; restored, the file's 31 tests pass.
- Knowledge: provider-runtime display-line section and history line, the
  product catalog's "Observing agents" entry, and row 4 plus the documentation
  note of the stream-json research document.
- Nothing outside the approved boundary changed.

Commands, run from the repository root:

| Command | Result |
| --- | --- |
| `node common/scripts/install-run-rush.js build` | SUCCESS 4, SKIPPED 4 |
| `node common/scripts/install-run-rush.js lint` | SUCCESS 7, NO OP 1 |
| `node common/scripts/install-run-rush.js test` | SUCCESS 4, SUCCESS WITH WARNINGS 3 (expected stderr from runtime failure-path tests), NO OP 1 |
| `node common/scripts/install-run-rush.js typecheck:tests` | SUCCESS 7, NO OP 1 |

After a test-helper tidy (no assertion change), `lint`, `test`, and
`typecheck:tests` were rerun with `--only @excitedjs/agent-runtime-claude-code`:
all succeeded.

## Coverage limits

- The probe ran the raw CLI, not a Dreamux-launched resident session.
- The Feishu card was not observed with the change.
- Nested subagents were not probed; the documentation states they carry
  `parent_tool_use_id` at every depth, and the filter does not depend on depth.

## Independent implementation review (2026-09-17)

External review of the pushed branch (commit `e50dfe70` on `next` `bc7d769d`),
used in place of the workflow review for this group's tasks. Verdict: approved,
no finding.

- The reviewer confirmed the filter sits in the envelope-meaning owner, that
  compaction, interruption, usage, and `turn.ended` never reach it, and that the
  RPC still feeds every line to `TurnAggregator`, so the recorded
  `lastAssistantText` non-goal is unchanged.
- The reviewer independently ran `rush build`, the full `rush test`, `eslint`,
  and `tsc -p tsconfig.tests.json`, all passing, and repeated the mutation
  check: with the filter line removed the new test fails (30 passed, 1 failed);
  restored, 31 pass.
- The only remaining item it named was the in-flight task state failing
  `.agents/scripts/check.sh`, resolved by setting `done` at closeout.

TeamLeader adjudication: nothing to fix.
