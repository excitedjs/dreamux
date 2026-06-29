# Feishu pairing-token access flow

- **Status:** Production ready. Decision record:
  [/.agents/decisions/feishu-pairing-access-v3.md](../decisions/feishu-pairing-access-v3.md).
  Supersedes the "Invite-code pairing" deferral in
  [Feishu introduce](feishu-introduce.md).
- **Affects:** `/packages/channel/feishu-channel/src/feishu-gate.ts`
  (v3 schema, gate result, pending bookkeeping, prune, mutations,
  pairing-token generator),
  `/packages/channel/feishu-channel/src/feishu-gate-io.ts`
  (load/save, pairing-prompt rendering, default state factory),
  `/packages/channel/feishu-channel/src/feishu-session-inbound.ts`
  (pair/drop/deliver branch in the extracted `onMessage` helper;
  class-side thin wrapper lives in
  `/packages/channel/feishu-channel/src/feishu-channel.ts`),
  `/packages/channel/feishu-channel/src/tools/registry.ts`
  (MCP tools remain `reply`, `react`, `list_chat_bots`;
  `src/feishu-mcp-tools.ts` is a backward-compatible re-export shim),
  `/packages/channel/feishu-channel/src/provider.ts`
  (provider session builder, unchanged),
  `/packages/channel/feishu-transport/src/policy/gate.ts` +
  `pairing.ts` (**DELETED**; transport's `package.json` now runs
  `prepublishOnly = clean && build` so stale `.d.ts` from deleted
  sources are never shipped),
  `/packages/channel/feishu-transport/src/contract/access-store.ts`
  (**DELETED** from the active source surface),
  `~/.dreamux/state/<dispatcher-id>/access.json` format (v3), Rush
  changelog (access state shape bump — change files pending, see
  §Rush Change).

## Locked Scope

This document is the single source of truth for pairing behavior. Any
branch not listed here either drops or delivers — there is no "default
implied" behavior in the gate, and no handler fallback outside the
switch below.

### Transport layer is side-effect free

`@excitedjs/feishu-transport` is a **stateless, side-effect-bound SDK adapter**.

The enforceable three-rule boundary (this is the audit criterion;
words like "network I/O only" are deliberately avoided because the
transport package legitimately contains parse/render pure functions
under `src/parse/` and `src/render/`):

1. **No file reads or writes.** Zero `fs` imports, zero path
   resolution for on-disk state, zero durable persistence.
   Purely-opaque SDK return-value wrappers that don't touch the
   filesystem.
2. **No access-control knowledge.** It must not define or reference
   `DmPolicy`, `GroupPolicy`, `GateResult`, `PendingEntry`,
   `Access`, `Pairing`, `allowlist`, or `mention-gating` concepts.
3. **No business rules.** It never decides whether a message is
   delivered or dropped; it never mutates pending bookkeeping; it
   never renders user-facing trust/pairing prompts. It calls
   endpoints when told; the caller decides *when* and *whether*.

Parse/render pure functions (`src/parse/content.ts`, `src/render/`)
are allowed because they contain no access-control knowledge, do no
I/O, and decide no business rules; they are SDK helpers shaped like
SDK helpers. Whether they move to the channel layer in the future is
a separate package-split decision with the same cross-repo consumer
constraint as B2 above — **not in scope for this PR**.

Concretely, the following code is **deleted** from
`@excitedjs/feishu-transport` as part of the pairing feature PR:

- `/packages/channel/feishu-transport/src/policy/gate.ts` (entire file)
- `/packages/channel/feishu-transport/src/policy/pairing.ts` (entire file)
- `/packages/channel/feishu-transport/src/contract/access-store.ts` (entire file)
- Re-exports of the above from `/packages/channel/feishu-transport/src/index.ts`
- Access-control types from
  `/packages/channel/feishu-transport/src/contract/types.ts`:
  `DmPolicy`, `GroupPolicy`, `GroupEntry`, `PendingEntry`, `Access`,
  `GateResult`, `DropReason`, `AccessStore`, `isGroupAuthorized`.
  If no other symbols remain, the whole `types.ts` is deleted.
  Primitive types still used for inbound parsing (`Mention` etc.) are
  retained on a per-usage basis.
- `/packages/channel/feishu-transport/tests/gate.test.ts`
  (orphan — directly imports deleted subjects).
- `/packages/channel/feishu-transport/tests/pairing.test.ts`
  (orphan — directly imports deleted subjects).
- `README.md` sections that describe a `policy` / access-control
  scope. Transport README lists only WebSocket lifecycle + raw SDK
  wrappers + parse/render helpers.
- `package.json` `description` / `keywords` references to "gate",
  "access control", "pairing", "allowlist". Package metadata matches
  the boundary above.

