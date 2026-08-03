# Feishu V3 pairing and trusted-chat access

This page is the normative current contract for Feishu inbound classification,
V3 `access.json`, ordinary delivery, pairing, and Owner approval.

Decision trail:

- [Feishu pairing access V3](../decisions/feishu-pairing-access-v3.md) owns the
  schema, pairing, and Owner-card design.
- [Feishu trusted allow-chats semantics](../decisions/feishu-allow-chats-trust-semantics.md)
  refines only ordinary human `allow_chats` delivery.
- [Feishu introduce](feishu-introduce.md) owns peer-bot trust mutation.

## Package Boundary

`@excitedjs/feishu-channel` owns access/trust policy, state I/O, pairing, Owner
approval, `/introduce`, and known/trusted peer-bot state. It receives the
dispatcher state directory from the host and does not import Dreamux core.

`@excitedjs/feishu-transport` owns Feishu SDK I/O plus pure parse/render helpers.
It owns no access state, gate, pairing, persistence, or delivery decision.

Source:

- `/packages/channel/feishu-channel/src/feishu-gate.ts`
- `/packages/channel/feishu-channel/src/feishu-gate-io.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`
- `/packages/channel/feishu-channel/src/introduce.ts`
- `/packages/channel/feishu-channel/src/chat-bots-store.ts`
- `/packages/channel/feishu-transport/`

## Raw Inbound Classification

The Channel session classifies an event once before loading access state for
ordinary processing, passive bot observation, `/introduce`, or the gate:

- `chat_type: p2p` is P2P;
- `chat_type: group` is group;
- every other or missing chat type drops as `unsupported_chat_type`;
- `sender_type: user` plus a non-empty `sender_id` is human;
- `sender_type: bot | app` plus a non-empty `sender_id` is bot;
- every other sender combination drops as `sender_unknown`.

Unknown events cannot observe a bot, run `/introduce`, create pairing state, or
deliver a turn. An unknown sender is never treated as human by negating
`isBotSenderType`.

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

## Current V3 State

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

Current ownership has four classes:

- `version`: Channel/schema-owned.
- `dm_policy`, `group.policy`, `group.allow_chats`, and
  `group.require_mention`: operator policy.
- `allow_users`: shared authority. Live pairing/App Owner approval may append
  it; an independent quiesced operator may maintain it.
- `pending`, `observed_chats`, `warnings`, and `last_gate`: Channel runtime
  ledger fields.

## Ordinary Delivery

P2P behavior is unchanged:

| Sender | `dm_policy` | Condition | Result |
|---|---|---|---|
| bot | any | — | `drop bot_untrusted` |
| human | `disabled` | — | `drop dm_disabled` |
| human | `all` | — | `deliver` |
| human | `allowlist` | sender in `allow_users` | `deliver` |
| human | `allowlist` | otherwise | `drop dm_not_on_allowlist` |
| human | `pairing` | sender in `allow_users` | `deliver` |
| human | `pairing` | otherwise | dm-kind pair/resend or slot-cap drop |

Human group evaluation order is exact:

1. If `group.require_mention` is true and the bot is not mentioned, drop
   `group_bot_not_mentioned`.
2. If `group.policy` is `block`, drop `group_policy_block`.
3. If the shallow V3 reader has surfaced any other policy string besides
   `allowlist` or `follow-user`, fail closed as `internal` before consulting
   `allow_chats`.
4. Resolve `chat_trusted = group.allow_chats.includes(chat_id)` once.
5. Under `allowlist`, drop an untrusted chat as `group_not_on_allowlist`; deliver
   a trusted chat immediately.
6. Under `follow-user`, deliver a trusted chat immediately; an untrusted chat
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
- `pairing`: deliver an `allow_users` sender, otherwise create/resend dm-kind
  pairing when mentioned, subject to the slot cap.

## Bot Awareness And Trust

Bot senders remain independent of human group policy:

- P2P bot senders drop as `bot_untrusted`.
- A group bot must be in that chat's trusted peer-bot set and must mention this
  bot; otherwise it drops as `bot_untrusted` or `group_bot_not_mentioned`.
- `group.require_mention: false` does not relax the trusted-bot mention rule.

Passive known-bot observation remains coupled to `group.allow_chats`. Only an
exact `bot | app` sender with a non-empty id in a listed group is recorded as
known. Known means observed, not authorized; only the trusted set can authorize
a peer bot.

