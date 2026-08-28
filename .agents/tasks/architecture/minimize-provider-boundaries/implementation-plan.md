# Implementation Plan: Minimal Provider Boundaries

## Authority

This plan executes the current requirement baseline at SHA-256
`acf90312dbeb02861654172943f1fd016de04d6c7c6a6c9c155e78889d0d5f28`
and the current technical design baseline at SHA-256
`30fa81118a9008eb28d171113bc87cb9e5acfe9fbf78d3028efd49aa67c28010`.
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
   for requirement/design drift, unexpected scope, and architectural integrity.
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

## TeamLeader supervision charter

The Developer owns implementation; the TeamLeader owns architectural judgment
and actively challenges the implementation. A stage is not acceptable merely
because it follows the written design, compiles locally, or appears mechanically
complete. The TeamLeader must inspect the code and ask why each non-obvious
choice exists before accepting it.

Every stage review explicitly tests the following questions:

- Which layer is authoritative for each fact, state transition, and action?
- Why does each value cross its boundary, and can the owning layer keep it
  instead?
- Does the change duplicate a capability or state already owned elsewhere?
- Should a reusable capability replace a provider, transport, or caller special
  case?
- Do domain namespaces, file placement, types, and function names describe the
  real ownership and behavior?
- Are concurrency, lifecycle, shutdown, recovery, and failure semantics closed
  without hidden races or partial authority?
- Did the implementation introduce compatibility glue, temporary adapters,
  parallel mechanisms, or dead legacy surfaces outside the approved design?
- After deletions and moves, is there exactly one authoritative mechanism and a
  complete cleanup trail?

When the answer is not evident from current source and prior Decisions, the
TeamLeader challenges the Developer for the necessity, alternatives, and
affected invariants. The TeamLeader resolves technical and layering questions
from evidence instead of escalating routine implementation details. Work stops
for the operator only when a genuinely unmodeled choice changes product
behavior, externally visible semantics, persistence, destructive data handling,
or another policy that cannot be derived safely from existing evidence.

## Operator-raised cases

These are concrete failures caught by the operator during this task. They are
mandatory review precedents, not historical anecdotes:

1. **System prompts were flattened to one string.** The written design omitted
   a load-bearing current behavior and the Stage 1 contract mechanically
   followed it. The review should first have inspected all current consumers and
   prior Decisions. The retained neutral contract has ordered `replace` and
   `append` forms: Dispatcher supplies both representations, each Provider
   selects one native mechanism, and TeamLeader, ordinary TeamMate identity, and
   Workflow operation prompts remain append-only. Dreamux reconstructs and
   re-supplies the bundle whenever a runtime context is created; Provider-native
   resume retention is never authoritative.
2. **The merged submit method kept a replacement `kind` discriminator.** Removing
   `channelInput` and `completionInput` while recreating the same split inside a
   union was a rename, not a boundary reduction. The mandatory challenge is why
   identical runtime behavior needs a source taxonomy. Agent Runtime now accepts
   only final text; Channel renders its own external XML before invocation, and
   Core retains origin and display facts without sending them through the
   Provider seam.
3. **`sourceId` and duplicate policy were left in every Provider adapter.** The
   correct question was which layer owns stable invocation identity. Core knows
   the target entity and invocation origin, so Core owns the bounded
   process-local admission ledger and public `duplicate` result. Agent Runtime
   receives no source id and contains no Dreamux idempotency policy.
4. **Written baselines were treated as authority over unexamined source.** A
   requirement or design snapshot only governs scenarios it actually modeled.
   When current code, a real consumer, a protocol invariant, or a prior Decision
   conflicts with it, implementation stops and the conflict is investigated;
   the code is never mechanically reshaped to make the document true.
5. **Domain names reflected transport mechanics instead of ownership.** Generic
   names such as `turn.submit`, `agent.state`, and unscoped `turn.tool_call`
   obscured the entity boundary. The locked vocabulary is `team.submit`,
   `teammate.state`, and `teammate.turn.*`; Dispatcher and TeamLeader are also
   TeamMates. The same ownership rule applies to modules, files, internal types,
   and function names, not only public strings.
6. **The first Command design confused today's Feishu usage with the platform
   catalog.** Feishu currently needs only `team.submit` and `team.create`, but
   that is a consumer fact, not an exposure policy. `admin.sock`, Channel
   invocation, CLI adapters, and Agent MCP facades delegate to one canonical,
   domain-namespaced Core Command registry. Do not build a second registry or an
   exposure-policy layer.
