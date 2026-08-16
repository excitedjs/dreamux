# Verification

## Current Native-Transcript Iteration

### Scope

- Requirement SHA-256:
  `e44f6411914cd1ff5ea49c55f09bbae17ad162f62335123f43d89ea0405208d0`
- Approved solution SHA-256:
  `157cb2602c2986d7877ab34085be6b7401c33c5778f9657ec85f4c866c05f300`
- Baseline `next` commit:
  `3b74f9bc59437cd234047473321a131658295126`
- Review target: the complete branch and working-tree change, including every
  tracked modification and every untracked file present when the workflow
  scope was resolved.
- TeamLeader pre-review completed after one implementation writer and one
  remediation turn. The independent implementation review and its accepted
  remediation are complete.

### TeamLeader Pre-Review

The TeamLeader inspected the complete implementation and the relevant upstream
Codex and Claude Code native-storage sources. The initial developer delivery
passed its own package checks, but TeamLeader pre-review returned five
root-cause groups to the same sole writer:

1. **Native path authority and file confinement.** Claude long-path hashing,
   relative config-home resolution, prospective symlink confinement, existing
   transcript session evidence, and both built-ins' open-after-validation
   TOCTOU handling needed to match the native owners precisely.
2. **Claude native conversation reconstruction.** Parallel tool activity is a
   DAG, not a single parent chain, and a completed turn requires native
   `turn_duration` evidence rather than mere assistant output. Open tool tails
   must remain invisible.
3. **Codex lineage and cursor correctness.** `history_base.thread_id` denotes a
   rollout id after revert and can differ from the stable thread id. Active and
   archived candidates, nested reverted lineage, compressed relocation, and
   strictly older continuation positions needed independent proof.
4. **Bounded reads and public errors.** Discovery, metadata records, rewrite
   scans, boundary records, malformed cursors, provider exceptions, and
   unreadable paths needed deterministic bounds and fixed path-free public
   mappings.
5. **Runtime-session checkpoint transactions.** Fresh and resumed Claude/Codex
   associations must publish only after native startup/path validation and one
   atomic checkpoint write; failure must preserve the old association and prove
   child/process teardown.

The same writer repaired all five groups. The TeamLeader then re-read the final
implementation and focused fixtures. The final code uses provider-owned
no-follow opened-file handles with identity revalidation, native session
evidence, bounded discovery and parsing, append-stable rewrite evidence,
realistic Claude DAG/completion fixtures, rollout-id-aware Codex lineage, and
checkpoint-before-admission transactions. No remaining pre-review blocker was
found.

### TeamLeader Commands And Results

Focused deterministic suites:

- Claude transcript and runtime-activity:
  - `2` files, `43` tests passed.
- Codex transcript and runtime-output-schema:
  - `2` files, `38` tests passed.
- Dreamux transcript/admin/MCP/read/lifecycle:
  - `5` files, `152` tests passed.

Repository gates:

- `node common/scripts/install-run-rush.js build`
  - Passed; all projects were already up to date.
- `node common/scripts/install-run-rush.js typecheck`
  - Passed for every package defining work.
- `node common/scripts/install-run-rush.js typecheck:tests`
  - Passed for every package defining test typecheck.
- `node common/scripts/install-run-rush.js lint`
  - Passed for every package defining work.
- `CI=true DREAMUX_RUN_LIVE_MODEL_GATE=0 node common/scripts/install-run-rush.js test`
  - Passed.
  - `dreamux-types`: `26` passed.
  - `dreamux-utils`: `16` passed.
  - `agent-runtime-claude-code`: `106` passed.
  - `agent-runtime-codex`: `117` passed.
  - `feishu-channel`: `274` passed.
  - `dreamux`: `1052` passed, `5` skipped.
- `node common/scripts/install-run-rush.js change --verify --no-fetch`
  - Exited successfully.
  - Rush emitted the existing warning that no baseline remote URL is declared
    and named `origin/main`; no fetch was attempted.
- `python3 .agents/skills/dev-workflow/scripts/init_task.py check --domain workflow --slug unified-teammate-lifecycle`
  - Passed.
- `.agents/scripts/check.sh`
  - Passed: `KB OK (119 files reachable from root.md)`.
- `git diff --check`
  - Passed.

