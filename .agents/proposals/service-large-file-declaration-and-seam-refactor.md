# Proposal: service large-file declaration and seam refactor

- **Status:** Proposed
- **Date:** 2026-08-04
- **Baseline:** `e711d33bb844cfd69ca09e539d3c00771a2de3e6`
- **Affects:** internal `@excitedjs/dreamux` service module ownership only

## Intent

Create honest headroom below the 700-physical-line source limit by moving
stable cross-module declarations to owner-local `types.ts` modules and moving
Dispatcher/TeamLeader caller policy to the existing `TeamChannelCoordinator`
seam. Keep implementation-coupled declarations and domain lifecycle state with
their implementation owners.

This is a behavior-preserving refactor. Source call sites may move to their
single owner, but JavaScript call order and observable behavior must not change.
The change must not alter public APIs, persisted data, runtime objects,
lifecycle ordering, error/result shapes, or provider seams.

## Current source evidence

The shared ESLint rule rejects source files above 700 physical lines and counts
comments and blank lines (`packages/eslint-config/index.js:207-210`). At the
baseline, the complete 90%-of-limit set is:

| Lines | Module | Named declarations and disposition |
| ---: | --- | --- |
| 700 | `service/team-service/index.ts` | Six at lines 57-118; move four and keep the two concrete-`TeamService` declarations local |
| 699 | `service/dispatcher-service/index.ts` | None; use existing ownership seams |
| 690 | `service/workflow-service/run.ts` | Two at lines 40-59; keep local |
| 682 | `service/teammate-collection/index.ts` | Five at lines 78-164; move three, keep options and route local |
| 672 | `service/team-collection/index.ts` | One at lines 61-101; move it |
| 671 | `service/team-collection/dissolve-controller.ts` | One at lines 45-59; keep local |
| 662 | `service/scheduler/service.ts` | Five at lines 24-74; move four |
| 662 | `service/dispatcher-service/collaboration-routing.ts` | None |
| 657 | `service/teammate-service/index.ts` | Four at lines 55-111; move three |
| 641 | `service/collaboration-space/target-lifecycle.ts` | Two at lines 35-49; keep local |

Here, a declaration means a named `interface` or `type`; anonymous parameter
object types are not independent declarations. `dispatcher-service/index.ts`
cannot be relieved by moving interfaces because it has none. Its shared options
and DTOs already live in `dispatcher-service/types.ts` (lines 12-42), and line
79 is a re-export rather than a declaration. `collaboration-routing.ts`
likewise has no named local declaration worth extracting.

Two current declaration moves would create dishonest type layers:

- `TeamServiceDeps` and `TeamServiceCreateOutput` name the concrete
  `TeamService`. Moving them to `team-service/types.ts` would make that module
  type-import `index.ts` while `index.ts` imports its declarations.
- `TeammateCollectionOptions` names `WorktreeManager`, whose manager already
  imports request contracts from `teammate-collection/types.ts`. Moving the
  options bag there would reverse that lower-level contract edge.

Type erasure would hide both strongly connected source-level dependency pairs,
but it would not make either module a clean lower contract layer. Those three
declarations therefore stay beside their concrete implementation owners.

The Dispatcher headroom seam has two existing cross-owner coordination blocks:

- `dispatcher-service/index.ts:506-525` combines TeamLeader generation leasing
  with channel-tool invocation even though `TeamChannelCoordinator` already
  holds both `TeamCollection` and `ChannelService`.
- `dispatcher-service/index.ts:600-621` owns the 9-second Dispatcher result
  projection and TeamLeader receipt mapping. The projection currently passes
  through two single-consumer forwarding methods at
  `team-collection/index.ts:474-485` and
  `team-collection/dissolve-controller.ts:290-300` before reaching
  `projectDispatcherDissolveResult`.

Moving only the dissolve facade block and then restoring the six compressed
facade methods would model at approximately 701 lines. Moving both existing
coordination blocks to the already-constructed coordinator models at
approximately 684 lines and creates useful headroom without a new helper or
DTO.

