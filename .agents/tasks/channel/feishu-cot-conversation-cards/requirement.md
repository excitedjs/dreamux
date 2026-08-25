# Requirement: Feishu conversation-of-thought cards

## Problem

Operators watching a Feishu group today see only final agent replies. What the
agent is doing between an inbound message and its completion — assistant
progress, tool invocations, internal pushes between agents — is invisible,
so long turns look like silence and multi-agent hand-offs are hard to follow.

## Requirement

1. **Live conversation card.** For each conversation the Feishu channel
   maintains one card ("COT card") that updates in place as the turn
   progresses, instead of emitting a message per event.
2. **Anchored to the turn's inbound message.** Each inbound turn's card is
   pinned to the channel message that started it, so the live view sits exactly
   where the operator asked. For a TeamLeader, the next card may instead use
   the leader's latest Reply receipt for the same conversation target — the
   same chat and, for a topic group, the same topic thread — while the binding
   notification for the team group is the fallback before any inbound exists.
   When a turn that entered conversation projection settles, the card wraps up
   in place (`completed` renders as done; any other settlement renders as
   interrupted). A late submitted fact, Reply receipt, or binding notification
   after re-anchoring, unbinding, route replacement, Team close, or session
   close must never recreate or revive presentation state.
3. **Neutral publication, scoped display.** Core publishes the conversation
   event surface for the dispatcher agent, TeamLeaders, and Team members so a
   Channel provider may consume the roles it supports. Dispatcher-spawned,
   team-less TeamMates remain outside the projection. Feishu COT display
   consumes only dispatcher and TeamLeader events; Team members are not
   rendered as leader conversations.
4. **Dispatcher conversations are chat-isolated.** A dispatcher serves many
   channels and many chats; its COT state is kept per chat and per turn.
   Concurrent conversations in different chats must never steal, close, or
   re-anchor each other's cards; events whose origin belongs to another
   channel are ignored. Dispatcher turns without an inbound channel origin
   (scheduled, completion, control) do not render — they are not
   conversations.
5. **Inbound and internal push display.** Inbound channel turns and internal
   (agent-to-agent) pushes into a leader's conversation render with their
   origin, so the card shows who fed the conversation and from where.
6. **Tool-call display enrichment.** Runtime providers report tool actions
   through the submission activity sink with enough neutral display detail
   (tool name, one-line summary) for the card to render meaningful tool rows.
7. **COT replaces automatic progress reactions.** The automatic inbound
   reaction progression (received / in-progress emoji and its cleanup ledger)
   is removed; the COT card is the progress surface. The model-facing `react`
   tool remains — agents can still place reactions deliberately.
8. **Neutral core, channel-owned presentation.** The core exposes a neutral
   conversation projection fed by submission activity and turn lifecycle
   facts; all Feishu-specific rendering, anchoring, throttling, and card I/O
   live in the Feishu channel package. No provider-specific concept enters
   core or the runtime contract beyond neutral display fields.
9. **Lark SDK.** Upgrade `@larksuiteoapi/node-sdk` to `^1.73.0` for the
   official chain-of-thought message APIs the COT output uses; existing
   transport behavior must not regress.

## Non-goals

- Reply interaction enhancements (choice cards, reply contracts).
- Workflow cards and any workflow-specific channel UI.
- Collaboration-space resources (parked separately).
- Channel scoping changes (TeamLeader scope et al.).
- Web or platform surfaces.
- Feishu COT display for Team-member or dispatcher-spawned TeamMate turns
  (their core publication rules remain as stated in requirement 3).

## Acceptance

- Full workspace build, typecheck (src and tests), lint, and test suites
  green on both runtimes' packages, dreamux-types, dreamux core,
  feishu-channel, and feishu-transport.
- The issue #63 automatic reaction tri-state contract is formally superseded:
  a decision record accompanies the change, the previously locked suites are
  rewritten against the new contract (not silently deleted), and the codex
  live suites pass against the new behavior.
- Change files with the correct 0.x types accompany every published package
  the PR touches; the reaction-removal note states the replacement (COT
  display) and the `react` tool retention.
- No internal identifiers, hosts, or non-public example values in code,
  tests, or fixtures.