### Independent Implementation Review

One new non-Codex `xhigh` code-review workflow reviewed the complete workspace:

- Run: `run-5c6e0b04-59c4-467a-b794-58568e695e93`
- Coverage: complete; no failed finder, failed verifier location, or partial
  coverage.
- Finders: `7`.
- Candidates: `32`.
- Independently verified: `32`.
- Refuted candidates: `13`.
- Primary reported findings after root-cause merging: `14`.

TeamLeader adjudication accepted eight findings:

1. bound Claude resident source-id deduplication while retaining pending
   single-flight and accepted/ambiguous duplicate semantics;
2. make concurrent Claude skill materialization converge on a valid
   `EEXIST`/`ENOTEMPTY` winner and fail loud on a malformed winner;
3. replace single-call positional transcript reads with bounded exact reads for
   Claude metadata/windows and Codex uncompressed windows;
4. apply the collection role/team predicate to roster-backed `list` and
   `history`, not only targeted reads;
5. map only `AgentTranscriptReadError` through the fixed transcript public-error
   table so ordinary TeamMate domain errors retain their normal diagnostics;
6. validate the public provider `readTranscript()` `turns` input as an integer
   in `1..50` at both built-in boundaries;
7. replace locale-dependent Claude parallel-branch ordering with deterministic
   code-unit ordering;
8. single-source neutral transcript digest, digest validation, discovery
   budget, exact positional read, and path-containment primitives in
   `@excitedjs/dreamux-utils`.

TeamLeader rejected six findings:

1. Early unlock after a sibling close failure contradicts the frozen invariant
   that close failure leaves the Workflow non-terminal, fully locked, and
   retryable.
2. Swallowing process-group `EPERM` would falsely claim termination and weaken
   the approved bounded KILL proof.
3. Changing Team-scoped read handles to bypass `TeamService` would move the
   existing Team generation/read-lease boundary and was not a transcript-reader
   entity/runtime materialization regression.
4. Reserving a corrupt TeamLeader name from a second state source is an
   existing corrupt-state authority decision, not a safe incidental change for
   this task.
5. Reclassifying late Agent exceptions after a Workflow terminal request is a
   diagnostic preference; it did not prove an incorrect external outcome and
   would let late work challenge the selected terminal intent.
6. Reintroducing shutdown-only terminal-delivery discard would restore the
   second lifecycle path that the approved truthful stop pipeline removes.

No rejected finding was implemented.

### Accepted-Finding Remediation

The same sole writer repaired all eight accepted findings without changing
`.agents/**`, committing, pushing, or changing GitHub state. TeamLeader
inspected the resulting source and regression tests.

Focused TeamLeader reruns:

- Claude runtime, skill materializer, and transcript: `3` files, `52` tests
  passed.
- Codex transcript: `1` file, `25` tests passed.
- Dreamux Utils: `1` file, `20` tests passed.
- Dreamux collection/admin/MCP transcript paths: `3` files, `92` tests passed.

Final repository gates:

- `node common/scripts/install-run-rush.js build`
  - Passed; all projects were up to date.
- `node common/scripts/install-run-rush.js typecheck`
  - Passed for every package defining work.
- `node common/scripts/install-run-rush.js typecheck:tests`
  - Passed for every package defining test typecheck.
- `node common/scripts/install-run-rush.js lint`
  - Passed for every package defining work.
- `CI=true DREAMUX_RUN_LIVE_MODEL_GATE=0 node common/scripts/install-run-rush.js test`
  - Passed with exit code `0`.
  - The warning output is from intentional failure/stop/restart-path tests.
  - The two real-model Codex cases used the repository's existing CI skip
    policy; no load-bearing test assertion was weakened.
- `node common/scripts/install-run-rush.js change --verify --no-fetch`
  - Passed with the existing baseline-remote warning.
- `python3 .agents/skills/dev-workflow/scripts/init_task.py check --domain workflow --slug unified-teammate-lifecycle`
  - Passed.
- `.agents/scripts/check.sh`
  - Passed: `KB OK (119 files reachable from root.md)`.
- `git diff --check`
  - Passed.

Post-remediation static checks also found:

