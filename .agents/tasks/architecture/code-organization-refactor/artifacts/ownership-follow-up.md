# PR #453 ownership follow-up

## Authority and scope

Continuation of the existing requirement and rulings, after PR #455 merged
into PR #453. Baseline: PR #453 immediately after the PR #455 merge.
The operator approved on 2026-09-29: "ok ，开始搞吧，主要还是以架构为主。然后我们再讨论最终的产品行为问题".

The confirmed product shape decides. Existing code, decisions, and documents
are evidence; changes to user-visible behavior remain operator decisions.
This pass removes misplaced ownership and repeated construction context. It
does not decide the behavior questions listed below. Delivery follows the
existing ruling: a reviewed child PR into `feat/plugin-system-mvp` / PR #453.

## Ownership decisions

These are adaptations of existing owners, not a new service architecture.
The greenfield criterion is that each owner receives its fixed context once,
constructs its own state, and exposes domain operations; callers do not
coordinate its internal resources. The exact implementation may be simpler
than the candidate below and should be chosen against current source.

| Area | Desired owner and removed complexity | Constraints |
| --- | --- | --- |
| Agent construction | The dispatcher-scoped `AgentServiceFactory` binds its fixed config reader, provider catalog, projection, and logger once. Callers supply only entity-specific storage, options, and publication/occupancy behavior. Remove repeated `buildDeps` assembly. | Bind the live config reader object, not a config snapshot. Preserve per-entity callbacks and logger fields. |
| Team member workspace | The Team-scoped member collection owns its fixed shared workspace. Ordinary and Workflow creation use the same scoped collection operation. Remove per-spawn workspace injection and Team-only forwarding surfaces made necessary by it. | R64: members use cwd mode and never delete the Team worktree. Dispatcher members keep their existing workspace policy. |
| Team cleanup | The Team module owns the record-based worktree settlement operation used by live dissolve and recovery. Remove `TeamService`'s callback into a private collection method. | R62/R67: precheck, durable closed, serial child destruction, worktree cleanup. Recovery stays record-only. Keep the pre-record checkout rollback separate. No one-method service or reconstructed closed Team. |
| Feishu routing | `FeishuRouting` constructs, loads, and drains its own routing store; the session supplies its location and fixed context. | Preserve document schema, routing actions, lifecycle order, and transactional rules. |
| Feishu access | `FeishuAccess` owns gating/pairing/refresh transitions and their store. Inbound invokes domain operations and owns message IO. Remove public store access and mutations from inbound. | Preserve send-before-save and current gate/TTL/approval semantics in this architecture pass. An observed expiry defect is listed separately, not silently fixed. |
| Codex construction | Provider/runtime internals accept fixed thread id, extra arguments, logger, and skill sources as required values where construction already guarantees them. | Keep public provider contracts and useful process/client injection seams. No submission serialization or native-turn behavior changes; issue #63 remains binding. |
| Plugin state directory | Give the existing Feishu extension owner its fixed plugin directory once during the lifecycle that supplies it; remove the nullable supplier threaded through provider/session layers. | Plugin contribution precedes server initialization. Respect this ordering instead of reading an uninitialized value. Preserve the path, plugin API, and extension activation behavior. |
| Command schema | Schema registration owns definition validation. Invocation validates input values against an already checked schema without repeating unreachable definition-shape guards. | Preserve user-input validation, supported schema keywords, and error classification. |

## Acceptance and review

- No cap-driven extraction or private-state callback module. Count removed
  call-site wiring and new seam consumers; fewer lines alone are not evidence.
- No new persisted schema, config requirement, timeout, retry, fallback, or
  recovery entity. If the implementation needs a product decision, report it
  and continue independent items rather than making that decision silently.
- Keep one code writer. The TeamLeader maintains task and KB records; an
  independent reviewer checks the complete resulting diff.
- Product catalog areas touched: Team member workspace and dissolve, Workflow
  member construction, Feishu binding/access, plugin initialization, and
  provider submission. Their current behavior is preserved in this pass.
- Run repository build, lint, test, and `typecheck:tests` after the complete
  implementation, plus `.agents/scripts/check.sh` for knowledge updates.
  R43 still applies to this child PR: no new or repaired unit tests; any
  invalidated deletion must be reported with the exact lost contract for the
  TeamLeader's ledger. Do not remove a test merely to hide a new regression.
