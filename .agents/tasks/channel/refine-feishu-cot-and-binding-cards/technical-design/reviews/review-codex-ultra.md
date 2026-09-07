# Independent solution review

Verdict: **NOT READY** — one blocking notification-cause mismatch. The other
proposed mechanisms fit the requirement and current ownership boundaries.

Reviewed source HEAD: `48882651ea09acb87ecaf96ba090bdddb829c613`.
The sole requirement and solution inputs were this task's `requirement.md` and
`technical-design/draft.md`, respectively:

- Requirement SHA-256: `f82cbf9145700cbdd03023fc6cd8bdf5cc087646db377a7653fbc6918c0a4864`.
- Draft SHA-256: `1cb87874954d67041167d1d07be9739f560f416bdbec84c6a831a3df86947ba7`.

No other review file was read. This review follows the engineering whitepaper's
requirement-driven mechanism and ownership rules. Source references below are
repository-relative.

## Blocking finding

### B1 — A refused dissolve can produce a card saying the Team dissolved

**Draft location:** `technical-design/draft.md:129-139`, especially the unconditional
replacement of the renderer called by `announceTeamClosed`.

**Requirement:** `requirement.md:80-89` distinguishes an MCP unbind from removal
caused by a received Team-closure notification. The latter card asserts that
the Team closed. Notification ordering and COT fencing must remain intact
(`requirement.md:109-110`).

**Source evidence:**

- `packages/channel/feishu-channel/src/feishu-channel.ts:286-291` invokes
  `forgetTeamRoutes(..., 'team_closed')` for a closed `team.state` event, but
  `:441-454` invokes the same path for a `TEAM_CLOSED` submission rejection.
  `:330-339` sends both through `announceTeamClosed` after route removal.
- `packages/dreamux/src/service/team-collection/errors.ts:21-25` explicitly
  defines `TEAM_CLOSED` to include closing/dissolving. In
  `packages/dreamux/src/service/team-service/index.ts:433-438`, a non-null
  `dissolveTask` produces that error before the Team is durably closed.
- `packages/dreamux/src/service/team-service/closing.ts:93-95,189-192` can refuse
  a non-force Dispatcher dissolve during the initial worktree assessment.
  Durable closure occurs later at `:108-117`. On refusal,
  `packages/dreamux/src/service/team-service/index.ts:479-485` clears the fence;
  the Team remains open.
- Today's `bindingUnboundCard` only states that the route no longer routes to a
  Team (`packages/channel/feishu-channel/src/feishu-binding-notification-card.ts:52-58`).
  It does not assert that the Team itself ended. The refusal path's existing
  announcement is covered by
  `packages/channel/feishu-channel/tests/feishu-channel-session.test.ts:142-179`.

**Trigger:** A Dispatcher requests a non-force dissolve of a Team with a dirty
managed worktree. An inbound reaches an existing route while the asynchronous
assessment is pending. Core rejects that submission with `TEAM_CLOSED`; the
assessment then refuses the dissolve.

**Wrong consequence:** The unchanged rejection cleanup calls the newly selected
Team-dissolution renderer, telling the conversation that its Team closed even
though it remains open and can accept work again. The existing route removal is
not the new defect; changing a factual route-ended announcement into a false
Team-lifecycle assertion is. Renaming a method does not establish the cause it
claims to represent.

**Minimal correction:** Account for the submission-rejection caller explicitly
in the draft. Reserve the confirmed-dissolution copy for the actual closed
`team.state` notification, and retain a factual route-ended announcement for the
existing rejection cleanup. Preserve its durable removal, COT release, and single
Dispatcher fallback. Do not replace that announcement with the MCP-unbind copy
claiming the Team remains active, or silently remove it. Keep this distinction
at the existing Channel notification boundary; no Core error-contract change,
persisted cause, retry, or compensation is needed.

**Verification:** Exercise a real closing fence while worktree assessment is
pending, then a refused dissolve. Assert that no card claims Team dissolution,
the route-ended notification still arrives, and cleanup/fallback behavior is
unchanged. Separately assert the selected dissolution card after a closed
`team.state` event. Direct tests of `announceTeamClosed` alone miss this caller.

## Ownership, boundary, and trade-offs

- Core already supplies the required card facts. `team.status` reaches
  `TeamCollection.summary` through
  `packages/dreamux/src/service/team-collection/commands.ts:330-332` and
  `packages/dreamux/src/service/dispatcher-service/index.ts:508-509`.
  `packages/dreamux/src/service/team-service/team-view.ts:5-10` supplies the
  canonical names and configured runtime ID;
  `packages/dreamux/src/service/agent-entity/read-helpers.ts:23-43`
  maps `identity.runtime_cwd` to `leader.repo.path`. The Feishu-local display
  helper has two real consumers and does not justify a new Core contract.
- A missing leader and a lazy runtime are different cases. The store-only status
  path can return `leader: null`
  (`packages/dreamux/src/service/team-collection/read-model.ts:77-83,142-151`),
  while a present leader with `runtime_status: null` still carries its cwd.
  The draft's required-facts check addresses an actual producer state. Retaining
  lazy startup follows commit `d74142c3` by YourWildDad; binding must not activate
  the runtime merely to populate the card.
- Reading status between creation and binding fits the existing failure model:
  `packages/channel/feishu-channel/src/feishu-provisioning.ts:113-130,145-179`
  leaves committed Team facts alone on a pre-submit failure, and
  `packages/channel/feishu-channel/src/feishu-channel.ts:421-456` delivers an
  `unsubmitted` inbound to the Dispatcher.
  One additional canonical read on provisioning is the justified cost of the
  requested facts. No durable provisioning mechanism is warranted.
- The proposed anchor transition uses facts already owned by the adapter.
  Non-null replacement enters at
  `packages/channel/feishu-channel/src/feishu-cot-adapter.ts:185-189`; retirement and
  lifecycle fences pass null at `:201,291-301`; session close explicitly uses
  interruption at `:310-317`. Existing `completed` maps to Feishu `done` in
  `packages/channel/feishu-channel/src/feishu-cot-events.ts:72-87`. No new state
  or provider behavior is needed.
- The route-card boundary deliberately follows the Channel ownership introduced
  by commit `2ed5f5ea` by YourWildDad, while restoring the presentation facts that
  commit removed. Keeping Card 2.0 construction local avoids changing space-policy
  cards or the general Card 1.0 helper. The selected client baseline is an
  explicit requirement trade-off and should be visible in the release note.

## Non-blocking verification notes

1. Preserve meaningful byte-budget coverage. The existing spacing test uses
   3,000 short lines
   (`packages/channel/feishu-channel/tests/feishu-cot-tool-rows.test.ts:179-188`),
   which the new line
   cap would reduce before it exercises byte fitting. Use at most ten sufficiently
   long indented lines as well, so NBSP conversion still tests the final byte
   bound. The draft already calls for post-line-cut byte-budget cases.
2. Keep fixtures representative of the canonical answer: the current manual-bind
   fake returns only `{ team: { status } }`
   (`packages/channel/feishu-channel/tests/feishu-session-bindings.test.ts:81-94`).
   Extend it with real-shaped Team and
   leader fields; retain the missing/closed-Team assertions. Distinguish a null
   leader from a present leader with null runtime status.

Validation performed: source/caller tracing, relevant source history, and existing
test inspection. No build, lint, tests, live Feishu send, or implementation changes
were performed. The draft's planned Rush gates remain implementation acceptance
work; this review does not claim them green.
