# Feishu event-route seam + group `/introduce`

- **Status:** Implemented. The original issue #62 event-route and `/introduce`
  increment remains current; its former pairing and attachment follow-ups have
  landed in [Feishu pairing access V3](../decisions/feishu-pairing-access-v3.md)
  and [Feishu inbound attachments](../decisions/feishu-inbound-attachments.md).
- **Source:** https://github.com/excitedjs/dreamux/issues/62,
  https://github.com/excitedjs/dreamux/issues/87
- **Affects:** `/packages/channel/feishu-channel/src/bot.ts`,
  `/packages/channel/feishu-channel/src/introduce.ts`,
  `/packages/channel/feishu-channel/src/chat-bots-store.ts`,
  `/packages/channel/feishu-channel/src/feishu-gate.ts`,
  `/packages/channel/feishu-channel/src/feishu-message.ts`,
  `/packages/channel/feishu-channel/src/feishu-channel.ts`,
  `/packages/channel/feishu-channel/src/tools/`,
  `/packages/dreamux/src/service/channel-service/mcp-delegate.ts`,
  `/packages/dreamux/src/command/registry.ts`,
  `/packages/dreamux/src/platform/paths.ts`,
  `/packages/channel/feishu-channel/tests/feishu-introduce.test.ts`

## Event-route seam (Phase 1)

`FeishuBot.start` takes a `FeishuInboundRoutes` object — one handler per Feishu
event type — instead of a single message handler. The bot builds the transport
route table from it and registers `im.message.receive_v1` always and
`im.chat.member.bot.added_v1` when an `onBotMemberAdded` handler is supplied.
Each route still awaits its handler before the SDK acks, preserving the
queue-before-ACK invariant. This is a small typed seam, not yet a generic
`eventType -> handler` registry; a third event type is the cue to promote it to
a map so `FeishuBot` does not grow one optional field per event.

`im.chat.member.bot.added_v1` is recorded idempotently by Feishu event id and
flags the chat for a future baseline injection; it emits no model notification.

## `/introduce` hard contract

In a group, a `/introduce` message triggers **if and only if the sender is
authorized to run it under the group's policy**. No `@`-mention of our bot is
required, and the group's `require_mention` setting is ignored on this path.

Authorization (`introduceDenyReason` / `canRunIntroduce` in
`/packages/channel/feishu-channel/src/introduce.ts`) is deliberately
sender-scoped because the command mutates peer-bot trust. It shares the delivery
gate's group-policy boundaries but does not inherit ordinary trusted-chat
authority, and it waives the ordinary `@`-mention requirement:

- `block` → never authorized (`group_blocked`); the gate drops every group
  message, and a trust-changing command is no exception.
- `follow-user` → the chat need not be in `group.allow_chats`, but the sender
  must be in the global `allow_users` list. A listed chat may authorize ordinary
  human delivery, yet it does not grant this trust-mutation authority.
- `allowlist` → the chat must be in `group.allow_chats` **and** the sender must
  be on `allow_users`. Ordinary delivery trusts every exact human in the listed
  chat, but "any member of a trusted group" is deliberately not a path to
  introduce.

`allow_users` is structurally a string list, and `/introduce` authorization is
an exact sender-id membership check rather than a human-only gate. An exact
bot/app sender whose id was deliberately or manually placed in that list can
therefore pass the current check. An empty list authorizes nobody, and ambient
bot/app senders are denied when their ids are absent.

> **Gate ↔ introduce split.** A table-driven test covers all group policies,
> listed/unlisted chats, and followed/unfollowed senders. It locks the intentional
> divergence under either non-block policy: an unfollowed exact human may deliver
> ordinary text in a trusted chat, while `/introduce` returns
> `sender_not_followed` and writes no trust. Under `follow-user`, an `allow_users`
> sender can still introduce in an unlisted chat.

Detection (`detectIntroduce`) is text-only and strips leading Feishu mention
placeholder tokens before matching `^/introduce`, so an `@`-prefixed
`/introduce` still matches regardless of who was mentioned. The peer bots being
introduced are the message's other mentions; they are recorded as **trusted**
for that chat and the `/introduce` message is consumed (never delivered to Codex
as a turn).

## Authorized-introduce channel ack (issue #87)

When an authorized group `/introduce` names at least one external peer bot, the
channel sends one immediate best-effort ack to the group after the trust store
write succeeds:

```text
✅ 已认识本群 N 个伙伴：@Name ...
```

The ack counts the peers mentioned in this `/introduce`, not only newly added
trust entries. Re-introducing an already-trusted peer therefore still acks the
current external mentions, matching the explicit user action. The channel
excludes the dispatcher bot itself. If Feishu omits a peer display name, the ack
uses `@伙伴` as the stable fallback rather than displaying a raw open_id.

The ack is channel-owned and best-effort. A send failure is logged as
`introduce ack failed` with structured fields (`dispatcher_id`, `chat_id`,
`message_id`, `peer_count`, `err`), but it does not roll back trust, does not
submit a Codex turn, does not add a reaction, and does not fail the message
handler. An authorized `/introduce` with no external peer still consumes the
command but sends no ack.

