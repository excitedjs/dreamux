# Implementation Plan: Minimal Provider Boundaries

## Authority

This plan executes the current requirement baseline at SHA-256
`996580fa8f32fdd09795d79f6639581f4a9e70cdb3cdaf13b66f2b8f8083e9dd`
and the current technical design baseline at SHA-256
`c456165258757c1ea6df8a753691d118b691fca379e65205f9c3450395e7c452`.
The operator granted development approval on 2026-08-27 with the staged
protocol below. Recorded product decisions remain authoritative over
implementation convenience only for the scenarios they explicitly cover.
Neither document is authority to discard a conflicting current-code behavior or
historical Decision that the design did not examine.

## Operating protocol

1. One Claude-runtime TeamMate acts as the Developer across all production-code
   stages so implementation context and ownership stay continuous.
2. Stage 0 deletes whole test files whenever any fixture, assertion, or import in
   that file is coupled to a replaced contract or removed architecture. It does
   not edit such files to preserve unrelated cases inside them. Only wholly
   unrelated test files stay intact. New coverage is intentionally deferred
   until the production design is complete.
3. After every production stage, the TeamLeader reviews the whole stage diff
   only for drift from the frozen requirement/design and for unexpected scope.
   Intermediate typecheck, build, and coverage are not stage gates and may be
   broken while the incompatible refactor is in flight.
4. If a stage contains an unexpected change, the TeamLeader asks the Developer
   why it is required before accepting the stage. If implementation discovers a
   product or architecture scenario not covered by the design, or any conflict
   between the written baseline and a load-bearing current-code behavior,
   consumer, protocol, or prior Decision, work stops. The TeamLeader presents
   the concrete evidence and consequence to the operator; neither agent treats
   the document as an implicit override or invents the missing rule.
5. After all production stages, the Developer reconciles the full tree until
   type checking succeeds and distributable artifacts build. This is the first
   mandatory compile/build gate.
6. Three standing Reviewer roles independently review the completed production
   implementation. No review finding is fixed until the TeamLeader presents the
   proposed correction to the operator and receives explicit approval.
7. Only after the production body and approved review corrections are complete,
   the Developer launches ultracode and orchestrates multiple Sonnet nodes to
   create the complete replacement test suite in one dedicated testing stage.

## Stage ledger

### Stage 0: remove coupled tests

- Inventory and delete entire test files that cover the replaced Agent Runtime
  and Channel contracts, provider loader shapes, transcript/Activity boundary,
  admin method dispatch, Channel routes/binding, Core Collaboration Space, old
  event names, wait-idle scheduler/dissolve behavior, or superseded Feishu
  routing/MCP behavior. Do not split mixed files or retain individual cases from
  an in-scope file.
- Preserve only test files wholly unrelated to this architecture task.
- Validation: deletion scope matches the frozen replacement surface; no product
  source is changed in this stage.

### Stage 1: public contracts

- Replace `@excitedjs/dreamux-types` Agent Runtime and Channel contracts.
- Add generic Provider-owned session identity, `start/submit/stop`, leased push
  state, neutral recent Activity Records, Channel lifecycle/ports, Channel MCP
  composition, canonical Command/event types, and required root exports.
- Retain neutral system-prompt replace/append forms: Dispatcher supplies both
  and each Provider selects its native mechanism; TeamLeader remains
  append-only for every Provider, with no Core Provider-id branch.
- Delete the old public members and Core Collaboration Space/binding types with
  no compatibility aliases.
- Validation: every mandatory member has a frozen use case; no provider-specific
  field crosses a neutral seam.

### Stage 2: Agent Runtime providers and Core runtime ownership

- Migrate Codex and Claude Code providers to the new contracts.
- Implement mandatory continuous recovery, session-bound structured output,
  leased state updates, optional live activity, and active-session recent
  Activity reads.
- Reshape Core runtime ownership, admission, settlement, restart notice, and
  `last` without weakening existing invariants.
- Validation: implementation follows sections 1 and 4 of the final design; no
  Core branch on concrete Provider identity appears.