Because `@excitedjs/feishu-transport` is a published package with
external consumers (notably `claudemux`), the PR ships **two Rush
change files**: one for `@excitedjs/feishu-channel` (BREAKING v3
schema bump), and a **separate** one for `@excitedjs/feishu-transport`
that explicitly lists every deleted public export / deleted type
symbol. See §Rush Change / Changelog below for the transport change
body template.

Only `@excitedjs/feishu-channel` reads and writes
`access.json` / `chat-bots.json`. The pairing feature is therefore
implemented entirely within the channel package; the channel package
also owns the `generatePairingToken` primitive (§ Pairing token below).

Out of scope for the first increment:

- Per-group `require_mention` override; per-group `allow_users`
  granularity. Stay on the flat `group.allow_chats` list. Upgrade path
  is a future v4 schema bump, tracked separately.
- Auto-migration from v2. Operator reads CHANGELOG, edits `access.json`
  to v3 shape, reruns `dreamux doctor`, restarts. Any runtime attempt
  to load v2 fails loud and blocks dispatcher boot for that channel.
- Deny (block) verb and revoke verb. Not shipped in the first
  increment. An operator who needs to remove an id edits `access.json`
  by hand. Until a future admin surface exists, a removed id that re-enters the flow rolls a
  fresh pending entry as if it had never been seen.
- `list_pending` / `list` approval inspection surface. Operator
  inspection reads `access.json` directly.
- Transport-layer gate use. The transport gate (`policy/gate.ts`) is
  **deleted**. The transport package never exported a gate, never
  modeled access state, and will not grow one in the future.
- CLI / admin RPC / `rushx doctor` extras. The only approval surface is
  the Owner-only Feishu interactive card callback.

## Data

### Access file location

Unchanged from v2: `stateDir` is passed in by the runtime, which
derives it from the dispatcher-local state root. The file path is
`join(stateDir, 'access.json')` inside the channel package — the
canonical on-disk path is therefore owned by channel code, not by
core path builders. File mode `0600` (owner only) on write via the
tmpfile open-mode; directory mode `0700`.

**Fresh-install default:** When `access.json` does not exist on disk,
`loadDispatcherAccess` returns the in-memory object produced by
`defaultDispatcherAccessState()` in
`/packages/channel/feishu-channel/src/feishu-gate.ts`. That function
is the **only** place the "fresh installs default to
`dm_policy='pairing'`" rule lives. No `dreamux onboard` or config
factory script writes an `access.json` file — v2 never created one
and v3 preserves that shape. The first persistence event is the
first gate mutation that saves (either a pairing `pending` write, an
`access` approval write, or a diagnostic write from `deliver`/`drop`).

**Egress posture change for fresh installs:** v2 defaulted to
allowlist-only DM semantics, so unknown DM senders were silently
dropped. v3 defaulting `dm_policy='pairing'` means a fresh install
**actively replies** to any unknown human DM sender with a pairing
prompt. This is intentional, and is called out separately in the
Rush change file body so an operator upgrading a v2 deployment with a
rebuild (copy-paste into a v3 `access.json`) does **not** see the
posture flip — only truly new deployments see it.

### V3 schema

Defined in `/packages/channel/feishu-channel/src/feishu-gate.ts`.

```ts
interface DispatcherAccessStateV3 {
  version: 3;
  dm_policy: 'all' | 'allowlist' | 'pairing' | 'disabled';
  group: {
    policy: 'block' | 'allowlist' | 'follow-user';
    allow_chats: string[];
    require_mention: boolean;
  };
  allow_users: string[];
  pending: Record<string, PendingPairingEntry>;
  observed_chats: string[];
  warnings: WarnEntry[];
  last_gate: LastGate;
}

interface PendingPairingEntry {
  kind: 'dm' | 'group';
  sender_id: string;
  chat_id: string;
  created_at: number;
  expires_at: number;
  replies: number;              // legacy compatibility; not a resend-card cap
  prompt_message_id?: string;   // message_id of the currently visible card
}
```

`snake_case` is used inside access state to match the v2 convention;
runtime variables use `camelCase`.

### Pairing token

Owned by `@excitedjs/feishu-channel`, implemented directly inside
`/packages/channel/feishu-channel/src/feishu-gate.ts` next to the
uniqueness check (no separate `pairing.ts` file). Pure function, no
file IO:

```ts
import { randomBytes } from 'node:crypto';
const PAIRING_TOKEN_BYTES = 3 as const;
function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString('hex');  // 6 lowercase hex characters
}
```

The transport layer neither owns nor re-exports this primitive.
Uniqueness loop: inside `dreamuxFeishuGate` (next to the pending-store
mutation), if `state.pending[token]` exists roll a new one until the
slot is free.

### Constants

```
MAX_PENDING_PER_KIND   = 10   // simultaneous dm-kind pending entries
PAIRING_TTL_MS         = 3_600_000  // 1 hour
```

