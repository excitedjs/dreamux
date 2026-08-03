# Feishu pairing-token access control (v3 schema + Owner card approval)

- **Status:** Production ready
- **Date:** 2026-06-27
- **Affects:** `@excitedjs/feishu-transport` scope (downward),
  `@excitedjs/feishu-channel` package (access schema v3, gate,
  pairing approval card, pairing prompt send),
  `~/.dreamux/state/<dispatcher-id>/access.json` file format,
  dispatcher operator workflow,
  `/.agents/domains/feishu-pairing-access.md`
- **PR / Issue:** TBD. Supersede the "Invite-code pairing" deferral in
  [/.agents/domains/feishu-introduce.md](../domains/feishu-introduce.md).

> **Current refinement:**
> [Feishu trusted allow-chats semantics](feishu-allow-chats-trust-semantics.md)
> supersedes only the ordinary human `allow_chats` delivery rows in this
> decision. The V3 schema, pairing flow, Channel ownership boundary, Owner-card
> approval, and all unrelated contracts below remain current.

## Context

Dreamux v2 Feishu access (`DispatcherAccessState.version === 2`, implemented in
`/packages/channel/feishu-channel/src/feishu-gate.ts`) is strictly
allowlist-based: any sender not on `allow_users` and any group chat not on
`group.allow_chats` is silently dropped with a diagnostic log only. There is
no out-of-band mechanism for a human operator to discover a stranger's
`open_id` or a new group's `chat_id` — the operator must edit
`access.json` by hand after extracting ids through a separate workflow.

Claudemux (`~/Development/claudemux`) ships a pairing-token flow in its
`@excitedjs/feishu-transport` access gate: unknown DM senders receive a
six-hex token via reply, the operator manually promotes the matching
`pending` entry. Dreamux keeps the random-token primitive but no longer
displays the token to users. The transport-level gate has the right primitives, but
Dreamux deliberately uses its own v2 gate and does not re-import the
transport gate for runtime decisions (see
[provider-architecture-realignment](provider-architecture-realignment.md) and
[npm-package-split-and-channel-targets](npm-package-split-and-channel-targets.md)
— channel layer owns gate + parsing + egress formatting, transport owns
network I/O only).

Three additional forces shape this decision:

1. Dreamux 0.x access-state compatibility is fail-loud with no silent
   auto-migration
   ([providerized-config-state-compatibility](providerized-config-state-compatibility.md)).
   In-code migration logic is forbidden; the operator rebuilds
   `access.json` after reading the changelog, then reruns doctor, then
   restarts.
2. Approval is Feishu-channel-specific and must not migrate to generic
   core MCP. With the Owner-only interactive card, approval no longer needs
   a model-visible MCP tool at all.
3. The operator (a human running a Team) approves requests by clicking the
   Feishu card as App Owner, not by editing a JSON file or asking the model
   to call a tool.

## Decision

### A. Transport / channel boundary — hard invariants

`@excitedjs/feishu-transport` is a **stateless, side-effect-free SDK wrapper**. It
owns Feishu platform I/O only. It contains no access control, no gate, no
pairing, and no persistence. Hard invariants, enforced by code review + the
`no-sync-io` lint gate:

- **No file reads or writes.** The transport layer takes every input as a
  function argument; it never touches `fs`, never discovers paths, and never
  mutates on-disk state. The `generatePairingToken` primitive is an
  unstructured, opaque random-hex helper with no semantic meaning — it is
  **moved out of the transport package** entirely (see §C) so the transport
  layer has zero knowledge of "pairing" as a concept.
- **No durable state.** No `class` fields persist between calls beyond the
  `@larksuiteoapi/node-sdk` client instance and the WebSocket handle.
- **No business rules.** No allowlist, no `DmPolicy`, no `GateResult`, no
  `PendingEntry`, no mention gating — these are all channel-layer concerns.

What the transport layer **does** own:

- WebSocket long-connection lifecycle (open, heartbeat, reconnect, close).
- `@larksuiteoapi/node-sdk` client construction and wrapping.
- Raw event delivery: subscribe to `im.message.receive_v1`,
  `im.chat.member.bot.added_v1`, and additional Feishu event types as they
  are wired; call a single-argument handler with the normalised raw event
  payload.
- Thin synchronous wrappers around Feishu OpenAPI endpoints that the
  channel layer calls: `sendText(chat_id, text)`,
  `sendCard(chat_id, raw_interactive_card)`,
  `react(chat_id, message_id, emoji)`,
  `editMessage(chat_id, message_id, text)`,
  `downloadImage(message_id, image_key, target_stream)`,
  `resolveAppOwner(app_id)`, and the like. Each returns a plain promise
  result; the transport layer never decides **when** or **whether** to call
  these endpoints.

