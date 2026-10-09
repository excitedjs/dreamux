# Verification and adjudication

## TeamLeader pre-review

Reviewed the entire staged and unstaged implementation against the accepted F2/F3/A1/A4–A9 scopes. Current-row derivation uses the existing transactional store; provider submission remains outside it. Startup reconciliation uses the same current-row boundary because channels start before the scheduler and may admit edits during startup. No new lock, generation, durable field or provider-specific policy enters the shared mechanism. The later F3 change validates only mandatory team_name at the existing binding decoder and keeps unknown-field/root compatibility.

The shared activity opener preserves the original filesystem sequence, provider messages, exception classification, device/inode comparison and handle lifetime. Claude native evidence remains in its existing activity path owner. Each approved deletion removes its unconsumed concept; actual external validation, terminal retry, hook rejection observation and argv override behavior remain.

## Local checks

Dependencies were installed once with `node common/scripts/install-run-rush.js update`. The following monorepo gates passed on the completed implementation and passed again after the later F3 change:

- `node common/scripts/install-run-rush.js build`
- `node common/scripts/install-run-rush.js lint`
- `node common/scripts/install-run-rush.js test`
- `node common/scripts/install-run-rush.js typecheck:tests`
- `git diff --check`

The post-F3 default test run passed 2,687 tests; six authenticated model-gate cases were skipped by their existing opt-in condition. All four gates passed again after C1 and R1: the changed Dreamux package rebuilt, unchanged package builds were up to date, and lint, test and typecheck:tests ran across their applicable packages. The test gate's warnings explicitly report the existing authenticated model-gate exclusion; they are not a model-behavior certification.

The first test-type pass caught Promise.withResolvers outside the configured library. The test now uses the existing deferred helper; no library/config change was made. An initial parallel Rush invocation was refused by Rush's repository lock; final gates ran sequentially. These were corrected verification attempts, not passing evidence.

The scheduler tests exercise concurrent sparse updates, pause and replacement occurrence during successful/ambiguous admission, unchanged one-shot completion, and edits between startup listing and reconciliation through real Scheduler/store owners. Existing non-blocking submission, missed fire and destruction ordering assertions remain. Shared filesystem tests use real files for successful opening, permitted roots, missing/non-regular files, leaf symlinks and intermediate-root escape. Pure barrel/export-list assertions and fictional async-hook registrations were removed; real hook rejection observation is tested. The real routing file tests reject missing/null/non-string team_name and retain valid bindings, tolerated unknown fields and absent-root compatibility.

Codex is installed and native non-model checks ran; no DREAMUX_SKIP_LIVE_CODEX override was used. The existing suite excludes authenticated model-gate cases unless DREAMUX_RUN_LIVE_MODEL_GATE=1. Passing the default suite does not certify real model folding or native model completion. No live Feishu application/card round-trip was run. The new filesystem cases do not demonstrate an actual inode replacement race or close-error path; the existing implementation mechanics were preserved and independently read against their predecessors.

## Supplemental read-only checks

A separate runtime reviewer found no new reachable defect in A1/A7/A8 and traced all four callers, native evidence checks, restart fencing and argv ordering. A separate core reviewer found no new reachable defect in F2/A4/A5/A6/A9 and traced live-run construction, terminal intent, SyncHook registration, registry ingress and external contract checks. Both inspected source and behavioral assertions without repeating gates. These focused checks preceded the final startup reconciliation correction; the current independent manual review covers the final workspace.

## Independent review

All earlier workflows were stopped. The last stopped run returned zero Seed candidates and two Mimo candidates: possible duplicate dispatch when an older fire re-arms an already-dispatching replacement occurrence, and existing export-list assertions outside the touched scope. Neither verifier completed; these are unverified claims, not accepted findings.

The operator subsequently requested manual scheduling. Direct Mimo and DeepSeek reviewers now independently inspect the current diff, and one Codex verifier checks recovered and new candidates. Final findings, source evidence and adjudication will be recorded before submission.

### Initial Codex adjudication

- **C1 — CONFIRMED, corrected within F2.** A replacement occurrence can already be dispatching while the earlier admission settles. The earlier derive preserved that occurrence, but unconditional arming scheduled the same past due time again. WorkFence tracks rather than serializes submissions, and the new dispatch uses a different source id, so the ledger does not deduplicate it. Native cold-start and serial native admission support this ordinary window. The correction arms only when this call's synchronous derive actually advanced the submitted occurrence; a preserved occurrence remains owned by its writer. The factual fire remains recorded in either case, without a new lock or durable field. Submitted and ambiguous regressions drive the replacement timer into an actual pending submit before settling the older admission. The writer observed three prompts before correction and two after, with all 30 scheduler cases passing. These are controlled admission-latency tests, not a live native cold-start claim.
- **C2 — OUT_OF_SCOPE.** Exact export-list assertions in official-provider-entries.test.ts are unchanged in BASE and the current diff. Their existing structure-only nature does not authorize unrelated cleanup. Preserve their real factory/plugin tests and the two existing name-list assertions. The additional core removal changes only this file's ProviderRegistry import to its defining module; it does not authorize cleanup of the provider package entries.