The baseline also places preparation and ordered Channel publication in
`dispatcher-service/input-source-channels.ts`, but that module is a pair of
parameter-heavy, single-consumer functions. It owns none of the preparation,
starting, prepared-session, or started state, and the aggregate retains
availability checks and failed-start rollback. Keeping that shape while using
it for Dispatcher line relief would contradict the owner-seam constraint below.
The honest boundary is one input-source lifecycle capability that owns those
states and transitions while the aggregate retains composition and shutdown
ordering.

The current runtime import graph has no multi-module strongly connected
component. `packages/dreamux/tsconfig.json:10-21` has
`verbatimModuleSyntax: false`, and neither the package ESLint config nor the
shared rules enforce consistent type imports. Successful compilation or a built
runtime import therefore cannot prove that a source-only edge was written with
`import type`; the moved declarations need a targeted source gate.

The existing built CLI smoke executes only `bin/dreamux --version`. That path
loads `dist/cli/dreamux.js`, which computes but does not import the server entry.
It does not load `dist/server.js` (the package `main`) or the service graph, so it
cannot be the service ESM-cycle gate by itself.

## Scope

1. Move the 15 declarations that form stable owner-local contracts into five
   type modules without creating a type-layer cycle.
2. Keep the three implementation-coupled declarations and eight
   implementation-private declarations beside their current owners. Do not
   perform unrelated export-surface cleanup.
3. Make `TeamChannelCoordinator` the single owner of Dispatcher/TeamLeader
   dissolve result mapping and TeamLeader channel-tool lease coordination while
   retaining dispatcher admission and method-entry timing.
4. Remove the two now-redundant dissolve-result forwarding methods.
5. Restore normal formatting currently compressed by line pressure.
6. Replace the stateless input-source extraction with a stateful lifecycle
   capability that owns preparation, startup, publication, and failed-start
   rollback without changing the public Dispatcher facade or stop order.
7. Consolidate the duplicate prepared/shared workspace contract and compose the
   teammate factory input from its dependency contract.
8. Update only the tests, built smoke, command description, proposal index, and
   ownership documentation required to enforce the moved contracts.

## Hard constraints

- Add nothing to `packages/dreamux/src/service/index.ts` and add no compatibility
  re-export from an old service `index.ts`. Internal consumers import the owning
  sibling directly. This preserves the intentional facade and service re-export
  lint rule.
- Add no public or facade runtime named export. The new `types.ts` files contain
  erased type contracts only. The internal Dispatcher-specific projection
  constant/helper move into `team-channel-coordinator.ts` as module-local
  implementation; do not retain a compatibility re-export from
  `team-collection/dissolve-lifecycle.ts`.
- Every dependency used only as a type is imported with `import type` or a
  type-only import specifier. None of the five target type modules may import its
  corresponding implementation `index.ts` or `service.ts`, even type-only. No
  extracted module may introduce a source-level or runtime cycle or change
  module initialization order.
- Keep `new SchedulerService(...)` in exactly
  `dispatcher-service/index.ts` and `team-service/index.ts`. Do not widen the
  scheduler ownership gate or expose lifecycle verbs beyond
  `SchedulerCommands`.
- Keep Team-dissolve generation authority, authoritative refresh, operation
  registry, retry/recovery, milestone settlement, fence finalization,
  suspension, and removal in `TeamDissolveController`. Do not split a shared
  registry across controllers or weaken
  `architecture-ownership-gate.test.ts:186-214`.
- Preserve Dispatcher shutdown ordering: interrupt dissolve before draining
  admitted work. Preserve Team-wide leader/member `waitIdle` enumeration and
  route member completion through the Team availability gate.
- Do not replace cohesive composition-root construction, stop sequencing, or
  ordinary facade forwarding with parameter-heavy stateless helpers merely to
  reduce line count. `DispatcherInputSourceLifecycle` owns its preparation,
  starting, prepared-session, and started state plus failed-start rollback;
  `DispatcherService` retains aggregate admission and stop sequencing.
- Do not invent names for implementation-local anonymous object shapes solely
  for line-count relief. A dedicated private contract module requires a real
  multi-implementation or multi-consumer boundary; none is justified here.

## Exact target modules and moves

### Declaration ownership

