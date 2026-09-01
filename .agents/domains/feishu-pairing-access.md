# Feishu access, pairing, and peer-bot trust

The normative current contract for how the Feishu channel classifies an inbound
event, decides ordinary delivery against V3 `access.json`, pairs an unknown
sender through Owner approval, and mutates peer-bot trust through `/introduce`.

## Ownership

`@excitedjs/feishu-channel` owns access/trust policy, state I/O, pairing, Owner
approval, `/introduce`, and known/trusted peer-bot state. It receives the
dispatcher state directory from the host and does not import Dreamux core.

`@excitedjs/feishu-transport` owns Feishu SDK I/O plus pure parse/render
helpers. It owns no access state, gate, pairing, persistence, or delivery
decision.

Two files under the dispatcher state directory answer two different questions
and are never conflated: `access.json` authorizes humans and chats,
`chat-bots.json` records peer-bot awareness and trust.

This page's path is itself load-bearing. `feishu-gate-io.ts` names it in the
user-visible V3 fail-loud message, and
`/packages/dreamux/tests/feishu-allow-chats-release-contract.test.ts` reads it
by path; renaming or moving the page changes user-facing copy and breaks CI.

Source:

- `/packages/channel/feishu-channel/src/feishu-gate.ts`
- `/packages/channel/feishu-channel/src/feishu-gate-io.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`
- `/packages/channel/feishu-channel/src/feishu-session-ops.ts`
- `/packages/channel/feishu-channel/src/introduce.ts`
- `/packages/channel/feishu-channel/src/chat-bots-store.ts`
- `/packages/channel/feishu-channel/src/bot.ts`
- `/packages/channel/feishu-channel/src/feishu-channel.ts`
- `/packages/channel/feishu-channel/src/feishu-message.ts`
- `/packages/channel/feishu-transport/`

## Contracts

### Inbound event routes

`FeishuBot.start` takes a `FeishuInboundRoutes` object — one handler per Feishu
event type — instead of a single message handler, and builds the transport
route table from it. `im.message.receive_v1` is always registered;
`im.chat.member.bot.added_v1` and `card.action.trigger` are registered when
their optional handlers are supplied. Each route awaits its handler before the
SDK acks, preserving the queue-before-ACK invariant, and each one short-circuits
when the session's lifecycle fence is no longer current. The seam is still one
optional field per event type rather than a generic `eventType -> handler` map.
No other Feishu event type is routed; there is no `doc_comment` handling.

`im.chat.member.bot.added_v1` is recorded idempotently per chat by Feishu event
id (a bounded seen-id list) and flags the chat for a future baseline injection;
it emits no model notification.

### Raw inbound classification

The Channel session classifies an event once before loading access state for
ordinary processing, passive bot observation, `/introduce`, or the gate:

- `chat_type: p2p` is P2P;
- `chat_type: group` is group;
- every other or missing chat type drops as `unsupported_chat_type`;
- `sender_type: user` plus a non-empty `sender_id` is human;
- `sender_type: bot | app` plus a non-empty `sender_id` is bot;
- every other sender combination drops as `sender_unknown`.

The package-root `dreamuxFeishuGate` input ABI remains:

```ts
interface GateInbound {
  chat_type: 'p2p' | 'group';
  sender_id: string;
  chat_id: string;
  is_bot_sender: boolean;
  trusted_bot: boolean;
  bot_mentioned: boolean;
}
```

There is no `sender_kind`. `is_bot_sender: false` is a caller assertion that
exact `sender_type: user` classification with a non-empty id already succeeded.

### Current V3 state

The file path is fixed at:

```text
~/.dreamux/state/<dispatcher-id>/access.json
```

`DREAMUX_CONFIG_DIR` relocates `config.json` only. The Channel joins
`access.json` under the host-supplied dispatcher state directory; callers must
not derive the state path from `dreamux config path`.

The complete secure default and accepted top-level shape are:

```json
{
  "version": 3,
  "dm_policy": "pairing",
  "group": {
    "policy": "follow-user",
    "allow_chats": [],
    "require_mention": true
  },
  "allow_users": [],
  "pending": {},
  "observed_chats": [],
  "warnings": [],
  "last_gate": {
    "at": 0
  }
}
```

`ACCESS_STATE_VERSION` remains `3`. No field, reader, saver, validator, fixture
version, or public state type changes for trusted-chat semantics.

Types:

```ts
type DmPolicy = 'all' | 'allowlist' | 'pairing' | 'disabled';
type GroupPolicy = 'block' | 'allowlist' | 'follow-user';

interface PendingPairingEntry {
  kind: 'dm' | 'group';
  sender_id: string;
  chat_id: string;
  created_at: number;
  expires_at: number;
  replies: number;
  prompt_message_id?: string;
}
```