- no direct `FileHandle.read()` remains in either built-in transcript module;
- no locale-dependent comparison remains in Claude transcript reconstruction;
- both providers consume the shared neutral transcript primitives;
- repository artifacts and added lines contain zero prohibited-family matches;
- the frozen requirement and solution SHA-256 values remain exact.

### PR CI Canonical-Path Correction

PR #338 first ran against commit
`c5802be4fdb3ba3a37c1a3ad892bcd0c0de6c840`. Ubuntu Rush and every
non-Rush gate passed. The macOS Rush test job exposed four test-only
lexical-path assumptions:

- three Claude transcript assertions expected a temporary path under
  `/var/...`, while the product correctly returned its canonical realpath;
- one Codex prospective thread-path assertion made the same lexical-versus-
  canonical comparison.

The product implementation was unchanged. The two provider transcript test
files now compute canonical expected paths with `realpath()`, preserving root
confinement, native session evidence, and TOCTOU checks. The Codex oracle keeps
its independence from product path builders by appending
`relative(configuredRoot, path)` to the canonical configured root.

TeamLeader pre-review after the CI correction:

- Claude transcript: `33/33` passed.
- Claude package: typecheck and lint passed; `115/115` tests passed.
- Codex transcript: `25/25` passed.
- Codex package: typecheck and lint passed; `122/122` tests passed.
- `git diff --check` and frozen-hash verification passed.

Because CI feedback changed repository tests, the correction received a new
non-Codex `xhigh` implementation review:

- Run: `run-994e9dd0-535d-4e8b-8a95-91e823168b19`
- Scope: only the two uncommitted provider transcript test files.
- Coverage: complete; `7/7` finders, no failed verifier location, no partial
  coverage.
- Candidates: `2`, both verified at one source location.
- Correctness blockers: none.
- Reported finding: one confirmed cleanup item asking the Codex expected path
  to reuse the test's already-constructed relative tail instead of duplicating
  the date/filename layout.

The TeamLeader accepted that cleanup finding. The same sole writer applied it
without changing product code or `.agents/**`; the Codex focused, typecheck,
lint, full-package, and diff checks passed again. No accepted finding remains
unresolved.

### Architecture, Deletion, And Publication Gates

Repo-wide product-source searches found no remaining:

- Dreamux Turn archive store, path builder, record type, validator, append,
  preflight, or archive-gated settlement/delivery code;
- rolling identity conversation field or preview projection;
- runtime `getLast()` / `lastResult` history source;
- public/service/persisted Turn id or submission id;
- Channel Turn submitted/settled event type, publisher, or subscriber;
- Claude synthetic Turn counter/id implementation;
- legacy `checkpoint_id` contract.

`transcript_path` is present only in the direct TeamMate `spawn` / `send`
receipt types, service projections, and MCP receipt schema/projector.
`transcript_locator` remains the private runtime checkpoint field. List,
status, history, `last`, Workflow, Team, Channel, completion delivery, core
events, and public error projections contain neither path.

Using the out-of-repository prohibited-family token set, the following exact
counts were all zero:

- tracked repository artifacts;
- untracked repository artifacts;
- added task-diff lines;
- current task commit messages;
- Issue #337 title/body/comments;
- PR #338 title/body/comments/reviews/public head ref.

Added-line scans for private registry/domain markers, machine-local paths, real
Feishu ids, and common credential token shapes were also zero.

### Live Gates And Known Limitations

The implementation writer ran the live gates after the final remediation:

- Claude Code `2.1.228`: `3/3` live tests passed.
- Codex `0.147.0`: `5/7` live tests passed.
  - The structured-output model turn timed out after repeated external service
    reconnects; native app-server `turn/start` reported no local protocol
    failure.
  - The mid-turn injection gate timed out waiting for the external model to
    begin command execution after MCP readiness and user-message submission.

The TeamLeader's deterministic full run used the repository's existing
`DREAMUX_RUN_LIVE_MODEL_GATE=0` policy and did not reinterpret those two
external model-service failures as local implementation failures.

`gitleaks` is unavailable locally and network attempts to obtain the pinned
binary are not reliable in this environment. The repository-artifact,
added-line, publication-surface, and targeted credential scans above passed,
but CI must still run the canonical gitleaks gate.

Rush `5.140.0` warns that Node `22.16.0` is outside its tested-version list.
Every executed Rush command otherwise completed successfully.

