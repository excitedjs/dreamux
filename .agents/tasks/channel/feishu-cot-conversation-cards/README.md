# Feishu conversation-of-thought (COT) cards

## Current state

- Goal: Render each channel-facing agent conversation (dispatcher and team
  leader; team members remain event-only) as a live, incrementally updated
  Feishu card:
  runtime submission activity (assistant output and tool calls) flows through
  a neutral core conversation projection into channel sessions, and the
  Feishu channel pins an inbound card to that turn's message, lets a TeamLeader
  use its latest same-target Reply receipt for the next card, and uses the
  team-group binding notification as the pre-inbound fallback, wrapping each
  card up in place on settlement. COT display replaces the automatic inbound
  progress reactions (the deliberate `react` tool stays). Upgrade the Lark SDK
  to `^1.73.0` for the card APIs this needs.
- State: `done`
- Requirement: [Current requirement](/.agents/tasks/channel/feishu-cot-conversation-cards/requirement.md)
- Final solution: [Final solution](/.agents/tasks/channel/feishu-cot-conversation-cards/technical-design/final.md)
- Verification: [Verification](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md)
- Solution review Issue: Not created — the operator approved the recorded final
  solution directly and waived further consultation (simplest path).
- Blockers: None.
- Next action: Prepare the pull request after operator approval. Do not push or
  open the pull request before that approval.
- Related tasks: Builds on
  [adopt-completion-token-routing](/.agents/tasks/completion-routing/adopt-completion-token-routing/README.md)
  (the submission activity sink this task consumes). The parked
  collaboration-resource work is out of scope.

## Development approval

- Status: Granted.
- Source: Operator instruction via the Team's bound channel, 2026-08-25 —
  deliver the COT card capability as one PR, following the same process shape
  as the completion-token task (task record; single developer, code first;
  two independent review seats; full test verification; PR).
- Approved implementation boundary: `packages/dreamux-types` channel and
  runtime activity types, `packages/dreamux` core conversation projection and
  channel/teammate service wiring, `packages/agent-runtime/claude-code` and
  `packages/agent-runtime/codex` tool-action display reporting,
  `packages/channel/feishu-channel` COT modules,
  `packages/channel/feishu-transport` COT send surface and the Lark SDK
  upgrade, associated tests and Rush change files.
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

## Delivery

- Implementation and test-stage review converged with no accepted finding left
  open. Full verification evidence is recorded in
  [verification.md](/.agents/tasks/channel/feishu-cot-conversation-cards/verification.md).
- Knowledge closeout: Complete — the durable capability and supersessions are
  recorded in
  [Feishu COT conversation display](/.agents/decisions/feishu-cot-conversation-display.md),
  and the Channel, routing, architecture, and non-blocking-inbound current-state
  pages are aligned.
- Pull request / CI / merge: Pending operator approval; no push or merge has
  been performed.

## Follow-ups

- Split `/packages/dreamux/src/service/dispatcher-service/collaboration-routing.ts`
  before further edits; it is at the 700-line lint cap.
- Consider per-turn TeamLeader presentations if future conversation interleaving
  requires more than the current single-active-presentation model. The current
  model intentionally ignores a stale settlement whose `turn_id` no longer
  matches the active card.
