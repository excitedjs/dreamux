# Independent solution review

Verdict: **NOT READY**.

One blocking finding: the proposed dissolution renderer would also announce a
Team as dissolved while its dissolve is merely pending and can still be refused.
The other proposed ownership and presentation changes fit the recorded requirement.

## Review basis and boundary

- Requirement authority: `requirement.md`, SHA-256
  `f82cbf9145700cbdd03023fc6cd8bdf5cc087646db377a7653fbc6918c0a4864`.
- Reviewed solution: `technical-design/draft.md`, SHA-256
  `1cb87874954d67041167d1d07be9739f560f416bdbec84c6a831a3df86947ba7`.
- Current source: `48882651ea09acb87ecaf96ba090bdddb829c613`.
- Applied `.agents/skills/engineering-whitepaper/SKILL.md` and the frontend
  whitepaper's abstraction/layering guidance. History and current knowledge were
  checked as implementation evidence, not additional requirement input.
- Only this review file is written. No implementation, tests, requirement, draft,
  or other task record is changed. No build, test run, or live card delivery was
  performed; this is a solution review, not implementation validation.

## Blocking finding

### R1 — [P2] An admission rejection does not prove that the Team dissolved

**Draft location:** lines 129-139, especially the unconditional assignment of the
Team-dissolution renderer to `announceTeamClosed`. The verification list at lines
153-158 also stops below the session caller that exposes the problem.

**Requirement:** lines 80-89 distinguish explicit MCP unbind from passive removal
after a Team closure notification. The dissolution card states that Team closure
caused the routes to be removed. That requires a closure fact.

**Current-source evidence:**

1. `packages/dreamux/src/service/team-service/index.ts:433-439` raises the same
   `TeamClosedError` both while `dissolveTask` is pending and when the durable Team
   record is closed. `packages/dreamux/src/service/team-collection/errors.ts:22-28`
   assigns that error the code `TEAM_CLOSED`.
2. Dissolve raises its fence before the background operation starts
   (`team-service/index.ts:457-468`). A non-forced Dispatcher dissolve then awaits
   the worktree assessment and can refuse a dirty worktree before closing anything
   (`packages/dreamux/src/service/team-service/closing.ts:91-96,189-193`). On failure,
   `team-service/index.ts:479-485` clears the fence; the Team need not have closed.
3. Besides the durable `team.state` event path at
   `packages/channel/feishu-channel/src/feishu-channel.ts:286-291`, an ordinary
   inbound rejected with `TEAM_CLOSED` calls `forgetTeamRoutes(..., 'team_closed')`
   at lines 441-454. That call removes the routes and invokes
   `announceTeamClosed` at lines 329-339. No closed event or status read is required.
4. The existing notification is truthful about the route alone:
   `packages/channel/feishu-channel/src/feishu-binding-notification-card.ts:39-60`
   says the conversation is no longer routed to a Team. The session regression
   test at `packages/channel/feishu-channel/tests/feishu-channel-session.test.ts:142-179`
   explicitly preserves notification and one Dispatcher fallback for this path.

**Triggering flow:** a Dispatcher submits a non-forced dissolve for a Team with a
dirty managed worktree. While the asynchronous assessment is pending, a message
arrives on one of its Feishu routes. Admission returns `TEAM_CLOSED`; the Channel
removes the Team's routes and calls `announceTeamClosed`. The worktree assessment
then refuses the dissolve and the Team remains open.

**Wrong consequence:** under the draft, the conversation receives an orange card
stating that its Team closed/dissolved even though the Team is still alive. The
wrong statement is introduced by the new cause-specific copy; this finding does
not ask this task to redesign the existing early route removal.

**Smaller correction:** separate the two existing callers' notification meaning
inside the Channel. Reserve the new dissolution renderer for the confirmed
`team.state(status: 'closed')` path. Preserve a route-removal-only notification for
the pre-admission rejection path, without asserting either completed dissolution
or explicit MCP unbind. The current generic unbound renderer already supplies
that narrower meaning; keep it for this existing fallback instead of repurposing
every caller. Preserve route removal, COT release, and one Dispatcher fallback.
No Core error change, status polling, notification ledger, or persisted phase is
needed. Include this small session call-site change in the declared boundary.