DeepSeek returned no blocker and three low-priority advisories. Codex independently adjudicated all three:

- **R1 — CONFIRMED improvement, corrected within A9.** Removing factory-context variability left a local ProviderFactory declaration identical to the published type, with no external consumer. The loader now imports the published type; the shadow declaration and unused context import are deleted, without a re-export shell.
- **R2 — PARTIAL, no correction.** The opener message interface is not exported, but its complete structural declaration remains in the emitted API and all four callers can provide their provider-owned object. No caller requires a named type import; adding another public name is not required by A1.
- **R3 — CONFIRMED coverage observation, no correction.** The removed artificial async fixture asserted plugin:null in its log. Current SyncHook tests cover owner-less registration, and both thrown and rejected callbacks still pass the captured owner/null unchanged to the logger. Missing a direct log assertion alone proves no regression; A4 does not require extra coverage.

DeepSeek's broad no-blocker statement does not override C1's reachable timer sequence. Codex's final holistic read-only verification passed the complete 45-file diff after C1/R1 corrections, with no remaining authorized-scope blocker, architecture regression or requirement omission. All four full Rush gates passed after those corrections; their final default test run passed 2,689 tests with six existing authenticated model-gate skips. Mimo completed its independent review and re-inspected both corrections, reporting zero remaining supported findings across F2/F3/A1/A4–A9.

The TeamLeader rejects Mimo's incidental claim that no export-list mirror remains: the two exact Object.keys assertions in official-provider-entries.test.ts remain unchanged. This does not reverse C2's out-of-scope disposition or authorize unrelated deletion. Two comment-level observations (an old invoke caller name and a decoder comment focused on absent-root compatibility) were below the finding threshold and establish no incorrect behavior.

## Knowledge closeout

The requirement/design, complete diff, operator scopes and final source were reconciled after independent review. Scheduled-work, provider-runtime and channel domains, the product catalog, the owning maintenance references and the utils README are updated. Existing plugin, terminal and native argv contracts remain accurate without a separate domain edit. The knowledge checker passed (52 task records, 343 reachable files), as did git diff --check. The source commit passed the mandatory staged ESLint, author identity, gitleaks and internal-content hook; no bypass was used. The reviewed change was pushed and submitted as [PR #466](https://github.com/excitedjs/dreamux/pull/466) to next. Repository CI and merge remain separate delivery facts.

## Additional core re-export removal

The operator's subsequent core-only deletion instruction is recorded in the requirement and final solution. The TeamLeader was the sole writer; two supporting readers independently traced consumers and main/smoke ownership before implementation.

Source pre-review confirms removal of all 18 sourced re-export declarations in six core modules. Three behavior-free aggregate files are deleted; command failure conversion, provider parsing and registry behavior remain in their defining modules. Forty-nine source/test files migrate imports, including leaf consumers of the old neutral-type paths. A temporary TypeScript AST audit found zero sourced or imported-binding local re-exports across the remaining 179 core source files. It is audit evidence, not a new source-structure test.

A second source comparison against the accepted pre-removal tree covered 43 changed/deleted core TypeScript files: after excluding import and forwarding-export declarations, every remaining definition/body is identical. Aliases and explicit type-only edges are preserved. The service facade's smoke export-list/value mirror is removed; compiled server.js still loads Dispatchers, DispatcherService, TeamService and WorkflowService through actual value imports before the unchanged CLI --version probe. No provider/channel package source or public entry is changed by this addition.

Fresh full Rush build, lint, test and typecheck:tests passed after removal, along with Rush smoke-built-cli and git diff --check. The test result is 2,689 passed and six existing authenticated-model skips. Dependency-cruiser reports no violations across 222 modules and 1,082 edges. A concurrent Rush attempt was rejected by its repository lock; the final test/typecheck gates were run sequentially and only their successful runs count. Stale generated files for the three deleted barrels were removed before build and smoke, so smoke cannot pass by resolving an old dist facade.

The core re-export lint gate now covers all source files with no entry exemption or inline re-export suppression. The deleted facade's Knip entry and dependency layer are removed. Owning source instructions, current service/operations references and Rush command help are synchronized. Rush change generated a plain minor note for the removed core import paths; no persisted-file upgrade block or migration is claimed. Independent Codex verification passed the full addition, including the generated change note and current compiled graph. It separately confirmed that registration is driven by explicit plugin loading/contribution, not a removed barrel side effect; error object identity and classification are unchanged. It did not rerun gates. Main/module initialization smoke is not a claim of actual service startup or native runtime end-to-end validation.

The final knowledge check passed (52 task records, 343 reachable files), and git diff --check passed. The mandatory commit hook remains required for the added deletion; its receipt is part of delivery evidence.
