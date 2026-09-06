# Verification

## Implementation (single developer, code only)

- Build: `rush update` then `rush build --to @excitedjs/dreamux --to
  @excitedjs/agent-runtime-claude-code --to @excitedjs/agent-runtime-codex` —
  passed (8 packages).
- Lint: affected packages — passed. `git diff --check` — passed.
- Internal-identifier and forbidden-path scan — clean.
- Unit suites and test typecheck intentionally not run at this stage: subject
  tests were deleted in step 2 and retained consumer suites do not compile
  until the shared helpers are restored by the re-coverage stage.

## TeamLeader pre-review

- Scope containment: the source diff touches only the approved boundary (24
  files across dreamux-types, dreamux core, agent-runtime/claude-code,
  agent-runtime/codex); with test re-coverage, change files, and knowledge
  updates the full PR is larger but stays inside the approved surfaces.
- The implementation realizes every element of the approved architecture:
  submission handles, result-time completion tokens, router keyed by
  producer/token/recipient, close drainage with zero-completion stops, and the
  Last-boundary fix.

## Design notes recorded during review

1. `dreamux-types/src/index.ts` exports only the runtime-contract surface; no
   channel telemetry types are introduced (non-goal).
2. `team-service` / `teammate-collection` deliver completions through
   `deliverRuntime` with no conversation-projection wiring (non-goal).
3. `teammate-service/index.ts` creates the coordinator first and hands it the
   activity sink, preserving the existing `name()` seam.
4. `turn-coordinator.ts`: token settlement, admission, and close drainage as
   designed; the activity sink is a type-safe no-op receiver until the channel
   telemetry task lands.
5. `turn-recording.ts` initially carried a diagnostic per-turn id referenced by
   the stop-drain error message. Reviewed explicitly (no routing or dedup
   role); the operator decided on 2026-08-25 to drop it for this round because
   nothing in this repository consumes it yet — the stop error reports only the
   unsettled count and entity name. It can return with the channel telemetry
   task, which needs a per-turn grouping key.
6. `claude-code/src/runtime-submissions.ts` reports submission lifecycle only;
   tool-action display reporting is deferred to the channel telemetry task.

## Independent review adjudication

- Two read-only seats (fable, codex) ran independently against the approved
  architecture and the acceptance matrix. No blocker. Both examined the
  diagnostic turn id (design note 5); the operator later dropped it for this
  round. The four `BREAKING: Review:` change files are committed and
  `rush change --verify` passes.

## Batch test re-coverage

- Complete. All four packages green: dreamux 1082 passed / 4 legitimately
  skipped (independently re-run by the TeamLeader), claude-code 158/158,
  codex 136/136, dreamux-types 31/31. Retained dissolve/collaboration consumer
  suites pass unchanged once the shared helpers were restored.
- Also fixed: claude-code and codex `tsconfig.tests.json` had inherited an
  exclude that silently dropped `tests/` from the checked program; both now
  include their test programs and expose a `typecheck:tests` script.

## PR review round (PR #344)

- External review confirmed the token model and layering; one blocker and four
  minors, all verified and dispositioned:
  1. Blocker (real): the re-covered issue #63 live gate had lost its reaction
     tri-state assertions. Restored the `[received] -> [in progress] ->
     removed` assertions and emoji imports; the gate was executed live against
     a real codex install and passes, proving the channel reaction lifecycle
     is unchanged by this PR.
  2. Docs still naming the retired settlement object (package READMEs,
     provider-runtime and dispatcher-orchestration domains): updated to the
     submission/completion model in the same PR.
  3. This file's stale pre-re-coverage statements: refreshed.
  4. Missing `typecheck:tests` scripts in the two runtime packages: added.
  5. Two codex turn-manager nits (terminal-order entry after `failRecord`;
     dropped deferred on ambiguous `turn/start`) are recorded as known
     non-blocking follow-ups: `stop()` backstops the first and the second
     leaks nothing; both are left unchanged here to avoid untested hot-path
     churn.

## Background-turn repair verification (2026-09-07)

