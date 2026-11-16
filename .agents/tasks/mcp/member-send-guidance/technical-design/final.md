# Two texts: what a member is told about reporting

## Boundary

Wording only. Two model-facing strings in `packages/dreamux/src/service/agent/`:

- `system-prompt.ts` — the ordinary-member communication statement.
- `member-mcp.ts` — the `send` tool description.

No delivery, admission, ordering, folding, availability, receipt, reminder,
schema, routing, or adapter change. No new tool, field, or capability.

## What is true, verified in source

Facts the new text may state, each checked against current code:

1. **A turn's final assistant message is what reaches the owner.** Codex takes
   the last `agentMessage` item (`events.ts`, `extractAssistantText`); Claude
   Code takes the `result` text, falling back to the last assistant text
   (`stream.ts`, `outcome()`). The completion notice wraps that text
   (`completion-renderer.ts`).
2. **Intermediate assistant messages are not delivered.** Codex marks them
   `phase: "commentary"` (app-server `AgentMessage.phase`); the adapter reads
   the item's text for display activity and never selects it as the result.
   They still reach the conversation display (the Channel's COT), which is a
   separate consumer — so a member's mid-turn narration is visible on the
   display surface and absent from the owner's context.
3. **`send` is the only path from a member into its owner's context before its
   turn ends.** It submits input with the peer reminder; the owner sees
   `<task from="…">` plus that reminder (`member-mcp.ts`, `submission-sources.ts`).
4. **A send to a peer is not a send to the owner.** A peer-directed message
   reaches only that peer; the owner receives the *peer's* eventual turn result,
   not the message. This asymmetry is why a single sentence covering both
   recipients must not imply the owner sees peer traffic.
5. **A send is admitted, not answered.** The receipt says admission only, and a
   reply needs the recipient's own send.
6. **Every measured send in the sample landed while the owner's turn was open**,
   so all of them folded into that turn. The text may not promise a new turn.

## Text 1 — member communication statement

Current (one run-on sentence, delivery as a trailing clause):

> Your owner is the {role} "{name}". You can use teammate.send to pass a message
> to your owner or a peer in your collection, and teammate.list to list your
> owner and peers. Your normally completed and failed turn results are
> automatically reported to your owner when its runtime is available.

Requirements for the replacement:

- Lead with the delivery fact. A member that knows its final answer *is* the
  report stops treating `send` as the report.
- Keep the owner address, the two tools, and the availability qualifier. The
  qualifier is a real limit (`runtime is available`), not decoration.
- State the condition for `send`: information the owner needs *before the turn
  ends*. That is the boundary the sample shows members missing — they sent
  progress and near-final summaries, both of which the turn result already
  carries or supersedes.
- Name the mid-turn case explicitly so the blocker path stays obviously
  available. This is a stated condition, not a prohibition.
- Stay short. The 2026-10-14 change in
  [PR #475](https://github.com/excitedjs/dreamux/pull/475) deliberately cut a
  much longer paragraph down to this one sentence; the replacement must not
  restore that length.

Draft:

> Your owner is the {role} "{name}". Your turn's final message is what reaches
> it, together with the turn's outcome, whenever its runtime is available.
> teammate.send reaches your owner or a same-collection peer before your turn
> ends; use it for what your owner needs while you are still working — a
> blocker, a decision it must make, or a fact that changes what it does next —
> and let your turn result carry the rest. teammate.list names your owner and
> peers.

## Text 2 — `send` description

Current:

> Send a message to your owner or a same-collection peer by concrete name. A
> closed peer reopens its recorded session; idle input wakes the recipient and
> busy input follows its runtime admission. {receipt reminder}

Requirements:

- Keep the addressing fact, the closed-peer reopen fact, and the admission
  behavior. Each is a real capability a caller relies on.
- Add the same usage condition as text 1, in this tool's own voice: the tool
  description owns the contract of *this* tool.
- Do not restate the receipt reminder; it is concatenated directly after.
- Do not claim the owner sees peer traffic.

Draft:

> Send a message to your owner or a same-collection peer by concrete name, for
> what that recipient needs before your turn ends — a blocker, a decision, or a
> fact that changes its next step. Your turn's final message reaches your owner
> on its own, so progress and results that can wait belong there instead. A
> message to a peer reaches that peer only; your owner receives its own turn
> results, not this message. A closed peer reopens its recorded session; idle
> input wakes the recipient and busy input follows its runtime admission.
> {receipt reminder}

## Why this shape and not an imperative

[Model-facing writing](/.agents/domains/model-facing-writing.md) reserves
imperatives for the dispatch boundary: "a reminder states a consequence the
model cannot see, at the moment of the action, and does not generally order the
model what to do." Both texts therefore state *what reaches the owner and
when*, and let the condition follow from that consequence, rather than issuing
"do not send progress updates". The member can still decide a blocker is worth
reporting; the text only removes the reason to narrate.

## Verification plan

- `rush build`, `rush lint`, `rush test`, `rush typecheck:tests`.
- The existing `teammate-system-prompt.test.ts` asserts prompt *order* and that
  the owner sentence contains the owner name; it uses `stringContaining`, so it
  must keep passing without edits. Confirm rather than assume.
- `mcp-tool-descriptions.test.ts` walks the owner catalogs, not the member
  catalog. The member catalog has no description test; do not add an
  exact-sentence assertion for prose.
- `member-messaging.test.ts` pins the receipt text with a loose regex; it must
  keep passing unchanged.
- Inspect the advertised member catalog in built output to confirm both strings
  reach the model.
- Independent review of the two strings against this page's fact list.

## Known limit

This is guidance, not enforcement. A model may still narrate. The change is
accepted on the reasoning that the observed behavior came from a text that never
stated the condition, not from a model that could not follow one. No live-model
measurement is claimed for this change.