### Knowledge Closeout

The approved requirement and solution still cover the final implementation;
the accepted review corrections strengthen boundedness, determinism, neutral
utility ownership, and public-error fidelity without changing the product
contract.

Updated current knowledge owners:

- [Current architecture](/.agents/reference/current-architecture.md)
- [Repo structure](/.agents/reference/repo-structure.md)
- [Service topology](/.agents/reference/service-topology.md)
- [Provider runtime](/.agents/domains/provider-runtime.md)
- [Dispatcher orchestration](/.agents/domains/dispatcher-orchestration.md)
- [State, config, and files](/.agents/domains/state-config-and-files.md)
- [State and paths](/.agents/reference/state-and-paths.md)
- [Channel runtime](/.agents/reference/channel-runtime.md)
- [Entity-owned TeamMate lifecycle and object Turns](/.agents/decisions/entity-owned-teammate-lifecycle-and-object-turns.md)
- [Provider architecture realignment](/.agents/decisions/provider-architecture-realignment.md)
- bundled maintenance
  `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md`

The shared transcript primitives are current package-boundary facts in
`@excitedjs/dreamux-utils`; provider-native schemas, locators, cursor envelopes,
and typed provider errors remain in their owning runtime packages. No new
decision record is required because this is the approved neutral-provider
boundary applied consistently rather than a new architectural choice.

Residual delivery gates:

- PR #338 must be replaced with the reviewed workspace and pass normal CI.
- Canonical gitleaks remains required in CI because the pinned binary was not
  available locally.
- The two real-model Codex gates require a healthy external model service; the
  local protocol/app-server prerequisites passed as recorded above.

## Superseded Strict-Archive Iteration Evidence

The sections below are preserved as historical verification for the previous
strict Dreamux `turn.jsonl` iteration. They do not verify the current approved
native-transcript implementation and must not be used as its review gate.

## Scope

- Requirement SHA-256:
  `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`
- Approved solution SHA-256:
  `ab3e27fbc6e6c46f4ae12ab60cc616b22b7a746bd9a62eb1f653024c9fb97e6d`
- Review target: the complete current working-tree change, including tracked
  and untracked implementation files.
- TeamLeader pre-review completed at `2026-08-16T04:48:47+08:00`.

## TeamLeader Pre-Review

The complete implementation was inspected across the neutral runtime seam,
Codex and Claude providers, TeamMate entity and collection ownership, Turn
persistence and delivery, Workflow terminalization, Team dissolve, Server
shutdown, public MCP/Channel contracts, tests, documentation, and Rush change
files.

Four correctness blockers found during pre-review were returned to the same
single developer and then re-reviewed:

1. Workflow runner termination-proof failure initially skipped member TeamMate
   close. Finalization now retains the runner failure while still joining
   materialization and closing every member; it cannot persist terminal or
   unlock until runner termination is proved.
2. A runtime-free close persistence failure initially projected the stale
   durable `running` state. Live entity reads now expose a non-running effective
   state without falsifying durable `closed`.
3. Fresh Workflow creation initially exposed a durable-identity-to-cache window
   in which public send could construct a second unlocked entity. Fresh creation
   and ordinary materialization now share the Collection's per-name canonical
   single-flight, with lock acquisition before cache publication.
4. Automatic Turn terminal persistence failure was initially swallowed and
   could leave a permanent persistence barrier while admitting later work. The
   failure now rejects the concrete Turn, fences entity admission, drives
   Workflow failure, remains visible in live reads, and is retried by the same
   entity close without duplicating the terminal row or delivery.

A final provider review found a Claude live-steer capability handshake race.
Capability-unknown steers now wait on the resident-session capability decision;
supported waiters flush in FIFO order, unsupported waiters fail without a native
write, and stop/exit/timeout releases them without a late write.

After these corrections, the TeamLeader found no remaining in-scope
architecture or correctness blocker.

## Commands and Results

### Repository and Static Gates

- `node common/scripts/install-run-rush.js update`
  - Passed.
  - No lockfile or dependency drift was introduced.
- `node common/scripts/install-run-rush.js build`
  - Passed.
- `node common/scripts/install-run-rush.js typecheck`
  - Passed for all seven packages with work; `@excitedjs/eslint-config` had no
    operation.