## Unauthorized-introduce diagnostic (issue #77)

A `/introduce` whose sender is not authorized is **not** consumed: it falls
through to `dreamuxFeishuGate` like any other group message. A trusted chat can
therefore deliver the command text as an ordinary turn without executing the
trust mutation; an untrusted path may drop or pair according to its ordinary
gate inputs. To keep this one-glance diagnosable, `introduceDenyReason`
(`/packages/channel/feishu-channel/src/introduce.ts`) is the discriminated
source of truth — `canRunIntroduce` is its boolean projection — returning a
stable, grep-able code: `non_group`, `empty_sender_id`, `group_blocked`,
`chat_not_allowlisted`, `sender_not_followed`. `group_blocked` is the `block`
policy; `chat_not_allowlisted` is the `allowlist` policy only (under
`follow-user` the chat allowlist is ignored, so an off-allowlist sender there is
`sender_not_followed`, never `chat_not_allowlisted`). When `detectIntroduce`
matches but the reason is non-null, `FeishuChannelSession` emits one channel log
`introduce detected but not authorized` carrying only
`chat_id`/`sender_id`/`message_id`/`reason` (never the message body, mentioned
peer open_ids, or mention names), then continues into the **unchanged** gate.
This is observability only: gate decisions, trust writes, baseline arming, and
authorized-introduce consume behavior are unchanged.

## Awareness vs trust

`chat-bots.json` tracks two sets per chat that must never be conflated:

- **known** — bots passively observed sending messages in an authorized chat.
  Awareness only; observing a bot never grants it trust.
- **trusted** — bots introduced by an allowlisted `/introduce`. Only this set
  lets a peer bot's group message through the gate.

Trust identity is **strictly the mention `open_id`** (`introducedPeers`): a
mention with no `open_id` is skipped, with no fallback to `union_id`/`user_id`
(issue #102). Within one receiving app a peer bot's `open_id` is the same in the
"mentioned" and "sender" contexts, so the mention `open_id` recorded here is
exactly what the gate later matches against the bot's sender `open_id`.

`dreamuxFeishuGate` drops every bot sender unless **both** hold: its sender
`open_id` is in the chat's trusted set (passed as `trustedBotIds`) **and** the
message `@`-mentions this bot. Trust is a precondition for entry, not a bypass of
the mention gate (issue #102, aligned with the upstream lineage where peer-bot
messages must address the bot before entering the conversation). When
`trustedBotIds` is omitted, no bot sender is ever delivered. Recording a human
open_id as "trusted" is harmless: the gate only consults the trusted set for a
bot *sender*, so a human entry never widens access.

`union_id` is never used for trust matching or persistence. A `sender_union_id`
field may appear in the `feishu inbound dropped` diagnostic log only — it helps
an operator tell "same bot, different app-scoped open_id" from "different
entity" after a drop, and is never consulted by the gate.

## One-shot trusted-bot context (issue #69)

When `/introduce` newly trusts a bot — or the bot is added to a chat — the chat
is flagged `needsBaseline` and its `baselineGeneration` is bumped
(`/packages/channel/feishu-channel/src/chat-bots-store.ts`). On the next
**delivered** group message, `formatFeishuMessageForRuntime` appends a one-shot
`<group_bots>` block listing the chat's **trusted** bots (name + open_id), so
the model can map a peer bot's open_id to a name. Passive `known` bots are
deliberately not pushed here; they are queried on demand via `list_chat_bots`.

The clear is **commit-after-notify and generation-safe**: the deliver path
snapshots the generation before enqueue and clears `needsBaseline` only after
the Channel delivery route returns `submitted`, and only via
`clearBaselineIfCurrent`, which no-ops if a newer `/introduce` / bot-added
bumped the generation mid-delivery. `duplicate` / `stopped` / `failed` leave
the context pending.

## `list_chat_bots` query tool

A model-facing Feishu MCP tool returns a chat's `known` and `trusted` peer bots
as two separated arrays of `{ open_id, name? }`, for context recovery after
compaction. The Feishu channel package owns the tool definition and handler in
`/packages/channel/feishu-channel/src/tools/messaging-tools.ts` and
`/packages/channel/feishu-channel/src/feishu-channel.ts`. The generic MCP shim
forwards the call over the 0600 admin socket to the channel's own in-server
delegate, which routes it to the built instance's MCP capability; the handler
reads `chat-bots-store` for the answer. Same transport shape as `reply` /
`react`; no operator CLI surface.

## Deferred follow-ups

The original issue #62 follow-up list is mostly implemented. Current contracts
are recorded in the landed
[Feishu pairing access V3](../decisions/feishu-pairing-access-v3.md) and
[Feishu inbound attachments](../decisions/feishu-inbound-attachments.md)
decisions.

Only these items remain unimplemented:

- An operator access admin/CLI surface (`access.*` admin methods + CLI).
- `doc_comment` handling.

(The one-shot discovery-context injection and the list-known-bots tool landed in
issue #69 — see the two sections above. Its former add-then-cancel automatic
reaction ordering is superseded by
[Feishu COT conversation display](../decisions/feishu-cot-conversation-display.md).)
