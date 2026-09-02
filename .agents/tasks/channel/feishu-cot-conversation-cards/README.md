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
- Superseded in part (2026-09-02,
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md)):
  the product model above stays in force — one recipient, one standing anchor, at
  most one open card — but the mechanism under it was replaced. The five
  turn-scoped Core events (including `teammate.turn.submitted` and its `source_id`
  echo) and the optional `nativeTurn` provider sink are deleted. Display is keyed
  on the Agent: Core publishes `teammate.input`, carrying the same `source_id`,
  and `teammate.activity`, whose `turn.ended` member is the card's only terminal.
  Read every mechanism named below under one of those old names through that
  mapping.
- State: `in-progress`
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
- Continued optimization (simplification findings raised after the draft pull
  request, none approved for implementation):
  [continued-optimization.md](/.agents/tasks/channel/feishu-cot-conversation-cards/continued-optimization.md).
- Next action: None. Pull request
  [#357](https://github.com/excitedjs/dreamux/pull/357) carries the corrective
  and simplification rounds and is approved and merged into `next`.
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
- Simplification adjudication (operator, 2026-09-02): delete every construct the
  review proved unnecessary, and repair every confirmed local-path projection
  defect. Concretely: report a synthesized Claude native-turn end only when that
  call actually settled an open submission, and delete the per-window
  deduplication flag and its command-start reset with it; delete the Channel's
  per-turn body-suppression ledger entirely, because it can never take effect and
  the duplicate it targets is already an accepted loss; pass this host's home
  prefixes into the conversation projection instead of caching them in a
  process-global, and delete the cache, its test reset hook, and the start-order
  dependency; fix all three confirmed path defects — home resolution, prefixes
  adjacent to ordinary prose punctuation, and prefixes inside `file://` URLs. The
  provider-contract guard around the native-turn sink and the fail-loud
  unattributed-result path are deliberately retained.
- Developer seat (operator, 2026-09-02): the simplification round is implemented
  by a Codex developer TeamMate, replacing the previous single Claude developer
  seat for this round. The TeamLeader still writes no product code, and owns the
  task record, knowledge closeout, commits, pushes, and review requests.
- Review adjudication (operator, 2026-09-02): fix and push the confirmed Claude
  native-turn granularity defect before continuing. A Claude native turn is one
  terminal `result`, not the whole resident execution window. Sequential results
  in one resident window each emit one ended fact; submissions folded into one
  result share that result's single fact. The correction adds no presentation
  identity, logical membership, buffering, or Channel state.

- Requirement change (operator, 2026-09-02, after live testing): restore hiding
  the Channel's own message body, and implement it so that it actually works.
  "裁掉的是这个东西啊！卧槽！那这个要补回来". The 2026-09-02 deletion removed a
  mechanism that could never fire; this restores the capability with the
  correlation that makes it possible — `source_id`, already sent on `team.submit`
  and used by Core for deduplication, echoed back on `teammate.turn.submitted` so
  the Channel establishes its anchor before the body it already displayed
  arrives. This also removes the predecessor-card duplicate that the 2026-09-01
  adjudication had accepted as a loss.
- Design adjudication (operator, 2026-09-02): take the simpler of the two shapes
  offered — the Channel moves its own anchor when it submits, instead of echoing
  a correlation id back on a Core event. "B，我说的话也不一定全都是权威". This
  knowingly supersedes his own 2026-09-01 admission-gated-anchor ruling: that rule
  is what forced every synchronously published fact onto the predecessor card, and
  removing it deletes the cause instead of compensating for it.
- Design adjudication (operator, 2026-09-02): identify the Channel's own body by
  the `source_id` it already supplied, echoed back on `teammate.turn.submitted` —
  not by comparing body text. "你是做了纯文本匹配？我感觉这样更恶心啊。那你还是走
  那个带 source_id 的机制吧". Anchor timing stays as adjudicated above: the
  Channel takes the anchor when it submits, so placement never depends on a
  display-only projection that is allowed to fail open. The echoed id is used
  only to recognize the Channel's own turn.

## Delivery

- Corrective implementation was completed by the single Claude developer on
  2026-09-01 and passed TeamLeader pre-review checks.
- Exactly one developer TeamMate writes product code at a time. The 2026-09-01
  corrective round was written by a Claude developer; the 2026-09-02
  simplification round is written by a Codex developer. The TeamLeader must not
  edit product code in either round.
- The 2026-09-02 simplification round was implemented by the Codex developer and
  passed TeamLeader pre-review after two correction cycles, both opened by a
  TeamLeader finding rather than a failing check: a token-class widening that
  made `<prefix>.<suffix>` read as the prefix, and a shadowing rule that
  published the operator's raw home path. Both are recorded in
  [continued-optimization.md](/.agents/tasks/channel/feishu-cot-conversation-cards/continued-optimization.md).
- Knowledge closeout is complete: the accepted decision record carries an
  amendment for the corrected card lifecycle, and
  [verification.md](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md)
  states the current scope, coverage, and accepted losses.
- Independent implementation review: approved by the Devbox seat after three
  rounds. Every finding it raised was resolved or recorded; the one it left open
  by operator adjudication — the close-drain window — is written into
  [verification.md](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md)'s
  accepted losses rather than left in a review thread.
- Existing proposal files, the withdrawn previous solution, public review text,
  and the generated Feishu design document are not implementation authorities.
- Pull request / CI / merge: [#357](https://github.com/excitedjs/dreamux/pull/357)
  merged into `next` with CI green on its final head.

## Follow-ups

- Simplification findings raised during operator review of the draft pull
  request are recorded in
  [continued-optimization.md](/.agents/tasks/channel/feishu-cot-conversation-cards/continued-optimization.md).
  They are recorded only; each still needs an operator ruling before it becomes
  work.
- Split `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
  before further edits; it is at the 700-line lint cap.
- No per-target or per-logical-turn presentation split is permitted by the
  current requirement.
