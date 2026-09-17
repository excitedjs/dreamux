# Verification

## Gates

```bash
.agents/scripts/check.sh
node common/scripts/install-run-rush.js build --to @excitedjs/dreamux-types --to @excitedjs/dreamux \
  --to @excitedjs/agent-runtime-codex --to @excitedjs/agent-runtime-claude-code \
  --to @excitedjs/feishu-channel
node common/scripts/install-run-rush.js typecheck:tests --to @excitedjs/dreamux \
  --to @excitedjs/agent-runtime-codex --to @excitedjs/agent-runtime-claude-code \
  --to @excitedjs/feishu-channel
node common/scripts/install-run-rush.js lint --to @excitedjs/dreamux-types --to @excitedjs/dreamux \
  --to @excitedjs/agent-runtime-codex --to @excitedjs/agent-runtime-claude-code \
  --to @excitedjs/feishu-channel
node common/scripts/install-run-rush.js test --to @excitedjs/agent-runtime-codex \
  --to @excitedjs/agent-runtime-claude-code --to @excitedjs/feishu-channel
```

Results of the author-side run are recorded below; the pull request's Actions
runs cover the same gates on macOS and Ubuntu:
[PR #442](https://github.com/excitedjs/dreamux/pull/442).

## Contract coverage

The assertions pin the contract end to end, not just the shape:

- **Exact object, not a subset.** Codex emits
  `{kind:'token.usage', id:'turn-1:usage', inputTokens:28_568, outputTokens:69, context:{usedTokens:14_500, windowTokens:29_000}}`
  (plus an `occurredAt` matcher), and claude emits the 28,531/69/14,500/`null`
  counterpart — a silent re-formatting or scaling of a native number fails the
  test.
- **Kinds sequence.** codex: `['assistant.message','token.usage','turn.ended']`;
  claude: `['token.usage','turn.ended']`; interrupted turns keep
  `[interrupt marker, token.usage, turn.ended]`.
- **Snapshot discipline (codex).** A foreign-thread notification is ignored;
  the latest matching-thread snapshot wins; a collector thread switch clears
  it so the next turn with no usage emits no activity; an early terminal
  admission carries `turn-early:usage` at most once.
- **No counters, no activity.** Both runtimes stay silent when the native
  terminal carries no usage (failed status / absent envelope).
- **Null window shapes.** Codex with `modelContextWindow: null` reports the
  used count; claude's background-result path reports `context: null`.
- **Projection.** The dreamux suite covers the camelCase to snake_case member
  with `redacted: false`.
- **Rendering.** `feishu-cot-token-usage.test.ts` pins the exact line for the
  percentage, compact-count, and `n/a` cases and the compact-number table from
  0 through 1.3b, so the channel-owning formatter reproduces the old
  provider-emitted text byte for byte.

## Non-live suite

The repository's non-live suite passes in the author's sandbox: 1,075 tests in
73 files for the `@excitedjs/dreamux` project (including the two exact-object
projection tests added here), plus the changed runtime and channel packages'
suites. The `codex-live.test.ts` tests require a reachable model API and are
not part of the sandbox result: each of the six times out on this branch and
identically on a clean base checkout, so they carry no signal here. The pull
request's CI runs the gates in a connected environment.

## Change-file and knowledge gates

- Rush change files exist for all five touched packages (`minor`), required by
  the change-file gate.
- `check.sh` validates the new task record and the knowledge base:
  task-record states/labels, reachable links, and the internal-content scan.
- Public-repository hygiene: the diff and the pull request text contain no
  private host names, identifiers, or sibling-repository references; the
  motivation is stated in upstream-neutral terms.
