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

## Revised implementation checks

On 2026-10-22, the unified-event implementation passed these monorepo commands:

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`
- `node common/scripts/install-run-rush.js smoke-built-cli`

The test run passed 2,842 tests across 186 files. Six existing opt-in model
tests in three files were skipped because `DREAMUX_RUN_LIVE_MODEL_GATE` was not
enabled. `DREAMUX_SKIP_LIVE_CODEX` was not set; installed-Codex tests that need
no model turn ran. The built CLI smoke loaded the compiled Server graph and
executed the launcher with `--version`.

The Codex tests cover own-thread filtering, missing/null/blank names, event
publication without an identity-state write, and original completion identity
and finalization order. Both provider suites now use the required event sink;
Claude's title capability is unchanged. Existing interruption, background
result, late admission, and stop/reopen contracts remain exercised.

Seven Core title cases use real state owners and filesystem writes to cover
leader/member/dispatcher isolation, unchanged identity content, both recovery
paths, accepted-before-revocation FIFO order, late-event rejection, failed
writes retaining the committed topic and live runtime, shutdown drain despite
native stop failure, and nonthrowing observation. The existing native-order
suite passed all 28 cases. A Feishu test verifies each `/teams` reads the current
intent and earlier cards remain snapshots. Exact-union contracts now separate
the three durable identity kinds from runtime observations and prohibit the
removed activity/results fields.

An initial run failed both immediate-close recovery cases: normal host shutdown
retained the record handle and therefore did not use its release-time drain.
The fix drains the same writer after stopping producers. The recovery tests
still emit a title, immediately await host close, and then reconstruct; no
extra polling or delay was added before closing to mask this failure.

The title callback and guard plumbing were removed. Two single-use TeamService
wrappers were also deleted without moving ownership or changing the line-limit
rule. The broader file-cohesion candidate is recorded in the design.

Fresh independent full-diff and boundary reviews approved the revised ownership,
synchronous FIFO admission, failure-isolated shutdown draining, completion
identity/report-failure convergence, test assertions, and the documented API
migration. Both were static source/test reviews and did not rerun the suite.
The first implementation's approval is not used as evidence for this replacement.

The KB check passed with all task records valid and all files reachable. Rush
change verification passed after the new Claude adapter change file was
committed; existing package notes were reconciled with the required event API.
The implementation commit passed staged lint, author, gitleaks, and
internal-content gates.

## Coverage boundary

The native probe verifies Codex's actual transport. Provider/Core tests verify
the integration and existing list/card projection. No production daemon has
been upgraded and no deployed Feishu client acceptance is claimed. There is no
added title producer, replay, polling, or model summary request. Dropped events
or failed title writes may leave the prior topic until a later rename.