### Stage 3: unified Core Command registry

- Replace `adminMethods` as an authority with domain-owned canonical Command
  definitions and one `CoreCommandRegistry`.
- Adapt both `admin.sock` NDJSON and Channel in-process `invoke` to that registry
  without exposure policy or duplicate schemas/handlers.
- Normalize all surviving Server, Dispatcher, Team, TeamMate, Workflow,
  Scheduler, and Channel-MCP infrastructure names; delete superseded names and
  Core Collaboration Space Commands.
- Implement durable `team.create` request idempotency and the unified
  `team.submit` admission boundary.
- Validation: every inventoried current admin method is retained, renamed, or
  deleted exactly as the final design says; both adapters resolve the same
  definition.

### Stage 4: Channel lifecycle, events, and MCP proxy

- Replace `ChannelRoutes` with direct lifecycle plus `invoke` and event source.
- Implement the six-event Team/TeamMate catalog and preserve current COT
  projection, redaction, truncation, and fail-open delivery semantics.
- Implement Channel MCP catalog registration, official-SDK stdio shim,
  lease-bound `channel.mcp.describe`/`channel.mcp.invoke`, live/sessionless
  dispatch, and Dispatcher/TeamLeader injection only.
- Validation: base Channel interfaces stay small; MCP remains optional
  composition; Core contains no provider tool-name branch.

### Stage 5: Feishu-owned routing and provisioning

- Move direct bindings, hierarchy/fallback, persistence, stale-binding cleanup,
  and list/unbind/bind tools into Feishu Channel.
- Move Collaboration Space policy and its four Dispatcher-only MCP tools into
  Feishu Channel while keeping Team as the only Core collaboration container.
- Implement idempotent child-target provisioning through `team.create` and
  `team.submit`, plus Channel-owned COT anchor migration.
- Validation: no external selector or binding mirror enters Core; unbinding a
  Collaboration Space never dissolves existing Teams.

### Stage 6: remove old Core domains and reshape lifecycle

- Delete Core binding and Collaboration Space services, state, config, MCP,
  admin, events, and routing callbacks.
- Remove `waitIdle`; submit scheduled fires immediately with folding allowed.
- Implement immediate Team dissolve, trigger-specific preflight, stop-first
  self-dissolve, post-stop worktree recheck, explicit force containment, and
  asynchronous physical cleanup.
- Add fail-loud incompatible state/config cutover and required maintenance/change
  records.
- Validation: removal is complete, destructive scope is contained, and no old
  authority survives behind an adapter.

### Stage 7: whole-tree compile and build reconciliation

- Resolve all cross-stage type and integration breaks without changing the
  frozen architecture.
- Run the monorepo type/build path until distributable artifacts succeed.
- Validation: type checking and build pass; any required design deviation stops
  for operator clarification.

### Stage 8: standing reviews and operator-controlled corrections

- Run independent Codex, Claude, and Seed/Trae reviews over the complete
  production diff and frozen inputs.
- Consolidate only concrete current findings with evidence and smallest fixes.
- Present each correction round to the operator and wait for explicit approval
  before changing code.

### Stage 9: replacement test suite

- Return the approved production tree to the same Developer.
- The Developer launches ultracode and orchestrates multiple Sonnet nodes to
  implement comprehensive new contract, behavior, architecture, migration, and
  live-path tests in one dedicated pass.
- Run the full Rush build/test gates and all applicable live runtime suites.

### Stage 10: closeout

- Finish Rush change files, current architecture/maintenance knowledge, public
  documentation, issue/PR evidence, and final clean-tree verification.
- Close the task only after the implementation, tests, review corrections, and
  required gates are complete.

## Stop conditions

- A newly discovered product or architecture scenario is not answered by the
  frozen requirement or design.
- A proposed implementation needs a provider/channel special case in Core, a
  second state authority, an exposure policy, a compatibility alias, or another
  rejected alternative.
- A Reviewer proposes a code correction and the operator has not approved that
  correction round.
- A destructive operation would exceed the exact owned managed-worktree scope.