| Owner-local module | Declarations moved into it | Required consumer rewiring |
| --- | --- | --- |
| New `service/team-service/types.ts` | `TeamAvailability`, `TeamLiveWriter`, `TeamServiceCreateInput`, `TeamSchedulerLifecycle` | `team-service/index.ts` imports its four contracts; dissolve controller/lifecycle import `TeamLiveWriter`; runtime registry imports `TeamSchedulerLifecycle` |
| Existing `service/team-collection/types.ts` | `TeamCollectionOptions` | `team-collection/index.ts` and `runtime-registry.ts` import it directly from `types.ts` |
| Existing `service/teammate-collection/types.ts` | `TeamMateSharedWorkspace`, `SpawnTeamMateRequest`, `TeammateOps` | Update the collection itself, `team-service/index.ts`, `dispatcher-service/index.ts`, `dispatcher-service/teammate-ops.ts`, `dispatcher-service/team-leader-handle.ts`, `worktree/manager.ts`, and `worktree/workspaces.ts`; delete the structurally identical `PreparedTeamMateWorkspace` contract and keep the `TeammateCollection` value import on `index.ts` |
| New `service/scheduler/types.ts` | `CronCreateRequest`, `CronUpdateRequest`, `SchedulerServiceOptions`, `SchedulerCommands` | Update scheduler service, DispatcherService, TeamService, TeamCollection, TeamRuntimeRegistry, and `admin/methods.ts`; keep the `SchedulerService` value import on `service.ts` |
| New `service/teammate-service/types.ts` | `TeammateServiceDeps`, `SettledCompletionRoute`, `TeammateServiceOptions` | Update teammate service, its factory, teammate collection, and `owned-teammates.ts`; keep the `TeammateService` value import on `index.ts` |

Keep these implementation-coupled declarations beside their concrete owners:

- `TeamServiceDeps` and `TeamServiceCreateOutput` in
  `team-service/index.ts`; and
- `TeammateCollectionOptions` in `teammate-collection/index.ts`.

Keep these eight implementation-private declarations beside their
implementations:

- `TeamDissolveControllerOptions` in `team-collection/dissolve-controller.ts`;
- `WorkflowRunDeps` and `AgentCall` in `workflow-service/run.ts`;
- `SpawnRoute` in `teammate-collection/index.ts`;
- `TimerSlot` in `scheduler/service.ts`;
- `RuntimeLaunchSpec` in `teammate-service/index.ts`; and
- `CollaborationTargetLifecycleOptions` and `AcceptedTargetCreated` in
  `collaboration-space/target-lifecycle.ts`.

Preserve the current `export` status of every retained declaration. Do not
create private type modules for them.

`CreateTeammateServiceInput` extends `TeammateServiceDeps` and adds only the
dispatcher id, identity, and options needed by the factory. The factory passes
that dependency capability through instead of repeating and rebuilding its nine
fields.

### Dispatcher lifecycle and channel seam

Move caller-specific policy into
`service/dispatcher-service/team-channel-coordinator.ts`:

- Move the existing 9-second constant and bounded Dispatcher result projection
  algorithm from `team-collection/dissolve-lifecycle.ts` into the coordinator as
  module-local implementation. Continue to use the Team-owned
  `projectInProgressDissolve` domain projection and preserve timeout,
  interruption, timer cleanup, and non-cancellation behavior exactly.
- Dispatcher dissolve receives the public-method entry timestamp, derives the
  same absolute 9-second decision deadline, passes it to
  `CollaborationSpaceService.dissolveTeam`, and projects the accepted handle
  with `Math.max(0, deadlineAt - Date.now())` remaining budget.
- TeamLeader dissolve calls the existing descriptor-bound collaboration path
  and returns the accepted handle's existing `receipt`.
- Delete `TeamCollection.dispatcherDissolveResult` and
  `TeamDissolveController.dispatcherResult`; neither has another source
  consumer. Do not replace them with a DTO, capability interface, or wrapper.
- `DispatcherService.dissolveTeam` captures the timestamp before admission so
  the current public-method-entry budget contract remains exact, then retains
  only `admitOperation` around the coordinator call.
- `DispatcherService.dissolveTeamForLeader` likewise retains only dispatcher
  admission around the coordinator call.