7. **The Channel-MCP-to-Agent path was initially missing.** Tool definitions are
   registered in the official-SDK MCP shim used by Dispatcher and TeamLeader.
   Each invocation is forwarded through `admin.sock` to Core, then dispatched
   through the canonical Command mechanism to the owning Channel. A design that
   shows only Channel-to-Core Commands is incomplete unless this reverse tool
   path, its caller context, lease, lifecycle, and error return are also closed.
8. **Deleting the Core Collaboration Space container was over-applied to the
   product flow.** Core does not regain a Collaboration Space domain object, but
   Feishu retains Dispatcher-only Channel MCP tools for binding, unbinding,
   getting, and listing its Channel-owned collaboration-space policy. Automatic
   provisioning composes ordinary Team Commands. Deleting an owner does not
   imply deleting a user capability that can be cleanly re-owned.
9. **Binding was modeled around Feishu identifiers inside Core.** Topic and chat
   hierarchy are Channel knowledge. Channel owns its opaque local binding state
   and selects a TeamLeader target before `team.submit`; Core does not interpret
   provider metadata or rebuild parent-topic fallbacks. A composite view may
   deliberately require separate Team and Channel reads rather than duplicating
   binding authority in Team state.
10. **A minimal consumer payload was mistaken for the canonical Command
    capability.** Feishu automatic provisioning only needs a repository path and
    base ref, but the existing transport-neutral `team.create` path also supports
    reusing a cwd and controlling managed-worktree branch, slug, and cleanup.
    The shared Command preserves that discriminated union; Feishu maps its small
    local policy into managed mode with `delete-on-close`. Never delete a broader
    load-bearing domain capability merely because the first migrated consumer
    uses a smaller subset.
11. **`last` was treated as settled transcript history.** Its actual user story
    is observing a TeamMate that may remain inside one active turn for an hour.
    Provider-owned recent Activity Records therefore cover the growing active
    session and expose assistant messages plus tool name/status; Dreamux state is
    queried separately. A neutral name alone is insufficient if the consumer
    story still fails.
12. **`waitIdle` was defended after its product purpose had disappeared.** Team
    dissolve is destructive cancellation, not graceful drainage: stop Workflow
    and TeamMate processes immediately, fence further work, check owned worktree
    safety, allow explicit `force`, and move expensive physical cleanup to the
    background. Do not preserve a capability merely because old orchestration
    consumed it.
13. **COT was at risk of being redesigned as a reliable event system.** Its
    current display is intentionally a live, best-effort projection: Provider
    emits normalized activity, Core applies the existing redaction/projection,
    and Channel consumes the event without replay, retransmission, or local
    message storage. Preserve the tuned presentation and fail-open behavior;
    lifecycle correctness belongs to Core state, not the COT stream.

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
- Keep Agent Runtime `submit` and `team.submit` flat: Channel renders its final
  model-facing XML/text before invocation, and neither seam retains an inbound
  versus text discriminator.
- Keep `source_id` and duplicate admission in Core. Agent Runtime `submit`
  accepts text only and contains no Dreamux dedupe policy.
- Retain neutral system-prompt replace/append forms: Dispatcher supplies both
  and each Provider selects its native mechanism; TeamLeader remains
  append-only for every Provider. Preserve ordinary TeamMate and Workflow
  operation-owned append fragments in their existing order, and re-supply all
  Dreamux-owned prompt sources on every runtime-context rebuild, with no Core
  Provider-id branch.
- Delete the old public members and Core Collaboration Space/binding types with
  no compatibility aliases.
- Validation: every mandatory member has a frozen use case; no provider-specific
  field crosses a neutral seam.

### Stage 2: Agent Runtime providers and Core runtime ownership

- Migrate Codex and Claude Code providers to the new contracts.
- Implement mandatory continuous recovery, session-bound structured output,
  leased state updates, optional live activity, and active-session recent
  Activity reads.
- Re-supply ordered append-only prompt fragments on fresh launch,
  close/reopen, process restart, Team rebuild, and resume. Codex maps them to
  `developerInstructions`; Claude Code maps them to
  `--append-system-prompt`. Preserve operation fragments before persisted
  TeamMate identity guidance.
- Reshape Core runtime ownership, admission, settlement, restart notice, and
  `last` without weakening existing invariants.
- Remove runtime-owned Channel rendering and source-kind branching. Preserve
  only prepared text at the Provider seam; keep source identity, bounded
  process-local dedupe, origin, correlation, and event source in Core-owned
  admission/turn state.
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
- Move the current external-message XML rendering into Feishu Channel so its
  `team.submit` invocation already contains final model-facing text.
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
