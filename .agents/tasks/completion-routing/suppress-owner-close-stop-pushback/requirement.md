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
- After the final architecture and implementation reviews of PR #389 exposed a
  distinction between aggregate teardown and failed-start rollback, the
  operator selected “采用栅栏语义 (Recommended)” for Team dissolve and
  Dispatcher shutdown, then explicitly selected “确认丢弃 (Recommended)” for
  pending TeamMate and Workflow completion during failed-start rollback as the
  lower-complexity behavior.

### Redo of PR #389 (2026-09-08)

- Reviewing the implementation in PR #389, the operator judged its shape, not
  its behavior: “他现在这个写法像是各处的堵漏。就把代码堵得比较恶心。有没有更优雅的解法？”.
- Shown a recipient-side design — the scope that owns a recipient publishes its
  own fence and delivery reads it; the producer never learns that its owner is
  going away — the operator ruled: “可以，按照你的思路重做吧，这个pr 不符合我的预期。”
  and “从 next 上拉新分支出来重新做。”.
- On the first redo report, which met the 700-line lint gate on
  `TeammateService` and `WorkflowRun` by moving code into two new files, the
  operator ruled on the shape of that gate: “不要搞什么机械拆分。700 行就是为了卡架构重构的。是不是有共性的模块可以拆出来？”.
  The gate is met by extracting mechanics shared across scopes, never by
  splitting one class across files.
- Every behavioral ruling above stands. Two clauses of the PR #389 requirement
  were authored by that PR's TeamLeader to make its own producer-side epoch
  correct; they are not operator rulings and are dropped by name under
  "Decisions and unknowns".

## Current alignment

- Status: Clarified; redo approved by the operator on 2026-09-08.
- Desired outcome: An owner is not told about the stop it asked for. A settled
  TeamMate turn or a Workflow terminal is reported only while the scope that
  owns the recipient still takes it. An entity that is closing or under host
  release, a Workflow whose stop reserved its terminal, a dissolving Team, and a
  dispatcher whose admission is closed produce no push. The fence is read on the
  recipient side at the moment delivery would start; no teardown walks the
  producer population, and a delivery already started is never retracted.

### Confirmed current behavior and evidence

- Baseline: `origin/next` at `fffc3bd337f8ce28070fb8658fc30893e71730bb`,
  unchanged between the PR #389 investigation on 2026-09-07 and the redo branch
  cut from it on 2026-09-08.
- The model-facing `close` tool in
  `packages/dreamux/src/service/teammate-collection/mcp-delegate.ts` calls the
  scoped collection's ordinary `close` method and returns its structured close
  result.
- `TeammateCollection.close` resolves the live entity and calls
  `TeammateService.close`. `TeammateService.transitionToClosed` stops the runtime,
  drains admissions, and converges the retained turns before committing the
  closed record.
- `EntityTurn` maps a runtime stop to `{ status: 'stopped' }` and, on the
  baseline, immediately runs the stored completion-delivery closure for every
  settled outcome. The renderer therefore creates the observed
  `TeamMate ... task was stopped` model turn.
- Team-owned members resolve completion delivery to their TeamLeader; dispatcher-
  scoped TeamMates resolve it to the Dispatcher. The same MCP delegate serves both
  scopes, so the observed behavior reaches both owner roles.
- The recipient-side idiom already exists at Team scope and is missing at
  Dispatcher scope. `TeamLeaderCompletionTargets` runs a member's delivery inside
  `TeamService.admit()`, which throws `TeamClosedError` once a dissolve is
  published; `TeammateService.enterOrdinaryMutation` refuses while the entity is
  not `active` or is under host release. `DispatcherService.completionInitiator()`
  hands out the raw dispatcher agent with no such gate, so a completion that
  settles while the dispatcher is stopping is accepted by a runtime that stops
  moments later.
- `packages/dreamux/tests/entity-turn.test.ts` on the baseline explicitly
  requires delivery of a close-induced stopped settlement.
  `packages/dreamux/tests/completion-delivery.test.ts` separately protects the
  general rule that a stopped outcome without a native completion token still
  reaches its recipient.