**Dedicated dm quota.** New pairing entries are dm-kind only and are capped
with `counts.dm < MAX`. The state shape still preserves `kind` so legacy
group-kind pending entries can be read and rejected without widening access.
The quota is enforced **after** prune-expired and **after** a sender
deduplication pass: a given `sender_id` counts against the quota at most
once, regardless of whether the request originated in a DM or group chat.
This bounds a single spammer to 1 slot per 1h TTL window instead of 10.
The pending Record stays a flat `token → entry`; enforcement walks the
values to count dm-kind entries.

**Existing-card reuse.** A brand-new entry is persisted after the first
card send with `prompt_message_id` set to the returned card message id when
Feishu provides one. A repeated inbound within the same TTL window returns
the same token (`is_resend = true`) and the session replies under the
existing card message instead of sending another approval card. The legacy
`replies` field is kept only so older access files remain readable.

`pruneExpiredPending(state)` is called at the **top** of every
`dreamuxFeishuGate()` invocation (and only there — see invariant #12
for the approval path's different guard). It mutates
`state.pending` in place and drops every entry where
`expires_at <= Date.now()`. The `last_gate` diagnostic records the
prune count. Running prune at the gate top guarantees expired
entries do not count against pending-queue quotas or feed back into
resend decisions.

## Gate Contract

`dreamuxFeishuGate(access, input, now?)` signature — pure (caller
passes `now` for determinism in tests; defaults to `Date.now()`).
The gate returns **next state plus structured logs** alongside the
action so the caller (the session inbound handler) can replay all
observable side effects without the gate touching IO:

```ts
interface GateInbound {
  chat_type: 'p2p' | 'group';
  sender_id: string;
  chat_id: string;
  is_bot_sender: boolean;          // boolean flag, NOT sender_type = 'bot'
  trusted_bot: boolean;            // precomputed: bot sender AND per-chat trusted set membership
  bot_mentioned: boolean;          // whether the inbound @-mentions the bot
}

type DropReason =
  | 'dm_disabled'
  | 'dm_not_on_allowlist'
  | 'dm_pairing_slot_cap'          // was "dm_pending_cap" in the first draft
  | 'group_policy_block'           // was "group_blocked"
  | 'group_bot_not_mentioned'
  | 'group_not_on_allowlist_and_not_mentioned'
  | 'group_follow_user_stranger_not_mentioned'
  | 'group_pairing_slot_cap'       // was "group_pending_cap"
  | 'bot_untrusted'                // bot sender not on the per-chat trusted set, or bot DM
  | 'unsupported_chat_type'
  | 'internal';                    // default-case fallthrough, never hit if switch is exhaustive

type GateAction =
  | { action: 'deliver' }
  | { action: 'drop'; reason: DropReason; context?: Record<string, unknown> }
  | {
      action: 'pair';
      kind: 'dm' | 'group';
      token: string;             // 6 lowercase hex chars, internal only
      is_resend: boolean;
      ttl_left_ms: number;        // exposed so the session log can carry TTL without a second state read
    };

interface GateResult {
  action: GateAction;
  nextState: DispatcherAccessStateV3;
  logs: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: Record<string, unknown> }>;
}
```

`GateResult` / `DropReason` are **channel-internal only**. Never
exported to `@excitedjs/dreamux` core and never serialised on the
admin socket.

### Branch table (the normative version)

Evaluation order: bot DM / bot-untrusted first, then the mention-gate for
groups, then per-policy branches. "DM" here means `chat_type === 'p2p'`
(the actual enum value; the UI name is DM).

| # | Sender | Chat type | Policy | Condition | Result |
|---|---|---|---|---|---|
| 1 | bot sender | `p2p` | any | — | `drop bot_untrusted` |
| 2 | any | `p2p` | `dm_policy === 'disabled'` | — | `drop dm_disabled` |
| 3 | human | `p2p` | `dm_policy === 'all'` | not self | `deliver` |
| 4 | human | `p2p` | `allowlist` \| `pairing` | `sender_id ∈ allow_users` | `deliver` |
| 5 | human | `p2p` | `allowlist` | otherwise | `drop dm_not_on_allowlist` |
| 6 | human | `p2p` | `pairing` | existing `kind:'dm'` pending for sender | `pair dm (resend=true)` |
| 7 | human | `p2p` | `pairing` | **no** existing dm pending **AND** `counts.dm < MAX_PENDING_PER_KIND` | `pair dm (resend=false)` |
| 8 | human | `p2p` | `pairing` | otherwise (slot cap) | `drop dm_pairing_slot_cap` |
| 9 | bot sender | group | any | `trusted_bot === false` | `drop bot_untrusted` |
| 10 | bot sender | group | any | `trusted_bot === true` **AND** `bot_mentioned === false` | `drop group_bot_not_mentioned` |
| 11 | bot sender | group | any | `trusted_bot === true` **AND** `bot_mentioned === true` | `deliver` |
| 12 | human | group | any | `require_mention === true` **AND** `bot_mentioned === false` | `drop group_bot_not_mentioned` |
| 13 | human | group | `group.policy === 'block'` | — | `drop group_policy_block` |
| 14 | human | group | `group.policy === 'allowlist'` | `chat_id ∉ allow_chats` | `drop group_not_on_allowlist` |
| 15 | human | group | any satisfied group shell | `dm_policy === 'disabled'` | `drop dm_disabled` |
| 16 | human | group | any satisfied group shell | `dm_policy === 'all'` | `deliver` |
| 17 | human | group | any satisfied group shell + `dm_policy === 'allowlist'` | `sender_id ∈ allow_users` | `deliver` |
| 18 | human | group | any satisfied group shell + `dm_policy === 'allowlist'` | otherwise | `drop group_user_not_on_allowlist` |
| 19 | human | group | any satisfied group shell + `dm_policy === 'pairing'` | `sender_id ∈ allow_users` | `deliver` |
| 20 | human | group | any satisfied group shell + `dm_policy === 'pairing'` | existing `kind:'dm'` pending for sender | `pair dm (resend=true)` |
| 21 | human | group | any satisfied group shell + `dm_policy === 'pairing'` | **no** existing dm pending **AND** `counts.dm < MAX_PENDING_PER_KIND` | `pair dm (resend=false)` |
| 22 | human | group | any satisfied group shell + `dm_policy === 'pairing'` | otherwise (slot cap) | `drop dm_pairing_slot_cap` |
| 23 | any | unsupported (meeting / calendar / topic / …) | any | `chat_type ∉ {'p2p','group'}` | `drop unsupported_chat_type` |
| — | — | — | — | default fallthrough (defense in depth) | `drop internal` |

Rows are evaluated top-to-bottom inside the gate implementation, but
the enum is not a sequence — the gate returns the **first matching
row's result**. `trusted_bot` is scoped per `chat_id` and precomputed
by the caller as `trusted_bot = is_bot_sender && chat_type==='group'
&& trusted_bot_ids.has(sender_id)`; this avoids the gate itself
reaching into the chat-bots store. "Mention check passes" means:
`require_mention === false` OR the inbound message @-mentions the bot
(already computed into `bot_mentioned` by the caller, so row 10 is a
simple boolean gate).

### Introduce parity lock

The `introduceDenyReason` function in
`/packages/channel/feishu-channel/src/introduce.ts` mirrors the gate
for `/introduce` authorization. The pairing feature must **not**
authorize `/introduce` before the sender or chat is fully on the
allowlist — a pending pairing state must never widen `/introduce`
trust. Concretely:

- `/introduce` in a DM from a pending user → not authorized (the
  sender is not on `allow_users`) → falls through to gate →
  `pair dm resend` (row 6).
- `/introduce` in a `follow-user` group with a sender not on
  `allow_users` → `introduceDenyReason = 'sender_not_followed'` →
  falls through to gate → `pair dm` when `dm_policy === 'pairing'`
  and the bot is mentioned (rows 20/21).
- `/introduce` in an `allowlist` group whose chat is not on
  `allow_chats` → `introduceDenyReason = 'chat_not_allowlisted'` →
  falls through to gate → `drop group_not_on_allowlist` (row 14).

Add one assertion to `tests/feishu-introduce.test.ts`'s gate-vs-introduce
parity table to lock this: `/introduce` + pending-only state → never
authorized.

## onMessage Branching

`FeishuChannelSession.onMessage` at
`/packages/channel/feishu-channel/src/sessions/feishu.ts` exhausts
`GateResult`:

- `deliver` → existing path: reaction emoji, format, attachment cache,
  `this.deliver(turn, envelope, hooks)`. No changes.
- `drop` → structured `logDebug('feishu inbound dropped', fields)`
  with all fields from v2 plus any `pending` context (`token`, `kind`,
  `ttl_left_ms`) when applicable. Silent to Feishu; no reply, no
  reaction.
- `pair` → **SEND FIRST, SAVE SECOND**:
  1. Build an Owner-only approval card. The internal token is carried only in
     the button `value`; it is never rendered in visible card text.
  2. `ctx.transport.sendCard(chat_id, card)`. Logged send errors:
     `'pairing prompt send failed'` with `chat_id` / `token` / `kind`
     / err. On send failure → do **not** write a `pending` entry,
     return from handler. No phantom tokens.
  3. Compute the new `pending[token]` entry with the returned
     `prompt_message_id` when available. On resend, reference the existing
     `prompt_message_id` instead of sending another card. Update
     `state.last_gate` with `pair: {kind, token, resend}`.
  4. `saveDispatcherAccess(stateDir, state)` — atomic via
     `writeFile(tmpPath, ..., {mode:0600})` → `rename(tmpPath, realPath)`.
     A `chmod` after `writeFile` on the final path is **not** allowed
     (TOCTOU race on a readable-then-chmodded file). Reuse the
     atomic-write helper pattern from
     `/packages/channel/feishu-channel/src/chat-bots-store.ts`.

### Approval card copy

Approval-card rendering lives in
`/packages/channel/feishu-channel/src/feishu-pairing-card.ts`. The bot display
name comes from the transport's runtime bot info (`bot.v3.info` `app_name`) and
falls back to the neutral `Dreamux bot` label if unavailable. Visible card text
(approval and success states) must use Feishu card i18n fields: default content
is Simplified Chinese and `en_us` carries English, so clients show one language
instead of a bilingual combined string. The approval card must @-mention the
requester with `<at id="open_id"></at>`. Repeated requests reference the
existing card message when `pending[token].prompt_message_id` is known instead
of sending another approval card. The card text **never displays the internal
token** and never names a specific operator by raw id or real name outside the
Feishu at-mention.

## Internal Approve-by-Token Helper

Feishu no longer exposes an `access` MCP tool. The tool catalog remains
`reply`, `react`, `list_chat_bots`; `parseFeishuMcpToolInput('access', ...)`
must fail. Pairing approval is an internal session helper called only after
the Owner-only card callback verifies the click operator.

Helper order for `approvePairingByToken(token)`:

1. **Per-entry expiry guard (not a global prune).** The approval
   path does **not** run `pruneExpiredPending` over the full pending
   Record. It relies on the single-entry
   `expires_at <= now` check at step 3 plus the gate-top prune
   running often enough to keep the cap counters honest. Stale
   non-matching entries are NOT swept during the approve path — the
   session mutex is already held for the lookup/write work and an
   extra O(N) walk there would add latency to the operator-critical
   approve path without improving correctness of the single
   matching entry.
2. Look up `pending[T]`. If absent → `not_found` with
   `details.token = T`. No write.
3. **Explicit TTL guard on the matching entry.** If
   `pending[T].expires_at <= Date.now()` → treat as absent, return
   `not_found` with `details.token = T`. **No delete, no persist**
   inside the approve path — the approval hot path does only the
   single-entry O(1) guard; expired entries are cleaned lazily by
   the inbound gate's per-kind prune pass (which runs before every
   `pair` new-slot decision). One shared `not_found` envelope with
   a unified human-readable message (`"授权请求不存在或已过期"`)
   covers both the unknown-token and expired branches so the wire
   surface stays minimal.