- Baseline: `48882651`; integration target: `next`.
- Bootstrap: `node common/scripts/install-run-rush.js update` passed.
- Native protocol probe: Claude Code 2.1.263, isolated resident stream-json
  process, real background Bash completion, two explicit inputs injected during
  a foreground tool call in its follow-up turn. Both inputs emitted queued,
  started, and completed lifecycle states before the shared result. The result
  retained `origin.kind = task-notification`, omitted user_message_uuid, and
  contained both requested output markers. A subsequent ordinary request
  completed in the same process. The probe closed stdin and exited cleanly.
- This proves origin cannot veto a started request group and confirms
  completed-before-result ordering. The initial ordinary input emitted started
  before init. An earlier reading missed that ordering; UUID matching without
  started remains compatibility coverage, not an observation from this probe.
- Isolated replay against the previously installed adapter demonstrated the
  foreign-UUID reap and queued-only fallback defects. Reap was a spy; no real
  process was terminated by that replay.
- At this initial-probe stage, repaired-provider verification had not run. Its
  completed results are recorded below. Raw local traces are not committed.

- Additional native 2.1.263 probes passed: a pure background follow-up completed
  and accepted a later input in the same process; a late explicit input emitted
  queued, then the prior background result arrived, then the input emitted
  started and received its own result. Both processes exited cleanly after the
  final follow-up. These are native protocol probes, not yet repaired-provider
  or Core end-to-end results.

- First implementation pre-review: five source files and six test/fixture files.
  Developer reported scoped build/lint/test/typecheck:tests passing (179 tests).
  TeamLeader found that the global lifecycle-observed/single-command fallback
  incorrectly excludes an initial UUID-matched result when another request is
  queued or refused. Added started frames in old tests masked that case. Returned
  to the same writer to restore those sequences and use positive UUID evidence
  without reinstating the foreign-UUID veto.
- The new command-group field changes the exported Claude-specific session
  callback, not the neutral AgentRuntime ABI. A breaking package release note
  will accurately describe this extension-seam impact.

### Repaired-provider pre-review

- Rebased onto `2575e056` from `origin/next`; the baseline card-spacing commit
  was already present upstream and was dropped by rebase. No manual conflicts.
- Corrected pre-review finding: restored the original no-start sequences and
  added positive UUID matching alongside the started group. Developer scoped
  build/lint/test/typecheck:tests passed: 12 files, 183 tests.
- Full Rush build, lint, test and typecheck:tests passed after rebase. Full test
  included real Codex 0.153.4 integration; no live-test skip flag was set.
  Initial simultaneous Rush commands were refused by its repository lock,
  then rerun sequentially.
- Live repaired provider plus actual Core CompletionDeliveryPolicy passed on
  Claude Code 2.1.263 in three isolated resident processes:
  - pure background: three native results, only the initial and subsequent
    explicit requests delivered (two deliveries); background activity/end seen;
  - folded B/C: both submissions shared the same completion object; three native
    results and three deliveries including initial and subsequent requests;
  - queued B: four native results, three deliveries; background result excluded
    and B received its own result, followed by the subsequent request.
- Every mode used exactly one resident PID throughout the scenario and accepted
  a subsequent request. All probe processes exited successfully after explicit
  test cleanup. Cleanup stops just after the final settlement and can log the
  existing stop-before-command-drain diagnostic; it did not alter settlements.
- These probes use real native subprocesses and the production provider/router,
  with an in-memory recipient to count automatic delivery; they do not deploy
  the change into an existing Dreamux host or send test messages to a chat.

### Independent review and TeamLeader adjudication

The complete staged repair was reviewed at xhigh against `2575e056`, including
source, tests, owning knowledge, package documentation and the release note.
Seven finders and nineteen verifier seats completed without workflow failures;
all eleven reported candidates are adjudicated below. The existing operator
authorization to repair background turns and open a PR covers these corrections.
They retain submission-based routing and introduce no origin filter.

