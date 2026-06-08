# Feishu trusted-bot context + list-chat-bots query + add-then-cancel reactions

- **Status:** Implemented (issue #69 review accepted; the settled behavior now
  lives in the domain/decision docs linked under Disposition — this proposal is
  kept as the design-rationale + open-question record)
- **Date:** 2026-06-05
- **Affects:** `/packages/dreamux/src/channel/chat-bots-store.ts`,
  `/packages/dreamux/src/channel/feishu-message.ts`,
  `/packages/dreamux/src/mcp/feishu-mcp.ts`,
  `/packages/dreamux/src/admin/methods.ts`,
  `/packages/dreamux/src/server.ts`
- **Source:** https://github.com/excitedjs/dreamux/issues/69
  (focused follow-up to the closed epic
  [#62](https://github.com/excitedjs/dreamux/issues/62), first increment #68;
  design review on the issue is accepted with the constraints below)

## Context

#68 shipped the typed event-route seam, the `/introduce` hard contract, and the
`known` / `trusted` peer-bot store (see
[`domains/feishu-introduce.md`](../domains/feishu-introduce.md)). Two Phase 4
items from #62 were deferred — one-shot discovery context and a list-known-bots
capability — and a separate channel-behavior tweak (reaction ordering) is folded
into the same focused change.

The first introduce requirement is **already satisfied by #68, with regression
coverage**: an allowlisted human's `/introduce` trusts the mentioned bots
immediately (no prior bot-to-bot trust needed) and records their `open_id` plus
best-effort display name; `tests/feishu-introduce.test.ts` and
`tests/smoke.test.ts` already cover the auth predicate, the trust store, and the
no-`@` consume-without-enqueue path. PR1 does **not** re-test that baseline — its
new tests target the pending-context behavior below.

## Behavior under review

### Trusted-bot context on the next message (one-shot, generation-safe)

After an `/introduce` adds newly trusted bots, the model's dispatcher context
should carry the group's trusted bot identities (display name + `open_id`) once,
so it can tell which bot/open_id sent a message or is otherwise known in the
group.

- Reuse the existing `needsBaseline` pending-context flag in
  `chat-bots-store.ts` (today only set by `im.chat.member.bot.added_v1`); set it
  when introduce adds a newly trusted bot.
- Render a small escaped `<group_bots>` block in `formatFeishuMessageForCodex`
  on the next delivered group message, escaped consistently with the existing
  `<feishu_message>` envelope. **Inject `trusted` only** — `known` is passive
  awareness, not trust, and is noisy; it is returned by `list_chat_bots` instead.
- **Conditional / generation-safe clear (critical):** `TurnManager.enqueue()`
  calls `onAccepted` before `turn/start`, so the pending flag may be cleared
  **only** after `enqueueInbound()` returns `status: 'submitted'`. Never clear on
  `duplicate`, `stopped`, or `failed` (the #62 commit-after-notify pattern).
  Guard against lost updates: if another `/introduce` or bot-added event changes
  the pending context while the first message is being enqueued, a late clear
  must not erase the newer context — use a generation / snapshot compare, not a
  blind boolean reset.

### `list_chat_bots` query tool

A model-facing Feishu MCP tool that returns the current group chat's `known` and
`trusted` bots (names + open_ids, as two clearly separated arrays), for context
recovery after compaction. It follows the existing `reply` / `react` shape: a
tool in `feishu-mcp.ts` forwarding an `mcp.list_chat_bots` request over the 0600
admin socket to a read-only `Server` method backed by the chat-bots store. No
new trust boundary, and no separate operator CLI/admin command in PR1.

### Reaction ordering: add-then-cancel

The inbound reaction lifecycle currently cancels the previous reaction and then
adds the new one (`setInboundReaction`, `Get` → `OnIt`). The agreed order is:

1. check pending clear;
2. capture the previous reaction;
3. **add** the new reaction;
4. if a pending clear appeared, remove the just-added reaction and do not store
   it, then return;
5. otherwise store the new reaction;
6. **then cancel** the previous reaction.

Race / failure constraints: a reply arriving while the previous reaction is
being canceled must still let the channel-owned `reply` MCP handler remove the
newly stored reaction (the reply-wins guarantee); if the new add fails or
returns no reaction id, keep the previous reaction/ledger entry rather than
deleting it. New tests beyond the existing "reply wins the initial add" race: a
replacement-race test around the `[received] → [in progress]` transition, and a
test proving add happens before cancel.

### Feishu API assumption (to confirm in review)

Add-then-cancel assumes Feishu lets the same bot/app add the new emoji while its
previous reaction is still present on the same message. The repo fake/transport
tests only prove request shape, not live platform semantics. If the assumption
is false, a different no-zero-window strategy is needed.

## Open questions

Resolved on the issue review: one-shot cadence (yes), trusted-only proactive
injection (yes), `list_chat_bots` as a model tool backed by the admin method
(yes, not a new operator CLI), and add-then-cancel acceptable only with the
stronger race tests above. The remaining live question is the Feishu reaction-API
assumption.

## Disposition

When the review converges and PR1 lands, promote the settled parts into the
relevant settled docs — `domains/feishu-introduce.md` (trust context / listing),
`decisions/top-level-design.md` (MCP tool surface), and
`domains/non-blocking-dispatcher-inbound.md` (reaction replacement ordering) —
and retire this proposal.
