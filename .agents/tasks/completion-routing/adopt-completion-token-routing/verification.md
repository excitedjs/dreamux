# Verification

Current work: [Resident-session replacement verification](#resident-session-replacement-verification-2026-09-07).
Earlier gate and live-probe results below certify their stated revisions only.

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

The initial repair at `72af66e5` changed five source files and six test/fixture
files, all in the Claude package. The public lifecycle observation callback remains intact.
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

### Alpha and complexity-review follow-up

PR #384 at `72af66e5` passed all nine GitHub CI checks. The authorized alpha
release succeeded in Actions run 34079076397. Registry metadata and packed
artifacts confirmed Dreamux 0.24.1-alpha.g72af66e58ab3 depends on Claude provider
0.7.0-alpha.g72af66e58ab3; the repaired code was present and a fixed-version CLI
help invocation succeeded. No installed host was upgraded.

An independent Claude complexity review judged the repair lower-entropy with
no mandatory correction. TeamLeader verification confirmed queuedTurnCount has
no consumer beyond its own updates, and that ordinary fixtures currently rely
on missing-start compatibility rather than observed lifecycle ordering. The
public RPC and session callbacks are exported, so deleting command_lifecycle
observation is not proven behavior-neutral by a repository-only consumer search.
The existing pending-request idle timeout remains outside this style cleanup.

The operator subsequently authorized fixing style and redundancy directly.
The task is reopened for that cleanup; its results will be recorded below.

### Cleanup implementation and TeamLeader pre-review

The cleanup removes the unused queued-turn counter, its two update methods and
three calls; the duplicate activity-state argument; an unused private UUID
default; and a result-text temporary whose error case is already handled by a
throw. Private drainage flags now name completed-command and attributed-result
facts. Imports, spacing and comments were aligned without changing policies.

Test cleanup removes a duplicate submissions map, repeated lifecycle types and
helpers, unused harness output and unnecessary async declarations. Ordinary
fixtures emit the observed top-level started lifecycle before init. No-start
plus matching-UUID, no-lifecycle and legacy-envelope cases remain explicit
compatibility coverage; they are not claimed as new native evidence.

The TeamLeader inspected the entire cleanup source and test diff against
`72af66e5`, checked all removed-state/default callers, and reviewed changed test
sequences against the repair contract. This pass found no behavior change or
weakened settlement assertion. The public lifecycle callback, positive UUID
attribution, cancellation/exit handling and existing idle timeout are retained.

The developer's scoped Rush build, lint, test and typecheck:tests passed with
12 test files and 199 cases. The TeamLeader full-workspace build was already up
to date; lint, test and test typechecking passed. Full test took 2 minutes
3.5 seconds with real Codex 0.153.4 enabled. Its warning summaries contain
expected runtime stderr diagnostics.
No additional live CLI probe was run for this behavior-preserving cleanup.

Relative to `72af66e5`, the cleanup touches six source files and five test/fixture
files. Across the complete repair PR, the totals are six source files and seven
test/fixture files: runtime-session.ts adds the redundant-expression cleanup,
and session.test.ts adds the ordinary lifecycle fixture assertion.

### Independent cleanup review and adjudication

The same independent Claude reviewer inspected the complete cleanup against
`72af66e5` and the enclosing repair. It found no behavior change or weakened
contract assertion, and reported two low-priority wording findings. The
operator's explicit instruction to fix style and redundancy covers both.

| Item | Decision | Reason and correction | Operator conflict |
| --- | --- | --- | --- |
| C1: stale stall-fixture comment | Accept | Remove the duplicate claim that the turn never terminates; the file header already explains that the idle deadline ends this synthetic window. | None; comment-only cleanup. |
| C2: five test names describe only compatibility inputs | Accept | Restore each asserted behavior in its title and retain compatibility as a suffix. Keep all test bodies and assertions unchanged. | None; test-title cleanup. |

The reviewer did not run gates or native probes. Its path review confirms the
removed counter, mirrored map, duplicate argument and unused default had no
independent consumers. Public lifecycle observation, UUID-positive attribution,
idle timeout and Core completion-token routing retain their approved behavior.

C1 and C2 are corrected. The TeamLeader checked that the final pass removed one
stale comment and changed five test titles; test bodies and assertions remain
unchanged, and no exact-title selector dependency was found. No accepted
finding remains unresolved. Full suites were not repeated for these wording-only
edits; git diff --check passed and the mandatory commit hook still checks the
staged TypeScript and public-content boundary.

Knowledge closeout retains the existing product/provider contracts and records
the cleanup in this task's requirement, solution and verification. No new domain,
configuration, persisted-state, maintenance or routing contract is introduced.
The already published alpha remains tied to `72af66e5`; this cleanup updates the
existing PR without republishing or upgrading an installed host.

## External review and corrected evidence (2026-09-07)

Eight external PR comments on `6acc6d28` were inspected, followed by an
independent Fable review against official SDK documentation, the installed
Claude Code 2.1.263 schema, existing native captures, Core routing and Channel
display. This was read-only: no GitHub replies or code corrections were made.
The operator subsequently approved the replacement below, so the old window's
branches are not a preservation requirement or a patch checklist.

The corrected evidence, rather than the reviewer's initial report, is retained:

- Task-notification results in the observed background fold omit both UUID
  echo fields while answering explicit steers. Origin and UUID-only routing
  cannot implement that observed case. The public SDK describes omissions for
  synthetic turns; the installed CLI marks command lifecycle as internal.
- The baseline before PR #384 did not call `discard` on cancellation. Clearing
  resident text for any cancelled UUID was introduced in this PR. An external
  queued-command cancellation may therefore clear another turn's cached text.
  That exact external-control sequence has not been probed. Dreamux does not
  itself send that control request, but this is not proof of unreachability
  through its optional Remote Control surface.
- Feishu operator input immediately opens a receipt card. A later unbound
  native end can close it before the queued request begins; subsequent activity
  opens a new card. This is consistent with the recorded activity/card model,
  not evidence for adding submission or origin gates to native end events.
- Official task-notification documentation describes ordinary background Bash,
  Monitor, subagent and automatically backgrounded MCP completion. Exceptional
  foreground tool-result ordering after a result remains unproven. If a late
  tool result loses its cached metadata, the current display still emits it
  with a generic name and null arguments; settlement is a separate concern.
- UUID-less interrupt artifacts were observed on 2.1.231 for an explicit
  cancelled input. Newer error-UUID echo documentation cannot be applied
  retroactively. The corresponding 2.1.263 interruption ordering has not been
  measured; the comments' proposed later second result is not established by
  the available captures.

The old capability tri-state mutation and unknown-state admission guard were
identified as avoidable compatibility changes. The replacement must implement
native admission coherently; it need not preserve those branches or reapply
their suggested edits mechanically. The exported session seam is now explicitly
in the approved replacement boundary, with a breaking extension note required.

Sources: [official TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[official headless documentation](https://code.claude.com/docs/en/headless),
installed CLI schema and private native captures. Raw captures are not committed.

## Resident-session replacement verification (2026-09-07)

- Baseline: `6acc6d28`; PR base remains `2575e056`.
- Development approval and the superseded model are recorded in [rulings](rulings.md).
- Current solution: [resident-session input and settlement](technical-design/session-submissions.md).
- Implementation and TeamLeader pre-review: complete. The current replacement
  uses one unanswered-request table in RPC and no aggregate execution-window
  promise, drainage gate, runtime queue or initial/steer execution split.
- Scoped developer gates passed: 12 test files, 205 cases. The TeamLeader then
  ran full-workspace Rush build, lint, test and typecheck:tests sequentially; all
  passed. Test warnings were expected stderr from exercised failure paths. The
  real Codex integration tests also ran; no live-skip variable was used.
- Existing pure/fold/queue native captures replayed through the replacement RPC
  successfully. This is producer-trace replay, distinct from the fresh live
  measurements below.
- Independent workflow review: not started and omitted at the operator's
  14:35 instruction; see [ruling R3](rulings.md#r3-publish-the-pr-link-and-omit-the-workflow-review).
  Earlier review conclusions certify their original revisions, not this rewrite.

### Fresh real-provider/Core measurements

Claude Code 2.1.263 ran in three isolated resident sessions with the production
provider and real Core completion-delivery policy. The recipient was in memory;
no production chat or running agent was used. Each scenario accepted a final
ordinary input through the same process and then stopped cleanly.

| Scenario | Native results / native ends | Delivered completions | Result |
| --- | --- | --- | --- |
| Pure background follow-up | 3 / 3 | 2: initial and subsequent input | Background result settled no request and caused no extra delivery. |
| Background plus two folded steers | 3 / 3 | 3: initial, shared steer answer, subsequent input | Both steer submissions shared the same completion object; recipient received it once. |
| Background plus queued input | 4 / 4 | 3: initial, queued answer, subsequent input | The queued request received its own answer, not the earlier background result. |

Private raw stdout, protocol-event captures and reports were retained separately
from the earlier repair evidence. They are not committed. These measurements
prove the observed scenarios, not all possible interruption or tool-result orders.

### Structural and capability account

Replacement relative to `6acc6d28`: nine source paths (six modified, one added,
two deleted) and six test paths. The complete PR relative to `2575e056` changes
ten source paths (seven modified, one added, two deleted) and eight test/fixture
paths. The package's source file count changes from 29 to 28.

| Source | Responsibility and reason |
| --- | --- |
| `rpc.ts` | One request table, native admission, observed consumption and direct per-request settlement; deletes `PendingTurn` and aggregate drainage. |
| `runtime.ts` | Resident session, persisted identity/status and stop/admission convergence; deletes request-window queue/readiness and group cleanup. |
| `runtime-session.ts` | Create one immutable completion, validating pinned identity and structured output, before sharing it with answered requests. |
| `runtime-activity.ts` (added) | Preserve the independent native activity projection from the deleted settlement module. |
| `runtime-submissions.ts` (deleted) | Remove `ActiveTurn`, the second request registry and runtime-side settlement ownership. |
| `admission-classify.ts` (deleted) | Remove error classification tied to the deleted steer-only path. |
| `supervisor.ts` | Forward unified submission and propagate actual child-exit/idle failure causes. |
| `types.ts` | Replace the Claude-specific window extension seam with submission admission and settlement; retain native observation callbacks. |
| `stream.ts` | Earlier PR repair retained resident aggregation reset boundaries and corrected UUID semantics; unchanged by this replacement. |
| `config.ts` | Remove the stale queue comment; configuration and timeout policy are unchanged. |

| Preserved capability | Current owner and evidence |
| --- | --- |
| Parent completion routing | Unchanged Core policy; fresh live probes check delivery counts and shared identity. |
| Fold, queue, early result, identical text | RPC regressions assert observed settlements and object identity; background tests run actual runtime plus RPC. |
| Cancellation and subsequent input | RPC/background regressions distinguish queued cancellation from consumed work, clear cancelled text and preserve unrelated requests. |
| Stop and process failure | Runtime/supervisor regressions cover pending admission, early exit, state-write failure and late callback suppression. |
| Native display events | Activity tests preserve text/tool filtering and one end per result independently of requests; cancellation reports its interrupted boundary. |
| Continuity, state fencing, MCP, skills, config, Remote Control, cold reads, structured output | Existing owners retained; source/caller review plus corresponding package suites and full test typecheck passed. |

Test changes were reviewed against the retained product contract and new session
seam. Refusal/discard fails its own request immediately, cancellation stops its
own request, and first input waits for native admission just like subsequent
input. No replacement test requires aggregate terminal drainage. Compatibility
fixtures remain labeled as such; they are not claimed as current native traces.

### Remaining evidence boundaries

- `command_lifecycle` is an internal CLI seam, not a stable documented SDK
  contract. Real background folds require consumption evidence because the
  observed result omits both UUID echo fields.
- Missing-start plus matching-UUID sequences retain deterministic compatibility
  coverage. No observed lifecycle-capable prompt lacks both consumption
  evidence and matching result UUID; the implementation does not guess owners.
- Cancellation/Remote Control interleaving and exceptional tool-result order
  have no fresh live probe. Their regression tests do not close that evidence gap.
- Genuine outstanding-request idle failure still reaps the process at the
  configured deadline. Pure background work with no pending request has no timer.
- PR CI is a separate delivery gate; local success does not claim remote CI.
