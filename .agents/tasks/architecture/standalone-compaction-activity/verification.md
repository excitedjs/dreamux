# Verification

## Contract coverage

| Acceptance criterion | Locked by |
| --- | --- |
| Claude reports compaction as `context.compacted`, same id, no text or metadata | `packages/agent-runtime/claude-code/tests/runtime-activity.test.ts` (exact object, `stream-0:compacted`); `runtime-background.test.ts` (background compaction, `stream-3:compacted`, position in the stream) |
| Claude reports a native interrupt as `turn.interrupted`, ahead of usage and the end | `runtime-activity.test.ts`: with metrics (`turn.interrupted`, `token.usage`, `turn.ended` as exact objects, ids `stream-0:interrupted` / `stream-1:usage`) and without metrics |
| Claude teardown reports only `turn.ended` `interrupted` | `runtime-background.test.ts`: the activity appended by `stop()` is exactly one interrupted end |
| Codex reports compaction on item completion only | `packages/agent-runtime/codex/tests/codex-runtime.test.ts`: nothing on `started`, one exact `context.compacted` (`turn-1:compact-1:completed`) on `completed` |
| Codex reports a native interrupt as `turn.interrupted`, ahead of usage and the end | `codex-runtime.test.ts`: interrupt without usage, and with usage (exact objects, `turn-1:interrupted` / `turn-1:usage`) |
| Codex teardown reports only `turn.ended` `interrupted` | `codex-runtime.test.ts`: `stop()` mid-turn yields exactly one interrupted end and nothing else |
| Core projects both kinds with the same id and `redacted: false` | `packages/dreamux/tests/cot-projection-privacy.test.ts` (exact objects for both kinds) |
| The Feishu card is byte-identical to the old assistant-message path, including opening a card | `packages/channel/feishu-channel/tests/feishu-cot-delivery.test.ts`: for each kind, onto an open card and when opening one, the `TEXT_MESSAGE_*` events deep-equal those of an `assistant.message` with the same `event_id` and the label text; the same test locks position before the usage line and the terminal (任务中断 for the interrupt) |

No `assistant.message` carrying either label remains in any runtime; the only
source occurrences of the two labels are in
`packages/channel/feishu-channel/src/feishu-cot-activity.ts`.

## Gates

Run by the TeamLeader with `node common/scripts/install-run-rush.js <command>`
on the change rebased onto `next` after #444 merged:

- `build`: `SUCCESS: 5 operations`, `SKIPPED: 3 operations` (up to date).
- `lint`: `SUCCESS: 7 operations`, `NO OP: 1 operation`.
- `typecheck:tests`: `SUCCESS: 7 operations`, `NO OP: 1 operation`.
- `test`: `SUCCESS: 4 operations`, `SUCCESS WITH WARNINGS: 3 operations`,
  `NO OP: 1 operation`; the warnings are stderr from failure-path tests, and no
  test failed. The developer's run before the rebase reported 160 test files
  and 2,613 tests passed, none skipped, including the live Codex tests.
- `.agents/scripts/check.sh`: task records and knowledge base OK.

## TeamLeader pre-review

The first implementation matched the solution in behavior and tests. Four
comment gaps went back to the developer and were closed without behavior or
test changes: the technical reason each runtime reports the interrupt marker
was restored (the Claude CLI's own sentence rides a hidden `user` envelope;
codex reports an interrupt only as a turn status), the codex-cli 0.153.4
measurement note was restored, the two Feishu acceptors gained doc comments
carrying the display rationale that left the runtimes, and the new type docs
use the same backtick convention as their neighbours.

## Implementation review

The Devbox reviewer reviews the pull request in place of the review workflow,
as the work group allows.

## Coverage limit

No live Feishu client probe. Card identity is asserted through the shared
`acceptDisplayText` path and the deep-equal delivery test, not observed in a
client.