- Move the existing `invokeChannelTool` caller branch into the coordinator.
  For a TeamLeader caller, the existing `TeamCollection.withTeamLeaderLease`
  must still wrap `invokeDispatcherChannelTool`; a Dispatcher caller still
  invokes that helper directly. `DispatcherService.invokeChannelTool` retains
  only admission around the coordinator call.

Do not move the Dispatcher object graph (`index.ts:115-244`), stop sequence
(`index.ts:395-456`), or any unrelated facade method. Restore normal formatting
for the compressed `scheduler`, `start`, `workspace`, `listTeams`,
`getTeamHistory`, and `listCollaborationSpaces` members after the two seam moves
create headroom.

### Dispatcher input-source lifecycle seam

Replace `input-source-channels.ts` with
`dispatcher-service/input-source-lifecycle.ts`. Its
`DispatcherInputSourceLifecycle` owns the single-flight preparation and startup
promises, prepared Channel sessions, started state, dispatcher agent/workspace
publication, ordered Channel publication, and failed-start rollback. It receives
the already-constructed dispatcher collaborators once from the composition root
and applies the aggregate's availability fact internally.

`DispatcherService.prepareChannels()` and `startInputSources()` remain public
facade methods with unchanged results. Aggregate stop still interrupts Team
dissolve before waiting for lifecycle startup, and still owns the ordered sweep
across workflows, live Channels, schedulers, admitted work, collaboration tasks,
Team runtimes, and the dispatcher agent. The lifecycle capability owns only its
prepared-session close/reset operations within that sequence.

### Tests, built smoke, and documentation

- Split the current 9-second test into two ownership tests:
  - keep a small `DispatcherService` facade test that delays execution of the
    admitted callback, advances the clock, and proves the timestamp passed to
    the coordinator was captured at public method entry; and
  - test the coordinator directly for the exact 9-second absolute deadline,
    the deadline passed to the collaboration path, remaining projection budget,
    closing/closed/completed result shapes, interruption behavior, timer cleanup,
    and non-cancellation of accepted background work.
- Extend `team-channel-coordinator.test.ts` to prove that a TeamLeader
  channel-tool call executes inside the exact generation lease and that a
  Dispatcher call does not acquire a Team lease. Preserve the existing
  authorization and invocation tests for `invokeDispatcherChannelTool`.
- Extend `architecture-ownership-gate.test.ts` with a targeted source gate for
  the 15 moved declarations. It must assert exactly one definition in the
  expected type module, reject compatibility re-exports and imports of the
  corresponding implementation, and verify through syntax-aware parsing that
  every named or namespace consumer import is type-only and comes directly from
  its owner. Include negative fixtures for indirect imports, namespace imports,
  and compatibility re-exports. Compilation and built imports are not
  substitutes for this gate.
- Extend `scripts/smoke-built-cli.mjs` so a fresh Node process directly imports
  `dist/server.js` and asserts `Server`, directly imports
  `dist/service/index.js` and asserts the existing value-export set
  (`Dispatchers`, `DispatcherService`, `TeamService`, `WorkflowService`, and
  `ChannelToolAuthorizationError`), then retains the existing
  `bin/dreamux --version` smoke. Update the Rush command description to name all
  three checks.
- Keep all dissolve, collaboration-space, scheduler, completion-routing, and
  ownership assertions at least as strong as the baseline; do not edit a
  load-bearing assertion merely to match moved text.
- Update `packages/dreamux/src/service/CLAUDE.md` and
  `.agents/reference/service-topology.md` for the coordinator's dissolve
  projection and TeamLeader channel-tool lease ownership. Also update the
  topology's `SchedulerService` / `SchedulerCommands` row so it names
  `scheduler/types.ts` as the command-contract owner instead of claiming both
  declarations live in `scheduler/service.ts`. No other architecture claim
  changes.
- Add this active proposal to `.agents/root.md`; this is a reachability index
  update required by `.agents/scripts/check.sh`, not another architecture claim.

## Planned file list

No implementation file outside this list may change without first amending and
re-reviewing this proposal.

- Proposal and ownership documentation:
  - `.agents/proposals/service-large-file-declaration-and-seam-refactor.md`
  - `.agents/root.md`
  - `.agents/reference/service-topology.md`
  - `packages/dreamux/src/service/CLAUDE.md`
