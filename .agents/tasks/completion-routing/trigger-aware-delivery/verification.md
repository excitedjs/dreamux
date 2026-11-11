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

## Post-release end-to-end run

Measured 2026-11-11 against the installed `0.29.0-alpha.g660a0afbeb41`
artifact — the published package, its real `codex app-server` child, and a real
model, not a fake client. Two harnesses, both driving the public
`createCodexAgentRuntimeProvider` API and recording the RPC each submission
issues.

**Routing, with the thread genuinely mid-turn** (a shell tool call sleeping, so
the turn cannot finish before the second submission lands):

| Submission | `thread/status/changed` before it | RPC issued | Admission |
| --- | --- | --- | --- |
| `trigger: 'user'` | `active` | `turn/start` | `submitted` |
| `trigger: 'completion'` | `active` | `thread/inject_items` | `appended` |

**Consequence for the response already being written.** Measured on raw native
notifications, keyed on the first assistant message's own item id — how many
`item/agentMessage/delta` frames it received, and whether it ever reached
`item/completed`:

| Submission | Busy before | RPC | First message completed | Deltas on it |
| --- | --- | --- | --- | --- |
| `trigger: 'user'` | `active` | `turn/start` | **no** | 50 (stopped there) |
| `trigger: 'completion'` | `active` | `thread/inject_items` | **yes** | 1238 |

Both runs submitted at the same point in the response (50 deltas streamed). The
steered message never completes and the answer restarts as a second message; the
appended one runs to completion and the news is read inside the same turn. This
is the property the change exists for, now observed on the released artifact.

Harness note: the first attempt at this measurement waited on the provider's own
`assistant.message` activity as the "response is in flight" signal. That activity
is emitted only at `item/completed`, so the harness was in fact waiting for the
message to finish and submitting into an idle thread — both runs then took
`turn/start`, correctly, and proved nothing. The measurement above waits on raw
`item/agentMessage/delta` frames instead. Recorded because the mistake is easy
to repeat and produces a confidently wrong conclusion.

## Coverage limits

- The end-to-end runs drive the provider package directly. No run has a real
  TeamMate completion travelling through the whole dispatcher — Core's
  `triggerForSource` mapping into the runtime — while a TeamLeader is busy. That
  path is covered by unit tests (`submission-envelope.test.ts` pins the
  source-to-trigger mapping) rather than by observation.
- Claude Code does not act on `trigger`; its adapter documents why rather than
  testing a behaviour it does not have.
- The idle-side behaviour is covered by a fake client emitting
  `thread/status/changed`; the real-codex runs above always entered the busy
  branch. No real-codex run has driven a completion into an idle thread.

## Review

Independent review is recorded on the pull request.
