# Verification

Date: 2026-11-24.

## Repository gates

The following commands passed against the complete current worktree:

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`

The full test run retained the existing live-Codex warnings: native model cases
were not enabled. `git diff HEAD --check`, `.agents` checking, and
`rush change --verify --no-fetch --target-branch next` also passed.

Earlier PR runs found and fixed two platform issues: Windows activity-root
containment now canonicalizes the allowed root before comparison, and macOS CI
installs tmux for the private-tmux integration tests. The final all-platform
Rush gates, repository scripts, KB, change declaration, internal-content,
gitleaks, and metadata checks passed. A separate macOS repository-scripts job
was twice cancelled without receiving a runner (`steps: []`); its independent
retries passed.

Independent Devbox review closed the five implementation findings from the
first review round on [draft PR #493](https://github.com/excitedjs/dreamux/pull/493).
The default-agent redesign below happened afterward and requires a fresh review
of its complete diff; the old approval is not inherited by the new architecture.
Devbox subsequently reviewed that redesign and verified its lazy-id Core loop,
byte-zero first transcript, admission ordering, and cache shapes. Its only low
finding was the 100ms full-log read after id publication; the runtime now skips
that read once `sessionId` is set. No new blocker was found.

## Deterministic coverage

The current package has **80 passing tests** across provider/config/version,
provider-cache customizations, native record decoding, cold activity pagination,
ACP fake-peer behavior, private-tmux behavior, and incremental transcripts.

Coverage includes exact resume, lazy fresh-id publication before first native
admission, registration and admission, shared frozen completions, Unicode and
multiline input, busy native-queue input, transport failure and stop, native
permission/tool outcomes, background terminals, malformed records, growing
files, cursor boundaries, and read bounds. The transport suites exercise the
same neutral runtime contract but remain separate fake-native suites rather
than one shared parameterized suite.

## Current default-agent native evidence

All current launch paths use agy's default agent without `--agent` and without a
Dreamux custom-agent profile. Synthetic public probes established:

- ACP native `_meta.antigravity.systemPrompt.append` produced `APPEND-OK`;
- a default ACP `session/new` MCP descriptor produced a real `probe_echo` call
  and `SYNTHETIC-MCP-OK`;
- an ordinary workspace skill and a provider-cache `.agents/skills` skill passed
  with `--add-dir` were both present in model context;
- provider-cache `.agents/rules/dreamux.md` (`trigger: always_on`) produced
  `RULE-OK` through the default agent;
- a real Carbon Team preloaded five MCP servers but agy rejected the Feishu reply
  schema's `^/(?!/)` pattern as unsupported Perl syntax, aborting toolbox
  construction. The schema now uses RE2-compatible alternation with identical
  absolute-path semantics and a regression assertion forbidding lookaheads;
- a real default TUI `/mcp` panel discovered the cache
  `.agents/mcp_config.json` server and its `probe_echo` tool;
- a real default TUI `/skills` panel discovered the cache skill while retaining
  the user's existing 47-skill inventory;
- default TUI did not create a conversation before the first model input, even
  with `--prompt-interactive ""`. The approved lifecycle is therefore ready
  without an id → first real input creates the conversation → provider publishes
  the logged UUID before confirming native admission;
- `agy --help` declares exactly `low|medium|high|xhigh|max` for `--effort`, the
  source of the provider config enum;
- earlier ACP probes established actual model output, exact `session/load`
  content replay and continued generation, early/out-of-order prompt responses,
  and merged native response groups. Quiet-time debounce is not valid terminal
  evidence.

A previous custom-agent implementation was removed after native probes showed
that its empty ACP `mcpServers` blocked preloaded servers and that the default
agent already supported the required prompt/MCP/skill paths. Native
`disabledTools` is deliberately not applied; the provider does not claim to
block `ask_question`, `schedule`, or other native tools.

Live resources were private to the probes. No credentials, account details, or
private native transcripts were copied into the repository.

## Coverage limits and unresolved native contracts

- Ordinary model generation through the real TUI hit Antigravity's native
  account/location eligibility failure while ACP succeeded. No cause is
  asserted. Real TUI first-input admission, merged-turn completion,
  interruption, background/subagent terminals, and control-byte fidelity remain
  unverified; deterministic coverage is not live evidence. The lazy-id sequence
  is covered by fake-native tests but has not completed a real model turn.
- Busy non-user news uses the native input path instead of a provider refusal.
  Real busy Enter behavior and preservation of the active answer/tool work are
  still unverified under the eligibility blocker.
- Tmux sends Escape as the implemented interrupt convention, not as a
  real-busy-turn-proven key. English interrupted-viewport recognition and the
  five-second confirmation have fake coverage only.
- ACP has no native interrupted-turn/result id for `turn.interrupted`. The
  implementation emits `turn.ended` and stopped settlements but does not invent
  an activity id. Tmux likewise cannot emit the marker without a native record
  id and reports that identity failure from `interrupt()`.
- ACP session updates lack native turn/group ids. Complex overlapping groups
  with id-less chunks or multiple failed tools cannot always be associated by
  authoritative identity. A bound native request error uses the existing
  transport-loss path rather than guessing membership. Settlement depends on
  the current full-transcript path/record shapes; no future-format recovery
  mechanism is added under the no-new-defensive-scenarios ruling.
- Native transcript tool calls generally have no call id and GENERIC results
  have no back-reference. Cold tool-result pairing is native file-order FIFO;
  live tool activities without native ids are omitted.
- Cross-transport resume and every real stop/restart terminal combination remain
  unverified.

These limits must not be described as full production readiness for both modes.