- `node common/scripts/install-run-rush.js typecheck:tests`
  - Passed for `dreamux-types`, `dreamux-utils`, `feishu-channel`, and
    `dreamux`; the other packages define no test-typecheck command.
- `node common/scripts/install-run-rush.js lint`
  - Passed for all seven packages with work.
- `node common/scripts/install-run-rush.js change --verify`
  - Passed.
- `git diff --check`
  - Passed.
- `python3 .agents/skills/dev-workflow/scripts/init_task.py check --domain workflow --slug unified-teammate-lifecycle`
  - Passed.

### Tests

- `node common/scripts/install-run-rush.js test`
  - All deterministic and provider-package suites passed.
  - Two real-model Codex gates failed:
    - portable structured output timed out after Codex reported
      `Reconnecting... 2/5` through `5/5`;
    - the issue #63 model/tool gate did not start command execution within its
      live timeout.
  - Result: `996 passed`, `2 failed`, `3 skipped`.
- The same full Dreamux suite was run a second time with real-model gates
  enabled.
  - The same two model-dependent cases failed at the same external model stage.
  - No local type, protocol, state-machine, or deterministic test failed.
- `env -u DREAMUX_RUN_LIVE_MODEL_GATE CI=true node ../../common/scripts/install-run-rushx.js test`
  from `packages/dreamux`
  - Passed: `88` files, `996` tests passed, `5` skipped.
  - The real Codex app-server binary, initialization handshake, thread start,
    and official Feishu MCP injection gates ran and passed.
  - The two Codex model/auth/network-dependent gates were skipped by the
    repository's existing CI policy.
  - The real Claude model turn remained opt-in and was skipped; the built-server
    Claude MCP handshake passed.
  - Two pre-existing `global-config` TODO #209 tests remained statically skipped.

### Architecture and Public-Surface Audits

Repo-wide searches confirmed:

- no product `OwnedTeammate*`, `spawnOwned`, `releaseAllOwned`,
  `releaseExclusive`, or `exclusivelyOwned`;
- no separate claims registry, public command adapter, or Workflow TeamMate
  lifecycle port;
- no service/public/persisted `turn_id`, `turnId`, `submission_id`, or Claude
  synthetic Turn ID;
- provider-native IDs remain confined to their provider packages;
- no Channel Turn submitted/settled event types or publishers;
- no core Turn reverse-lookup registry;
- raw runtime stop remains inside the entity-owned runtime owner;
- `TeammateService` has no dependency on `teammate-collection` internals.

The fallback public-artifact scan found only synthetic placeholder Feishu IDs in
test fixtures. No private chat/user/message ID, machine-local path, private
domain, secret, or task-internal transport metadata was introduced.

## Known Limitations

- The two Codex real-model gates could not pass in the current environment
  because the external model connection repeatedly reconnected or failed to
  begin model tool execution. They passed before the final provider-only
  correction in the developer run, but the TeamLeader does not treat that older
  result as current proof. The load-bearing tests remain enabled and unchanged;
  CI or another environment with healthy model service must run them again.
- The real Claude model turn requires
  `DREAMUX_RUN_LIVE_CLAUDE_CODE=1`, an installed Claude Code binary, and valid
  authentication. Provider tests and the built-server MCP handshake passed.
- Rush 5.140.0 warns that Node 22.16.0 is not in its tested-version list. Every
  executed Rush command otherwise completed as recorded above.
- `gitleaks` is not installed. The fallback targeted public-artifact scan passed.

## Independent Review

The shared code-review workflow completed at `xhigh`:

- Finder seats: 8
- Candidates: 45
- Verifier seats: 33
- Verified locations: 45
- Failed finders or verifier locations: none
- Partial coverage: `false`
- Reported findings: 15
- Refuted candidates: 3

The TeamLeader adjudicated every reported finding against the frozen
requirement, approved solution, current source, and baseline. All 15 reported
findings were accepted and merged into 12 repair groups:

1. Server and Dispatcher close-before-drain ordering.
2. Deadline-bounded completion preparation and submission.
3. Runtime stop-time convergence of already-started admissions.
4. Codex active-slot linearization while native aliases remain pending.
5. Claude source reservation committed only after accepted or ambiguous
   admission.
