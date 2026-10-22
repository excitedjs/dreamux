# Verification

## Native protocol observation

On 2026-10-22, installed `codex-cli 0.164.0-alpha.8` was run with a fresh
temporary Codex home and a stdio app-server. The probe initialized the client,
created a thread, and sent `thread/name/set`. No `turn/start` or model request
was made. The server replied successfully and emitted:

```json
{
  "method": "thread/name/updated",
  "params": {
    "threadId": "<created thread>",
    "threadName": "Investigate login timeout"
  }
}
```

This confirms the native event is usable by a non-TUI client. It does not prove
that bare app-server generates titles, or that another app-server instance
forwards its events to Dreamux.

## Implementation checks

On 2026-10-22, the completed implementation passed these monorepo commands:

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`
- `node common/scripts/install-run-rush.js smoke-built-cli`

The test run passed 2,841 tests across 186 files. Six existing opt-in model
tests in three files were skipped because `DREAMUX_RUN_LIVE_MODEL_GATE` was not
enabled. `DREAMUX_SKIP_LIVE_CODEX` was not set. The built CLI smoke loaded the
compiled Server graph and executed the launcher with `--version`.

Four new provider cases cover native thread ownership, missing/null/blank
names, and fatal persistence/lease failures. Five new Core cases use real
state owners and filesystem writes to cover leader/member/dispatcher
isolation, unchanged identity content, both reconstruction paths, awaited
durability, rejection after queued lease revocation, and write failure without
changing the committed topic. A Feishu test verifies each `/teams` reads the
current intent and earlier cards remain unchanged. The neutral exact-union
test and exhaustive switch include the new event without weakening their
assertions.

An independent read-only implementation review approved the ownership,
queued authority check, failure semantics, and tests. A follow-up review
confirmed compatibility with the optional `threadName` field at Codex's
supported 0.137 minimum. The knowledge check (`.agents/scripts/check.sh`)
passed after linking this evidence and completing the task record.

## Coverage boundary

The native probe verifies Codex's actual transport. Provider/core tests verify
the integration and existing list/card projection. No production daemon has
been upgraded and no deployed Feishu client acceptance is claimed.