| Item | Decision | Reason and correction |
| --- | --- | --- |
| R1: cancelled text survives without a result | Accept | Discard aggregate text at the cancelled native boundary, including when another input remains queued in the same window. Preserve session identity and other running members. |
| R2: background process exit lacks a native end | Accept | Publish the missing failed end using existing session ownership; retain the active request failure path without duplicate ends. |
| R3: owning settlement section contradicts repair | Accept | Rewrite the current owning section around positive UUID evidence, started command groups and attributed-result drainage. |
| R4: requirement still says native validation is pending | Accept | Link the completed provider/Core probes and correct the initial started observation. |
| R5: legacy fallback overrides a foreign UUID | Accept with evidence limit | Keep absent-UUID legacy compatibility, but do not override an explicitly foreign UUID. The mechanism is demonstrable; that legacy native ordering has not been reproduced. |
| R6: lifecycle input lacks both started and result UUID | Reject as unproven | No complete native trace establishes this combination. Restoring sole-pending attribution would consume known queued background results. |
| R7: protocol callbacks continue after stop | Accept narrowly | Suppress late callbacks using the existing stopped flag. Outer Team or Channel closure may close a reopened card, so a permanent card hang is not claimed for every teardown. |
| R8: old fixture models the double omission | Reject as native proof | A synthetic fixture is not evidence of a supported producer sequence. Keep no-start plus matching-UUID compatibility coverage and the approved removal of ambiguous fallback. |
| R9: initial no-start command omitted from a shared result | Reject as unproven | The premise combined different versions and an incorrect probe reading. A new initial A plus steers B/C probe observed started for all three and one result naming A. |
| R10: later no-start command drains before its own result | Reject as unproven | The required combined native ordering has not been observed. Do not add another attribution ledger or infer group members without evidence. |
| R11: historical COT task retains fail-loud guidance | Accept as knowledge correction | Preserve historical quotes and append dated supersession links to this repair. |

For R6/R8/R9/R10, future raw traces can reopen the decision; successful probes
on one version do not establish an all-version guarantee. In the hypothetical
partial-settlement cases, Core sends a stopped notification, not zero delivery.

The raw native traces were rechecked during review: all four initial inputs
emitted started before init and before their first result. The added initial
A plus B/C fold probe also accepted a subsequent input in the same process and
exited cleanly. Private raw logs and runtime identifiers remain uncommitted.

Adjacent source comments will be aligned with resident aggregation. The public
RPC command_lifecycle observation callback is retained: absence of an internal
runtime consumer does not authorize removal of an exported capability. No
additional origin state, mirror ledger or public pending-query API is needed.

### Accepted corrections and final pre-review

R1, R2, R5 and R7 are implemented with no extra attribution ledger. The
aggregator's discard capability retains session identity and leaves the existing
no-result takeOutcome behavior intact. Cancellation clears unfinished content
without removing other started submissions. Background exit uses the existing
active session ownership; stop uses the existing stopped flag. Legacy UUID-less
input remains supported, while a foreign UUID does not consume it.

The TeamLeader inspected the complete final source/test change against HEAD,
including rewritten assertions and the preserved fold/queue/interruption
contracts. New tests cover cancellation with no result across and within a
window, surviving started members, queued refusal/discard, unbound exit, active
exit without duplicate end, admission before session ownership, and callbacks
after stop. Scoped build, lint, test and typecheck:tests passed: 12 test files,
199 cases. A subsequent class-comment correction changed no executable code.

R3, R4 and R11 are corrected in the owning settlement section, current
requirement/verification and dated historical COT annotations. The package
README also now distinguishes immediate result settlement from request drainage
and names Core as source-deduplication owner.

The final repair changes five source files and six test/fixture files, all in
the Claude package. The public lifecycle observation callback remains intact.
No existing host was upgraded and no raw native traces were committed. The
three earlier repaired-provider/Core live probes remain evidence for native
background/fold/queue behavior; the cancellation/exit corrections were verified
by deterministic provider/RPC regressions, not additional live probes.

Final full-workspace Rush build, lint, test and typecheck:tests passed. The full
test completed in 2 minutes 13.7 seconds with real Codex 0.153.4 enabled; its
SUCCESS WITH WARNINGS summaries contain expected runtime stderr diagnostics.
Build was refreshed after the comment-only correction. No accepted review
finding remains unresolved.

Knowledge closeout passed: task-record check, KB links/reachability (167 files),
git diff --check, and the internal-content tree scan. The task is done for PR
handoff; merge and deployment require separate operator authority.
