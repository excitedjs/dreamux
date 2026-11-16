# Requirement: state when an ordinary member should message its owner

- Source: the operator's request in the bound conversation on 2026-11-16, after
  reviewing a real Team's transcripts (quoted under [Evidence](#evidence)).
- Status: Accepted for development. The operator approved both items on
  2026-11-16 with 「可以，我感觉1和2 可以做一下。」.

## Product outcome

An ordinary member should report through `teammate.send` when, and only when,
its owner needs the information before the member's turn ends. Its turn result
already reaches the owner on its own, so progress narration and an end-of-turn
repeat are wasted context for the owner, not extra service.

## Evidence

Measured on a live Team on 2026-11-16 (one TeamLeader, three gpt-codex members,
one Team turn open for 46 minutes):

- The user typed 593 characters into that turn. The members injected 51,294
  characters into the same turn — 86 times the user's own input. The leader's
  context grew from 177k to 312k tokens within that turn.
- The members made 51 `teammate.send` calls to their owner.
- Only 13% (7 of 52) were preceded by an explicit "report back / notify me"
  instruction from the owner. The rest were the member's own decision.
- 15 of the 32 sends made during a turn landed within 120 seconds *before* that
  member's own final answer — the send was followed almost immediately by the
  automatic completion notice carrying the same work. Those tail sends were 30%
  of all send text.
- Every one of the 51 sends landed while the owner's turn was open, so every one
  was folded into the live turn. None started a new owner turn.

Root cause, verified in source rather than inferred from the sample:

- Both runtime adapters deliver only a turn's **final** assistant message to the
  owner. Codex takes the last `agentMessage` item
  (`packages/agent-runtime/codex/src/events.ts`, `extractAssistantText`);
  Claude Code takes the `result` text, falling back to the last assistant text
  (`packages/agent-runtime/claude-code/src/stream.ts`, `outcome()`).
  Intermediate commentary never reaches the owner.
- `teammate.send` is therefore the member's only mid-turn channel. That is why
  it reaches for it to narrate progress, and also why it uses it at the very end
  of a turn where the automatic notice already says the same thing.
- Neither model-facing surface states when `send` is worth using. The member
  prompt states automatic delivery as a trailing clause inside one long
  sentence, after the send/list capability; the `send` description states what
  the call does and what its receipt means, and nothing about the choice.

## Scope

Two model-facing texts, both in `packages/dreamux/src/service/`:

1. `agent/system-prompt.ts` — the ordinary-member communication statement.
   The fact that a turn's final answer is delivered to the owner becomes the
   leading statement instead of a subordinate clause.
2. `agent/member-mcp.ts` — the `send` tool description gains the condition
   under which the call is worth making.

## Non-goals and preserved behavior

- **A mid-turn blocker report must remain available.** The product requirement
  ([proactive ordinary-member messaging](/.agents/tasks/mcp/enable-team-member-messaging/requirement.md),
  user story 1) has a member report a blocker during its turn. Neither text may
  remove, discourage, or gate that path.
- No change to delivery, admission, ordering, folding, availability limits,
  receipts, reminders, tool schemas, routing, or either runtime adapter. This is
  wording only.
- No prompt-length increase beyond what the replacement needs: the current
  member communication statement was deliberately shortened on 2026-10-14 to a
  Codex-style capability sentence in
  [PR #475](https://github.com/excitedjs/dreamux/pull/475), and that decision
  stands.
- No new mandatory reporting frequency and no end-of-turn send requirement — the
  same boundary the 2026-10-14 wording change recorded.
- The TeamLeader and Dispatcher roles are unchanged: this concerns what an
  ordinary member is told about its own reporting, not how an owner delegates.

## Acceptance criteria

- The member communication statement states the delivery fact before the
  send/list capability: the turn's outcome is reported, and a completed turn
  carries the final message. It must be accurate about failed turns, whose text
  is not delivered.
- The `send` description states when the call is worth making, in terms of the
  recipient's need before the turn ends. It does not restate the delivery fact;
  the prompt owns that.
- Both texts stay true for a TeamLeader owner and a Dispatcher-agent owner, and
  for both in-tree runtimes.
- Both texts obey
  [model-facing writing](/.agents/domains/model-facing-writing.md): no
  provider names, present tense, no history, no new imperative beyond what the
  surface already carries.
- A member reading only these two texts can still tell that reporting a blocker
  mid-turn is expected behavior.
