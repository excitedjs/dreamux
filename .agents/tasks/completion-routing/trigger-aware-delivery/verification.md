# Verification

## Local gates

All four run at the repository root, in this order, all green:

```
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js lint
node common/scripts/install-run-rush.js test
node common/scripts/install-run-rush.js typecheck:tests
```

`typecheck:tests` caught the two contract suites that pin the submission key set
and the admission union — neither the build nor `test` would have, because
`tsconfig.json` excludes `tests/` and vitest erases types. Both were updated to
state the new contract rather than loosened.

## Upstream evidence

Measured against codex-cli 0.166.0 before implementation:

| Path | Same turn | Interrupts |
| --- | --- | --- |
| `turn/start` while busy (previous behaviour) | yes | **yes** |
| `thread/inject_items` with `Message{role:"user"}` | yes | no |
| `thread/inject_items` with `AgentMessage` | no | no |
| `thread/queue/add` | no | no |

Interruption measured as an assistant message that starts but never completes:
previous behaviour left the first message at 65 streamed deltas with no
`item/completed`; appended context let it finish at 294. Three consecutive runs
agreed.

`thread/status/changed` was observed to report `active` then `idle` for a real
turn, and `thread/read` reports the same status on demand.

## Coverage limits

- No live end-to-end run of a real TeamMate completion reaching a busy
  TeamLeader through the upgraded dispatcher; that is the post-release check.
- Claude Code's `origin` is asserted on the envelope only. This build does not
  consume it on the stream-json path, which is the intended behaviour and is
  documented in the adapter rather than tested through the CLI.
- The idle-side behaviour is covered by a fake client emitting
  `thread/status/changed`; no test drives a real idle-to-turn transition.

## Review

Independent review is recorded on the pull request.
