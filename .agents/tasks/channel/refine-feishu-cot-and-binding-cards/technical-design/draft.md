# Technical solution draft

## Outcome and boundary

Keep the change inside the Feishu Channel except for consuming the existing
neutral `team.status` command. Core already owns and returns every Team fact the
cards need, so no Core contract, persisted record, provider interface, or routing
document changes. The Channel gains one small route-Team view derived from the
canonical command response and uses it for both manual and provisioned binding.

The implementation changes five behaviors only:

1. Plain-text tool results keep at most ten source lines before the existing
   Feishu byte fitting runs. JSON objects and arrays bypass this line rule.
2. Replacing a non-null COT anchor closes the superseded card as completed.
   Retiring an anchor to `null`, session close, route release, Team close, and a
   runtime-reported interruption remain interrupted.
3. Manual and provisioned route binds obtain the same canonical Team card facts
   before the route becomes visible.
4. Route-bound notifications render the selected Team-focused Card 2.0 design.
5. Explicit MCP unbind and passive Team closure render distinct selected-set-2
   Card 2.0 notifications.

Collaboration-space policy cards and the general Card 1.0 status-card helper stay
unchanged.

## 1. Bound plain-text tool results where presentation class is known

Extend `toolResultOutput` in
`/packages/channel/feishu-channel/src/feishu-cot-events.ts`. It already parses the
complete result before classifying it, which is the correct ownership point. If
the parsed value is a non-null object or array, pretty-print it as JSON exactly as
today and do not count lines. Otherwise scan the original text by LF/CRLF source
line boundaries. A terminal delimiter ends the preceding line and does not create
another content line; a delimiter followed by more content, including another
blank-line delimiter, does. When an eleventh content line exists, keep the first
ten complete lines, preserve their original line separators, and append the
existing English `TRUNCATION_MARKER` on a new line. Apply `preserveSpacing` only
after that source-text line cut.

The existing `assembleToolResultContent` byte-fitting pipeline remains the final
bound for both classes. No new budget, option, or Core processing is introduced.

## 2. Give anchor replacement its own terminal without widening lifecycle rules

Change `FeishuCotAdapter.advanceAnchor` so the terminal follows the transition:

- old anchor -> new non-null anchor: `completed`;
- old anchor -> `null`: `interrupted`.

The method already owns both the old presentation and the replacement target, so
the decision needs no new state or parameter. `finishCard`, `close`, and all route
and Team fences keep their current explicit terminals. Update the method and
domain comments that currently say replacement is interruption; do not alter the
anchor generation, receipt opening, open-tool-call clearing, or serialized I/O.

## 3. Read one canonical route-Team card context

Add one Feishu-local helper module that invokes `team.status` and returns the
minimum display context:

```ts
interface FeishuRouteTeamContext {
  teamName: string;
  leaderName: string;
  agentRuntime: string;
  runtimeCwd: string;
}
```

Read `teamName`, `leaderName`, and configured runtime ID from `answer.team`
(`team_name`, `leader_name`, `leader_agent_runtime`), and the actual runtime cwd
from `answer.leader.repo.path`. Do not inspect provider references or reconstruct
paths from a collaboration-space repository policy. A nullable
`leader.runtime_status` is irrelevant: a lazily started TeamLeader still has a
durable identity and repo path.

The helper preserves the existing missing/closed-Team public failures. A response
that cannot supply the four required display facts cannot produce a successful
route-bound notification and therefore fails before route persistence; this is a
real reachable state when the canonical Team read cannot load its leader identity.
It does not start or probe the runtime.

Manual `bindChannel` awaits this context where it currently calls
`requireRoutableTeam`, then performs the existing durable bind, previous-owner
release, new-owner claim, notification, and return in the same order.

Automatic provisioning awaits the same context after a successful `team.create`
and before `routing.bind`. Its order becomes:

```text
team.create -> team.status -> routing.bind -> COT claim/card -> team.submit
```

Thus an unavailable canonical status leaves the created Team as the ordinary
unbound Team the provisioning design already accepts for any pre-bind failure,
and returns the inbound as `unsubmitted`; no compensation or retry mechanism is
added. Extend the provisioning announcement input with the resolved context so it
never performs another read after the route is visible.

## 4. Render the three route notifications directly as Card 2.0

