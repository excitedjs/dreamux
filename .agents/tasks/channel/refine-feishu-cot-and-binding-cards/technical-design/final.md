# Final technical solution

## Outcome and boundary

Keep presentation and routing behavior inside the Feishu Channel while exposing
the facts already owned by Core through the neutral command that naturally
produces them. Manual binding consumes `team.status`; automatic provisioning
consumes `team.create`. The latter result is extended with configured Agent
Runtime ID and runtime cwd, avoiding an immediate status round trip. This adds
no provider interface, persisted record, routing schema, or provisioning state.

The implementation changes five user-visible behaviors:

1. Plain-text COT tool results keep at most ten content lines before the
   existing Feishu byte fitting runs. JSON objects and arrays bypass this line
   rule.
2. Replacing a non-null COT anchor closes the superseded card as completed.
   Retiring an anchor and all genuine lifecycle interruptions remain
   interrupted.
3. Manual and provisioned route binds obtain canonical Team card facts before
   the route becomes visible, without sharing a Channel helper or duplicating a
   Core read.
4. Route-bound notifications render the selected Team-focused Card 2.0 design,
   with the runtime cwd in the selected full-width detail-panel treatment.
5. Explicit MCP unbind, confirmed Team dissolution, and pre-final route removal
   each use copy that states only the cause the Channel actually knows.

Collaboration-space policy cards and the general Card 1.0 status-card helper
remain unchanged.

## 1. Bound plain-text tool results after JSON classification

Extend `toolResultOutput` in
`/packages/channel/feishu-channel/src/feishu-cot-events.ts`, where the complete
result is already parsed and classified. If the parsed value is a non-null
object or array, pretty-print it as JSON exactly as today and do not count its
lines. Treat JSON scalars and all non-JSON values as plain text.

For plain text, scan the original string by LF and CRLF source boundaries. A
terminal delimiter terminates the preceding content line but does not create an
additional line. A delimiter followed by content, including another blank-line
delimiter, does start another content line. When an eleventh content line
exists, keep the first ten complete lines, preserve their original separators,
and append the existing English `TRUNCATION_MARKER` on a new line. Apply
`preserveSpacing` only after this source-text cut.

The existing `assembleToolResultContent` byte-fitting pipeline remains the
final bound for JSON and text. This adds no Core processing, configuration, or
second byte budget.

## 2. Give anchor replacement its own terminal

Change `FeishuCotAdapter.advanceAnchor` so its terminal follows the transition:

- old anchor to a new non-null anchor: `completed`;
- old anchor to `null`: `interrupted`.

The adapter already owns both the old presentation and the replacement target,
so this needs no new state or caller parameter. Keep `finishCard`, `close`, route
release, Team close, session close, runtime-reported interruption, anchor
generation, receipt opening, open-tool-call clearing, and serialized I/O
unchanged.

## 3. Return canonical card facts on the producing paths

Extend the neutral `TeamCreateResult` with `leader_agent_runtime` and
`runtime_cwd`. Core already persists both facts in the accepted Team record, so
new creation and idempotent `existing` / `closed` replay return the same shape.
The result is required rather than optional: successful Team creation publishes
the TeamLeader identity before returning. No new fact or secondary lookup is
introduced.

Automatic provisioning consumes `leader_name`, `leader_agent_runtime`, and
`runtime_cwd` directly from that receipt:

```text
team.create -> routing.bind -> COT claim/card -> team.submit
```

Manual `bindChannel` still invokes `team.status` once because it binds an
already-existing Team. It reads the configured runtime ID from
`answer.team.leader_agent_runtime` and the actual cwd from
`answer.leader.repo.path`, then preserves the existing bind, previous-owner
release, new-owner claim, notification, and response order. A nullable runtime
process status is irrelevant because a lazily started TeamLeader still has a
durable identity and repo path.

The status semantics stay owned by Core: a nonexistent Team throws
`TEAM_NOT_FOUND`, which the Channel leaves unchanged; a closed Team is a
successful status response and the Channel rejects it before route persistence.
If the successful response lacks the required leader view, binding also fails
before persistence. No Channel error translation, shared context helper,
compensation, retry, or persisted phase is added.

## 4. Render selected route notifications as Card 2.0

Keep route-card construction in
`/packages/channel/feishu-channel/src/feishu-binding-notification-card.ts`. Do
not change `buildFeishuStatusCard`; Collaboration Space cards retain their
existing Card 1.0 presentation. Small private builders in the notification-card
module may share repeated Card 2.0 label, fact-column, and full-width panel
shapes without introducing a repository-wide card abstraction.

All fixed copy in the three selected production cards is English. Remove every
preview candidate/set label. Render target, Team, TeamLeader, runtime ID, and cwd
as `plain_text`; never interpolate dynamic values into Markdown.

