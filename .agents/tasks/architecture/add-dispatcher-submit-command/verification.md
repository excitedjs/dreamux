# Verification

## Gates

Run by the TeamLeader on the complete worktree, from the repository root
through `node common/scripts/install-run-rush.js`, after the implementation
round and again after the pre-review fix round. Both runs: all four green.

| Gate | Result |
|---|---|
| `build` | SUCCESS, no failures |
| `lint` | SUCCESS 7, NO OP 1 |
| `test` | SUCCESS 4, SUCCESS WITH WARNINGS 3, NO OP 1 — no failing test; the warnings are the expected stderr of negative-path cases |
| `typecheck:tests` | SUCCESS 7, NO OP 1 |

The live Codex tests ran; `DREAMUX_SKIP_LIVE_CODEX` was not used.

## Acceptance criteria

| Criterion | Evidence |
|---|---|
| The catalog registers both Commands and they reach the addressed Dispatcher's Agent over both adapters | `core-command-registry.test.ts` frozen name table; `core-command-adapters.test.ts` `dispatcher.submit` and `dispatcher.interrupt` cases |
| `team.submit` / `team.interrupt` without `team_name` are `BAD_REQUEST` and reach no Agent | `core-command-adapters.test.ts` rejection case, which also asserts the Agent fakes were not called; `dreamux-types` contract test asserts the payload no longer type-checks |
| No Feishu source invokes a Team Command without `team_name` | `feishu-channel.ts` names the Command from the plan; asserted in the session, slash-command, and COT suites |
| Unbound conversation, rejected bound Team, and document-comment cold open still reach the Dispatcher Agent | `feishu-channel-session.test.ts` (unbound, both fallbacks, cold open); `feishu-cot-delivery.test.ts` |
| `/stop` addressing | `feishu-slash-commands.test.ts` |
| A provisioning run that delivers to no Team posts the notice and submits nothing to the Dispatcher | `feishu-channel-session.test.ts`: throwing `team.create`, replayed closed Team, empty Team name, rejected submission to the fresh Team, concurrent waiter with no installed route; plus `failed` / `ambiguous` / `error` asserting no notice |

## TeamLeader pre-review

Findings sent back to the developer and fixed in one round:

- a redundant liveness check in the notice branch, with no await between it and
  the check on the line above — defensive code with no reachable failure
  scenario;
- a comment naming only `team.submit` for the non-empty-`text` rule on a path
  that now reaches `dispatcher.submit`;
- the question-card settlement path: it shares the delivery entry point, so a
  `provision` plan that produces no recipient now drops the answer with a log
  line and no notice. The operator ruled to keep that ("保持现状：只记日志"); the
  reason is recorded in the code at that log line.

Two files outside the solution's list were accepted as they stand:
`feishu-route-reconciliation.ts` (the notice helper's parameter narrows to the
two rejection codes that can still reach it) and `team-service/types.ts` (the
shared submit receipt's output schema moves beside the projection both Commands
return).