Code removed from `@excitedjs/feishu-transport` as part of this decision:

| File / export / asset | Reason |
|---|---|
| `src/policy/gate.ts` (entire file) | Claudemux-era transport gate; Dreamux never used it, new pairing lives in channel layer |
| `src/policy/pairing.ts` (entire file) | Pairing primitive owned by channel layer; see §C below |
| `src/contract/access-store.ts` (entire file) | Persistence contract for access state; transport must not read/write files |
| `src/contract/types.ts` → `DmPolicy`, `GroupPolicy`, `GroupEntry`, `PendingEntry`, `Access` types | Types describe access state, transport must not model it; `Mention` primitive stays if still used for inbound parsing — review per usage. If no other symbols remain the whole `types.ts` is deleted. |
| All imports / re-exports of the above from the transport package entry point (`src/index.ts`) | Surface stays minimal and platform-oriented only |
| `tests/gate.test.ts` and any `tests/` that exercise `policy/*` or access-store | Deleted together with their subjects |
| `README.md` sections that describe a `policy` / access-control scope | Transport README lists only SDK endpoints and WebSocket lifecycle |
| `package.json` `description` / `keywords` references to "gate", "access control", "pairing", "allowlist" | Package metadata stays aligned with the pure-SDK boundary |

The channel layer (`@excitedjs/feishu-channel`) owns, end-to-end: inbound
gate logic, access state load/save, pairing token generation, prompt
rendering and send, pending bookkeeping, `/introduce` authorization, and
the Owner-card approval mutation. It imports the SDK-adapter surface only
from `@excitedjs/feishu-transport`.

### B. Schema: v2 → v3 bump, fail-loud on shape mismatch

`DispatcherAccessState.version` is bumped from `2` to `3`. The type is
extended at `/packages/channel/feishu-channel/src/feishu-gate.ts`:

```typescript
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
  created_at: number;   // ms epoch
  expires_at: number;   // ms epoch
  replies: number;      // legacy compatibility; not a resend-card cap
  prompt_message_id?: string;
}
```

Semantics of the new fields:

- `dm_policy === 'all'` — every non-bot DM is delivered.
- `dm_policy === 'allowlist'` — only `allow_users` DM senders are
  delivered; unknowns are dropped.
- `dm_policy === 'pairing'` (**new installation default**) — unknown DM
  senders receive an Owner-only approval card and are recorded in `pending`.
- `dm_policy === 'disabled'` — DMs are never delivered.
- `pending` — keyed by the 6-hex-digit pairing token. Values are the same
  shape as Claudemux's `PendingEntry`, using snake_case to match the
  rest of `DispatcherAccessStateV3`.
- `group.policy` keeps v2's enum (`block | allowlist | follow-user`).
  No per-group `require_mention` overrides, no per-group `allow_users`
  — those are deferred.

Backward-compatibility stance (explicit, per issue #98 +
`providerized-config-state-compatibility`):

- **No in-code v2 → v3 migration.** The loader enforces `version === 3`
  exactly. When `version` is missing, is `2`, or the parsed shape lacks
  required fields, `readDispatcherAccess` fails loudly with a message
  that includes: `access.json must be v3 shape — copy allow_users to
  v3, add dm_policy + pending fields, then restart. See CHANGELOG.md
  and /.agents/domains/feishu-pairing-access.md.`
- **`dreamux onboard` / config factory** scripts write v3 by default.
- Existing deployments require an explicit operator edit of
  `access.json`. There is no silent upgrade path.

### C. Gate result is channel-internal; pairing is fully channel-owned

`dreamuxFeishuGate` changes its return type from the v2
`{ allowed: boolean; reason: string }` to a channel-internal discriminated
union packaged together with the mutated next-state snapshot and
structured log entries (so the gate stays pure and side-effect-free):

```typescript
type GateAction =
  | { action: 'deliver' }
  | { action: 'drop'; reason: DropReason; context?: Record<string, unknown> }
  | { action: 'pair'; kind: 'dm' | 'group'; token: string; is_resend: boolean; ttl_left_ms: number };

interface GateResult {
  action: GateAction;
  nextState: DispatcherAccessStateV3;
  logs: Array<{ level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: Record<string, unknown> }>;
}
```