- Build smoke:
  - `common/config/rush/command-line.json`
  - `packages/dreamux/scripts/smoke-built-cli.mjs`
- Declaration owners and consumers:
  - `packages/dreamux/src/admin/methods.ts`
  - `packages/dreamux/src/service/scheduler/service.ts`
  - `packages/dreamux/src/service/scheduler/types.ts` (new)
  - `packages/dreamux/src/service/team-collection/dissolve-controller.ts`
  - `packages/dreamux/src/service/team-collection/dissolve-lifecycle.ts`
  - `packages/dreamux/src/service/team-collection/index.ts`
  - `packages/dreamux/src/service/team-collection/runtime-registry.ts`
  - `packages/dreamux/src/service/team-collection/types.ts`
  - `packages/dreamux/src/service/team-service/index.ts`
  - `packages/dreamux/src/service/team-service/types.ts` (new)
  - `packages/dreamux/src/service/teammate-collection/index.ts`
  - `packages/dreamux/src/service/teammate-collection/owned-teammates.ts`
  - `packages/dreamux/src/service/teammate-collection/types.ts`
  - `packages/dreamux/src/service/teammate-service/factory.ts`
  - `packages/dreamux/src/service/teammate-service/index.ts`
  - `packages/dreamux/src/service/teammate-service/types.ts` (new)
  - `packages/dreamux/src/service/worktree/manager.ts`
  - `packages/dreamux/src/service/worktree/workspaces.ts`
- Dispatcher seam and direct consumers:
  - `packages/dreamux/src/service/dispatcher-service/index.ts`
  - `packages/dreamux/src/service/dispatcher-service/input-source-channels.ts` (remove)
  - `packages/dreamux/src/service/dispatcher-service/input-source-lifecycle.ts` (new)
  - `packages/dreamux/src/service/dispatcher-service/team-channel-coordinator.ts`
  - `packages/dreamux/src/service/dispatcher-service/team-leader-handle.ts`
  - `packages/dreamux/src/service/dispatcher-service/teammate-ops.ts`
- Tests:
  - `packages/dreamux/tests/architecture-ownership-gate.test.ts`
  - `packages/dreamux/tests/dispatcher-collaboration-space.test.ts`
  - `packages/dreamux/tests/team-channel-coordinator.test.ts`
  - `packages/dreamux/tests/team-dissolve-contract.test.ts`

## Acceptance

- All 15 listed moved declarations have exactly one owner-local definition. The
  three listed implementation-coupled declarations and eight listed private
  declarations remain beside their implementations with their existing export
  status.
- None of the five type modules imports its implementation module; every
  consumer imports moved symbols type-only and directly from its owner, with no
  compatibility re-export, enforced by positive and negative ownership tests.
  The emitted runtime graph remains free of cycles.
- `dispatcher-service/index.ts` is at most 685 physical lines after normal
  formatting. It gains headroom from the two existing coordinator
  responsibilities and the stateful input-source lifecycle capability, not an
  interface move or stateless wrapper. No source file exceeds 700 lines, and
  final validation reports physical line counts for all ten baseline files.
- `DispatcherInputSourceLifecycle` owns preparation/start single-flight state,
  prepared Channel sessions, agent/workspace publication, ordered session
  publication, and failed-start rollback. Dispatcher public start behavior and
  interrupt-before-wait-before-drain shutdown ordering remain unchanged.
- `TeamMateSharedWorkspace` is the single prepared/shared workspace result
  contract, and `CreateTeammateServiceInput` composes `TeammateServiceDeps`
  without repeating or rebuilding its fields.
- Dispatcher dissolve still starts the exact 9-second decision budget at public
  method entry, passes the same absolute deadline, returns the same
  closing/closed/completed projections, clears its timer, and does not cancel
  accepted background work. TeamLeader dissolve still returns its immediate
  receipt.
- TeamLeader channel-tool invocation remains inside its exact generation lease;
  Dispatcher invocation remains lease-free. Channel authorization and tool
  invocation order and errors are unchanged.
- `TeamCollection.dispatcherDissolveResult` and
  `TeamDissolveController.dispatcherResult` are deleted with no replacement
  wrapper. Scheduler construction sites, dissolve authority, shutdown ordering,
  Team-wide quiescence, and completion availability fencing are unchanged.