The reader is deliberately shallow: it requires `version === 3` plus the
presence and container type of each top-level field, and accepts any string for
`dm_policy` and `group.policy`. A missing file yields the secure default; a
present file that fails the shape check fails loud instead of migrating.

Current ownership has four classes:

- `version`: Channel/schema-owned.
- `dm_policy`, `group.policy`, `group.allow_chats`, and
  `group.require_mention`: operator policy.
- `allow_users`: shared authority. Live pairing/App Owner approval may append
  it; an independent quiesced operator may maintain it.
- `pending`, `observed_chats`, `warnings`, and `last_gate`: Channel runtime
  ledger fields. `observed_chats` accumulates every chat this dispatcher has
  seen, and crossing more than one appends the trust-domain warning once.

### Ordinary delivery

P2P:

| Sender | `dm_policy` | Condition | Result |
|---|---|---|---|
| bot | any | — | `drop bot_untrusted` |
| human | `disabled` | — | `drop dm_disabled` |
| human | `all` | — | `deliver` |
| human | `allowlist` | sender in `allow_users` | `deliver` |
| human | `allowlist` | otherwise | `drop dm_not_on_allowlist` |
| human | `pairing` | sender in `allow_users` | `deliver` |
| human | `pairing` | otherwise | dm-kind pair/resend or slot-cap drop |

Group evaluation order is exact:

1. A bot sender is decided first, before any human policy applies.
2. If `group.require_mention` is true and the bot is not mentioned, drop
   `group_bot_not_mentioned`.
3. If `group.policy` is `block`, drop `group_policy_block`.
4. If the shallow V3 reader has surfaced any other policy string besides
   `allowlist` or `follow-user`, fail closed as `internal` before consulting
   `allow_chats`.
5. Resolve `chat_trusted = group.allow_chats.includes(chat_id)` once.
6. Under `allowlist`, drop an untrusted chat as `group_not_on_allowlist`;
   deliver a trusted chat immediately.
7. Under `follow-user`, deliver a trusted chat immediately; an untrusted chat
   follows the existing `dm_policy` / `allow_users` / dm-kind pairing path.

The model is:

```text
trusted chat OR sender accepted by the existing dm_policy path
```

A trusted chat bypasses `dm_policy`, `allow_users`, and pairing, including when
`dm_policy` is `disabled`. It does not bypass `group.require_mention`. Setting
`require_mention` to false is the one explicit switch that permits
non-mentioned human group delivery; there is no trusted-chat-only mention gate.

An untrusted `follow-user` chat retains the prior sender path:

- `disabled`: drop `dm_disabled`;
- `all`: deliver;
- `allowlist`: deliver an `allow_users` sender, otherwise drop
  `group_user_not_on_allowlist`;
- `pairing`: deliver an `allow_users` sender; otherwise create/resend dm-kind
  pairing subject to the slot cap, or drop
  `group_pairing_stranger_not_mentioned` when the bot was not mentioned (only
  reachable with `require_mention: false`).

### Peer bots: awareness, trust, and the bot-sender gate

`chat-bots.json` tracks two sets per chat that must never be conflated:

- **known** — bots passively observed sending messages in an authorized chat.
  Awareness only; observing a bot never grants it trust.
- **trusted** — bots introduced by an authorized `/introduce`. Only this set
  lets a peer bot's group message through the gate. A trusted bot is also
  recorded as known.

Passive known-bot observation is coupled to `group.allow_chats`: only an exact
`bot | app` sender with a non-empty id in a listed group is recorded as known.

Trust identity is **strictly the mention `open_id`** (`introducedPeers`): a
mention with no `open_id` is skipped, with no fallback to `union_id`/`user_id`.
Within one receiving app a peer bot's `open_id` is the same in the "mentioned"
and "sender" contexts, so the mention `open_id` recorded here is exactly what
the gate later matches against the bot's sender `open_id`. Recording a human
open_id as "trusted" is harmless: the gate only consults the trusted set for a
bot *sender*, so a human entry never widens access.

Bot senders are decided independently of human group policy:

- P2P bot senders drop as `bot_untrusted`.
- A group bot must be in that chat's trusted peer-bot set (passed to the gate as
  `trustedBotIds`) and must mention this bot; otherwise it drops as
  `bot_untrusted` or `group_bot_not_mentioned`.
- `group.require_mention: false` does not relax the trusted-bot mention rule.
- When `trustedBotIds` is omitted, no bot sender is ever delivered.