4. `kind='dm'` entry → de-dupe push `sender_id` → `allow_users`,
   delete `pending[T]`, persist → `ok`.
5. `kind='group'` is no longer generated or approved. It is treated as
   unsupported and does not mutate `allow_users`, `group.allow_chats`, or
   `pending`.
6. If the id was already on the target array (consecutive approval
   race) → still `ok` with `duplicate:true`.

| Invocation | Helper result |
|---|---|
| `pending["<PAIRING_TOKEN_HEX>"]` exists, `kind: 'dm'`, `expires_at > now` | push `entry.sender_id` to `allow_users` (deduplicated), delete `pending["<PAIRING_TOKEN_HEX>"]`, persist; return `status: "ok"`, `kind: "dm"`, `sender_id`, `chat_id`, `duplicate: bool`, `ttl_left_ms` |
| `pending["<PAIRING_TOKEN_HEX>"]` exists, `kind: 'group'`, `expires_at > now` | no mutation; return unsupported-request error |
| Entry exists but `expires_at <= now` | **no write** — shared `not_found` result; entry is cleaned later by gate prune |
| Token not in `pending` | no mutation; same `not_found` result as expired |

## Owner-only Interactive Card Approval

The interactive approval card is a channel-owned UI for the same
approve-by-token operation above. It does **not** introduce a second approval
path and must not mutate `allow_users`, `group.allow_chats`, or `pending`
directly.

