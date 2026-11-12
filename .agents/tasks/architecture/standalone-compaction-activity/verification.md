# Verification

## Contract coverage

| Acceptance criterion | Locked by |
| --- | --- |
| Claude reports compaction, assistant text, and tool calls under native ids, with no counter | `packages/agent-runtime/claude-code/tests/runtime-activity.test.ts` (exact objects: line `uuid` for text and compaction, `tool_use.id` for a call's start and result); `runtime-background.test.ts` (background text, tool pair, and compaction as exact objects in stream order) |
| Claude's usage and interrupt marker take the `result` envelope's own `uuid`, not `user_message_uuid` | `runtime-background.test.ts`: an interrupted result carrying both a `uuid` and the submission's `user_message_uuid`, with and without usage — marker, usage, and interrupted end as exact objects under the envelope `uuid`; `runtime-activity.test.ts`: two results give two usage ids |
| A Claude result without a `uuid` still ends the turn | `runtime-activity.test.ts`: `result` and `interrupted` with no envelope `uuid` report exactly one `turn.ended` |
| Claude teardown reports only `turn.ended` `interrupted` | `runtime-background.test.ts` (unchanged): the activity appended by `stop()` is exactly one interrupted end |
| Codex reports item ids and `turnId`, compaction on completion only | `packages/agent-runtime/codex/tests/codex-runtime.test.ts`: exact objects for agent message (`item.id`), tool start and result (item id), compaction (`compact-1`, completion only), usage and interrupt (`turnId`), and no cross-turn usage relabel |
| Codex teardown reports only `turn.ended` `interrupted` | `codex-runtime.test.ts` (unchanged): `stop()` mid-turn yields exactly one interrupted end |
| One activity type reaches the Channel, redacted in place | `packages/dreamux/tests/cot-projection-privacy.test.ts`: every kind comes out as the same kind with ids, counters, and `occurredAt` untouched and every text and JSON member redacted (`text`, `summary`, `invocation`, `items`, `arguments`, `result`, `error`, `reason`), inside a camelCase envelope; the existing per-rule redaction cases now assert on structured values |
| No `TeammateActivity` export; `callId` and `redacted` gone | `packages/dreamux/tests/package-boundary-guards.test.ts` (pinned export set); `packages/dreamux-types/tests/team-teammate-contract.test.ts`; `rush typecheck:tests` over every test fixture |
| The four Core events are camelCase and sealed on `schemaVersion` / `occurredAt` | `packages/dreamux/tests/core-event-catalog.test.ts`, `input-source-lifecycle.test.ts`, `team-teammate-contract.test.ts` |
| The Feishu card renders as before | `packages/channel/feishu-channel/tests/feishu-cot-delivery.test.ts`: for each fixed-label kind, onto an open card and when opening one, the `TEXT_MESSAGE_*` events equal an assistant row's with the same content in every member but `messageId`; a usage row sharing the marker's native id still appears, with a distinct `messageId`; `feishu-cot-tool-rows.test.ts`: a tool start and result pair by `id`, a failed call shows its error ahead of its result, object, JSON-text string, and plain string results render as before; `feishu-cot-token-usage.test.ts`, `feishu-cot.test.ts` |
| A closed `team.state` still removes the Team's routes | `packages/channel/feishu-channel/tests/feishu-channel-session.test.ts` (existing cleanup cases, migrated to `teamName`) |

## Gates

Run by the TeamLeader with `node common/scripts/install-run-rush.js <command>`
after the pre-review fixes, on the branch based on `next` at #444:

- `build`: `SUCCESS: 5 operations`, `SKIPPED: 3 operations` (up to date).
- `lint`: `SUCCESS: 7 operations`, `NO OP: 1 operation`.
- `typecheck:tests`: `SUCCESS: 7 operations`, `NO OP: 1 operation`.
- `test`: `SUCCESS: 4 operations`, `SUCCESS WITH WARNINGS: 3 operations`,
  `NO OP: 1 operation`; the warnings are stderr from failure-path tests, and no
  test failed. The developer's run before the comment-only fixes reported 160
  test files and 2,639 tests passed, none skipped, including 10 live Codex
  tests.
- `.agents/scripts/check.sh`: task records and knowledge base OK.

## TeamLeader pre-review

First scope: the implementation matched the solution; four comment gaps went
back to the developer and were closed.

Second scope: the developer stopped before writing code on one gap in the
solution — `feishu-channel.ts` also reads `team.state` to remove a closed
Team's routes — which is inside the approved scope; the solution names it now.
The implementation then matched the solution in behavior and tests. Four
comment and naming gaps went back to the developer: two technical rationales
deleted from the projection (why payloads are walked as structure; why
exhaustiveness is compile-time only), the purpose comment of the neutral-kind
check that became type-level, a Claude variable still named for an API message
id while holding the line `uuid`, and the reason for the Feishu display
namespace.

## Implementation review

The Devbox reviewer reviews the pull request in place of the review workflow,
as the work group allows; its first-scope approval does not cover the second.

## Coverage limit

No live Feishu client probe. Card behaviour is asserted through the projected
card events, not observed in a client.
