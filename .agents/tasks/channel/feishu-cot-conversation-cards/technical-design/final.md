# Final solution: Feishu conversation-of-thought cards

## Shape

Three layers, each owning exactly one concern:

1. **Runtime activity (providers).** Each provider reports live submission
   activity through the synchronous activity sink introduced with the
   completion-token contract: assistant deltas and tool actions carry neutral
   display fields (tool name, one-line action summary). claude-code reports
   from its submission lifecycle; codex reports from its turn manager.
   Providers never render; they only describe.

2. **Conversation projection (core, neutral).** A core projection module
   (`/packages/dreamux/src/channel/conversation-projection.ts`) folds turn
   lifecycle facts and submission activity into an ordered, per-conversation
   event stream, and redacts obvious secret/path material before anything
   leaves core. Projection is a neutral capability of the dispatcher agent and
   team-scoped entities: the dependency reaches the dispatcher, TeamLeader,
   and Team-member construction paths, while team-less dispatcher-spawned
   TeamMates fail the participation predicate. The event scope is a closed
   union:

   - `{ team_name: string; role: 'team_leader' | 'team_member' }` — a
     team-scoped agent conversation;
   - `{ team_name: null; role: 'dispatcher' }` — a team-less dispatcher
     conversation.

   Turn origins are enriched with the neutral `ChannelOrigin` frozen at
   routing time so the projection can
   broadcast where an inbound turn came from; `ChannelOrigin.binding` is
   nullable — leader routes carry their real binding snapshot, dispatcher
   direct routes carry `null` rather than a fabricated binding. Internal
   pushes and control turns are distinct origin kinds. The projection is
   channel-agnostic: it knows nothing about cards, messages, or Feishu.

3. **COT card output (Feishu channel).** The Feishu package consumes the
   projection through its channel sessions and owns everything visual:
   - `feishu-cot-state` / `feishu-cot-session` — presentation state and
     lifecycle. Leader conversations keep one anchored presentation per
     leader; dispatcher conversations are bucketed per `agentName + chatId`
     with an independent presentation per `turn_id`, so concurrent turns in
     different chats (or interleaved in one chat) never steal or close each
     other's cards. Events whose `channel_origin` belongs to another channel
     are ignored outright; dispatcher turns without an inbound channel
     origin are not rendered.
   - `feishu-cot-events` — projection event → COT display event mapping. A
     normal tool-result row omits the arguments already shown by the tool-call
     row. Provider detail cleanup is deliberately disabled, so detail bytes
     remain intact subject to the escaped-byte budget;
   - `feishu-cot-outbox` — pure bounded buffering and append-batch
     selection for one COT presentation;
   - `feishu-cot-io` — serialized presentation create/append I/O with
     failure isolation;
   - `feishu-cot-adapter` — binds sessions, events, outbox, and transport. An
     inbound card is pinned to its turn's message. For a TeamLeader,
     `refreshReplyNextAnchor` forwards a successful Reply's synchronous
     per-message `{ messageId, ordinal }` creation receipt to
     `refreshNextAnchor`, and `setBindingFallbackAnchor` forwards the
     team-group binding notification to `setFallbackAnchorIfAbsent` before any
     inbound anchor exists. Receipt observation and its logger are fail-open.
     A receipt refresh never creates leader state and must match the current
     conversation target by chat, target type, and target key (the topic thread
     for topic groups); a notification completion revalidates that its endpoint
     still routes to the same Team and leader before committing a fallback.
     Two bounded lifecycle fences reject late submitted and fallback anchors:
     a leader-wide fence set by Team close and endpoint-scoped route fences set
     by unbind or replacement. Team starting/running clears both fence kinds for
     that leader; a matching re-bind clears its endpoint route fence. These
     fences prevent re-anchor, unbind, replacement, Team close, or session close
     from being revived by a late callback without disabling the leader's other
     live endpoints.
     Leader activity is admitted only when its `turn_id` matches the current
     single admitted turn, so a fence-rejected or superseded turn cannot open
     or append to another endpoint's card. Route fences and route-driven
     interruption compare the anchor's authoritative `ChannelOrigin.binding`,
     never its visible target fallbacks.
     `turn.settled`
     wraps the card up in place (`completed` → done, any other settlement →
     interrupted);
   - `feishu-cot-diagnostics` — structured diagnostics for COT I/O.
   The transport package gains a stateless COT message surface
   (`/packages/channel/feishu-transport/src/transport/cot.ts`) over the
   official Feishu chain-of-thought endpoints (an append carries 1..50
   events), which require Lark SDK `^1.73.0`. Its text-send option also exposes
   the synchronous, fail-open per-message creation observer used by the
   TeamLeader Reply anchor path.

## Reaction chain replacement

The automatic inbound reaction progression (received / in-progress emoji,
its ledger, timers, and cleanup wiring in the Feishu session and transport)
is removed: the COT card is now the progress surface, and two overlapping
progress surfaces would disagree. The deliberate, model-facing `react` tool
and the `addReaction` surface it uses remain unchanged. This formally
supersedes the issue #63 automatic-reaction tri-state contract; the decision
record and rewritten suites accompany this change.

## Contracts

- Push-back and settlement semantics are untouched: display consumption is
  read-only over the activity sink; the completion router and token contract
  do not change.
- COT failures never fail a turn: presentation I/O errors are contained in
  the channel layer and surface as diagnostics, not turn errors.
- The projection is the only core surface the channel consumes; no channel
  code reaches into teammate or turn internals.
- The runtime contract additions are display-only. The tool-call activity's
  `action` field (`RuntimeToolAction | null`) is required but nullable: a
  provider must state it has nothing to display rather than omit the field;
  providers that report no activity at all remain valid (`dreamux-types`
  runtime contract tests pin this).
- Every turn that enters conversation projection settles exactly once on the
  display surface: the turn publishes its terminal fact (`completed`, `failed`,
  or `stopped`) from its own submission settlement, so cards always wrap up
  even when the runtime folds several submissions into one completion or a
  turn ends without one. Turns rejected by the participation predicate publish
  no display events.

## Alternatives considered

- Emitting one Feishu message per event: rejected — floods groups and cannot
  follow the conversation; in-place card updates with per-turn anchoring keep
  exactly one live view per conversation.
- Rendering in core: rejected — presentation is channel policy; core stays
  neutral behind the `ChannelProvider` seam.
- Polling transcripts for display: rejected — transcripts are cold history
  under the completion-token contract; live display must come from the
  synchronous activity sink.
- Rendering teammate turns in Feishu COT: rejected — Team-member events are a
  neutral provider surface, but treating them as leader events would corrupt
  leader-owned presentation state. Feishu filters them explicitly, while core
  avoids hard-excluding a role another Channel provider may legitimately
  consume. Team-less dispatcher-spawned TeamMates still publish nothing.
- One global anchor per dispatcher: rejected — a dispatcher serves many
  chats concurrently; a single anchor lets conversations clear or capture
  each other's cards. Per-chat, per-turn state is the only shape that keeps
  cards correct under interleaving.
- Keeping automatic reactions alongside COT: rejected — two progress
  surfaces drift apart and double every inbound's side effects; the COT card
  replaces the tri-state, while the deliberate `react` tool stays.
