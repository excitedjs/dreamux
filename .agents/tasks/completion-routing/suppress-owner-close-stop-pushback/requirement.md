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

## Current alignment

- Status: Clarified; the operator selected the TeamLeader-authored direct-design
  path with three independent reviewers.
- Desired outcome: Deliberate TeamMate lifecycle teardown retires the still-pending
  completion delivery before stopping the runtime. Owner close, Team dissolve,
  and host restart therefore do not submit cleanup-induced results into an owner
  that already knows the work was abandoned or is itself stopping.

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
  during dissolve, and materialized TeamMate teardown during host restart.
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
  teardown during dispatcher shutdown or restart.
- Core TeamMate lifecycle and turn-delivery ownership needed to retire a pending
  delivery without discarding runtime settlement.
- Behavior tests for both owner roles plus preservation of ordinary stopped,
  completed, and failed delivery.
- The product catalog and owning architecture knowledge whose current blanket
  statement says every settled turn is reported.

### Non-goals

- No provider-specific stop or completion behavior change.
- No change to Workflow completion semantics, Channel presentation, or the text
  of notifications that remain deliverable.
- No attempt to retract a terminal outcome whose settlement and delivery were
  already selected before the applicable lifecycle boundary began.
- No new persisted state, config field, retry path, recovery mechanism, or
  caller-visible mode flag.

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
- A TeamMate turn that becomes stopped without that owning Agent initiating the
  close still produces exactly one stopped completion for its recipient.
- Completed and failed TeamMate turns retain their current completion delivery
  while the lifecycle relationship remains active; results still pending when
  deliberate teardown begins are abandoned with stopped outcomes.
- Direct admin close uses the same TeamMate lifecycle boundary and does not gain a
  separate notification exception.
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
- Accepted design direction, not yet a final technical solution: retire the
  pending delivery before lifecycle stop rather than suppressing a rendered
  stopped notification afterwards.
- Blocking unknowns: None.
