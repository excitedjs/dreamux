# Verification

Date: 2026-11-24.

## Repository gates

The following commands passed against the complete current worktree:

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`

The full test run retained the existing live-Codex warnings: native model cases
were not enabled. No Antigravity live test was hidden behind those warnings.
`git diff HEAD --check` also passed.

One earlier package-test run reported a transient private-tmux `server exited
unexpectedly` failure in the fresh/resume case. The focused tmux suite and the
next complete package run passed, followed by the green full-repository run.
The failure is recorded rather than presented as a consistently reproduced
native defect.

`node .agents/scripts/check.mjs` found no content error other than the expected
rule that an in-flight `implementation` task record cannot be submitted to the
trunk. Task state must advance through the workflow before PR submission.

## Deterministic coverage

The package contains 77 focused tests across provider/config/version, native
profiles, native record decoding, cold activity pagination, ACP fake-peer
behavior, private-tmux behavior, and incremental transcript reading. Coverage
includes exact session ids, role-resume rejection, registration and admission,
shared completion objects, Unicode/multiline input, transport failure and stop,
native permission/tool outcomes, background terminals, malformed records,
growing files, cursor boundaries, and read bounds.

The transport suites exercise the same neutral runtime contract but are
currently separate fake-native suites rather than one shared parameterized
suite. This remains an acceptance-criterion difference for review.

## Real agy 1.5.15 evidence

Read-only or isolated live probes using the existing authentication established:

- fresh custom-agent TUI startup creates and reports a real conversation UUID
  before ready;
- exact TUI resume restores the same conversation and original role when the
  stable generated profile remains present;
- deleting the original profile makes agy fall back to its default role, so the
  runtime rejects that fallback before ready;
- process-local trusted-workspace settings reach native ready without editing
  shared configuration;
- ACP `session/new` creates a native session before the first prompt;
- ACP produces actual model output, exact `session/load` replays native content,
  continued generation works, and native cumulative usage was observed in the
  probe even though no neutral per-turn identity exists for it;
- concurrent ACP prompt responses can arrive early or out of order, and adjacent
  native inputs can merge into one planner response; quiet-time debounce is not
  valid terminal evidence;
- raw leading-slash TUI probes opened native panels, but those probes bypassed
  Dreamux's real Core XML envelope. The operator identified that incorrect
  premise; ordinary provider input has no slash-specific branch.

Live resources were private to the probes. No credentials, account details, or
private native transcripts were copied into the repository.

## Coverage limits and unresolved native contracts

- Ordinary model generation through the real TUI hit a native location/account
  eligibility failure while ACP succeeded with the same configured model label.
  No cause is asserted. Real TUI model admission, merged-turn completion,
  interruption, background/subagent terminals, and control-byte fidelity remain
  unverified; their deterministic coverage is not live evidence.
- ACP has no native interrupted-turn/result id for `turn.interrupted`. The
  implementation emits `turn.ended` and stopped settlements but does not invent
  an activity id. Tmux likewise cannot emit the marker without a native record
  id and currently reports that identity failure from `interrupt()`.
- ACP session updates do not carry native turn/group ids. Complex overlapping
  groups with id-less transcript chunks or multiple failed tools cannot always
  be associated by authoritative native identity. A bound native request error
  uses the existing transport-loss path rather than guessing group membership.
- Native transcript tool calls generally have no call id and GENERIC results
  have no back-reference. Cold tool-result pairing is native file-order FIFO;
  live tool activities without native ids are omitted.
- The generated role profile now declares `inheritMcp: false`, exact tmux MCP
  descriptors, selected skill paths, and native `disabledTools` mappings for
  `userInterrupt` and `cron`. Full live MCP/skill/disabled-tool isolation has not
  been certified because the real TUI model path is blocked as described above.
- Cross-transport resume, all real stop/restart terminal combinations, and the
  complete live role matrix remain unverified.

These limits must not be described as full production readiness for both modes.