When `dreamuxFeishuGate` returns `pair`, the session sends a Feishu interactive
card whose button value contains:

```json
{
  "dreamux_action": "approve_pairing",
  "dreamux_pairing_token": "<PAIRING_TOKEN_HEX>"
}
```

`card.action.trigger` handling stays below the LLM / Agent Runtime boundary:

1. Ignore unrelated card actions by returning `{}`.
2. Validate the 6-hex token from `dreamux_pairing_token`.
3. Resolve the app creator / owner open_ids through the Feishu application API.
4. If the click operator is not an App Owner, return only an error toast:
   `"只有 App Owner 才有权限点击批准授权"`. The card is not updated.
5. If the click operator is an App Owner, call `approvePairingByToken(token)`.
6. On successful approval, return the official Feishu card callback response
   shape:

```json
{
  "toast": { "type": "success", "content": "..." },
  "card": { "type": "raw", "data": { "...green success card..." } }
}
```

The success update must be delivered through the callback ACK response above,
not by calling ordinary `im.v1.messages.patch` from inside the handler. Feishu's
callback contract treats `{card:{type:"raw",data}}` as the immediate update
response; using `{card:<raw card>}` is a response-format error, and racing a
message patch with the callback ACK can briefly update then revert the client.

## Invariants (assert in tests)