`union_id` is never used for trust matching or persistence. A `sender_union_id`
field may appear in the `feishu inbound dropped` diagnostic log only — it helps
an operator tell "same bot, different app-scoped open_id" from "different
entity" after a drop, and is never consulted by the gate.

### `/introduce`

In a group, a `/introduce` message triggers **if and only if the sender is
authorized to run it under the group's policy**. No `@`-mention of our bot is
required, and the group's `require_mention` setting is ignored on this path.

Authorization (`introduceDenyReason` / `canRunIntroduce` in
`/packages/channel/feishu-channel/src/introduce.ts`) is deliberately
sender-scoped because the command mutates peer-bot trust. It shares the delivery
gate's group-policy boundaries but does not inherit ordinary trusted-chat
authority:

| `group.policy` | Chat in `allow_chats` | Sender in `allow_users` | Deny reason |
|---|---|---|---|
| `block` | — | — | `group_blocked` |
| `allowlist` | required | required | `chat_not_allowlisted`, else `sender_not_followed` |
| `follow-user` | not consulted | required | `sender_not_followed` |

`block` drops every group message, and a trust-changing command is no
exception. Under `allowlist` ordinary delivery trusts every exact human in a
listed chat, but "any member of a trusted group" is deliberately not a path to
introduce.

`introduceDenyReason` is the discriminated source of truth and `canRunIntroduce`
is its boolean projection. The full reason order is `non_group`,
`empty_sender_id`, `group_blocked`, `chat_not_allowlisted`,
`sender_not_followed`; the codes are stable and grep-able. Under `follow-user`
the chat allowlist is ignored, so an off-allowlist sender there is
`sender_not_followed`, never `chat_not_allowlisted`.

Authorization is an exact sender-id membership check. `allow_users` is
structurally a string list rather than a human-only type, so a bot/app id
deliberately placed there can pass; an ambient bot/app id absent from the list
cannot. An empty list authorizes nobody. Pending pairing entries never
authorize `/introduce`.

Detection (`detectIntroduce`) is text-only and strips leading Feishu mention
placeholder tokens longest-key-first before matching `^/introduce`, so an
`@`-prefixed `/introduce` still matches regardless of who was mentioned. The
peer bots being introduced are the message's other mentions, deduplicated and
excluding this bot; they are recorded as **trusted** for that chat and the
`/introduce` message is consumed (never delivered to the runtime as a turn).

When an authorized group `/introduce` names at least one external peer bot, the
channel sends one immediate best-effort ack to the group after the trust store
write succeeds:

```text
✅ 已认识本群 N 个伙伴：@Name ...
```

The ack counts the peers mentioned in this `/introduce`, not only newly added
trust entries. Re-introducing an already-trusted peer therefore still acks the
current external mentions, matching the explicit user action. If Feishu omits a
peer display name, the ack uses `@伙伴` as the stable fallback rather than
displaying a raw open_id. The ack is channel-owned and best-effort: a send
failure is logged as `introduce ack failed` with structured fields
(`dispatcher_id`, `chat_id`, `message_id`, `peer_count`, `err`), but it does not
roll back trust, does not submit a runtime turn, does not add a reaction, and
does not fail the message handler. An authorized `/introduce` with no external
peer still consumes the command but sends no ack.

An unauthorized `/introduce` is **not** consumed: it falls through to
`dreamuxFeishuGate` like any other group message. A trusted chat can therefore
deliver the command text as an ordinary turn without executing the trust
mutation; an untrusted path may drop or pair according to its ordinary gate
inputs. `FeishuChannelSession` emits one channel log `introduce detected but not
authorized` carrying only `chat_id`/`sender_id`/`message_id`/`reason` (never the
message body, mentioned peer open_ids, or mention names), then continues into
the **unchanged** gate. This is observability only: gate decisions, trust
writes, baseline arming, and authorized-introduce consume behavior are
unchanged.

### One-shot trusted-bot context

When `/introduce` newly trusts a bot — or the bot is added to a chat — the chat
is flagged `needsBaseline` and its `baselineGeneration` is bumped. On the next
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

### `list_chat_bots`

A model-facing Feishu MCP tool returns a chat's `known` and `trusted` peer bots
as two separated arrays of `{ open_id, name? }`, for context recovery after
compaction. The Feishu channel package owns the tool definition and handler
(`/packages/channel/feishu-channel/src/tools/messaging-tools.ts`,
`/packages/channel/feishu-channel/src/feishu-channel.ts`); the generic Channel
MCP delegate routes the call to the created session's MCP capability, and the
handler reads `chat-bots.json` for the answer. Same transport shape as `reply` /
`react`; no operator CLI surface.

### Pairing

Pairing is Channel-owned and creates only dm-kind pending entries. It promotes
the human sender to `allow_users`; it never adds `allow_chats`.