- [PR #149](https://github.com/excitedjs/dreamux/pull/149), merged as
  `eb65592707d42acc9679dc6da5879e91f208fcd6`, introduced reverse completion
  delivery for completed, failed, and stopped TeamMate turns. Its end-to-end test
  explicitly retained failed/stop delivery.
- [PR #338](https://github.com/excitedjs/dreamux/pull/338), merged as
  `8ed949e236d575c9b27a554aebed7d36ea40a3b2`, later consolidated close-first
  lifecycle ownership and added the baseline close-induced-stopped test.
- [PR #344](https://github.com/excitedjs/dreamux/pull/344) still recorded the
  intended opposite behavior in a router-only test: close/stop with no native
  result should produce no push. That test did not exercise the entity delivery
  closure and therefore did not protect the real end-to-end behavior.
- [PR #350](https://github.com/excitedjs/dreamux/pull/350), merged as
  `2ed5f5ea7006fee7197d39b9de98570db63ee00b`, established the exact baseline
  rule that every settled entity turn, including a close-induced `stopped`
  outcome, runs its delivery closure. This is the direct origin of the present
  regression, while PR #149 is the older ancestry of reverse delivery itself.
- [PR #380](https://github.com/excitedjs/dreamux/pull/380) added the explanatory
  automated-notification sentence to the rendered text; it changed the wording,
  not the existence of the pushed turn.
- `TeammateService.stopForHost` also converges retained turns; Team dissolve
  reaches every live member through `stopForHost`, and dispatcher shutdown uses
  the same operation for materialized TeamMates. The source therefore confirms a
  shared mechanism for all three operator-reported paths.
- The operator-provided screenshot shows repeated failed COT turns containing a
  stopped TeamMate notification and a closed runtime client error. The screenshot
  proves the visible failure shape, but does not by itself identify which teardown
  invocation produced each individual card.
- `WorkflowService.stop()` and `WorkflowService.stopAll()` both reach
  `WorkflowRun.stop()`. On the baseline `WorkflowRun.finalize()` always calls
  its captured `deliverTerminal` closure, so a stopped Workflow is pushed to its
  initiator even when that initiator explicitly stopped it or its whole scope is
  stopping. `WorkflowRunTerminal.suppressDelivery` suppresses only child-Agent
  results sent to the runner; it does not suppress the Workflow's terminal
  completion to its owner.
- `packages/dreamux/tests/workflow-service.test.ts` on the baseline explicitly
  requires `WorkflowService.stop()` to deliver one stopped Workflow completion,
  so that assertion changes knowingly rather than incidentally.
- [PR #389](https://github.com/excitedjs/dreamux/pull/389) (superseded, never
  merged) solved the same requirement producer-side: a `CompletionDeliveryScope`
  epoch in four aggregates, `abandonPendingDelivery` sweeps over every entity,
  construction-time `retireIfStale` / `observeConstruction` inheritance,
  `rearm*` after rollback and failed dissolve, and a `TeamCompletionDelivery`
  wrapper propagating the Team fence into members. Its behavior tests are
  reused here unchanged; its mechanisms are not.

### User story and desired behavior

- User story: a Dispatcher or TeamLeader decides that one of its TeamMates should
  stop, invokes that scope's model-facing `close` tool, and expects the close
  result to be the complete acknowledgement of that decision. Dreamux must not
  wake the same owner with a second stopped notification produced by the action it
  just requested.
- The behavior is owner-based, not role-based: the same rule applies to a
  Dispatcher closing its direct TeamMate and a TeamLeader closing a Team member.
- This is not a renderer filter and not a producer-side sweep. The scope that
  owns the recipient publishes its fence before it stops anything; a turn reads
  that fence once, when it settles, and still settles so lifecycle convergence
  remains observable to Core.
- The same semantic boundary covers explicit TeamMate close, Team member teardown
  during dissolve, materialized TeamMate teardown during host restart, and
  failed-start rollback after a partially opened Dispatcher or Team start.
- The same rule covers explicit `workflow_stop` and `WorkflowService.stopAll()`
  during Team dissolve, host stop, or failed-start rollback. The Workflow record
  and journal still converge to `stopped`; only its not-yet-started completion
  delivery to the initiating Agent is dropped. No Workflow or TeamMate work is
  replayed after rollback.
- A terminal outcome selected independently while the relationship remains active
  is still real news and keeps the existing completion delivery. Once a scope's
  fence is up, every result still pending behind it is dropped, whether it later
  settles as completed, failed, or stopped. One consequence is stated rather than
  hidden: a TeamLeader's own turn that completes naturally while a dissolve is
  still stopping the Team's Workflows, before the dissolve reaches the leader,
  is news the dispatcher did not end and is delivered.
- The close tool's structured result and the TeamMate's durable closed status and
  history remain unchanged.

### Scope

- The model-facing TeamMate `close` path for both dispatcher and team-leader MCP
  scopes.
- Team-scoped member teardown during Team dissolve and process-owned TeamMate
  teardown during dispatcher shutdown, restart, or failed-start rollback.
- The recipient-side fences and the reads of them: the dispatcher admission gate
  read by `CompletionDeliveryPolicy` before it queues a delivery; the entity's
  "still owed" fact read by `EntityTurn` when it settles; the Workflow run's
  nullable terminal report cleared when a stop reserves its terminal.
- Behavior tests for both owner roles plus preservation of ordinary stopped,
  completed, and failed delivery.
- The product catalog and owning architecture knowledge whose baseline blanket
  statement says every settled turn is reported.

### Non-goals

- No provider-specific stop or completion behavior change.
- No change to a naturally completed or failed Workflow whose terminal intent
  was selected before a stop boundary, child-Agent result delivery inside a
  running Workflow, Channel presentation, or the text of notifications that
  remain deliverable.
- No attempt to retract a terminal outcome whose delivery already started before
  the applicable fence went up.
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
- The decision is made at the lifecycle boundary from facts the owning scope
  already publishes; it must not infer causality from notification text, close
  notes, provider output, or a late `stopped` status.
- The producer side never learns its owner's lifecycle: no epoch, scope, or
  obligation object travels from an aggregate into the entities or Workflow runs
  it owns, and no teardown enumerates producers to retire deliveries.
- Clearing the coordinator's retained-turn set is not acceptable: those turns are
  also the authority used to prove that runtime stop settled, and each turn already
  owns an asynchronous `ensureDelivery` continuation.
- Workflow stop must not add a caller-role branch or a mode distinguishing public
  stop, aggregate `stopAll()` cleanup, and failed-start rollback.
- The existing first terminal intent is the causality boundary. Delivery is
  dropped only when stop reserves the run's `stopped` intent. A completed or
  failed intent selected first keeps delivery; a runner terminal message merely
  queued behind the scope fence has not selected an intent, so stop may win and
  drop it without a second ordering mechanism.

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
- Dispatcher stop, shutdown, and failed-start rollback close the dispatcher
  admission gate synchronously. A completion requested behind that gate is
  dropped before it is folded or queued, whatever the state of Workflow, Team,
  scheduler, runtime, or worktree convergence, and a delivery already queued is
  not retracted. A successful rollback reopens the gate.
- An entity whose host release fails to stop the native runtime still drains its
  in-flight admissions while its own fence is up, so a turn attached during the
  release settles without a report, and the failure is still thrown.
- A failed Dispatcher or Team start may stop work accepted during its partially
  opened window. Pending TeamMate and Workflow completion from that rollback is
  dropped; the work is not recovered or replayed.
- A TeamMate turn that becomes stopped without that owning Agent initiating the
  close still produces exactly one stopped completion for its recipient.
- Completed and failed TeamMate turns retain their current completion delivery
  while the lifecycle relationship remains active; results still pending when a
  scope's fence goes up are dropped whatever their outcome.
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
- Existing completion folding and recipient ordering tests remain green, and the
  end-to-end tests observe the absence or presence of actual owner submissions
  rather than private implementation state.
- Rush build, lint, test, and `typecheck:tests` pass; live provider or Channel
  validation is not required because the causal decision and both recipients are
  Core-owned and can be observed through the real Core seams with fake runtimes.

## Decisions and unknowns

- Confirmed operator decisions:
  - An owner that called `close` must not receive the extra stopped notification
    caused by that call.
  - The rule covers both TeamLeader and Dispatcher owners.
  - Team dissolve and service restart must not emit a storm of cleanup completion
    submissions after the recipient is already stopping or stopped.
  - On the delivery-boundary question, the operator selected “全部丢弃（推荐）”:
    after close, Team dissolve, or service restart begins, every TeamMate result
    still pending at that boundary is dropped; an already completed submission
    is not retracted.
  - On 2026-09-08, after the TeamLeader showed that Workflow stop still pushes a
    stopped terminal completion and recommended the uniform rule for explicit
    `workflow_stop` plus `stopAll()`, the operator replied “继续”. This confirms
    the Workflow-stop extension at that stated scope; it does not alter natural
    Workflow completion or failure delivery.
  - During implementation-review ratification of PR #389 on 2026-09-08, the
    operator selected “采用栅栏语义 (Recommended)”: Team dissolve and Dispatcher
    shutdown drop every not-yet-started TeamMate delivery at the outer
    synchronous fence, not when each entity is later reached.
  - After the rollback scenario and implementation cost were explained, the
    operator selected “确认丢弃 (Recommended)”: failed-start rollback also drops
    pending TeamMate and Workflow completion, with no recovery or replay.
  - The operator selected “只测主路径”; the correction protects the reviewed
    aggregate-fence regression but does not add the review's extra completed /
    failed settlement matrix, queued-runner-message race, or same-Service re-arm
    tests.
  - On 2026-09-08 the operator rejected the PR #389 implementation shape and
    approved a redo on a fresh branch from `next`: “可以，按照你的思路重做吧，这个pr
    不符合我的预期。” and “从 next 上拉新分支出来重新做。”.
- Dropped as PR-authored, not operator rulings (they existed only to make the
  superseded producer-side epoch correct; the recipient-side gate satisfies the
  “采用栅栏语义” ruling without them):
  - “Per-entity host release cannot re-arm an aggregate fence; only a later
    successful start, completed rollback, or failed dissolve may enable future
    work in its still-active scope.”
  - “TeamMate, Team, member, or lazy leader construction that began before an
    aggregate fence but finishes afterwards inherits the retired relationship
    before it publishes or submits work.”
- Accepted by inclusion in the approved redo design (stated in the reply the
  operator approved; labeled inference, not a standalone ruling):
  - After a failed teardown, an entity that is still active reports again as
    soon as its own release ends; a dispatcher whose admission stays closed
    still drops everything at the policy.
  - A TeamLeader turn that completes naturally during a dissolve's
    Workflow-stop window, before the dissolve reaches the leader, is delivered
    to the dispatcher as real news.
- Accepted design direction: the scope that owns a recipient publishes its fence
  and delivery reads it, rather than retiring obligations on the producer side.
- Blocking unknowns: None.