1. **Pairing does not widen `/introduce`** (§ Gate Contract above).
2. **Send-before-save**: a failing Feishu send of a pairing prompt →
   no `pending` entry exists after the handler returns. An
   intermediate crash between send and save leaves at most a
   *message-sent-with-no-token-on-file* edge case (harmless — sender
   re-sends a message to roll a new token); the symmetric
   *token-saved-but-message-never-sent* case is eliminated.
3. **MAX_PENDING_PER_KIND never exceeded for dm-kind pairing**. Every `pair new`
   branch counts dm-kind `pending` entries after pruning expired ones; a single
   sender counts as one slot regardless of resend count. Group-kind pending
   entries are legacy/unsupported and are never generated or approved by the
   Owner-card flow.
4. **Resend idempotency**. Re-invoking the same gate for the same
   sender/chat within the resend window either returns the same
   `token` and references the existing card message. No new token churn and
   no repeated approval-card sends.
5. **Approval idempotency**. `approvePairingByToken(same)` twice → first `ok`
   + `duplicate:false`, second `ok` + `duplicate:true`. No double
   push onto arrays; arrays stay unique. Implementation note: look
   up in `pending` first and capture the entry, THEN mutate.
   Consecutive calls that both race into the lookup path must both
   detect that the id is already on `allow_users` / `allow_chats`
   and return `duplicate:true`.
6. **`dm_policy='allowlist'` behaves exactly like v2**. This is the
   post-migration backward-compat anchor. Add a table-driven
   regression test in `tests/feishu-gate.test.ts` that runs every v2
   input case through v3 with `dm_policy='allowlist'` and asserts
   identical outcomes.
7. **File mode.** `saveDispatcherAccess` opens the tmpfile with
   `{ mode: 0o600 }` before writing, THEN renames onto the final
   path. A `stat().mode & 0o777 === 0o600` test MUST pass. Two-step
   `writeFile + chmod` on the final path is explicitly disallowed
   (TOCTOU race — file is world-readable between the two syscalls).
8. **Atomic rename on every write.** Reuse the same atomic-write
   pattern as
   `/packages/channel/feishu-channel/src/chat-bots-store.ts`
   (tmpfile in the SAME directory as the target file so rename is
   cross-filesystem-safe; tmp filename includes pid + nanosecond
   timestamp + random suffix). Crash mid-write never truncates a
   valid existing `access.json`.
9. **Two-entrypoint serialization.** `FeishuChannelSession` owns a
    single private per-session `AsyncMutex` (`_accessMutex`) that is
    handed to helpers through the opaque `SessionHandle`. **Every**
    `read → mutate → saveDispatcherAccess` sequence — the inbound WS
    path in `onMessage` AND the `card.action.trigger` path
    (via `approvePairingByToken`) — acquires
    THIS mutex before `loadDispatcherAccess` and releases it after
    the rename() syscall in `saveDispatcherAccess`. The mutex does
    NOT live in a module-scope singleton or in IO helpers.
    `saveDispatcherAccess`. Regression test: fire `Promise.all([N ×
    inbound pair, M × card approvals with distinct tokens])` and
    assert that, in the final file, ALL pending writes and ALL
    allowlist pushes are present — no last-rename-wins clobbering.
    Locking rationale is explicitly documented: the
    `@larksuiteoapi/node-sdk` `EventDispatcher` makes no in-repo
    verifiable promise to serialize WS frames to a single handler
    at a time, so we cannot inherit serial ordering from the
    transport SDK.
10. **Save failure is fail-loud, no silent drop.** If `saveDispatcherAccess`
    throws (disk full, permission denied, EIO), the `onMessage`
    handler for the `pair` branch has already sent the user a
    pairing prompt — it MUST log a level=error structured entry with
    `chat_id`, `token`, `err`, return a `logError` to runtime hooks,
    and MUST NOT subsequently try to approve or reuse that token on
    later messages (the `pending` entry was never committed;
    re-inbound rolls a fresh token). For the card approval branch, a
    failing save is surfaced as an error result so the callback can
    return an error toast and the Owner can retry.
11. **Diagnostic writes do not dominate IO.** `observed_chats` /
    `warnings` / `last_gate` (v2 carry-over diagnostics) are updated
    and persisted **only on `deliver` and `drop` branches**, not on
    `pair`. The `pair` branch writes `access.json` only when it
    actually records a new or bumped `pending` entry. This avoids
    doubling the write rate for the stranger-spam load path that
    pairing was designed to handle.
12. **Approval respects TTL.** `approvePairingByToken(token)` never promotes an
    expired entry. The access handler runs a **single-entry explicit
    `expires_at > now` check** on the looked-up pending entry — it
    does NOT re-run `pruneExpiredPending` globally (pending-map
    iteration under lock dominates IO cost for the approval hot
    path; the entry-specific check is O(1) and equally correct).
    Entries are cleaned lazily by the inbound gate path on its
    per-kind pruning passes. The `not_found` envelope for an
    expired-or-unknown token shares one wire format (no top-level
    `expired` boolean); callers diagnose from message text + logs.
