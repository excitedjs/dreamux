# Two texts: what a member is told about reporting

## Boundary

Wording only. Two model-facing strings in `packages/dreamux/src/service/agent/`:

- `system-prompt.ts` — the ordinary-member communication statement.
- `member-mcp.ts` — the `send` tool description.

No delivery, admission, ordering, folding, availability, receipt, reminder,
schema, routing, or adapter change. No new tool, field, or capability.

## What is true, verified in source

Facts the new text may state, each checked against current code:

1. **Only a completed turn's final assistant message can reach the owner, and it
   may be absent even then.** Codex takes the last `agentMessage` item
   (`events.ts`, `extractAssistantText`), returning null when there is none;
   Claude Code takes the `result` text, falling back to the last assistant text
   and mapping an empty result to null (`stream.ts`, `rpc.ts`). The completion
   notice wraps whatever text it gets (`completion-renderer.ts`).
2. **A failed or stopped turn carries no message text at all.** Core hard-codes
   `result: null` for both (`service/agent/service.ts`, the `deliverRuntime`
   call), and the `failed` variant of `RuntimeCompletion` has no `resultText`
   field. The owner receives `"…turn failed."` with an empty body, pinned by
   `completion-renderer.test.ts`. Any sentence promising the final message
   unconditionally is therefore false; the shipped text says the *outcome* is
   reported and a completed turn's final message is what that report delivers.
3. **Selection is by order, not by a phase filter.** The adapter never reads
   `AgentMessage.phase`; it takes the last `agentMessage` item. Commentary
   precedes the final answer in the observed shape, which is why the last item
   is the answer — an ordering fact, not a filter. An earlier draft of this page
   claimed a phase filter that does not exist.
4. **Intermediate commentary is still displayed.** It reaches the conversation
   display as `assistant.message` activity, a separate consumer from the owner's
   context — so a member's mid-turn narration is visible on the display surface
   and absent from the owner's context.
5. **`send` is the only path from a member into its owner's context before its
   turn ends.** It submits input with the peer reminder; the owner sees
   `<task from="…">` plus that reminder (`member-mcp.ts`, `submission-sources.ts`).
6. **A send to a peer is not a send to the owner.** A peer-directed message
   reaches only that peer; the owner receives the *peer's* eventual turn result,
   not the message.
7. **A send is admitted, not answered.** The receipt says admission only, and a
   reply needs the recipient's own send.
8. **Every measured send in the sample landed while the owner's turn was open**,
   so all of them folded into that turn. The text may not promise a new turn.
   A busy recipient's runtime may not read the input until after the sender's
   turn ends, so the text describes when the member sends, never when the
   recipient reads.

## Text 1 — member communication statement

Current (one run-on sentence, delivery as a trailing clause):

> Your owner is the {role} "{name}". You can use teammate.send to pass a message
> to your owner or a peer in your collection, and teammate.list to list your
> owner and peers. Your normally completed and failed turn results are
> automatically reported to your owner when its runtime is available.

Requirements for the replacement:

- Put the delivery fact before the capability, so a member that knows its
  completed turn *is* the report stops treating `send` as the report. It cannot
  lead the sentence: the owner address must come first.
- Keep the owner address, the two tools, and the availability qualifier. The
  qualifier is a real limit (`runtime is available`), not decoration.
- Do not put the `send` usage condition here — the tool description owns it.
- Keep the delivery fact accurate about failed turns: the outcome is reported,
  the message only on completion.
- Stay short. The 2026-10-14 change in
  [PR #475](https://github.com/excitedjs/dreamux/pull/475) deliberately cut a
  much longer paragraph down to this one sentence; the replacement must not
  restore that length.

Shipped:

> Your owner is the {role} "{name}". Your turn's outcome is reported to it
> whenever its runtime is available, and a completed turn's final message is what
> that report delivers. You can use teammate.send to pass a message to your owner
> or a peer in your collection before your turn ends, and teammate.list to list
> your owner and peers.

"Delivers" is the accurate verb, and it survives all three shapes the text can
take. A completed turn's `resultText` may be null (both adapters produce that —
claude-code when the text is empty, codex when the turn had no assistant
message), in which case the report still goes out with no body. A result longer
than the inline budget is spilled to a file and the report carries the path
(`completion-renderer.ts`, `completion-body.ts`). Saying the message *is* the
report, or that the report *carries the text*, would be false in one of those
cases; saying the message is what the report delivers holds in all three.

The condition lives in the description, not here (see "Why this shape" below).
An earlier draft of this page put the condition and two imperatives in this
sentence; review removed them.

## Text 2 — `send` description

Current:

> Send a message to your owner or a same-collection peer by concrete name. A
> closed peer reopens its recorded session; idle input wakes the recipient and
> busy input follows its runtime admission. {receipt reminder}

Requirements:

- Keep the addressing fact, the closed-peer reopen fact, and the admission
  behavior. Each is a real capability a caller relies on.
- State the usage condition here, in this tool's own voice: the tool description
  owns the contract of *this* tool.
- Do not restate the delivery fact or the receipt reminder; the prompt owns the
  first, and the receipt is concatenated directly after.
- Do not claim the owner sees peer traffic.

Shipped:

> Send a message to your owner or a same-collection peer by concrete name, when
> that recipient needs something before your turn ends — a blocker, a decision,
> or a fact that changes its next step. A closed peer reopens its recorded
> session; idle input wakes the recipient and busy input follows its runtime
> admission. {receipt reminder}

## Why the condition has one home

[Model-facing writing](/.agents/domains/model-facing-writing.md) reserves
imperatives for the dispatch boundary: "a reminder states a consequence the
model cannot see, at the moment of the action, and does not generally order the
model what to do." It also gives each rule one owner.

The delivery fact belongs to the role prompt, which every member reads on every
turn. The usage condition belongs to the tool description, which the member
reads when it is deciding whether to call this tool. An earlier draft stated the
condition on both surfaces with the same three-item list and added two
imperatives to the prompt ("use it for …", "let your turn result carry the
rest"); review removed both. The shipped texts state the delivery fact once and
the condition once, and neither issues an order.

The member can still decide a blocker is worth reporting. The text removes the
reason to narrate; it does not remove the capability.

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
