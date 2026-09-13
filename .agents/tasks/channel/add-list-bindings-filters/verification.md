# Verification

## Unit tests

`packages/channel/feishu-channel/tests/feishu-routing-tools.test.ts`, block
`list_bindings — query parameters narrow one table read`, over a four-row
fixture: one chat's own binding, two topic bindings under it, and a second
chat's binding, spread across two Teams.

| Acceptance criterion | Test |
| --- | --- |
| 1. No argument is unchanged | returns all four rows for `{}` and for `undefined` |
| 2. `team_name`, including an empty answer | `alpha` returns its two rows; an unknown Team returns `[]` |
| 3. `chat_id` returns the chat row and its topics | `oc_space` returns three rows, none from the other chat |
| 4. `thread_id` pinpoints one topic | returns exactly that row |
| 5. `target_kind` splits whole-chat from topic rows | `group` returns the two chat rows, `topic` the two topic rows |
| 6. Filters intersect; no match is an empty array | `chat_id`+`team_name` narrows; a contradictory pair returns `[]` |
| 7. A rejected `target_kind` names what is accepted | `p2p` raises `target_kind must be one of: group, topic` |
| 8. Four optional properties, none required | asserts the advertised schema's keys and empty `required` |
| 9. The advertised schema is the one that runs | invokes `list_bindings` with arguments through `createFeishuSessionMcp`, and again with a bad `target_kind` |

Criterion 9 exists because every criterion above it reads `listBindingsDef`
directly. `feishuToolRegistrations` advertises `def.inputSchema` and
`findFeishuTool` resolves the same object to serve the call
(`packages/channel/feishu-channel/src/tools/registry.ts`), so the two invoke
tests are what show a Dispatcher's arguments meeting the schema it was shown.

## Repository gates

All four run from the monorepo root and pass on the implementation commit:

- `node common/scripts/install-run-rush.js build` — SUCCESS, 8 operations.
- `node common/scripts/install-run-rush.js lint` — SUCCESS, 7 operations + 1 no-op.
- `DREAMUX_SKIP_LIVE_CODEX=1 node common/scripts/install-run-rush.js test` —
  SUCCESS 4, SUCCESS WITH WARNINGS 3 (stderr from runtime error-path tests), 1 no-op.
- `node common/scripts/install-run-rush.js typecheck:tests` — SUCCESS, 6 operations + 2 no-ops.

## Knowledge check

`.agents/domains/channel.md`, `.agents/domains/dispatcher-skill.md`, and
`packages/dreamux/README.md` name `list_bindings` but state no input shape for
it; the dispatcher-skill page explicitly defers schemas to the channel package's
live `tools/list`. Nothing there became stale, so nothing there changed. The
`dreamux-maintenance` skill documents the routing document's shape and
ownership, which this change does not touch.