13. **Dm pending quota, plus sender dedup.**
    `MAX_PENDING_PER_KIND` applies to active dm-kind pairing. A single
    `sender_id` counts as **one slot** regardless of resend count — a spammer
    with N identities still needs N distinct ids to fill the quota. The flat
    pending Record is traversed for enforcement; no new top-level schema grouping is
    introduced.
14. **`defaultDispatcherAccessState()` is the sole default.** There
    is no code path that writes an `access.json` from `onboard` or
    a config factory. First persistence is driven by the first
    mutation. Changing the "fresh install" default from v2's
    effective allowlist-drop to v3's pairing-reply is done
    **exclusively** in `defaultDispatcherAccessState()`.

## Package Import Boundary Baseline

Captured from the Lens2 boundary audit. The following external imports
**are explicitly permitted** in `packages/channel/feishu-channel/src/`
(issue #209 boundary contract + channel-package responsibilities,
verifiable by `grep`):

1. `@excitedjs/dreamux-types` — the neutral provider seam.
2. `@excitedjs/feishu-transport` — the platform I/O boundary.
3. `@excitedjs/dreamux-utils` — host-agnostic platform utilities
   (owner-only directory helpers, no dispatcher state).
4. `node:*` built-ins. In practice: `node:crypto` (pairing-token
   CSPRNG), `node:fs/promises` and `node:path` (access.json +
   chat-bots store + attachment cache persistence and atomic
   renames), `node:stream` (attachment download streams).

The following import sources are **explicitly forbidden** (#209
red lines):

- `@excitedjs/dreamux` (core) anywhere under
  `packages/channel/feishu-*/src/` — channel packages never import
  core directly.
- `@excitedjs/feishu-transport` anywhere under
  `packages/dreamux/src/` — core never reaches past the provider
  seam. Transport is not an npm dependency of the dreamux package.

**Audit 2026-06-26 result:** both red lines have 0 hits across the
full import graph. The only real boundary bug found was stale emit
in `feishu-transport/dist/` (deletion of `src/policy/` and
`src/contract/access-store.ts` was not reflected in `dist/` because
TypeScript never deletes old emit); fixed by forcing
`prepublishOnly = clean && build` on the transport package.

## Rush Change / Changelog

> **Status: change files NOT YET CREATED.** The two files below are the
> target plan; they are written only after the claudemux MUST-VERIFY
> sweep confirms no sibling-repo consumer still references the deleted
> `feishu-transport` public exports (see §Cross-repo MUST-VERIFY
> below). `@excitedjs/feishu-transport/package.json` is still at
> `0.3.0` (no version bump); the `dist/` directory still carries old
> `.d.ts` artifacts from the deleted `src/` modules. The `Mention`
> type family under `src/contract/types.ts` in the transport package
> is **retained** (not part of the deletion scope) because the
> inbound path still consumes `isBotMentioned` / `isBotSenderType`
> from `@excitedjs/feishu-transport/parse/mentions`. Deletion scope
> is: the pairing-token module, the top-level `FeishuSession` class,
> the `ChannelAccessGate` type, and v2 access helpers.

Two Rush change files are required, **one per affected published
package**.

### Change file 1 — `@excitedjs/feishu-channel`

Body must start with `BREAKING:` because `access.json` v2 is no
longer loadable. Body must include:

```
BREAKING: ~/.dreamux/state/<dispatcher-id>/access.json now requires v3
shape (dm_policy, pending fields; version:3). Existing v2 files fail
loud on load. To rebuild:
  1. Copy allow_users / group.allow_chats / group.require_mention
     verbatim from your current file.
  2. Add "version": 3, "dm_policy": "allowlist", "pending": {}.
  3. Save and restart `dreamux serve`.
     NOTE: `dreamux doctor` does not pre-validate access.json (it is
     validated at dispatcher boot by the Feishu provider). If you
     want a preflight check, run:
       node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('JSON OK')" \
         ~/.dreamux/state/<dispatcher-id>/access.json
     before restarting.
Backward compat: keeping dm_policy === "allowlist" reproduces v2's
allowlist-only DM behavior exactly (no egress behavior change for
existing deployments after rebuild).
NEW BEHAVIOR (fresh installs only): fresh installs default
dm_policy to "pairing" so unknown human DM senders receive a
pairing-token reply instead of being silently dropped. This is an
egress posture change — the bot now actively replies to strangers
on a fresh install. Existing deployments rebuilt with
dm_policy="allowlist" are unaffected.
Owner-only interactive cards approve pending pairing entries via a
6-hex-digit token. The card handler validates App Owner identity first,
then calls the internal approve-by-token helper. Expired entries are
guarded by a single-entry TTL check so stale tokens cannot be approved.
DM pending slots are capped at 10 with per-sender dedup so a single sender
cannot fill the pool. Group allowlisting remains manual via access.json.
Inspect pending entries / revoke ids by editing access.json directly.
Rebuild: ~/.dreamux/state/<id>/access.json.
```