DropReason (11 values):
```typescript
type DropReason =
  | 'dm_disabled'
  | 'dm_not_on_allowlist'
  | 'dm_pairing_slot_cap'
  | 'group_policy_block'
  | 'group_bot_not_mentioned'
  | 'group_not_on_allowlist_and_not_mentioned'
  | 'group_follow_user_stranger_not_mentioned'
  | 'group_pairing_slot_cap'
  | 'bot_untrusted'
  | 'unsupported_chat_type'
  | 'internal';
```

The gate input is `GateInbound` — a 6-field normalized record the
caller builds per event from `event.*` fields plus
`isBotSenderType` / `isBotMentioned` / per-chat `trusted_bot_ids` Set
membership, all evaluated once outside the lock:

```typescript
interface GateInbound {
  chat_type: 'p2p' | 'group';
  sender_id: string;
  chat_id: string;
  is_bot_sender: boolean;
  trusted_bot: boolean;
  bot_mentioned: boolean;
}
```

This type is **never exported across the provider boundary** and never
reaches `@excitedjs/dreamux` core. The `FeishuChannelSession.onMessage`
handler exhausts it in a local `switch`. `deliver` proceeds into the
existing `this.deliver(...)` callback; `drop` emits a structured log
entry and returns without an egress send; `pair` **sends the pairing
prompt via Feishu transport first, then saves the mutated access
state**, matching Claudemux's ordering so a failed send never produces a
phantom `pending` entry.

Pairing triggers (gate branches):

> The ordinary human group rows in this table record the original V3 decision.
> For current `allow_chats` delivery, use the accepted refinement linked above:
> after the global mention and `block` gates, a listed chat directly trusts
> exact human members under either `allowlist` or `follow-user`; only an
> unlisted `follow-user` chat reaches `dm_policy` / `allow_users` / pairing.

| Inbound | Policy | Condition | Action |
|---|---|---|---|
| DM | `disabled` | — | drop |
| DM | `all` | not a bot sender | deliver |
| DM | `allowlist` | sender ∈ `allow_users` | deliver |
| DM | `allowlist` | otherwise | drop |
| DM | `pairing` | sender ∈ `allow_users` | deliver |
| DM | `pairing` | existing `kind: 'dm'` pending for sender | pair (resend same token) |
| DM | `pairing` | otherwise, `|pending| < MAX_PENDING` | pair (new token) |
| DM | `pairing` | otherwise | drop (slot cap) |
| Group | `block` | — | drop |
| Group | `follow-user` | bot not @-mentioned | drop |
| Group | `follow-user` + `dm_policy=allowlist` | sender ∈ `allow_users` | deliver |
| Group | `follow-user` + `dm_policy=allowlist` | otherwise | drop |
| Group | `follow-user` + `dm_policy=pairing` | sender ∈ `allow_users` | deliver |
| Group | `follow-user` + `dm_policy=pairing` | otherwise + bot @-mentioned | pair dm (new or resend) |
| Group | `allowlist` | chat ∉ `allow_chats` | drop |
| Group | `allowlist` + `dm_policy=allowlist` | chat ∈ `allow_chats` + sender ∈ `allow_users` + mention check passes | deliver |
| Group | `allowlist` + `dm_policy=pairing` | chat ∈ `allow_chats` + sender ∉ `allow_users` + bot @-mentioned | pair dm (new or resend) |
| Group bot sender | any | not in `trustedBotIds` for chat | drop |
| Group bot sender | any | trusted + bot not @-mentioned | drop |
| Group bot sender | any | trusted + @-mentioned | deliver |

Hard constants (aligned with Claudemux production values):

- `MAX_PENDING_PER_KIND = 10` — active pairing creation checks the dm-kind
  pending count. The v3 pending shape still has a `kind` field so old
  group-kind entries can be read and rejected safely, but new Owner-card
  pairing never creates or approves group-kind pending entries.
- Existing-card reuse — a fresh pending entry starts at `replies: 1`
  after the first prompt and records the returned card `prompt_message_id`
  when Feishu provides one. Later inbound requests for the same sender return
  the same token and reference the existing card instead of sending another
  approval card. `replies` remains only for compatibility with existing v3
  access files.
- `PAIRING_TTL_MS = 3_600_000` (1 hour). `pruneExpiredPending()` is
  invoked at the top of every `dreamuxFeishuGate` call.

Pairing tokens are generated inline inside the gate at
`/packages/channel/feishu-channel/src/feishu-gate.ts` (no separate
`pairing.ts` file — the generator is a 1-line `randomBytes(3).toString('hex')`
placed next to the uniqueness loop that consumes it):

```ts
function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString('hex');  // 6 lowercase hex chars
}
```

Group pairing is not approved by this flow. `group.allow_chats` is a
manual allowlist shell; Owner card approval promotes only the requester
open_id onto `allow_users`.