- A fresh Node process imports the built package main and asserts `Server`,
  imports the built service facade and asserts its exact existing value-export
  set, and still executes the built CLI `--version` path successfully.
- The implementation diff is limited to the planned file list and contains only
  the declaration/seam refactor, necessary import rewiring, focused gates,
  normal formatting, built-smoke correction, proposal indexing, and
  current-state documentation. No Rush change file is expected because there is
  no user-observable or upgrade-relevant change; if implementation reveals one,
  stop and amend this proposal before proceeding.

## Validation

Run from the monorepo root, in this order:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js lint --to @excitedjs/dreamux
node common/scripts/install-run-rush.js typecheck --to @excitedjs/dreamux
node common/scripts/install-run-rush.js typecheck:tests --to @excitedjs/dreamux
node common/scripts/install-run-rush.js build --to @excitedjs/dreamux
node common/scripts/install-run-rush.js test --to @excitedjs/dreamux
node common/scripts/install-run-rush.js smoke-built-cli --to @excitedjs/dreamux
.agents/scripts/check.sh
git diff --check
```

The full test run must include coverage for `architecture-ownership-gate`,
`team-channel-coordinator`, `team-dissolve-contract`,
`team-dissolve-acceptance`, `team-dissolve-quiescence`,
`team-dissolve-recovery`, `collaboration-space-race`,
`collaboration-space-repo-close`, `dispatcher-collaboration-space`,
`channel-service-feishu-topic-auth`, `team-scheduler`, and
`team-leader-handle`. `smoke-built-cli` runs after build and must load the
package main and service facade before it can be cited as an ESM initialization
gate.

## Review adjudication rationale

Accepted findings are reflected above: preserve a facade entry-timestamp test;
give Dispatcher real headroom by moving the existing channel-tool lease
coordination; remove both dissolve-result wrappers; eliminate proposed type
dependency pairs; add a syntax-aware type-import gate; load the built service
graph directly; replace the stateless input-source split with a lifecycle owner;
enforce direct type-owner imports across namespace syntax and re-exports;
consolidate the workspace and factory dependency contracts; and update the
affected topology claims.

The following recommendations were consciously not adopted as written:

- Moving `TeamServiceDeps`, `TeamServiceCreateOutput`, or
  `TeammateCollectionOptions` into the proposed lower type modules was rejected.
  Type-only erasure prevents a runtime cycle but does not make the resulting
  source-level dependency pair an honest layer. Keeping these three declarations
  local still leaves adequate line headroom.
- Leaving `projectDispatcherDissolveResult` in TeamCollection and having the
  coordinator call it directly was rejected while its wrapper-removal intent was
  accepted. Current source shows the constant and algorithm are
  Dispatcher-specific and have no other production consumer, so leaving them
  below the coordinator would preserve the double-owner problem the seam is
  meant to remove.
- Removing the `export` modifiers from `WorkflowRunDeps`, `RuntimeLaunchSpec`,
  and `CollaborationTargetLifecycleOptions` was rejected as opportunity cleanup.
  It provides no line headroom and would add unrelated implementation files to
  a behavior-only refactor.
- Enabling a repository-wide consistent-type-import lint rule was rejected as a
  speculative enforcement expansion. A targeted syntax-aware ownership test
  proves the exact invariant for the five touched contract modules without
  changing unrelated packages or style policy.

## Out of scope

- New public service, admin, MCP, DTO, persistence, configuration, or provider
  capabilities.
- A second dissolve controller, operation-registry abstraction, admission state
  owner, projection DTO/capability, or any movement of dissolve
  settlement/retry authority.
- Moving Scheduler construction or lifecycle ownership.
- Splitting `workflow-service/run.ts`, `dissolve-controller.ts`,
  `collaboration-routing.ts`, or `target-lifecycle.ts` merely because they are
  near the line limit.
- General service-facade cleanup, composition-root extraction, stop-sequence
  extraction, anonymous-type naming, private-export cleanup, repository-wide
  lint-policy changes, state/config changes, changelog work, or unrelated
  formatting.

## Open decisions

None. Further `TeamDissolveController` growth is deliberately deferred until a
stateless admission boundary can be justified without creating a second state
owner.