### Change file 2 — `@excitedjs/feishu-transport` (published API deletion)

Minor version bump (0.3.x → 0.4.x). Body must enumerate every deleted
public export / deleted type symbol, list the orphan test files deleted in the
same commit, give a consumer migration note, and carry a must-verify item for
the external claudemux cross-repo dependency. Template:

```
Removes all access-control / gate / pairing / persistence code from
the package. Enforced three-rule package boundary going forward:
  1. No file reads or writes (zero fs imports, zero persistence.
  2. No access-control concepts (no DmPolicy, GateResult, pairing,
     allowlist, mention-gating).
  3. No business-rule decisions (never decides deliver/drop; caller decides
     when/what.
Stateless parse/render pure functions under src/parse/ and src/render/ are
unaffected and remain exported.

Deleted public exports from src/index.ts:
  - Access, DmPolicy, GroupPolicy, GroupEntry, PendingEntry (type
    symbols previously exported via src/contract/types.ts, or the whole types.ts
    file if empty after removal).
  - AccessStore, readDispatcherAccess, writeDispatcherAccess,
    saveDispatcherAccess (from src/contract/access-store.ts, whole
    file deleted).
  - dreamuxGate, GateResult, DropReason, pruneExpiredPending,
    isGroupAuthorized (from src/policy/gate.ts, whole file deleted).
  - generatePairingToken (from src/policy/pairing.ts, whole file deleted).

Deleted test files (orphaned by above:
  - tests/gate.test.ts (imports src/policy/gate).
  - tests/pairing.test.ts (imports src/policy/pairing).

Deleted documentation / metadata changes:
  - README.md sections describing a "policy" / "access-control" scope"
    scope are removed; README now lists only: WebSocket lifecycle, raw SDK
    endpoint wrappers, parse/render helpers.
  - package.json description/keywords drop references to gate/access/pairing/allowlist.

CONSUMER ACTION REQUIRED if you import deleted exports from this package:
  - Claudemux consumers of the transport gate / access-store /
    generatePairingToken exports:
    • Gate / pairing / allowlist logic moves into your own
      channel-layer equivalent. Inline the generatePairingToken
      one-liner if you only need the random-hex primitive.
    • Access JSON persistence belongs next to your own dispatcher
      state directory; use an atomic tmpfile+rename write helper
      (dreamux's feishu-channel has a reference implementation
      patterned after chat-bots-store.ts).
    • Feishu WebSocket lifecycle and raw endpoint wrappers
      (sendText/react/editMessage/downloadImage) are UNCHANGED.
  - Claudemux maintainer verification item [MUST-VERIFY before
    publishing]: confirm whether claudemux imports deleted exports
    from the published @excitedjs/feishu-transport package or carries
    its own parallel copy. If the former: pin claudemux's dependency
    at <0.4.0 and schedule a follow-up PR to migrate before unpublishing
    0.3.x. If the latter: document in the transport README that dreamux's
    transport is the dreamux channel architecture's copy; claudemux's runtime
    carries its own parallel set.
```

## End-to-End Sequence

```mermaid
sequenceDiagram
    participant Stranger
    participant Bot as Feishu Bot
    participant Chan as Channel Session
    participant Gate as dreamuxFeishuGate
    participant Store as access.json v3
    participant Operator

    Note over Stranger,Store: Trigger from unknown DM sender
    Stranger->>Bot: 私聊消息
    Bot->>Chan: normalize (sender_id=A, chat_type=p2p)
    Chan->>Store: load access.json
    Store-->>Chan: v3 state (dm_policy=pairing, A∉allow_users)
    Chan->>Gate: gate(state, input)
    Gate->>Gate: pruneExpiredPending
    Gate-->>Chan: {action:pair, kind:dm, token:"<PAIRING_TOKEN_HEX>", resend:false}
    Chan->>Bot: sendCard(Owner approval card; hidden token)  ← SEND FIRST
    Bot-->>Stranger: approval card
    Chan->>Store: save pending["<PAIRING_TOKEN_HEX>"]  ← SAVE SECOND

    Note over Stranger,Operator: Out-of-band
    Operator->>Bot: clicks pairing approval card

    Note over Bot,Store: Approval path
    Bot->>Chan: card.action.trigger (operator_open_id=Owner)
    Chan->>Bot: resolve app owner identity
    Chan->>Store: load → push sender_id to allow_users → delete pending → save
    Store-->>Chan: ok
    Chan-->>Bot: callback response {toast, card:{type:"raw",data:green card}}
    Bot-->>Operator: card becomes green success state
```
