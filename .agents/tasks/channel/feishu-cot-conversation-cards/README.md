# Feishu conversation-of-thought (COT) cards

## Current state

- Goal: Give each TeamLeader, and the Dispatcher, one global standing anchor and
  at most one open Feishu COT card. Every successfully admitted Feishu inbound
  replaces the anchor, closes the old card, and opens its successor; Reply never
  affects an anchor or card; a Team bind card may initialize only an anchorless
  TeamLeader, while a Dispatcher remains anchorless until its first user inbound;
  after initialization every input, including a restart notice in the live
  session, displays by default except the already-visible Feishu user body;
  pre-anchor events are absent only because no card placement exists; all
  anchor/card state is session-memory-only and is intentionally lost when that
  session restarts; one native turn emits one ended fact and closes the recipient's
  current card without logical-turn membership. Projected text keeps local paths
  readable by rendering this host's workspace and home prefixes as `.` and `~`.
- State: `review`
- Requirement: [Current requirement](/.agents/tasks/channel/feishu-cot-conversation-cards/requirement.md)
- Technical design: owned by the single Claude implementation developer. The
  developer receives only the locked requirement and must derive the design
  from current source and repository guidance. Existing proposals and the
  withdrawn previous solution are not implementation inputs.
- Withdrawn historical solution marker:
  [technical-design/final.md](/.agents/tasks/channel/feishu-cot-conversation-cards/technical-design/final.md).
- Verification: [Verification](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md)
- Solution review Issue:
  [#360](https://github.com/excitedjs/dreamux/issues/360).
- Blockers: None.
- Accepted decision record: [accepted-decision.md](/.agents/tasks/channel/feishu-cot-conversation-cards/accepted-decision.md) (backfilled 2026-09-01).
- Next action: Complete independent implementation review and knowledge
  closeout, then update draft pull request
  [#357](https://github.com/excitedjs/dreamux/pull/357) and mark it ready.
- Related tasks: Builds on
  [adopt-completion-token-routing](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md)
  (the submission activity sink this task consumes). The parked
  collaboration-resource work is out of scope.

## Development approval

- Status: Granted.
- Source: Operator instruction via the Team's bound channel, 2026-09-01 — lock
  the refreshed requirement and assign one Claude developer to design and
  implement it; the TeamLeader must not modify product code and must pass only
  the requirement to the developer.
- Approved implementation boundary: `packages/dreamux-types`,
  `packages/dreamux`, `packages/agent-runtime/claude-code`,
  `packages/agent-runtime/codex`, `packages/channel/feishu-channel`, affected
  tests, current architecture knowledge, and Rush change files. Transport,
  configuration, persistence, dependency, and service changes are out of scope
  unless current-source evidence shows they are strictly required by the locked
  requirement; any such expansion requires an operator decision. The original
  approved scope explicitly includes readable local-path projection in Dreamux
  conversation facts: workspace and current-host home prefixes render as `.` and
  `~` rather than being blanked or replaced by opaque placeholders.
- Explicit non-goals: reply interaction enhancements, workflow cards,
  collaboration-space resources, channel scope changes, and any web/platform
  surface.
- Scope updates (operator instructions via the bound channel, 2026-08-26):
  dispatcher conversations render COT too; Team members publish the neutral
  conversation event surface but remain explicitly excluded from Feishu COT
  display; dispatcher-spawned TeamMates remain outside the projection. The
  automatic inbound progress reaction chain is removed in the same change
  (the model-facing `react` tool stays), formally superseding the issue #63
  tri-state contract.
- Corrective instruction (operator, 2026-09-01): one Team has one anchor and at
  most one open card regardless of Feishu target. Reply never affects an anchor
  or card. A visible bind card may initialize an anchorless TeamLeader; a
  Dispatcher has no anchor until its first Channel user message. Pre-anchor events
  produce no COT only because no placement exists; while the session remains live
  and an anchor exists, a restart notice and every other source display normally.
  Anchors and open-card references are best-effort, session-memory-only state;
  restarting the session intentionally discards all of them without recovery or
  replay.
  Each Agent Runtime emits one ended fact per native turn regardless of folded
  inputs.
  Feishu already owns Team routing; the sole routing exception is a
  proven-no-admission fallback from a missing or closed Team to the Dispatcher.
- Review adjudication (operator, 2026-09-01): switch the anchor only after steer
  or queue admission succeeds. Do not add complex ordering guarantees for facts
  synchronously projected before that success is observed; predecessor-card or
  no-anchor loss is acceptable. Do not add an early-native-end ordering buffer,
  and allow a tool result that crosses an anchor replacement to be dropped. A
  transient card create or append failure must not disable the standing anchor;
  a later opening activity must be able to open a card there. A native-ended fact
  only closes an existing card and is ignored when no card is open. A visible bind
  card may initialize a TeamLeader only when no standing anchor exists; it never
  replaces an existing anchor.
- Review adjudication (operator, 2026-09-02): the local-path projection change is
  an original requirement and remains in this pull request. The prior scope-drift
  finding is rejected because the task record had omitted that requirement. Fix
  the confirmed implementation defects in home resolution, punctuation-adjacent
  prefixes, and `file://` prefix recognition without removing the capability.
- Review adjudication (operator, 2026-09-02): fix and push the confirmed Claude
  native-turn granularity defect before continuing. A Claude native turn is one
  terminal `result`, not the whole resident execution window. Sequential results
  in one resident window each emit one ended fact; submissions folded into one
  result share that result's single fact. The correction adds no presentation
  identity, logical membership, buffering, or Channel state.

## Delivery

- Corrective implementation was completed by the single Claude developer on
  2026-09-01 and passed TeamLeader pre-review checks.
- The single Claude developer is the sole product-code writer. The TeamLeader
  must not edit product code.
- Independent implementation review and knowledge closeout are pending.
- Existing proposal files, the withdrawn previous solution, public review text,
  and the generated Feishu design document are not implementation authorities.
- Pull request / CI / merge: Draft pull request
  [#357](https://github.com/excitedjs/dreamux/pull/357) targets `next` while
  independent review and knowledge closeout continue; CI and merge are pending.

## Follow-ups

- Split `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
  before further edits; it is at the 700-line lint cap.
- No per-target or per-logical-turn presentation split is permitted by the
  current requirement.