- Final coverage restoration and the PR #453 merge-to-next gate remain open.

## Deferred behavior discussion

The following are review findings to discuss after ownership converges, not
authority for behavioral changes in this pass:

- Live `last`/activity resolves newly edited config instead of the running
  generation's config (#448's next-launch contract needs reconciliation).
  Resolved 2026-09-30: while a runtime generation runs, `last` reads provider,
  config and session id from that generation, including a TeamMate still being
  reopened from a closed record (`last` waits for the reopen's build); with no
  runtime running it uses the current config.
- Workflow `createLocked` bypasses collection admission; closing during
  construction can strand a lock before its caller receives the handle.
- First binding may lose the initial COT anchor. R41 only ruled on restart.
  Resolved 2026-09-30: the sent bind card is the leader's first anchor again
  (see the R41 addition in `rulings.md`).
- A leader that already holds COT state fences a released topic by the
  anchor's own place, not by the binding row that served it: a topic unbound
  while its parent group still serves it gets no anchor for that leader until
  the fence clears. Inherited from the pre-refactor behavior. Making the
  inbound anchor carry the matched binding endpoint would close it; the review
  fixes do not name it, so it is left open.
- An expired pairing token can prevent persisting the newly sent token.
- Config shape failures may surface as INTERNAL instead of BAD_REQUEST.
- A plugin without a config reader currently ignores its `config` block.
  R21 records an inference, and the requirement still leaves this rule open;
  documenting the current implementation does not settle that product choice.
- Rootless topic notification receipts, runtime defaults, and other product
  differences raised on PR #453 need comparison with their exact rulings.

Do not split COT presentation or TurnManager projections merely because the
files approach 700 lines. Do not remove completion retries, COT caps, or
provider hooks without their own requirement and consumer analysis.

## Review candidates not adopted

- A separate COT presentation owner and a separate TurnManager projection file
  are optional design directions, not required remedies for file length. The
  current owner can legitimately hold its own state machine.
- Config's raw document, normalized plugin entries, and loaded plugin objects
  have different consumers. `readPluginEntries` is the one normalization
  authority; `ConfigService.replaceAgents` preserves its result without
  loading plugins again. The typed `plugins` field serves onboard serialization
  (`onboard/config-files.ts` and `config/config.ts`), so deleting it would lose
  that round trip. Moving attachment into `resolveConfig` adds another parse
  or a parameter rather than removing a concept. A future raw-document-based
  onboard rewrite would need to discuss unknown-field preservation and output
  semantics; it is not part of this ownership pass.

## Preservation ledger

Independent reads of the baseline found no behavior decision required by the
eight ownership adaptations. Review the resulting diff against these risks:

| Boundary | Existing capability to retain | Failure to check |
| --- | --- | --- |
| Factory to runtime | Live config reader; one dispatcher ledger; per-owner publication and occupancy | Capturing `current()` freezes future launches; flattening callbacks loses roster/cache publication. |
| Team to members | Workspace loan carries three location facts, not cleanup authority | Giving members the Team's managed-worktree identity lets member close delete the Team checkout. |
| Team settlement | Pending record and force survive failed cleanup; recovery needs no Team construction | Eagerly clearing pending loses retry-on-start; combining unclaimed rollback requires a nonexistent record. |
| Session to Routing | Load before subscriptions/extensions; drain after their close; same commit queue | Early drain misses tail writes; moving preconditions outside the transaction races binding. |
| Inbound to Access | Lazy load; policy also serves bot observation and `/introduce`; send-before-save with latest-state merge | Startup eagerly fails on access state; a sent token resurrects after concurrent approval. |
| Runtime to TurnManager | One fixed thread per native generation, immediate native submit | A runtime-wide thread snapshot becomes stale after restart; added serialization breaks issue #63. |
| Plugin to extensions | Shared registry exists at contribution; directory arrives at server; independent per-session resources | Delaying contribution breaks provider catalog construction; requiring a directory breaks standalone empty providers. |
| Registry to schema validator | Every schema branch validated at registration; invocation checks payloads | Removing shared definition helpers or real bounds changes accepted inputs or output error classification. |
