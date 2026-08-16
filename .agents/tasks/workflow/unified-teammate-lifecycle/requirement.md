# Requirement

## Initial request

Reconstruct the intended requirement behind
[issue #328](https://github.com/excitedjs/dreamux/issues/328),
[PR #329](https://github.com/excitedjs/dreamux/pull/329), and
[PR #330](https://github.com/excitedjs/dreamux/pull/330), then replace their
competing Workflow-local teardown designs with an architecture-first lifecycle
model.

The target outcome is not merely to make `workflow_stop` return later. Workflow
agents must remain ordinary TeamMates created through the scope's existing
`TeammateCollection`, while every module owns a coherent capability set and
closes its own lifecycle without another module recreating that lifecycle.

PR #316 is explicitly excluded because Feishu currently provides no
authoritative topic-close event or readable closed state.

### Operator architecture red line

The following operator wording is preserved verbatim because it defines the
failure mode this task must eliminate:

> 第 3 点，其实我觉得也不太对，就是说，关闭 TeamMate 不应该经过 TeamMate Collection。而应该是 TeamMate 对外抛出事件，由 TeamMate Collection 监听事件之后，把它从自己的引用中移除掉
> 整体的设计，为什么我总是强调必须要有架构师？让架构师把控住每个模块到底应该包含什么样的能力？它应该怎么样自闭环的管理自己的生命周期？先把我说的这些都明确到 Task 里。

> 需求主干的第三点需要扩散一下范围，既然 Stop 是这个样子控制的，那肯定有大量的代码都是类似的场景，需要把它们的依赖关系反转过来。这个地方，我感觉发布订阅模式还是挺有用的。而且之前也已经给部分模块继承了 eventemitter 了。
> 这个作为基础方案设计的要点，先把 TeamMate Service 和 TeamMateCollection 和 Workflow Service 三者之间给我捋清楚依赖关系

> 你这几个技术问题问的太白痴了，我架构不是已经告诉你了吗？不要搞那种正向依赖关系，就是为了让 TeamMate Collection 感知到 TeamMate 关闭了，需要通过 TeamMate Collection 的 Close 调用到 TeamMate 的 Close。这个设计太白痴了，太傻逼了，我不知道是怎么写出来的

These quotes are normative for architecture review. The task must not preserve
the current dependency direction merely by renaming `close`,
`releaseAllOwned`, or their DTOs. A subscriber's need to observe an entity fact
must never force the fact-owning entity's command path to route through that
subscriber.

## Current alignment

- Status: Confirmed; requirement clarification is complete and the task is
  ready for architect-led technical solution.
- Source baseline inspected during clarification:
  `6b8ec14b080389bf6c6ae36fa336ec0451e401ec`.

### Confirmed current behavior

- `WorkflowRun` calls `OwnedTeammateOps.spawnOwned()` and records the returned
  concrete TeamMate `name` and `turn_id` in its own Workflow agent record.
  Workflow therefore already has the durable business fact that relates a run
  agent to a TeamMate.
- `TeammateCollection.spawnOwned()` uses the same identity store, worktree
  preparation, `TeammateService` factory, runtime-provider seam, turn store, and
  live entity cache as ordinary TeamMate creation. There is no separate
  Workflow-only runtime tree.
- Workflow-created TeamMates are in the collection's normal identity roster.
  The existing `list`, `status`, `history`, and `last` read paths therefore make
  them visible through the normal TeamMate MCP surface.
- The collection currently keeps a process-local
  `Map<TeamMateName, OwnedTeammateOwner>`, rejects ordinary `send` and `close`
  operations for entries in that map, and implements Workflow cleanup through
  `releaseAllOwned(owner)`.
- After current owner release succeeds, the collection removes the process-local
  exclusivity entry and evicts the live entity but retains its durable identity
  and history. A later ordinary `send` resolves that identity, reopens the
  closed TeamMate through `ensureStarted({ reopenClosed: true })`, and continues
  it as a normal TeamMate. This behavior has focused test coverage.
- `TeammateService.close()` and owner-only `release()` already converge on
  `transitionToClosed()`. That method stops the runtime first, then drains local
  submission and settlement persistence, performs any entity-owned worktree
  cleanup, and persists the identity as closed.
- `teammate_close` does not call `waitIdle()` and does not wait for an active
  model turn to finish naturally. Both built-in runtimes stop their resident
  process group through `SupervisedChild`: signal `SIGTERM`, wait for at most
  one second by default, then signal `SIGKILL`.
- The current Workflow stop path returns the reserved `stopped` result before
  finalization completes. Finalization drains agent tasks before it asks the
  collection to release Workflow-owned TeamMates, so a turn that never settles
  can keep the Workflow durably running and can hold Team dissolve at its writer
  idle barrier.

### Desired outcome

Establish one architecture in which:

1. Workflow-created agents are the same `TeammateService` entities exposed by
   the existing TeamMate collection and MCP read surfaces.
2. `WorkflowService` owns Workflow membership, orchestration state, and the
   decision of when its borrowed TeamMates should close.
3. Each `TeammateService` owns and self-closes its complete entity lifecycle.
4. `TeammateCollection` owns construction, registration, lookup, roster reads,
   caching, and observation of contained TeamMates, but does not own or recreate
   an entity's close state machine.
5. Lifecycle coordination occurs through explicit capabilities and events,
   rather than Workflow-specific grace periods, runtime-kill logic, synthetic
   Agent lifecycle states, or collection-owned teardown orchestration.
6. The refactor is not limited to Workflow stop. Every dependency among
   `TeammateService`, `TeammateCollection`, and `WorkflowService` that exists
   only so an outer container can observe an inner entity fact must be audited
   and reversed to entity-owned state plus fact publication.

## Required ownership model

### WorkflowService

`WorkflowService` owns the business relationship between a Workflow run and the
agents it created. Its durable records remain the source of truth for which
concrete TeamMate represents each Workflow agent.

It may:

- borrow the scope's existing TeamMate creation capability;
- retain the returned TeamMate identity or lifecycle capability;
- decide when Workflow admission closes and when each borrowed TeamMate must
  close;
- consume TeamMate completion/closed outcomes;
- persist Workflow agent and run results.

It must not:

- construct an Agent Runtime or a parallel TeamMate entity;
- define how a TeamMate waits, cancels, kills, persists, or closes;
- add a Workflow-only natural-settle grace window;
- interpret provider-specific process or turn behavior;
- recreate TeamMate close single-flight, runtime termination, or settlement
  logic inside Workflow finalization.

### TeammateService

`TeammateService` owns the complete lifecycle of one TeamMate. Closing a TeamMate
must be a self-contained entity operation, including:

- owning one exclusive process-local `lock()` capability for temporary
  orchestration membership;
- closing admission for new turns and preventing a concurrent start/reopen from
  crossing the close boundary;
- immediately cancelling current work rather than waiting for natural model
  completion;
- asking the runtime provider to terminate its resources;
- ensuring built-in runtime teardown is bounded and escalates to force-killing
  the resident process group;
- converging unfinished turns to an observable stopped outcome;
- draining and persisting entity-owned turn and identity state;
- performing only cleanup that the entity itself owns;
- reaching one idempotent closed result under concurrent callers;
- publishing an explicit lifecycle event after the relevant close transition.

The exact event payload and publication point remain a technical-design
decision, but the event must report an entity-owned fact rather than ask another
module to finish the close.

`lock()` is the required active-Workflow write fence. It returns a restricted,
entity-owned handle that authorizes the owning Workflow to submit and close that
TeamMate. While the lock is held, every ordinary side-effecting entry point on
the TeamMate rejects before it can start, reopen, submit to, steer, close, or
otherwise mutate the runtime or identity.

The lock remains held through TeamMate close and Workflow terminal persistence.
Closing a locked TeamMate does not implicitly unlock it. After the Workflow
terminal journal and record agree, the Workflow unlocks the TeamMate. If the
TeamMate is already durably closed, unlock triggers the terminal lifecycle fact
that lets the Collection remove its live reference. This prevents a public
`send` from reconstructing or reopening the TeamMate before the Workflow itself
is durably terminal.

### TeammateCollection

`TeammateCollection` is the shared container and directory for TeamMates in one
dispatcher or Team scope. It owns:

- the one creation path and `TeammateService` factory;
- durable roster and turn-store access;
- live entity registration and lookup;
- normal TeamMate read surfaces;
- subscriptions to contained entity lifecycle events;
- removal of a closed entity from its live references/cache after observing the
  entity's close event.

The collection must not be the owner of the TeamMate close state machine.
Closing a TeamMate must not require the collection to execute the entity's
shutdown steps and then manually evict it as a second lifecycle owner.

A public adapter may resolve a TeamMate through the collection, but the
collection must not wrap `TeammateService.close()` merely so it can perform
post-close bookkeeping. The resolved entity or an entity-scoped command handle
executes the close; the collection learns the committed result from the
TeamMate's lifecycle event and updates only its own index/cache.

The process-local lock belongs to `TeammateService`; no separate claim registry,
public command adapter, or Workflow anti-corruption port is required. Existing
scope admission wrappers may continue to resolve a TeamMate through the
Collection and call its public methods. The TeamMate itself enforces the lock,
and the Collection performs no post-command lifecycle bookkeeping.

### Dependency direction

The technical solution must establish these directions:

- composition root -> constructs and wires `TeammateCollection`,
  `WorkflowService`, and their event subscriptions;
- `TeammateCollection` -> constructs/registers `TeammateService` and exposes
  entity lookup/read projections;
- `WorkflowService` -> depends on a narrow TeamMate creation/attachment
  capability and on the restricted handle returned by `TeammateService.lock()`,
  not on collection-owned bulk lifecycle verbs;
- `TeammateService` -> owns commands and publishes committed lifecycle/turn
  facts through a narrow publisher or entity event source;
- `TeammateCollection` and `WorkflowService` -> subscribe to the facts they need
  and update only their own state;
- no event subscriber -> is called synchronously as a required step for the
  publisher to complete its own state transition;
- no `TeammateService` implementation -> imports a capability from
  `teammate-collection`; shared runtime-resolution or construction support must
  live in a neutral lower module.

The architect must audit the full direct dependency surface, not just close:

- public `send` and `close` forwarding;
- Workflow `spawnOwned` / `releaseAllOwned`;
- live runtime enumeration and shutdown sweeps;
- spawn failure rollback;
- settle capture/drain callbacks;
- completion routing callbacks;
- worktree-state synchronization;
- runtime/config resolution imports;
- cache eviction and restart/reopen materialization.

For each dependency, the final solution must name the authoritative owner,
whether the interaction is a command, query, or fact event, and why the
resulting dependency direction does not make an observer part of the owner's
lifecycle state machine.

### Shared entity, distinct responsibilities

One Workflow-created TeamMate participates in two valid views:

- the Workflow view identifies it as one run agent with an index, task, result,
  and close timing;
- the collection view identifies it as one ordinary TeamMate in the scope's
  roster, history, runtime cache, and MCP read surface.

These are two responsibilities over the same entity, not two entity trees and
not ambiguous business ownership.

TeamMate identity and lifecycle must remain independent from any one Workflow
membership. The current MVP creates fresh TeamMates while a Workflow runs, but
the architecture must also admit a later capability that attaches an already
existing TeamMate to a Workflow:

- a TeamMate first created through ordinary TeamMate tools may later participate
  in a Workflow;
- a TeamMate originally created for one completed Workflow may later participate
  in another Workflow;
- leaving or completing a Workflow does not consume, replace, or permanently
  classify the TeamMate identity.

This later attachment/re-orchestration capability is not implemented in this
task. It is nevertheless a design constraint: the chosen ownership, lease,
event, routing, and close contracts must not encode "created by this Workflow"
as an irreversible entity kind or assume that one TeamMate can belong to only
one Workflow across its lifetime.

A future attach-existing operation resolves the existing TeamMate and invokes
the same entity-owned `lock()` capability. Fresh Workflow creation and future
attachment therefore differ only in how the same `TeammateService` is obtained,
not in membership, mutation, close, or unlock semantics.

## Required behavior

### Immediate cancellation

- Explicit Workflow stop immediately closes Workflow agent admission and asks
  every already-created Workflow TeamMate to close.
- It does not preserve an in-flight turn for an additional natural-completion
  grace period.
- Queued work that has not created a TeamMate must not create one after stop.
- A close that races entity creation must have one architecturally owned
  linearization point: either creation becomes visible and is closed, or it is
  rejected and cleaned up without leaking a runtime or durable half-entity.

### One TeamMate close contract

- `teammate_close`, Workflow stop, Team dissolve, and Server shutdown must rely
  on the same TeamMate-owned close behavior. They may differ in scope and
  initiation timing, not in what it means to close one TeamMate.
- A normal in-flight turn is not a reason for close to fail or wait without
  bound. The built-in worst case is bounded runtime termination followed by
  force kill.
- Runtime termination, durable TeamMate closure, turn settlement, and optional
  filesystem cleanup are distinct facts. The final design must not collapse
  every error into an ambiguous "release failed" state.
- A successful public or owner close means both that the live runtime is
  terminated and that the TeamMate's durable identity has committed `closed`.
  A failure after runtime termination but before durable closure returns an
  operation error; recovery must preserve the fact that no runtime remains
  instead of describing the TeamMate as still executing.

### Workflow terminal consistency

- A successful `workflow_stop` must not claim a terminal Workflow while its
  borrowed TeamMates continue running.
- Workflow status/list, Workflow journal/record, agent records, and the actual
  TeamMate lifecycle facts must converge without a second Workflow-specific
  Agent close model.
- Late runtime or completion callbacks must not resurrect or rewrite an already
  closed TeamMate or terminal Workflow agent.
- Team dissolve must not remain indefinitely at `waiting_for_team_idle` because
  a Workflow-owned TeamMate was never asked to execute its normal close.
- Server shutdown is a process-wide caller of the same entity capability; it
  must not introduce a different Workflow-Agent resource lifecycle.

### In-process Turn objects

- Dreamux service-layer code represents one accepted logical turn as one object,
  not as a unique string plus a lookup map.
- An Agent Runtime submission returns a `RuntimeTurn` object whose terminal
  outcome is exposed through an idempotent promise/latch. A runtime fold or
  steer into an already-active logical turn returns the same object.
- `TeammateService` owns a `Turn` object that directly retains the runtime turn,
  prompt/origin/intent, timestamps, terminal state, persistence task, and the
  completion-delivery closure captured from the initiating caller.
- `WorkflowRun.AgentCall` retains the concrete `Turn` object. It does not write
  an ID and later accept a callback that must be matched back to the call.
- Entity close iterates its active `Turn` objects and reserves `stopped` for any
  unresolved turn. Runtime completion and close-induced stop compete on the
  same object-owned one-shot latch, so only one terminal outcome can win.
- A normal send captures its initiator in the Turn's completion-delivery
  closure. Settlement invokes the shared bounded delivery policy directly; no
  `producerName + turnId -> initiator` registration or reverse lookup is used.
- Turn history persists one complete terminal record from the settled Turn
  object. It does not append separate submit/settled rows and later join them by
  ID.
- Dreamux service records, Workflow records/journal rows, TeamMate MCP receipts,
  `last`/history results, and Channel turn events do not expose a turn ID merely
  to preserve this in-process relationship.
- The current Channel `turn.submitted` / `turn.settled` events have no
  production subscriber and are removed from the current Channel provider
  contract rather than retained as a speculative reason to serialize a Turn
  identity. A future external turn-feed feature must define a self-contained
  event contract from a real consumer requirement.
- Provider-native IDs stay inside the runtime provider implementation only when
  the provider protocol requires them. Codex may use app-server `turn.id` to
  correlate its own notifications. Claude Code may use native message UUIDs
  internally, but Dreamux core neither requests nor interprets them.
- Claude Code's synthetic `claude-turn-<runtime>-<counter>` identifier is
  removed together with the service-level turn-ID contract.

### Visibility

- Workflow-created TeamMates remain visible through the existing scoped
  TeamMate `list`, `status`, `history`, and `last` surfaces during and after
  their lifecycle, subject to the same durable-history rules as other
  TeamMates.
- Closing and live-cache removal must not erase their durable identity, history,
  or Workflow linkage.
- While a TeamMate has an active Workflow membership, ordinary TeamMate `send`
  is prohibited. The active membership is an exclusive write claim: only the
  Workflow may submit the turn(s) defined by its orchestration.
- The active-send fence protects the Workflow's deterministic call graph,
  per-call schema, turn/result correlation, concurrency accounting, and terminal
  result. An unrelated TeamLeader turn must not be folded into or race the
  Workflow-owned call.
- The public TeamMate surface for an active Workflow member is read-only.
  `list`, `status`, `history`, and `last` remain available, but every
  public operation with entity or runtime side effects is rejected, including
  individual `send` and individual `close`.
- The only public cancellation command for active Workflow members is
  `workflow_stop` for the owning run. The Workflow closes its membership and
  asks every affected TeamMate to execute the normal TeamMate-owned close
  lifecycle as one coordinated Workflow transition.
- An operator cannot partially mutate or terminate one active Workflow member
  through the ordinary TeamMate MCP surface. A partial side effect could change
  dependency inputs, schema outcomes, concurrency, or the final Workflow
  result, so control must remain at the Workflow boundary.
- After its Workflow has completed or stopped and released its active
  orchestration claim, the closed TeamMate must support the existing ordinary
  `send` behavior: reopen from its persisted runtime-native checkpoint/session
  and continue as a normal TeamMate. Workflow completion does not permanently
  make the TeamMate read-only or unsendable.
- Reopening the TeamMate after Workflow completion starts a new ordinary
  TeamMate turn. It does not reopen, mutate, or append work to the already
  terminal Workflow run.
- After Workflow membership ends, the ordinary TeamMate mutation surface is
  restored. Subsequent `send` and `close` act on the retained TeamMate identity,
  not on the terminal Workflow.

## Scope

- Architecture and contracts across `WorkflowService`, `WorkflowRun`,
  `TeammateCollection`, and `TeammateService`.
- A complete direct-dependency audit across those modules, including non-stop
  lifecycle, routing, runtime visibility, failure cleanup, and shutdown paths.
- Reversal of dependencies whose only purpose is to let a container observe a
  contained entity's committed fact.
- The internal creation/lifecycle capability returned when Workflow borrows a
  TeamMate from the collection.
- Entity lifecycle events and collection subscription/eviction behavior.
- Workflow stop and terminalization ordering.
- Workflow-created TeamMate behavior during Team dissolve and Server shutdown.
- Built-in Codex and Claude Code teardown only where needed to satisfy the
  common TeamMate close contract.
- Focused concurrency, lifecycle, persistence, and integration tests.
- Current architecture, Dynamic Workflow, provider-runtime, and maintenance
  documentation affected by the final design.

## Non-goals

- A Workflow-specific Agent entity, runtime tree, close state machine, or
  provider cancellation API.
- A natural-completion grace period after explicit stop.
- Workflow replay/resume or configurable stop policies.
- Replacing TeamMate history or scoped MCP read surfaces.
- Changing worktree safety rules or deleting branches/refs.
- Feishu topic-close inference or PR #316.
- Picking an arbitrary MCP timeout before the bounded service lifecycle is
  designed and measured.
- Implementing attachment or re-orchestration of a pre-existing ordinary or
  historical Workflow TeamMate into a Workflow. This is a required future
  extension point, not part of the MVP delivery.
- A Dreamux-owned `submission_id`, service-level turn ID, request fingerprint,
  or provider replay protocol. In-process object identity and closures own
  service-level turn correlation.

## Constraints and invariants

- Architecture review is mandatory before implementation. The architect must
  define each module's capabilities, authoritative facts, lifecycle closure,
  event direction, and allowed dependencies.
- The technical solution must be reviewed for owner correctness, not assembled
  by combining PR #329 and PR #330 implementation details.
- No product-code implementation is authorized during requirement
  clarification.
- Core stays behind provider-neutral `AgentRuntimeProvider` and TeamMate
  lifecycle seams. Workflow code must not name Codex, Claude Code, process
  signals, or provider-specific settlement behavior.
- The existing single TeamMate creation path, identity roster, history, and
  TeamMate MCP read visibility are preserved.
- TeamMate identity is not owned by or permanently typed to one Workflow.
  Workflow membership must be a separable orchestration relationship whose
  lifecycle can end while the TeamMate remains reusable.
- Active Workflow write exclusion is entity-owned through
  `TeammateService.lock()`. Do not split this fact into a separate claim
  registry, public command adapter, or Workflow port without new evidence that
  the entity-owned lock cannot satisfy a required behavior.
- Provider-native turn/message identifiers must not escape their provider
  adapter merely to reconstruct in-process service relationships.
- Public MCP/admin submission receipts report acceptance status without a turn
  ID.
- TeamMate history stores and returns complete terminal turn records in
  chronological order without a turn ID.
- Workflow Agent records and journal rows do not contain a turn ID.
- Every lifecycle fact has one authoritative owner. Events communicate facts;
  subscribers do not complete another module's state machine.
- Publish/subscribe is the preferred collaboration shape for committed entity
  facts needed by multiple observers. The design may reuse the repository's
  existing typed EventEmitter/source/subscription patterns, but must expose
  narrow publishers and revocable subscriptions rather than raw cross-module
  emitter control.
- Event delivery is not a substitute for authoritative state or a hidden
  command bus. Commands remain explicit and target the owning module; events
  are post-transition facts.
- A listener failure must not roll back or poison the TeamMate transition that
  produced the fact. Subscribers own their own retry/reconciliation needs.
- The architecture consultation must include at least one explicit dependency
  graph for current and target directions and an owner/command/query/event
  matrix covering the full audited surface.
- Load-bearing Team dissolve, non-blocking inbound, worktree safety, shutdown,
  and persistence tests must not be weakened to make the refactor pass.

## Acceptance criteria

1. Architecture documentation names the capability set, authoritative state,
   lifecycle state machine, event contract, and dependency direction for
   Workflow, TeammateService, and TeammateCollection.
2. The final solution includes a complete current-to-target dependency graph
   and classifies every direct three-module interaction as an owner command,
   read query, or post-transition fact event.
3. Every Workflow agent is created through the scope's existing
   TeammateCollection factory and is represented by one ordinary
   TeammateService and durable TeamMate identity.
4. Workflow records, not a collection-local owner map, remain the durable
   source of the Workflow-to-TeamMate relationship.
5. `TeammateService.lock()` rejects concurrent ownership and every ordinary
   side-effecting operation while active, while its restricted handle lets the
   owning Workflow submit and close the entity.
6. A locked TeamMate remains locked through durable Workflow terminal commit;
   unlock restores ordinary mutation access and triggers cache-retirement
   notification when the entity is already closed.
7. Workflow stop invokes the borrowed TeamMate's close capability; Workflow
   contains no runtime-kill, grace-period, or TeamMate settlement algorithm.
8. `TeammateService.close()` does not have to execute through
   `TeammateCollection.close()` for the collection to observe closure. The
   TeamMate publishes a committed close fact and the collection removes its
   live reference as a subscriber-owned reaction.
9. TeammateService close is admission-fenced, idempotent, single-flight, and
   immediately cancelling under close-vs-start, close-vs-send, and concurrent
   close interleavings.
10. Built-in runtime close is bounded, escalates to force-killing the process
   group, and produces a stopped outcome for unfinished turns without waiting
   for natural model completion.
11. Successful TeamMate close proves both runtime termination and durable
   identity closure. A post-termination persistence failure is reported as an
   error and remains recoverable without reviving or falsely reporting a live
   runtime.
12. TeammateService publishes the agreed terminal lifecycle event, and
   TeammateCollection removes its live reference in response without taking
   ownership of the entity's close steps.
13. Listener failures cannot fail or roll back an already committed TeamMate
    lifecycle transition, and restart/read reconciliation restores each
    subscriber's derived state without treating the event stream as the source
    of truth.
14. Workflow-created TeamMates remain visible through normal scoped TeamMate
   read tools and retain durable identity/history after live eviction.
15. Every ordinary `send` attempted while the TeamMate has an active Workflow
   membership is rejected before runtime submission and cannot alter Workflow
   turn routing, schema enforcement, or results.
16. Every ordinary individual `close` or other public side-effecting TeamMate
    operation attempted during active Workflow membership is rejected before it
    can mutate the entity or runtime; `workflow_stop` is the only public
    cancellation entry point.
17. After Workflow completion or stop, an ordinary `send` to the retained
   TeamMate reopens it through the existing TeamMate resume path without
   changing the terminal Workflow.
18. AgentRuntime, TeamMate, Workflow, completion delivery, and history use one
    shared in-process Turn object per logical turn; no service-layer map or
    persisted/public turn ID is used to reconstruct that relationship.
19. Public TeamMate receipts, Workflow Agent projections, TeamMate history, and
    Channel provider contracts no longer expose `turn_id`; the unused Channel
    turn submitted/settled event pair is removed.
20. After a successful Workflow stop, no Workflow-created runtime remains live,
   and Workflow status/list, journal, run record, and agent records expose one
   consistent terminal outcome.
21. A never-settling Workflow turn cannot hold Team dissolve indefinitely.
22. Server shutdown reuses the same TeamMate close capability and does not need
    a separate Workflow-Agent lifecycle model.
23. Deterministic tests prove the create-vs-stop, close-vs-start,
    close-vs-settle, concurrent-close, Team-dissolve, and Server-shutdown
    interleavings.
24. Architecture review demonstrates that no persisted role, collection-local
    claim, creation-only capability, event route, or close rule prevents a
    future Workflow from attaching an existing ordinary or historical Workflow
    TeamMate without creating a second entity.

## Decisions and unknowns

### Confirmed operator decisions

- Ignore PR #316; authoritative Feishu topic-close behavior is unavailable.
- Explicit stop means immediate cancellation, consistent with existing
  TeamMate close intent. Do not add a five-second natural-settle window.
- Workflow agents must be ordinary TeamMates created through the shared
  TeamMateCollection so the TeamLeader can observe them through existing
  TeamMate tools.
- After the Workflow completes or stops, its closed TeamMates remain ordinary
  durable TeamMates and support later `send`/reopen through the existing
  TeamMate session-resume behavior.
- While Workflow membership is active, ordinary `send` is locked out so only
  the Workflow can drive the TeamMate and consume its correlated result.
- While Workflow membership is active, all public side-effecting TeamMate
  operations, including individual `close`, are locked out. Operators may only
  inspect the TeamMate or stop the owning Workflow as a whole.
- The MVP does not attach pre-existing TeamMates to Workflows, but the
  architecture must preserve that future ability for both ordinary TeamMates and
  TeamMates created by earlier Workflows.
- WorkflowService owns Workflow membership and close timing.
- TeammateService owns and self-closes the TeamMate lifecycle.
- Active Workflow ownership is implemented by `TeammateService.lock()` and its
  restricted handle; no separate mutation-claim registry, public command
  adapter, or Workflow port is required.
- Service-layer turn correlation is object/closure-based. Runtime-native IDs
  remain provider-internal; Claude Code removes
  `claude-turn-<runtime>-<counter>`, and Dreamux removes turn-ID-based router,
  Workflow, history, receipt, and event contracts.
- TeammateCollection listens for TeamMate lifecycle events and removes closed
  live references; it must not become the mandatory executor of TeamMate close.
- The dependency-reversal requirement applies to all analogous three-module
  interactions, not only `close` or `workflow_stop`.
- Preserve the operator's quoted architecture red line in this requirement and
  use it as a review rejection criterion for any design that retains
  collection-forwarded entity lifecycle solely for collection bookkeeping.
- Successful TeamMate close means the runtime is terminated and the durable
  identity is committed `closed`; a later persistence failure is an explicit
  operation error, not permission to report a successful or still-running
  state.
- Module capability and lifecycle ownership must be designed and guarded by an
  architect before implementation.

### Assumptions to verify

- Existing Codex and Claude Code process-group teardown is the correct lower
  layer to satisfy the common close contract, but its post-`SIGKILL`
  verification and error semantics may require strengthening.

### Technical-design questions

These questions do not block the product requirement. The architect must answer
them in the technical solution and reviewers must verify owner correctness:

- What event does TeammateService publish, at which committed lifecycle point,
  and how does the collection safely subscribe/unsubscribe across recreation?
- How are post-kill persistence or worktree-cleanup failures represented without
  pretending the Agent Runtime is still live?
- How does the fresh creation path return a locked `TeammateService` handle
  before runtime start so a concurrent Workflow stop can always close it?
- Which existing external/public consumers, if any, need a separate
  observational turn label after turn-ID-based service correlation is removed,
  and can their event/receipt be made self-contained instead?