Keep Card 2.0 construction in
`/packages/channel/feishu-channel/src/feishu-binding-notification-card.ts`. Do not
change `buildFeishuStatusCard`: collaboration-space cards still use that Card 1.0
surface, while route cards deliberately adopt the operator-selected Card 2.0
baseline. Small private builders in this file may express the repeated English
plain-text, static label, fact-column, and full-width detail-panel shapes without
creating a repository-wide card abstraction.

Every production route card removes preview tags and uses English fixed copy
only. Dynamic target, Team, TeamLeader, runtime ID, and cwd values are
`plain_text`; static colored labels may use the already validated Markdown shape.
No dynamic string is interpolated into Markdown.

### Route bound

- green header and bound state;
- Team name as the hero;
- target, TeamLeader, and configured Agent Runtime ID as three grey fact cells;
- runtime cwd in one full-width green-tinted detail panel, matching set 2's
  bottom-panel treatment.

### Explicit MCP unbind: selected set 2

- neutral grey header and unbound state;
- Team name as the hero;
- target, binding kind, and Team as three grey fact cells;
- one full-width grey reason panel stating that Feishu Channel removed this
  route and the Team remains active.

### Passive Team closure: selected set 2

- neutral header with orange warning icon/tag and orange Team hero;
- the same three fact cells;
- one full-width orange reason panel stating that the Team closed and all of its
  routes were removed automatically.

Split the current shared unbound renderer into three truthful presentations:

- `unbindChannel` calls the explicit-unbind renderer;
- `announceTeamClosed` calls the Team-dissolution renderer only when invoked
  after a final `team.state(status: 'closed')` event;
- the existing inbound fallback after a `TEAM_CLOSED` rejection uses a
  cause-neutral route-ended renderer, because that error is also raised while a
  dissolve is merely in progress and the dissolve can still fail.

Make the cause explicit at the existing `forgetTeamRoutes` caller boundary:
the closed-event caller requests final-dissolution presentation; the admission
rejection caller requests neutral route-ended presentation. Both still share the
same one durable `routing.forgetTeam` commit path. Preserve route mutation, COT
fencing, best-effort notification, and the single Dispatcher fallback. Do not
change Core's error vocabulary, poll status, add state, or claim that the Team
remains active in the neutral card.

## Verification

- Extend `feishu-cot-tool-rows.test.ts` with 10-line, LF-terminated 10-line,
  CRLF-terminated 10-line, 11-line, explicit blank eleventh-line, JSON
  object/array over ten lines, JSON scalar, and post-line-cut byte-budget cases.
- Extend `feishu-cot.test.ts` across both TeamLeader and Dispatcher recipients:
  three successive non-null anchors close the first two cards as `done`; anchor
  retirement, route release, Team close, session close, and native interruption
  remain interrupted; mid-native-turn activity continues on the successor.
- Add focused notification-card tests for schema 2.0, English-only static copy,
  absent preview labels, selected colors/layout, configured runtime ID, literal
  Markdown-significant dynamic values, and the full-width bound-cwd/set-2 reason
  panels.
- Extend binding-operation tests to assert canonical context is read before bind,
  manual unbind and Team-close paths choose different renderers, and a lazy
  leader with `runtime_status: null` remains bindable.
- Extend session-level tests for the third route-removal cause: an inbound
  rejected while dissolve is pending keeps the neutral route-ended card, route
  removal/COT interruption, and one Dispatcher fallback even if dissolve is then
  refused; only a final closed event emits the Team-dissolution card.
- Extend provisioning tests to assert `team.create -> team.status -> bind ->
  announce -> submit`, context propagation, and no route/announcement/submission
  when status detail cannot be obtained.
- Update the product catalog and Channel domain to state the three distinct route
  notifications, canonical runtime context, English Card 2.0 presentation, and
  successful superseded-anchor terminal. Run `.agents/scripts/check.sh`.
- Run Rush build, lint, test, and `typecheck:tests`. Add the required
  `@excitedjs/feishu-channel` change file through `rush change`; this is a
  user-visible non-breaking notification/presentation fix, with no state rebuild.

## Rejected alternatives

- Do not restore Core binding events. Routing is Channel-owned; the Channel only
  reads canonical Team facts through the existing neutral command.
- Do not derive cwd from Space policy or the Team record path: neither is the
  TeamLeader runtime cwd.
- Do not display provider refs or require a live `runtime_status`; both contradict
  the selected runtime-ID behavior and lazy runtime lifecycle.
- Do not convert collaboration-space cards or the general Card 1.0 helper merely
  for visual uniformity beyond the operator-selected route cards.
- Do not add persisted provisioning phases, retries, or compensation for a
  pre-bind status-read failure.
