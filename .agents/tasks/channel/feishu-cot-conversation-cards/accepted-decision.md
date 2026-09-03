> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree: this is
> the accepted decision record of this task, preserved verbatim.

# Feishu COT conversation display

- **Status:** Accepted and implemented
- **Date:** 2026-08-26
- **Affects:** `@excitedjs/dreamux-types`, `@excitedjs/dreamux`,
  `@excitedjs/agent-runtime-claude-code`, `@excitedjs/agent-runtime-codex`,
  `@excitedjs/feishu-channel`, `@excitedjs/feishu-transport`, Channel turn
  display, and automatic inbound progress reactions
- **Task:** [feishu-cot-conversation-cards](/.agents/tasks/channel/feishu-cot-conversation-cards/README.md)

## Context

Channel conversations previously exposed progress through an automatic
received/in-progress reaction owned by the Feishu session. That signal showed
only delivery phase, could outlive a failed or stopped turn, and could not
present live assistant or tool activity. The runtime activity sink already
carried the authoritative live facts, but core had no neutral, display-only way
to project them to Channel sessions.

The capability also needs an honest ownership boundary. The dispatcher agent
and TeamLeaders own Feishu-visible conversations; Team members publish neutral
conversation facts for provider choice, while dispatcher-spawned TeamMates do
not. A dispatcher can serve several chats concurrently, so
its presentation state cannot be one process-wide active card. Display must
remain observational: a publisher, sanitizer, logger, or platform request must
never change admission, settlement, completion delivery, or shutdown behavior.

## Decision

Introduce a neutral conversation projection for conversation-bearing entities
and let the Feishu Channel own the COT presentation.

- Core injects `ConversationProjection` into the dispatcher agent and
  team-scoped `TeammateService` instances. TeamLeaders and Team members publish
  the neutral event surface; team-less dispatcher-spawned TeamMates fail the
  participation predicate and publish nothing.
- The public scope is a closed union: `{ team_name: null, role: 'dispatcher' }`
  or `{ team_name: string, role: 'team_leader' | 'team_member' }`. Dispatcher
  turns participate only when core captured a
  Channel origin; scheduled, completion, and control dispatcher turns produce
  no partial stream.
- Core publishes the display-only `turn.submitted`, `turn.message`,
  `turn.tool_call`, and `turn.settled` event surface. Every admitted EntityTurn
  that enters conversation projection publishes exactly one terminal fact from
  its own submission settlement, including `completed`, `failed`, and
  `stopped`, even when a runtime folds several submissions into one completion;
  non-participating turns publish no display events.
- Runtime activity fields and completed assistant text are sanitized and
  bounded before publication. Duplicate and pre-admission activity retention
  is bounded and drops newest with one warning. Every projection entry point is
  fail-open, including its diagnostic logger.
- The Feishu session pins an inbound turn to its inbound message. For a
  TeamLeader, a successful Reply receipt may anchor the next card and the
  team-group binding notification is the fallback before any inbound exists. A
  receipt never recreates missing leader state and must match the current
  conversation target by chat, target type, and target key (the topic thread
  for topic groups); a fallback commit revalidates the endpoint's current Team
  and leader. Late submitted and fallback anchors consult two bounded fences: a
  leader-wide Team-close fence and endpoint-scoped route fences for unbind or
  replacement. Team starting/running clears both kinds for that leader, while a
  matching re-bind clears its route fence. These guards prevent late callbacks
  from reviving presentation state after re-anchor, unbind, replacement, Team
  close, or session close without disabling another live endpoint.
  Leader activity is accepted only for the state's single admitted `turn_id`;
  route fences and interruption match the anchor's authoritative binding
  endpoint rather than visible-target fallbacks.
  TeamLeaders retain one active presentation and correlate settlement by
  `turn_id`; dispatchers keep independent per-chat and per-turn state and ignore
  foreign-channel origins. COT create, append, and finish calls are bounded by
  deadlines, and abandoned or settled state is reaped from the session-local
  indexes.

## Supersession

This decision formally supersedes the automatic inbound reaction tri-state from
issue #63 and its issue #69 add-then-cancel replacement ordering. The Feishu
Channel no longer adds received/in-progress reactions or maintains their ledger;
COT cards are the automatic progress surface. The deliberate model-facing
`react` tool and the transport `addReaction` operation remain available.

The issue #63 **non-blocking inbound gate is not superseded**. Dreamux must still
submit before waiting for completion, accept a second inbound while a turn is in
progress, and let the runtime fold that input without a Dreamux submission
mutex. Live Codex coverage remains the load-bearing proof.

