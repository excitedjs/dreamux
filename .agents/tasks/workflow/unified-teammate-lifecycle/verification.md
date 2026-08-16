# Verification

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