Source:

- `/packages/channel/feishu-channel/src/chat-bots-store.ts`
- `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`

## `/introduce` Authority Split

`/introduce` changes peer-bot trust, so it remains sender-scoped rather than
inheriting ordinary trusted-chat authority:

- `block`: deny `group_blocked`;
- `allowlist`: require the chat in `allow_chats` and the sender in
  `allow_users`;
- `follow-user`: require the sender in `allow_users`; the chat need not be
  listed.

The authorization check is exact sender-id membership. `allow_users` is a
string list rather than a human-only type, so a bot/app id deliberately placed
there can pass; an ambient bot/app id absent from the list cannot.

A human outside `allow_users` may deliver ordinary text in a trusted chat but
receives `sender_not_followed` for `/introduce`, and no trust write occurs. An
unauthorized `/introduce` is not consumed; it falls through to the ordinary
gate, so trusted-chat semantics may deliver the command text as an ordinary
turn. This does not execute the trust mutation.

Pending pairing entries never authorize `/introduce`.

## Pairing

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
rename; final `access.json` mode is `0600`.

## Owner Approval

The pairing card hides the token in its action value. Approval is not an MCP,
CLI, or generic core surface.

On `card.action.trigger`:

1. Reject unknown/malformed actions without mutating access state.
2. Resolve the Feishu app creator/owner identity.
3. Reject a non-Owner click without changing the card or pending entry.
4. Under the access mutex, find the exact token and reject a missing, expired,
   or unsupported group-kind entry.
5. For a valid dm-kind entry, append its `sender_id` to `allow_users` if needed,
   delete that pending entry, persist, and return the immediate raw-card success
   response.

Approval checks the target entry expiry directly; it does not depend on another
message arriving to prune state. The token and raw ids are not displayed in
visible card copy or broad logs.

## Safe Same-Version Maintenance

An external/manual edit requires the target Channel owner to remain fully
quiesced for the entire read-modify-write window. A target Dispatcher may only
prepare and report a requested policy/shared-authority patch; it cannot stop
and then continue to apply its own patch. An independent operator performs:

```text
dispatcher stop -> confirmed stop -> post-stop re-read -> exact atomic patch
-> current-shape validation -> dispatcher start
```

Change only requested operator-policy or `allow_users` fields. Preserve
`version` and every Channel ledger field exactly. Use an owner-only sibling
temporary file and final mode `0600`; validate JSON and the full V3 shape
without printing values. `dreamux doctor` is not an access-state validator.

If the file is absent after confirmed stop, use the full secure V3 default as
the in-memory baseline, apply only requested policy/shared-authority fields,
create a missing state directory at mode `0700`, and atomically create the first
mode-`0600` file through a sibling temporary file. This is valid current-state
initialization, not a rebuild.

## In-Place Semantic Warning

V3 needs no rebuild for trusted-chat semantics. The same stored shape is
accepted, but authorization expands when the new server starts:

- a retained `follow-user` `allow_chats` entry now trusts every exact human in
  that chat for ordinary delivery instead of being ignored there;
- a retained `allowlist` entry now trusts every exact human in that chat instead
  of applying `dm_policy` and `allow_users` afterward.

Before deployment, review every non-empty `allow_chats` entry under both
non-block policies. Keep only groups whose human membership should be trusted
and whose passive known-bot observation should remain enabled.

## Test Locks

Focused tests protect:

- the trusted-chat truth table across both policies, every `dm_policy`, block,
  and both mention-switch values;
- the unchanged P2P and bot/trusted-bot paths;
- exact raw classification and no pre-gate side effects for unknown events;
- allow-chat-scoped exact-bot observation;
- the ordinary-delivery versus `/introduce` authority split;
- V3 defaults, reader/saver behavior, fixture versions, and public state types;
- the unchanged package-root gate input ABI;
- public/skill/release guidance for the in-place semantic warning and safe
  current maintenance.

Source:

- `/packages/channel/feishu-channel/tests/feishu-gate.test.ts`
- `/packages/channel/feishu-channel/tests/feishu-inbound-classification.test.ts`
- `/packages/channel/feishu-channel/tests/feishu-introduce.test.ts`
- `/packages/channel/feishu-channel/tests/public-api.test.ts`