6. Full-file strict v2 archive validation and conservative torn-tail handling.
7. Cold-cache durable TeamMate materialization and close during Team dissolve,
   Team stop, and Dispatcher shutdown.
8. Durable terminal closure of a Team whose creation fails after record
   publication.
9. Immutable first-wins snapshot of provider Turn outcomes.
10. Promise-consistent Claude `start()` failure after stop.
11. Codex teardown before joining startup or restart tasks.
12. Explicit provider-proven `failed` versus post-boundary `ambiguous`
    admission semantics.

The three workflow-level refutations remain non-findings:

- no duplicate response-before-disconnect finding without independent evidence;
- no requirement to deduplicate Team and Dispatcher projection helpers;
- no requirement to centralize provider-private `RuntimeTurn` latch
  implementations.

The same single developer implemented all accepted corrections. The TeamLeader
then reviewed the repaired source and tests; no second writer or second
implementation-review workflow was started.

## Post-Review Verification

### Focused Regression Gates

- Nine Dreamux lifecycle files:
  - `completion-router`
  - entity Turn
  - strict v2 archive
  - TeamMate service
  - Workflow service
  - Team read/materialization
  - Team dissolve acceptance
  - Dispatcher collaboration/shutdown
  - external runtime parity
  - Passed: `9` files, `176` tests.
- Public runtime contract fixture:
  - Passed: `1` file, `8` tests.
- Codex active-slot and start/stop suites:
  - Passed: `2` files, `50` tests.
- Claude RPC/admission/activity suites:
  - Passed: `2` files, `32` tests.
- Total focused post-review result:
  - `14` files, `266` tests passed.

These tests include deferred interleavings for close-before-drain, late
admission, source reservation, Codex alias completion before folded submission
response, Claude capability/write ambiguity, cold-cache materialization, Turn
outcome mutation, archive middle-row corruption, and provider startup/stop
races.

### Repository and Static Gates

- `node common/scripts/install-run-rush.js build`
  - Passed; all eight projects were already up to date.
- `node common/scripts/install-run-rush.js typecheck`
  - Passed for all seven packages with work.
- `node common/scripts/install-run-rush.js typecheck:tests`
  - Passed for every package defining that command.
- `node common/scripts/install-run-rush.js lint`
  - Passed for all seven packages with work.
- `node common/scripts/install-run-rush.js change --verify`
  - Exited successfully and recognized the Rush change files.
  - Rush warned that `rush.json` has no baseline remote URL and could not fetch
    `origin/main`; this did not invalidate the local change-file verification.
- `git diff --check`
  - Passed.
- Frozen artifact checks:
  - requirement SHA remains
    `4367fcdee10bbe23c5af6a2a3806772fcda3eb57887432552d3b0488e45c264a`;
  - approved solution SHA remains
    `ab3e27fbc6e6c46f4ae12ab60cc616b22b7a746bd9a62eb1f653024c9fb97e6d`.

### Full Tests

- `node common/scripts/install-run-rush.js test`
  - Every package other than the Dreamux live-model cases completed.
  - Dreamux deterministic, app-server, handshake, MCP, and fake-provider tests
    passed.
  - Two unchanged real-model Codex gates failed at the external model-service
    stage:
    - portable structured output reached a successful app-server
      `turn/started`, then the external service reported
      `Reconnecting... 2/5` through `5/5`;
    - the issue #63 live run reached app-server, MCP readiness, and user-message
      submission, but model command execution did not begin before its live
      timeout.
  - Dreamux result: `1022 passed`, `2 failed`, `3 skipped`.
- `CI=true DREAMUX_RUN_LIVE_MODEL_GATE=0 node ../../common/scripts/install-run-rush-pnpm.js exec vitest run --fileParallelism=false --silent`
  from `packages/dreamux`
  - Passed: `88` files, `1022` tests passed, `5` skipped.
  - Real Codex `0.147.0` installation, app-server startup, initialize
    handshake, thread start, and official Feishu MCP injection ran and passed.
  - Only the two model/auth/network-dependent gates used the repository's
    existing public-CI skip policy.
  - The real Claude model turn remained opt-in; its built-server health/MCP
    handshake passed.
  - Two pre-existing `global-config` TODO #209 tests remained statically
    skipped.

