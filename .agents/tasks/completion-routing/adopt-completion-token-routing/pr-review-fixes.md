# PR review corrections to resident-session settlement

Baseline: `87763c2c`, PR #384. This is an in-scope correction to the approved
[resident-session design](technical-design/session-submissions.md), not a return
to request windows. Development and push were approved in
[ruling R4](rulings.md#r4-correct-the-accepted-pr-findings-and-push).

## Adjudication

| Finding | Decision | Evidence and correction scope | Ruling conflict |
| --- | --- | --- | --- |
| F1/F2: broad error-artifact guard | Accept | UUID-less error_during_execution results with no result string are discarded even when errors and terminal_reason describe failure. Current RPC replay strands A, then completes A with B's answer. Correct error boundaries and preserve the actual failed outcome; the complete wrong-answer sequence has not been captured live. | None. |
| F4: cancelled masks native failure | Accept defect; reject proposed no-start heuristic | Installed CLI setup failure emits a failure result with no UUID, followed by cancelled without started. Current replay loses its reason and returns stopped. Classify using native failure evidence, not absence of started. The operator clarified that the Claude provider has no user cancellation entry point. | Do not invent a user cancellation capability or implement speculative external-client cases. |
| A1: stopped admission after child failure | Accept narrowed scenario | Controlled real child processes with the production runtime/session show a recovered child exiting during durable identity publication; failure cleanup calls session.stop, and the pending submission then returns stopped although the runtime received no stop request. Actual user stop must still return stopped; failure cleanup must preserve failure. | None. |
| T3: direct RPC API absent from release note | Accept | src/index.ts exports ClaudeCodeStreamRpc and its options. Document the renamed submission methods and changed options, including required sessionId and the timeout error argument. | None. |
| F3: held results delivered after a newer result | Not established as a blocker | Installed 2.1.263 holds results at the examined engine site only after input closes, and drains older held results before the current result. No complete native trace supports the claimed inversion during resident streaming. Do not add speculative ordering machinery. | None; evidence gap remains explicit. |
| Public command_lifecycle observation | Optional clarification | Preserve the approved public observation seam; explain its purpose if touching its type documentation. | Removing the seam is outside this correction. |

The worker-crash note documents omitted UUID, not byte identity with every old
interrupt artifact. The old classifySteerFailure classified admission exceptions,
not lifecycle settlement. Neither claim justifies restoring the old model.

## Required outcomes

1. A genuine native failure must produce the correct failure/end rather than
   disappear as an old interrupt artifact. Requests actually consumed by it
   cannot survive to receive an unrelated result. Preserve the native error
   reason, including error results whose subtype is success but is_error is true.
2. Native cancelled is not evidence of a user stop. Cover the actual
   setup-failure result followed by cancelled and consumed-request failures.
   Preserve unrelated queued requests. Under [ruling R5](rulings.md#r5-no-user-cancellation-entry-point),
   do not introduce states, ordering machinery or compatibility paths for a
   hypothetical user cancellation entry point or external client. Existing
   protocol fixtures do not establish a Dreamux product capability.
3. Actual child exit during admission is failed or ambiguous according to
   whether a write occurred, even when cleanup has called session.stop. Only
   actual runtime stop intent is a normal stopped admission. Preserve stop
   convergence and existing process-group cleanup.
4. Document every changed public Claude session/RPC seam accurately in the
   existing breaking minor change entry and package README.

All prior product constraints hold: an unbound background result settles no
unrelated request and does not reap; started steers receive their result; queued
inputs wait; folded inputs share one completion; no origin-based filter. Preserve
the single request owner, independent activity, Core and neutral ABI. No new
request window, second registry, speculative timer or retry machinery.

## Evidence and validation

- [Official TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
  documents terminal_reason, including aborted_streaming/aborted_tools and
  turn_setup_failed/model_error, separately from the optional input UUID.
- Installed CLI 2.1.263 embedded producer code confirms the setup-failure shape,
  overloaded cancellation and examined held-result ordering. This is source
  evidence, not a live capture of all failure interleavings.
- The SDK success result arm permits is_error: true; the installed CLI uses
  that shape for API failures. The old test that treated subtype: success as
  stronger than is_error encoded a parser assumption, not an operator ruling.
  Correct that assumption together with its test and owning knowledge.
- TeamLeader retained an isolated current-RPC replay and a production-provider
  admission reproduction with controlled child processes. Raw evidence remains
  local and must not be committed.
- Add targeted behavioral regressions with real owner code and realistic error
  envelopes. Do not make the error case carry a successful result body merely
  to bypass the guard, and do not weaken the existing cancellation contracts.
- Developer runs scoped Rush build, lint, test and typecheck:tests sequentially.
  TeamLeader checks the complete final diff, replays the confirmed cases, runs
  proportionate full gates and knowledge checks, then commits and pushes PR #384.
  The operator's instruction not to run dynamic-workflow remains in force.
- No merge, release, deployment or GitHub review-comment posting is part of this
  instruction.

## Fresh native API-failure evidence

The TeamLeader ran installed Claude Code 2.1.263 with an isolated configuration
and working directory, a placeholder API key, and a local HTTP server returning
a controlled 401 authentication error. With native retries disabled for the
probe, stdout was queued(A), started(A), result, cancelled(A). The result carried
subtype: success, is_error: true, terminal_reason: api_error, the authentication
failure text and both UUID echo fields identifying A. No cancellation request
was sent. The child exited after stdin closed, and the local server was stopped.

This is real CLI evidence with a controlled API, not a production-service or
provider/Core end-to-end measurement. The initial attempt with default retries
was ended at its 30-second probe deadline after retry events and had no result;
only the subsequent complete capture supports the result/cancelled ordering.
Raw captures and the probe script remain outside the repository.
