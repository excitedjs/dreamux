# Requirement

## Initial request

- An owning Agent that explicitly closes a TeamMate already expects that work to
  stop and must not receive a second model turn saying that the same work was
  stopped. The extra turn consumes tokens and can make the model reason about an
  event it initiated itself.
- Operator wording: “这个 team leader 如果调用了 close 之后，他本身就是有预期这个任务不会再返回了。额外给 team leader 推送一条关闭通知是会造成额外的 token 消耗，并且有可能会导致模型幻觉的”.
- The operator explicitly widened the same behavior to the Dispatcher: “当然要覆盖 dispatcher。”.
- The operator proposed removing the pending delivery before close instead of
  filtering a later notification: “是不是调用close的时候，先把回推的 submission清掉就可以了”.
- The operator also reported the same visible failure during Team dissolve and
  service restart: cleanup stops many TeamMates after the TeamLeader has stopped,
  causing repeated completion submissions to fail and appear as failed COT cards.
- During review of PR #389, the operator asked: “你这个回推处理Workflow的Stop逻辑了吗？”.
  Source inspection showed that explicit `workflow_stop`, Team dissolve, and
  host stop still deliver a `stopped` Workflow terminal completion. The
  TeamLeader proposed applying the same pending-delivery rule to those Workflow
  stop paths, and the operator replied “继续”.
- After the final architecture and implementation reviews exposed a distinction
  between aggregate teardown and failed-start rollback, the operator selected
  “采用栅栏语义 (Recommended)” for Team dissolve and Dispatcher shutdown, then
  explicitly selected “确认丢弃 (Recommended)” for pending TeamMate and Workflow
  completion during failed-start rollback as the lower-complexity behavior.

## Current alignment

- Status: Clarified; the operator selected the TeamLeader-authored direct-design
  path with three independent reviewers.
- Desired outcome: Deliberate TeamMate lifecycle teardown retires the still-pending
  completion delivery before stopping the runtime, and deliberate Workflow stop
  retires its still-pending terminal delivery. Owner close, `workflow_stop`, Team
  dissolve, host restart, and failed-start rollback therefore do not submit
  cleanup-induced results into the owner. Aggregate teardown publishes that
  retirement synchronously at its outer fence rather than when each contained
  entity is eventually reached.

### Confirmed current behavior and evidence

- Baseline: `origin/next` at `fffc3bd337f8ce28070fb8658fc30893e71730bb`
  on 2026-09-07; the task branch was fast-forwarded to that exact commit before
  investigation.
- The model-facing `close` tool in
  `packages/dreamux/src/service/teammate-collection/mcp-delegate.ts` calls the
  scoped collection's ordinary `close` method and returns its structured close
  result.
- `TeammateCollection.close` resolves the live entity and calls
  `TeammateService.close`. `TeammateService.transitionToClosed` stops the runtime,
  drains admissions, and invokes `settleAndDeliverRetained` before committing the
  closed record.
- `EntityTurn` maps a runtime stop to `{ status: 'stopped' }` and immediately runs
  the stored completion-delivery closure for every settled outcome. The renderer
  therefore creates the observed `TeamMate ... task was stopped` model turn.
- Team-owned members resolve completion delivery to their TeamLeader; dispatcher-
  scoped TeamMates resolve it to the Dispatcher. The same MCP delegate serves both
  scopes, so the observed behavior reaches both owner roles.
- `packages/dreamux/tests/entity-turn.test.ts` explicitly requires delivery of a
  close-induced stopped settlement. `packages/dreamux/tests/completion-delivery.test.ts`
  separately protects the general rule that a stopped outcome without a native
  completion token still reaches its recipient.