**Verification:** extend the session-level cases, not only direct binding-operation
tests. Exercise an inbound during the real dissolve fence with a dirty-worktree
refusal; assert no dissolution claim, unchanged route removal/COT interruption,
and exactly one Dispatcher fallback. Separately emit the confirmed closed event
with multiple remaining routes and assert one dissolution notification per removed
route. Do not delete the existing rejection-notification assertion to make the
new renderer pass.

## Supported design choices

- **COT ownership and terminal scope are correct.** `toolResultOutput` classifies
  the complete value at `feishu-cot-events.ts:274-285`; byte fitting follows at
  lines 288-320. The proposed line cut belongs only in its text branch. In
  `feishu-cot-adapter.ts`, inbound supplies a non-null anchor at lines 168-201,
  Team/route fences supply null at lines 291-301, and session close explicitly
  uses interruption at lines 310-318. Changing the terminal selected at lines
  359-370 therefore preserves the requested lifecycle boundary. `completed`
  already maps to wire `done` at `feishu-cot-events.ts:72-86`.
- **Canonical Team context needs no new Core capability.** `team.status` invokes
  `getTeamStatus` at `packages/dreamux/src/service/team-collection/commands.ts:312-333`.
  `TeamView` exposes the configured runtime ID and leader name at
  `team-collection/types.ts:231-247`; `agent-entity/read-helpers.ts:23-44` maps
  `identity.runtime_cwd` to `leader.repo.path`. `team-collection/index.ts:282-294`
  reads an unmaterialized Team from records, without starting its runtime.
  `leader: null` is reachable through the record reader
  (`team-collection/read-model.ts:77-82,142-151`), so refusing a bind when the
  required cwd cannot be obtained has a concrete producer. It must remain distinct
  from a valid leader whose `runtime_status` is null.
- **The helper has two real consumers.** Replace the manual validation read at
  `feishu-session-bindings.ts:74,116-134`, and add the same read before the durable
  bind at `feishu-provisioning.ts:145-179`. Carrying only the four display facts
  avoids a second canonical read during notification. A provisioning failure at
  that point already has an honest `unsubmitted` outcome at lines 113-129; the
  session delivers it to the Dispatcher at `feishu-channel.ts:429-456`. The extra
  query adds latency and a pre-bind failure point, but implements the explicitly
  required canonical-context ordering without compensation state.
- **Channel-local rendering follows the ownership history.** Commit `2ed5f5ea`
  (author: YourWildDad) removed Core binding-event inputs and the old runtime/cwd
  card fields. The draft correctly restores the presentation through the existing
  command port instead of restoring Core routing ownership. Keeping the Card 1.0
  status helper for unchanged space cards and constructing the selected route
  cards locally avoids widening the abstraction.

## Non-blocking verification notes

1. Add a rendered check of the final production JSON for all three selected cards,
   including a long cwd and Markdown-significant dynamic text. Requirement lines
   44-50 record candidate validation, but that does not validate the final English
   copy and combined detail-panel layout. The transport merely serializes the
   `unknown` card and checks its size before sending
   (`packages/channel/feishu-transport/src/transport/feishu.ts:446-459`); unit shape
   assertions cannot establish client rendering. This review sent nothing.
2. Make the line-boundary tests explicit about empty output, trailing line breaks,
   and CRLF. Keep the original text unchanged below the threshold, and test the
   final emitted event after spacing preservation and byte fitting, rather than
   only a split helper. The draft already names the main 10/11-line and JSON cases.

The requested Card 2.0 client baseline and best-effort notification delivery are
accepted trade-offs in the requirement, not reasons to add a compatibility
fallback or a delivery guarantee. The implementation still needs the four Rush
gates and knowledge/change-note work listed in the draft after R1 is resolved.