Constants:

```text
PAIRING_TOKEN_BYTES = 3
PAIRING_TTL_MS = 3600000
MAX_PENDING_PER_KIND = 10
```

Tokens are six lowercase hex characters generated with `randomBytes(3)`. The
gate prunes expired pending entries at the beginning of each evaluation. Active
dm-kind entries count toward the slot cap; the same sender reuses an existing
unexpired entry across P2P/group requests.

The session preserves send-before-save:

1. Compute the pure gate result under the first access lock.
2. For a new pair, send the Owner approval card before saving a pending entry.
3. If send fails, save no pending entry.
4. Under the second access lock, re-read and merge without overwriting a
   concurrent approval or same-sender entry.
5. A resend references the existing approval card when its message id is known
   and refreshes its TTL.

All writes are complete owner-only sibling temporary files followed by atomic
rename; final `access.json` mode is `0600` and a missing state directory is
created at mode `0700`.

### Owner approval

The pairing card hides the token in its action value. Approval is not an MCP,
CLI, or generic core surface.

On `card.action.trigger`:

1. Reject unknown/malformed actions without mutating access state.
2. Resolve the Feishu app identity: the accepted set is the app creator plus the
   app owner when the owner type is absent or an enterprise member.
3. Reject a non-Owner click without changing the card or pending entry.
4. Under the access mutex, find the exact token and reject a missing, expired,
   or unsupported group-kind entry.
5. For a valid dm-kind entry, append its `sender_id` to `allow_users` if needed,
   delete that pending entry, persist, and return the immediate raw-card success
   response.

Approval checks the target entry expiry directly; it does not depend on another
message arriving to prune state. A token whose sender is already on
`allow_users` still consumes its single-use slot. The token and raw ids are not
displayed in visible card copy or broad logs.

### Same-shape semantic expansion

V3 needs no rebuild for trusted-chat semantics. The same stored shape is
accepted, but authorization expands when the new server starts:

- a retained `follow-user` `allow_chats` entry now trusts every exact human in
  that chat for ordinary delivery instead of being ignored there;
- a retained `allowlist` entry now trusts every exact human in that chat instead
  of applying `dm_policy` and `allow_users` afterward.

Before deployment, review every non-empty `allow_chats` entry under both
non-block policies. Keep only groups whose human membership should be trusted
and whose passive known-bot observation should remain enabled.

### Same-version maintenance

The quiesced external-edit workflow (`daemon stop` → confirmed process exit →
post-stop re-read → exact atomic patch → shape validation → `daemon start`), the
`ENOENT` first-write path, and the field-by-field editability boundary are owned
by the maintenance skill:
[`dreamux-maintenance`](/packages/dreamux/skills/dispatcher/dreamux-maintenance/).

## Invariants

- An unknown event cannot observe a bot, run `/introduce`, create pairing
  state, or deliver a turn. An unknown sender is never treated as human by
  negating `isBotSenderType`.
- `group.allow_chats` is operator-maintained and nothing in the running system
  writes it: pairing is dm-kind only, and no group-kind pairing path exists.
- Owner approval is the only live path that promotes a sender into
  `allow_users`. There are no `access.*` admin methods and no operator CLI for
  access state, and `dreamux doctor` is not an access-state validator.
- The gate is pure: it takes a state snapshot and returns an action, the next
  state, and logs. The session owns all I/O, the access mutex, and
  send-before-save.

## Regression Traps

> **Gate ↔ introduce split.** A table-driven test covers all group policies,
> listed/unlisted chats, and followed/unfollowed senders. It locks the intentional
> divergence under either non-block policy: an unfollowed exact human may deliver
> ordinary text in a trusted chat, while `/introduce` returns
> `sender_not_followed` and writes no trust. Under `follow-user`, an `allow_users`
> sender can still introduce in an unlisted chat.

Focused tests lock the trusted-chat truth table across both policies and every
`dm_policy`, the unchanged P2P and bot/trusted-bot paths, allow-chat-scoped bot
observation, the ordinary-delivery versus `/introduce` authority split, V3
defaults and reader/saver behavior, the token never reaching visible card copy,
and the package-root gate input ABI:

- `/packages/channel/feishu-channel/tests/feishu-gate.test.ts`
- `/packages/channel/feishu-channel/tests/feishu-introduce.test.ts`
- `/packages/channel/feishu-channel/tests/feishu-pairing-card.test.ts`
- `/packages/channel/feishu-channel/tests/public-api.test.ts`

Raw inbound classification currently has no dedicated test lock.

History: [/.agents/tasks/channel/README.md](/.agents/tasks/channel/README.md)