This decision also supersedes only the "no public Channel turn events" clause
of
[entity-owned-teammate-lifecycle-and-object-turns](/.agents/tasks/architecture/service-topology-foundations/requirement.md#entity-owned-teammate-lifecycle-and-object-turns).
The reintroduced event surface is live, best-effort, display-only, and scoped to
conversation presentation. Entity-owned lifecycle, provider-native completion
identity, no durable Turn archive, and no Turn id in service receipts or
persisted state remain in force.

## Consequences

- Channel sessions can render live progress without importing core services,
  runtime-native schemas, or transcripts.
- Channel providers receive Team-member conversation events and choose whether
  to present them; Feishu COT explicitly ignores them.
- The event `turn_id` is process-local display correlation, not a public command
  handle, routing authority, persistence key, or completion identity.
- Dispatcher presentation growth is capped at 512 conversations, 512 turns per
  session, and 64 turns per chat. Core retains at most 512 early activity events
  and 512 projected activity facts per submission.
- Display loss is acceptable; turn failure is not. All display projection and
  Feishu COT I/O paths therefore fail open relative to runtime admission,
  settlement, delivery, and shutdown.
- The automatic reaction constants and removal surface are no longer part of
  the Feishu Channel/transport contract. Explicit model reactions remain a
  separate, intentional tool action.

## Alternatives Considered

- **Keep reactions beside COT cards.** Rejected: two automatic progress
  surfaces can disagree and duplicate every inbound side effect.
- **Render every TeamMate in Feishu COT.** Rejected: Team members do not own
  leader presentation state, and dispatcher-spawned TeamMates have no
  participating conversation scope. The neutral Team-member surface remains
  available to other Channel providers.
- **Render or store cards in core.** Rejected: cards, anchors, throttling, and
  Feishu I/O are provider presentation policy.
- **Use one dispatcher presentation.** Rejected: concurrent chats and
  interleaved turns would steal or terminate each other's cards.

## Amendment — corrected card lifecycle (2026-09-01 / 2026-09-02)

The 2026-08-26 decision above is preserved as accepted history. The clauses
listed here were replaced by the corrective round recorded in
[requirement.md](requirement.md) and
[continued-optimization.md](continued-optimization.md); everything else in the
decision still stands, including the issue #63 supersession boundary and the
display-only, fail-open discipline.

What replaced what:

- **Presentation identity.** "Dispatchers keep independent per-chat and per-turn
  state" and "TeamLeaders retain one active presentation … for the state's
  single admitted `turn_id`" are replaced by one presentation per *recipient*.
  Every TeamLeader and the Dispatcher owns one standing anchor and at most one
  open card, whichever Feishu chat, DM, group, or topic supplied the anchor. A
  target is an attribute of the anchor, not a state key. The per-chat and
  per-turn dispatcher modules are deleted, and with them the 512/512/64
  presentation caps.
- **What moves an anchor.** Only a Channel user message that Core reports as
  admitted. "A successful Reply receipt may anchor the next card" and the
  deferred `nextAnchor` it needed are removed: a Reply is outbound only. A
  visible Team bind card may still initialize a TeamLeader that has no anchor,
  and never replaces one.
- **What closes a card.** `teammate.turn.settled` no longer closes, reopens, or
  re-anchors anything. Core publishes a new actor-scoped
  `teammate.native_turn.ended` fact, sourced from an optional provider seam
  (`AgentRuntimeCreateContext.nativeTurn`), and that is a card's only terminal.
  (Superseded 2026-09-02: the fact is now the `turn.ended` member of
  `teammate.activity`, produced by the one activity sink; the second sink and
  the `teammate.native_turn.ended` kind are deleted. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)
  One Claude Code terminal `result` and one Codex `turn/completed` are each one
  native turn; several Dreamux submissions folded into one of them share its
  single end. A provider synthesizes an end for a stop, failure, or protocol
  loss only when that call actually settled a still-open submission, so an
  ordinary success reports exactly one end and no deduplication state exists.
  (Superseded 2026-09-03: the operator ruled the providers' at-most-once tables
  out, so a provider keeps no display state and never asks whether a turn was
  open. It reports `turn.ended` from the native terminal it observed — one codex
  terminal per turn, one Claude `result` — and again when it tears down a native
  session: codex from `TurnManager.stop()` and from its first protocol failure,
  Claude Code from `stop()` and from the state fence, both gated on a live
  child,
  and from a run that died, gated only on not having been stopped. An ordinary
  success followed by a teardown therefore reports two ends, not one. The only
  deduplication left is the native stream's own, and the Channel ignores an end
  that arrives with nothing open (requirement rule 8). A runtime start that
  fails
  reports no end from either provider — the codex manager does not exist until
  the native session is up, and a Claude child that failed to come up is gone
  before Core's `stop()` — so Core's own failed end carries the start error to
  the card; the one exception is a state write failing after the native session
  is up, where the fence's teardown ends first. See
  [split-streaming-display-from-pushback](/.agents/tasks/architecture/split-streaming-display-from-pushback/README.md).)
- **What is displayed.** The source whitelist is gone: once a recipient has an
  anchor, every projected input displays, including the body of the message this
  Channel itself submitted. There is no body-suppression ledger — such a mark
  could only be written after Core had already published that body inside the
  admitting call.
- **Accepted best-effort losses** are recorded in
  [verification.md](verification.md) and are operator rulings, not defects.
- **Projected paths** are renamed rather than blanked: the workspace reads `.`
  and this host's home reads `~`, found by scanning the prefixes this host
  actually uses. The prefixes are resolved once during `Server.start()` and
  passed into each conversation projection as a value; no process-global cache
  decides whether a path is renamed. See
  [`/packages/dreamux/src/platform/home-paths.ts`](/packages/dreamux/src/platform/home-paths.ts)
  and
  [`/packages/dreamux/src/channel/conversation-projection.ts`](/packages/dreamux/src/channel/conversation-projection.ts).