The two live-model failures match the two earlier TeamLeader runs byte-for-byte
at the relevant failure stage. No assertion or load-bearing live gate was
weakened or disabled in source.

### Latest `next` Integration

Before PR creation, `origin/next` advanced through PRs #335 and #336. The task
commit was rebased onto `3b74f9bc59437cd234047473321a131658295126`.

- The cron run-now deletion and capability-domain task routing from #335 remain
  authoritative. This task was migrated to `.agents/tasks/workflow/` and does
  not restore `cron_run_now`, `scheduler.cron.run_now`, or `runNow`.
- Scheduler integration keeps the timer-only API while adding the narrow
  writer-idle capability, status-only Turn admission, lifecycle-generation
  fence, and admission-ambiguous one-fire/no-retry behavior.
- The isolated collaboration worktree fixture from #336 remains intact.
- Focused rebase intersection:
  - scheduler, Team scheduler, and Dispatcher collaboration suites passed:
    `3` files, `84` tests.
- Final deterministic Dreamux suite on the rebased head:
  - `CI=true DREAMUX_RUN_LIVE_MODEL_GATE=0 node ../../common/scripts/install-run-rush-pnpm.js exec vitest run --fileParallelism=false --silent`
  - Passed: `88` files, `1027` tests passed, `5` skipped.
  - Real Codex app-server/handshake/official Feishu MCP gates and the built
    Claude health/MCP gate still ran and passed under the repository's existing
    CI policy.
- Rebased-head `build`, `typecheck`, `typecheck:tests`, `lint`, Rush change
  verification, task validation, KB validation, and `git diff --check` passed.
- Requirement and approved-solution SHA-256 values remained unchanged.

### Final Architecture and Residue Audits

Repo-wide searches confirmed:

- removed ownership and shutdown names appear only in architecture
  anti-regression test regular expressions;
- no product `OwnedTeammate*`, `spawnOwned`, `releaseAllOwned`,
  `releaseExclusive`, `exclusivelyOwned`, `stopAllForShutdown`, or
  `stopForShutdown`;
- no service/public/persisted `turn_id` or `submission_id`;
- no Channel Turn submitted/settled event type or publisher;
- provider-native Turn ids remain inside provider packages only;
- raw `runtime.stop()` calls in Dreamux service source exist only in
  `teammate-service/runtime-owner.ts`;
- `TeammateService` imports no `teammate-collection` internals;
- the approved requirement and solution hashes did not drift.

## Knowledge Closeout

- Added accepted decision:
  [Entity-owned TeamMate lifecycle and object Turns](/.agents/decisions/entity-owned-teammate-lifecycle-and-object-turns.md).
- Updated current owners:
  - [Current architecture](/.agents/reference/current-architecture.md)
  - [Service topology](/.agents/reference/service-topology.md)
  - [Provider runtime](/.agents/domains/provider-runtime.md)
  - [Dispatcher orchestration](/.agents/domains/dispatcher-orchestration.md)
  - [State, config, and files](/.agents/domains/state-config-and-files.md)
  - [State and paths](/.agents/reference/state-and-paths.md)
  - bundled maintenance
    `packages/dreamux/skills/dispatcher/dreamux-maintenance/references/service-lifecycle.md`
- Marked the old completion-router portion of
  `service-architecture-refactor.md` as superseded while preserving its accepted
  Collection + Service topology.
- Repaired the archive link to the intentionally removed
  `teammate-collection/owned-teammates.ts`.
- `.agents/scripts/check.sh`
  - Passed after the latest-`next` task-route merge:
    `KB OK (116 files reachable from root.md)`.

## Residual Risk

- The two real-model Codex gates still require a healthy external model service.
  Their app-server, protocol, and MCP prerequisites passed locally, and CI or
  another healthy authenticated environment must run the model-dependent stage
  again.
- The real Claude model turn requires
  `DREAMUX_RUN_LIVE_CLAUDE_CODE=1`, an installed Claude Code binary, and valid
  authentication.
- Rush 5.140.0 warns that Node 22.16.0 is not in its tested-version list; all
  executed Rush commands otherwise behaved as recorded.
- `gitleaks` is not installed. Targeted public-artifact and residue scans found
  no private identifier, secret, private domain, or service-level Turn id.