### Route bound

- Green header and bound-state tag.
- Team name as the hero.
- Target, TeamLeader, and configured Agent Runtime ID as three grey fact cells.
- Runtime cwd in one full-width green-tinted detail panel matching the selected
  set-2 bottom-panel treatment.

### Explicit MCP unbind

- Neutral grey header and unbound-state tag.
- Team name as the hero.
- Target, binding kind, and Team as three grey fact cells.
- One full-width grey reason panel stating that Feishu Channel removed this
  route and the Team remains active.

### Confirmed Team dissolution

- Neutral header with an orange warning icon/tag and orange Team hero.
- Target, binding kind, and Team as three grey fact cells.
- One full-width orange reason panel stating that the Team closed and all of its
  routes were removed automatically.

## 5. Preserve three distinct route-removal facts

Use the existing Channel caller boundary to choose the truthful notification:

- `unbindChannel` uses the explicit-unbind renderer.
- A final `team.state(status: 'closed')` caller uses the Team-dissolution
  renderer for every forgotten route.
- The existing inbound fallback after a `TEAM_CLOSED` admission rejection uses
  a cause-neutral route-ended renderer. That error also means dissolution is
  merely in progress, and a non-force dissolve may still be refused. The card
  must claim neither completed dissolution nor continued Team activity.

Pass this distinction at the existing `forgetTeamRoutes` caller boundary while
keeping one durable `routing.forgetTeam` mutation path. Preserve COT fencing,
best-effort notification, and exactly one Dispatcher fallback. Do not change
Core's error vocabulary, poll Team status, or persist a route-removal reason.

## Verification

- Extend `feishu-cot-tool-rows.test.ts` with 10-line, LF-terminated 10-line,
  CRLF-terminated 10-line, 11-line, explicit blank eleventh-line, JSON
  object/array over ten lines, JSON scalar, and post-line-cut byte-budget cases.
- Extend `feishu-cot.test.ts` across TeamLeader and Dispatcher recipients: three
  successive non-null anchors close the first two cards as `done`; anchor
  retirement, route release, Team close, session close, and native interruption
  remain interrupted; activity continues on the successor mid-native-turn.
- Add notification-card tests for schema 2.0, English fixed copy, absent preview
  labels, selected colors/layout, configured runtime ID, literal
  Markdown-significant dynamic values, and the full-width cwd/reason panels.
- Extend binding tests to prove canonical context is read before persistence,
  explicit unbind and final Team close select different renderers, and a leader
  with `runtime_status: null` remains bindable.
- Extend session-level tests for the third removal cause: an inbound rejected
  while dissolve is pending keeps the neutral route-ended card, route removal,
  COT interruption, and one Dispatcher fallback even if dissolution is refused;
  only a final closed event emits the dissolution card.
- Extend provisioning tests to prove `team.create -> bind -> announce ->
  submit`, direct receipt propagation, and the absence of a redundant
  `team.status` call.
- Update the product catalog and Channel domain for the three removal semantics,
  canonical runtime context, selected Card 2.0 presentation, and successful
  superseded-anchor terminal; run `.agents/scripts/check.sh`.
- Add Rush change files for `@excitedjs/feishu-channel`,
  `@excitedjs/dreamux-types`, and `@excitedjs/dreamux`, then run Rush build,
  lint, test, and `typecheck:tests`. No state rebuild is needed.

## Review adjudication

Three independent reviews were completed. Two reviewers found the same blocking
lifecycle ambiguity: `TEAM_CLOSED` can represent an in-progress dissolution that
later fails. The final solution accepts that finding and reserves dissolution
copy for final `team.state(status: 'closed')`, while keeping the existing early
route removal and Dispatcher fallback with neutral copy. The third reviewer found
that a raw split could misclassify a terminating LF or CRLF as an eleventh line.
The final solution accepts that finding and defines content-line scanning plus
explicit regression cases. No material ownership or architecture disagreement
remains.

## Rejected alternatives

- Do not restore Core binding events. Routing remains Channel-owned; the Channel
  reads canonical Team facts from the Core command already required by each
  path.
- Do not add a shared Channel context helper: after provisioning consumes the
  create receipt, manual binding is its only possible caller.
- Do not derive cwd from Space policy or a Team record path; neither is the
  TeamLeader runtime cwd.
- Do not display provider refs or require a live `runtime_status`; both
  contradict the selected runtime-ID behavior and lazy runtime lifecycle.
- Do not convert Collaboration Space cards or the general Card 1.0 helper merely
  for visual uniformity outside the selected route cards.
- Do not add status polling, persisted route-removal causes, provisioning phases,
  retries, or compensation.