### D. Internal approve-by-token helper, no approval MCP tool

Feishu channel MCP tools remain `reply`, `react`, and `list_chat_bots`.
There is no `access` MCP tool: pairing approval is performed only by the
Owner-only card callback after it verifies the click operator's open_id.
The old compatibility parser must reject `parseFeishuMcpToolInput('access', ...)`.

Internal helper semantics:

1. **Per-entry expiry guard (not a global prune).** Unlike the gate,
   the approval helper does not sweep `pruneExpiredPending` over the
   full pending Record. Instead it runs an explicit
   `expires_at <= now` check on the single matching entry after
   lookup — this catches stale entries the gate hasn't reached yet
   without paying the O(N) sweep cost inside the mutex.
2. Look up `pending[token]`.
   - `kind: 'dm'` entry → de-dupe + push `entry.sender_id` onto
     `allow_users`; delete the pending entry; persist; return
     `{status:'ok', details: {kind:'dm', added: sender_id, duplicate: bool, ttl_left_ms}}`.
   - `kind: 'group'` entry → unsupported request; no mutation.
   - Not found (or expired before prune caught it) →
     `{status:'not_found', message: '授权请求不存在或已过期'}`.
   - `allow_users` already contained the id → still
     returns `ok`, `details.duplicate = true`.

`list_pending` and `revoke` are **intentionally out of scope**. The
operator inspects `access.json` by hand when needed. Revocation is
performed by editing `access.json` directly (documented in the
changelog rebuild section). Future increments may add an explicit admin
surface, but the first increment ships no model-visible approval tool.

No CLI surface is added. No admin RPC surface is added. The operator
uses the Owner-only Feishu card interaction. Core never sees an approval
MCP call.

### E. Owner-only interactive card approval

The Feishu interactive approval card is a channel-owned UI for the same
approve-by-token operation. It is not a second approval path and does not
mutate access state directly.

When `dreamuxFeishuGate` returns `pair`, the session sends an interactive
card instead of a plain-text pairing prompt. The button value contains the
channel-owned action marker and hidden token:

```json
{
  "dreamux_action": "approve_pairing",
  "dreamux_pairing_token": "<PAIRING_TOKEN_HEX>"
}
```

`card.action.trigger` is handled inside `@excitedjs/feishu-channel`, below
the Agent Runtime / LLM boundary:

1. Unknown card actions return `{}`.
2. Malformed tokens return an error toast.
3. The handler asks the transport for app creator / owner `open_id` values.
4. A non-Owner click returns only
   `"只有 App Owner 才有权限点击批准授权"` as an error toast; the card is not
   replaced and `pending` is not mutated.
5. An Owner click calls `approvePairingByToken(token)`.
6. A successful approval returns Feishu's immediate callback-update shape:

```json
{
  "toast": { "type": "success", "content": "..." },
  "card": { "type": "raw", "data": { "...green success card..." } }
}
```

The callback path must not call ordinary `im.v1.messages.patch` from inside
the handler. The live Feishu client accepts the raw-card callback wrapper above
for immediate replacement; `{ "card": <raw card> }` is rejected, and racing an
ordinary patch against the callback ACK can visibly update then revert.

## Consequences

- **Package invariant:** `@excitedjs/feishu-transport` loses its
  `policy/` directory, its access-control types, and any awareness of
  `pairing` / `gate` / `allowlist`. From this PR on, transport review
  can audit the absence of `fs` imports and access-model exports as a
  zero-tolerance rule.
- **Deletion scope:** this PR removes
  `/packages/channel/feishu-transport/src/policy/gate.ts`,
  `/packages/channel/feishu-transport/src/policy/pairing.ts`,
  `/packages/channel/feishu-transport/src/contract/access-store.ts`, their
  `index.ts` re-exports, the
  `DmPolicy`/`GroupPolicy`/`GroupEntry`/`PendingEntry`/`Access`
  symbols **only** from `src/contract/types.ts` (the `Mention` family
  and other message-payload types are retained — inbound parsing still
  consumes `isBotMentioned` / `isBotSenderType` from
  `@excitedjs/feishu-transport/parse/mentions`, so the types file is
  NOT deleted wholesale),
  `tests/gate.test.ts` and any other tests that import deleted
  subjects, and transport README / `package.json` metadata that
  describes a policy / access-control scope.
