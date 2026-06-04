# Feishu event-route seam + group `/introduce`

- **Status:** Implemented (issue #62, first increment). Invite-code/pairing and
  rich attachments are deferred to follow-up PRs — see Deferred below.
- **Source:** https://github.com/excitedjs/dreamux/issues/62
- **Affects:** `packages/dreamux/src/feishu/bot.ts`,
  `packages/dreamux/src/channel/introduce.ts`,
  `packages/dreamux/src/channel/chat-bots-store.ts`,
  `packages/dreamux/src/channel/feishu-gate.ts`,
  `packages/dreamux/src/channel/feishu-message.ts`,
  `packages/dreamux/src/mcp/feishu-mcp.ts`,
  `packages/dreamux/src/admin/methods.ts`,
  `packages/dreamux/src/server.ts`,
  `packages/dreamux/src/runtime/paths.ts`

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

In a group, a `/introduce` message triggers **if and only if the sender is on
the allowlist**. No `@`-mention of our bot is required, and the group's
`require_mention` setting is ignored on this path.

The authorization is sender-scoped, not group-scoped. `canRunIntroduce`
(`channel/introduce.ts`) requires the chat to be explicitly in
`group.allow_chats` **and** the sender to be explicitly in `group.follow_users`.
An empty `follow_users` authorizes nobody — "any member of an allowlisted group"
is deliberately **not** a path, and `canRunIntroduce` never reuses a broad
group-authorization predicate that would trust the group without checking the
sender's identity. A bot sender is never on the human allowlist, so ambient
self-introduction by an arbitrary bot does not trigger introduce.

Detection (`detectIntroduce`) is text-only and strips leading Feishu mention
placeholder tokens before matching `^/introduce`, so an `@`-prefixed
`/introduce` still matches regardless of who was mentioned. The peer bots being
introduced are the message's other mentions; they are recorded as **trusted**
for that chat and the `/introduce` message is consumed (never delivered to Codex
as a turn).

## Awareness vs trust

`chat-bots.json` tracks two sets per chat that must never be conflated:

- **known** — bots passively observed sending messages in an authorized chat.
  Awareness only; observing a bot never grants it trust.
- **trusted** — bots introduced by an allowlisted `/introduce`. Only this set
  lets a peer bot's group message through the gate.

`dreamuxFeishuGate` drops every bot sender except one whose open_id is in the
chat's trusted set (passed as `trustedBotIds`); a trusted bot is delivered
without an `@`-mention because a bot cannot mention us. When `trustedBotIds` is
omitted, no bot sender is ever delivered — preserving prior behavior. Recording
a human open_id as "trusted" is harmless: the gate only bypasses for a bot
*sender*, so a human entry never widens access.

## One-shot trusted-bot context (issue #69)

When `/introduce` newly trusts a bot — or the bot is added to a chat — the chat
is flagged `needsBaseline` and its `baselineGeneration` is bumped
(`chat-bots-store.ts`). On the next **delivered** group message,
`formatFeishuMessageForCodex` appends a one-shot `<group_bots>` block listing the
chat's **trusted** bots (name + open_id), so the model can map a peer bot's
open_id to a name. Passive `known` bots are deliberately not pushed here; they
are queried on demand via `list_chat_bots`.

The clear is **commit-after-notify and generation-safe**: the deliver path
snapshots the generation before enqueue and clears `needsBaseline` only after
`enqueueInbound` returns `submitted`, and only via `clearBaselineIfCurrent`,
which no-ops if a newer `/introduce` / bot-added bumped the generation
mid-enqueue. `duplicate` / `stopped` / `failed` leave the context pending.

## `list_chat_bots` query tool

A model-facing Feishu MCP tool (`mcp/feishu-mcp.ts`) returns a chat's `known` and
`trusted` peer bots as two separated arrays of `{ open_id, name? }`, for context
recovery after compaction. It forwards an `mcp.list_chat_bots` request over the
0600 admin socket to the read-only `Server.listChatBotsFromMcp`, which reads the
`chat-bots-store` directly (no running slot required). Same transport shape as
`reply` / `react`; no operator CLI surface.

## Deferred to follow-up PRs

Not in this increment, tracked on issue #62:

- Invite-code pairing, the shared `Access` contract migration, and the
  operator approve/deny surface (`access.*` admin methods + CLI).
- Rich inbound attachments (bounded authorized downloads, token references).
- `doc_comment` handling.

(The one-shot discovery-context injection and the list-known-bots tool landed in
issue #69 — see the two sections above; the add-then-cancel reaction ordering it
also carried is in
[`/.agents/domains/non-blocking-dispatcher-inbound.md`](/.agents/domains/non-blocking-dispatcher-inbound.md).)