- [PR #149](https://github.com/excitedjs/dreamux/pull/149), merged as
  `eb65592707d42acc9679dc6da5879e91f208fcd6`, introduced reverse completion
  delivery for completed, failed, and stopped TeamMate turns. Its end-to-end test
  explicitly retained failed/stop delivery.
- [PR #338](https://github.com/excitedjs/dreamux/pull/338), merged as
  `8ed949e236d575c9b27a554aebed7d36ea40a3b2`, later consolidated close-first
  lifecycle ownership and added the present close-induced-stopped test.
- [PR #344](https://github.com/excitedjs/dreamux/pull/344) still recorded the
  intended opposite behavior in a router-only test: close/stop with no native
  result should produce no push. That test did not exercise the entity delivery
  closure and therefore did not protect the real end-to-end behavior.
- [PR #350](https://github.com/excitedjs/dreamux/pull/350), merged as
  `2ed5f5ea7006fee7197d39b9de98570db63ee00b`, established the exact current rule
  that every settled entity turn, including a close-induced `stopped` outcome,
  runs its delivery closure. This is the direct origin of the present regression,
  while PR #149 is the older ancestry of reverse delivery itself.
- [PR #380](https://github.com/excitedjs/dreamux/pull/380) added the explanatory
  automated-notification sentence to the rendered text; it changed the wording,
  not the existence of the pushed turn.
- `TeammateService.stopForHost` also calls `settleAndDeliverRetained`; Team dissolve
  reaches every live member through `stopForHost`, and dispatcher shutdown uses
  the same operation for materialized TeamMates. The source therefore confirms a
  shared mechanism for all three operator-reported paths.
- The operator-provided screenshot shows repeated failed COT turns containing a
  stopped TeamMate notification and a closed runtime client error. The screenshot
  proves the visible failure shape, but does not by itself identify which teardown
  invocation produced each individual card.
- `WorkflowService.stop()` and `WorkflowService.stopAll()` both reach
  `WorkflowRun.stop()`. `WorkflowRun.finalize()` currently always calls its
  captured `deliverTerminal` closure, so a stopped Workflow is pushed to its
  initiator even when that initiator explicitly stopped it or its whole scope is
  stopping. The existing `WorkflowRunTerminal.suppressDelivery` suppresses only
  child-Agent results sent to the runner; it does not suppress the Workflow's
  terminal completion to its owner.
- `packages/dreamux/tests/workflow-service.test.ts` explicitly requires
  `WorkflowService.stop()` to deliver one stopped Workflow completion, so that
  assertion must change knowingly rather than being treated as incidental.

### User story and desired behavior

- User story: a Dispatcher or TeamLeader decides that one of its TeamMates should
  stop, invokes that scope's model-facing `close` tool, and expects the close
  result to be the complete acknowledgement of that decision. Dreamux must not
  wake the same owner with a second stopped notification produced by the action it
  just requested.
- The behavior is owner-based, not role-based: the same rule applies to a
  Dispatcher closing its direct TeamMate and a TeamLeader closing a Team member.
- This is not a renderer or router filter. A deliberate lifecycle stop abandons
  the source turn's pending delivery obligation before it asks the runtime to
  stop; the turn itself still settles so lifecycle convergence remains observable
  to Core.
- The same semantic boundary covers explicit TeamMate close, Team member teardown
  during dissolve, materialized TeamMate teardown during host restart, and
  failed-start rollback after a partially opened Dispatcher or Team start.
- The same rule covers explicit `workflow_stop` and `WorkflowService.stopAll()`
  during Team dissolve, host stop, or failed-start rollback. The Workflow record
  and journal still converge to `stopped`; only its not-yet-started completion
  delivery to the initiating Agent is abandoned. No Workflow or TeamMate work is
  replayed after rollback.
- A terminal outcome selected independently while the relationship remains active
  is still real news and keeps the existing completion delivery. Once deliberate
  teardown begins, every result still pending at that boundary is abandoned,
  regardless of whether it later settles as completed, failed, or stopped.
- The close tool's structured result and the TeamMate's durable closed status and
  history remain unchanged.

### Scope

- The model-facing TeamMate `close` path for both dispatcher and team-leader MCP
  scopes.
- Team-scoped member teardown during Team dissolve and process-owned TeamMate
  teardown during dispatcher shutdown, restart, or failed-start rollback.
- Core TeamMate lifecycle and turn-delivery ownership needed to retire a pending
  delivery without discarding runtime settlement.
- Core Workflow-run terminal-delivery ownership needed to retire its pending
  owner completion without discarding terminal record and journal convergence.
- Behavior tests for both owner roles plus preservation of ordinary stopped,
  completed, and failed delivery.
- The product catalog and owning architecture knowledge whose current blanket
  statement says every settled turn is reported.

### Non-goals

- No provider-specific stop or completion behavior change.
- No change to a naturally completed or failed Workflow whose terminal intent
  was selected before a stop boundary, child-Agent result delivery inside a
  running Workflow, Channel presentation, or the text of notifications that
  remain deliverable.
- No attempt to retract a terminal outcome whose settlement and delivery were
  already selected before the applicable lifecycle boundary began.
- No new persisted state, config field, retry path, recovery mechanism, or
  caller-visible mode flag. In particular, a request accepted in the narrow
  partially-started window may have no completion after rollback; Dreamux does
  not recover or replay it.

### Constraints and invariants

- Core remains behind the neutral `AgentRuntimeProvider` and `ChannelProvider`
  seams; the repair must not branch on Codex, Claude Code, Feishu, or another
  provider.
- TeamLeader and Dispatcher must share one semantic path rather than duplicate
  role checks.
- The general rule from PR #149 remains: an independently failed or stopped turn
  that the recipient cannot infer is delivered without inventing a native
  completion token.
- Completion folding and per-recipient FIFO ordering remain unchanged for turns
  that are still deliverable.
- The implementation must retire delivery at the lifecycle boundary; it must not
  infer causality from notification text, close notes, provider output, or a late
  `stopped` status.
- Clearing the coordinator's retained-turn set is not acceptable: those turns are
  also the authority used to prove that runtime stop settled, and each turn already
  owns an asynchronous `ensureDelivery` continuation. Only the pending delivery
  obligation may be retired.
- Workflow stop must reuse the same source-obligation concept at `WorkflowRun`.
  It must not add a caller-role branch or a mode distinguishing public stop,
  aggregate `stopAll()` cleanup, and failed-start rollback.
- The existing first terminal intent is the causality boundary. Delivery is
  abandoned only when stop successfully reserves the run's `stopped` intent. A
  completed or failed intent selected first keeps delivery; a runner terminal
  message merely queued behind the scope fence has not selected an intent, so
  stop may win and abandon it without a second ordering mechanism.

## Acceptance criteria

- When a TeamLeader closes a running Team member through the model-facing
  TeamMate tool, the close call returns the normal structured result and the
  leader receives no close-induced stopped completion turn.
- When a Dispatcher closes a running direct TeamMate through the same model-
  facing tool, the close call returns the normal structured result and the
  Dispatcher receives no close-induced stopped completion turn.
- Team dissolve produces no member cleanup completion submissions and no failed
  COT cards caused by delivering into its stopping or stopped TeamLeader.
- Service shutdown or restart produces no TeamMate cleanup completion submissions
  and no failed COT cards caused by delivering into stopping or stopped owner
  Agents.
- Team dissolve and Dispatcher shutdown publish pending TeamMate delivery
  retirement synchronously at the aggregate fence, before awaiting Workflow,
  Team, scheduler, runtime, or worktree convergence.
- TeamMate, Team, member, or lazy leader construction that began before an
  aggregate fence but finishes afterwards inherits the retired relationship
  before it publishes or submits work. Per-entity host release cannot re-arm an
  aggregate fence; only a later successful start, completed rollback, or failed
  dissolve may enable future work in its still-active scope.
- A failed Dispatcher or Team start may stop work accepted during its partially
  opened window. Pending TeamMate and Workflow completion from that rollback is
  abandoned; the work is not recovered or replayed.
- A TeamMate turn that becomes stopped without that owning Agent initiating the
  close still produces exactly one stopped completion for its recipient.
- Completed and failed TeamMate turns retain their current completion delivery
  while the lifecycle relationship remains active; results still pending when
  deliberate teardown begins are abandoned with stopped outcomes.
- Direct admin close uses the same TeamMate lifecycle boundary and does not gain a
  separate notification exception.
- Explicit `workflow_stop` returns the normal terminal receipt and submits no
  stopped Workflow completion to the Agent that invoked it.
- Team dissolve and host stop submit no stopped Workflow terminal completion for
  runs stopped by their `WorkflowService.stopAll()` cleanup.
- A Workflow whose natural completed or failed terminal intent is selected before
  stop keeps exactly one terminal completion delivery. Delivery already started
  before a stop boundary is not retracted. If a runner terminal message is still
  queued when the stop fence wins the existing intent race, the resulting stopped
  run has no owner completion delivery.
- Existing completion folding and recipient ordering tests remain green, and new
  end-to-end tests observe the absence or presence of actual owner submissions
  rather than private implementation state.
- Rush build, lint, and test pass; live provider or Channel validation is not
  required because the causal decision and both recipients are Core-owned and
  can be observed through the real Core seams with fake runtimes.

## Decisions and unknowns

- Confirmed operator decisions:
  - An owner that called `close` must not receive the extra stopped notification
    caused by that call.
  - The rule covers both TeamLeader and Dispatcher owners.
  - Team dissolve and service restart must not emit a storm of cleanup completion
    submissions after the recipient is already stopping or stopped.
  - On the delivery-boundary question, the operator selected “全部丢弃（推荐）”:
    after close, Team dissolve, or service restart begins, every TeamMate result
    still pending at that boundary is abandoned; an already completed submission
    is not retracted.
  - On 2026-09-08, after the TeamLeader showed that Workflow stop still pushes a
    stopped terminal completion and recommended the uniform source-obligation
    rule for explicit `workflow_stop` plus `stopAll()`, the operator replied
    “继续”. This confirms the Workflow-stop extension at that stated scope; it
    does not alter natural Workflow completion or failure delivery.
  - During implementation-review ratification on 2026-09-08, the operator
    selected “采用栅栏语义 (Recommended)”: Team dissolve and Dispatcher shutdown
    abandon every not-yet-started TeamMate delivery at the outer synchronous
    fence, not when each entity is later reached.
  - After the rollback scenario and implementation cost were explained, the
    operator selected “确认丢弃 (Recommended)”: failed-start rollback also
    abandons pending TeamMate and Workflow completion, with no recovery or
    replay.
  - The operator selected “只测主路径”; the correction must protect the reviewed
    aggregate-fence regression but does not add the review's extra completed /
    failed settlement matrix, queued-runner-message race, or same-Service re-arm
    tests in this change.
  - The operator selected “同步更正 (Recommended)” for requirement, product,
    design-hash, and task-state traceability.
  - After the duplicate Workflow delivery bookkeeping was explained, the
    operator selected “本次重构”. The implementation must make the nullable
    source-owned closure the single stored terminal-delivery obligation while
    preserving first-intent causality, retry after delivery failure, and the
    no-retraction rule.
- Accepted design direction: retire the pending delivery at the source-owned
  lifecycle fence rather than suppressing a rendered stopped notification
  afterwards.
- Blocking unknowns: None.