- **Published-API deletion:** `@excitedjs/feishu-transport` is a
  published package with consumers (at minimum `claudemux`). The PR
  therefore ships with two Rush change files: one for the v3 schema
  bump on `@excitedjs/feishu-channel` (BREAKING, see §Rush Change in
  the domain doc), and a **separate** Rush change file for
  `@excitedjs/feishu-transport` whose body explicitly lists every
  deleted public export and every deleted type symbol. The transport
  package gets a **minor version bump** (existing consumers that do
  not import `policy/*` or access-control symbols keep working;
  consumers that did will observe a TypeScript resolution error and
  can follow the changelog migration note). Migration text must be
  copy-pasteable: "replace `import { generatePairingToken, dreamuxGate,
  GateResult } from '@excitedjs/feishu-transport'` with in-repo
  equivalents in your own access layer, or upgrade to a dreamux-style
  channel/provider split." Claudemux's transport gate is a known
  affected consumer; its migration tracking entry is linked from the
  transport change file body.

  > **Status:** neither Rush change file is written yet;
  > `@excitedjs/feishu-transport/package.json` still reports
  > `version: 0.3.0` (no bump). Both are gated behind the claudemux
  > MUST-VERIFY sweep that cross-repo greps every listed deleted
  > export to bound the actual breakage scope — if a consumer
  > still references an export the deletion plan can be adjusted
  > before the version is moved. `dist/` still contains stale `.d.ts`
  > for deleted `src/` modules; these are cleaned as part of the
  > transport build in the same rush change.
- **State compatibility:** the v2 → v3 bump is visible the first time
  an existing deployment restarts after the upgrade. Changelog +
  doctor output must include a concrete `access.json` template so the
  operator can copy-paste their current `allow_users` /
  `allow_chats` in.
- **Approval card copy:** Approval and success card copy uses Feishu card i18n
  fields so clients display one language (Simplified Chinese by default,
  English under `en_us`). The approval card @-mentions the requester so the
  Owner can identify who requested access. Cards never display the internal
  token and never name a specific operator by raw Feishu id or real name outside
  the Feishu at-mention. Messages must not include raw `chat_id` or internal
  pairing tokens in visible text.
- **Noisy diagnostics:** Pending entries are observable by reading
  `access.json` by hand (operator-only) and via the structured
  `feishu inbound dropped` log entry's `context` field when a drop is
  pending-related (`token`, `kind`, `ttl_left_ms`). No `list_pending`
  MCP selector is exposed in the first increment.
- **Pairing race:** If a stranger spams the bot from multiple DMs,
  `MAX_PENDING` caps the blast radius. If two strangers happen to
  share a token collision (probability ~16M), the second `gate()` call
  will generate a new token after re-checking uniqueness — add an
  internal loop (`while (pending[token]) token = generatePairingToken()`)
  inside `dreamuxFeishuGate`.
- **Review checklist items added:** Any PR touching `feishu-gate.ts`
  must show the gate-table branches are unchanged-by-default (i.e.,
  `dm_policy='allowlist'` must behave identically to v2) and that
  `version !== 3` paths still fail-loud.

## Alternatives Considered

- **Reuse transport-level gate in Dreamux.** Not an option — the
  entire transport gate module is deleted. Access/gate/pairing
  ownership is channel-layer by construction, not by adapter or
  indirection.
- **MCP approval tool (`access`, `approve_pairing`, or a union schema
  with `token` / `list` / `revoke+id`).** Rejected after live Feishu card
  validation: the Owner-only interactive card is a simpler approval surface
  and avoids routing approval through the model. `list` and `revoke` remain
  operator-visible only and can be performed by editing `access.json` by hand.
  Future increments may add an explicit admin surface if needed, but not a
  hidden model-mediated approval path.
- **Silent v2 → v3 schema migration.** Rejected explicitly by
  `providerized-config-state-compatibility` / issue #98. Access
  control state is the highest-sensitivity state file in dreamux; a
  silent migrate that accidentally defaulted `dm_policy` to
  `'pairing'` on an existing `'allowlist'` deployment would change
  egress behavior (send a message to a stranger) without the operator
  opting in. Fail-loud is the only acceptable stance.
- **Per-group `require_mention` / per-group `allow_users`.** Deferred.
  The v3 schema deliberately keeps the flat `group.allow_chats` list
  so the first pairing increment can land with a small diff. Upgrade
  to a `groups: Record<chat_id, GroupEntry>` sub-shape is a future v4
  bump on its own.
- **Transport-only pairing prompt send with channel owning gate.**
  Rejected: pairing prompt rendering (copy, language, TTL disclosure,
  resend hint) is a channel-layer UX concern, not a transport concern.
  Transport does not own any send-while-writing-state timing invariant.
  Keeping send in `FeishuChannelSession.onMessage` lets future
  localization and card rendering changes stay in one file, and keeps
  `feishu-transport` free of state/side-effect logic.
