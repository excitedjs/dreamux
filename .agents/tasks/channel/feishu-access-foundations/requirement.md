# Backfilled decision records: feishu access foundation records

> Backfilled 2026-09-01 from the dissolved `.agents/decisions/` tree on
> operator instruction: task records are the single derivation layer. Each
> section preserves one record verbatim (original heading, status, and date;
> headings demoted one level for nesting). Later reality is recorded only in
> dated "Since this was recorded" subsections; historical text is never edited.

## feishu-pairing-access-v3

## Feishu pairing-token access control (v3 schema + Owner card approval)

- **Status:** Production ready
- **Date:** 2026-06-27
- **Affects:** `@excitedjs/feishu-transport` scope (downward),
  `@excitedjs/feishu-channel` package (access schema v3, gate,
  pairing approval card, pairing prompt send),
  `~/.dreamux/state/<dispatcher-id>/access.json` file format,
  dispatcher operator workflow,
  `/.agents/domains/feishu-pairing-access.md`
- **PR / Issue:** TBD. Supersede the "Invite-code pairing" deferral in
  [/.agents/domains/feishu-introduce.md](/.agents/domains/feishu-pairing-access.md).

> **Current refinement:**
> [Feishu trusted allow-chats semantics](/.agents/tasks/channel/feishu-access-foundations/requirement.md#feishu-allow-chats-trust-semantics)
> supersedes only the ordinary human `allow_chats` delivery rows in this
> decision. The V3 schema, pairing flow, Channel ownership boundary, Owner-card
> approval, and all unrelated contracts below remain current.

### Context

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
[provider-architecture-realignment](/.agents/tasks/architecture/providerization-epic/requirement.md#provider-architecture-realignment) and
[npm-package-split-and-channel-targets](/.agents/tasks/architecture/npm-package-split/requirement.md#npm-package-split-and-channel-targets)
— channel layer owns gate + parsing + egress formatting, transport owns
network I/O only).

Three additional forces shape this decision:

1. Dreamux 0.x access-state compatibility is fail-loud with no silent
   auto-migration
   ([providerized-config-state-compatibility](/.agents/tasks/architecture/providerization-epic/requirement.md#providerized-config-state-compatibility)).
   In-code migration logic is forbidden; the operator rebuilds
   `access.json` after reading the changelog, then reruns doctor, then
   restarts.
2. Approval is Feishu-channel-specific and must not migrate to generic
   core MCP. With the Owner-only interactive card, approval no longer needs
   a model-visible MCP tool at all.
3. The operator (a human running a Team) approves requests by clicking the
   Feishu card as App Owner, not by editing a JSON file or asking the model
   to call a tool.

### Decision

#### A. Transport / channel boundary — hard invariants

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

#### B. Schema: v2 → v3 bump, fail-loud on shape mismatch

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

#### C. Gate result is channel-internal; pairing is fully channel-owned

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

#### D. Internal approve-by-token helper, no approval MCP tool

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

#### E. Owner-only interactive card approval

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

### Consequences

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

### Alternatives Considered

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

### Since this was recorded (2026-09-01)

Status wording normalized: Accepted; the ordinary human `allow_chats` delivery rows were later refined by the allow-chats trust-semantics record in this same file.


---

## feishu-allow-chats-trust-semantics

## Feishu trusted allow-chats semantics

- **Status:** Accepted
- **Date:** 2026-07-31
- **Affects:** `@excitedjs/feishu-channel`, V3 `access.json`,
  `@excitedjs/dreamux` public/current maintenance guidance
- **Specification:**
  [Feishu allow-chats trust semantics](/.agents/archive/proposals/feishu-allow-chats-trust-semantics.md)

### Context

The production V3 pairing decision kept `group.allow_chats` as a flat manual
list, but ordinary human delivery interpreted it inconsistently. `allowlist`
used it only as an outer shell before applying `dm_policy` and `allow_users`;
`follow-user` ignored it for human delivery even though the same list enabled
passive known-bot observation. Operators wanted listed groups to be the actual
human trust unit without adding another access field or state version.

The public gate already accepts normalized `chat_type` and `is_bot_sender`.
Unknown Feishu sender types could previously be projected as
`is_bot_sender: false`, so changing chat trust also required an exact raw-event
classification boundary without changing that public input.

### Decision

Keep `access.json` at version 3 with its current fields, defaults, loader,
saver, and public state types. Refine only ordinary human group delivery:

- Classify inbound once in the Feishu Channel session. Only `p2p | group` chat
  types proceed. Only `sender_type: user` with a non-empty id is human, and only
  `sender_type: bot | app` with a non-empty id is bot. Other chat types fail as
  `unsupported_chat_type`; other sender shapes fail as `sender_unknown` before
  observation, `/introduce`, pairing, or delivery.
- Keep the public `dreamuxFeishuGate` input unchanged. Its
  `is_bot_sender: false` value is a caller assertion that exact-human
  classification already succeeded, not the negation of a bot helper.
- For human group traffic, apply `group.require_mention` first and
  `group.policy: block` second.
- Because the unchanged V3 reader validates `group.policy` only as a string,
  fail closed as `internal` for any value other than `allowlist` or
  `follow-user` before consulting `allow_chats`.
- For either recognized non-block policy, resolve
  `group.allow_chats.includes(chat_id)` once after those gates.
- Under `allowlist`, drop an unlisted chat and deliver any exact human in a
  listed chat without consulting `dm_policy`, `allow_users`, or pairing.
- Under `follow-user`, deliver any exact human in a listed chat without those
  sender checks; an unlisted chat follows the existing `dm_policy`,
  `allow_users`, and dm-kind pairing path.

The resulting model is:

```text
trusted chat OR sender accepted by the existing dm_policy path
```

Bot/P2P behavior remains unchanged. Passive known-bot observation still needs
an exact bot/app id and a listed group. `/introduce` deliberately stays
sender-scoped: `block` denies; `allowlist` requires listed chat plus
`allow_users`; `follow-user` requires `allow_users` without requiring a listed
chat. Ordinary trusted-chat delivery never grants peer-trust mutation.

### In-Place Compatibility Decision

This is an explicitly approved same-shape authorization change. A V3 file needs
no rebuild, migration, marker, or acknowledgement field. When the new server
starts, every retained non-empty `allow_chats` entry under `allowlist` or
`follow-user` trusts all exact human members in place. Release/public guidance
must tell operators to review those entries before deployment and keep only
groups whose human membership and passive known-bot observation should remain
trusted.

The repository release rule continues to require fail-loud plus `Rebuild:` for
incompatible shape, version, or path changes. An explicitly approved same-shape
semantic exception instead requires a `BREAKING:` note followed immediately by
`Review:`, an explicit no-rebuild statement, and no `Rebuild:` instruction.

### Maintenance Consequences

`access.json` is mixed ownership at the fixed path
`~/.dreamux/state/<dispatcher-id>/access.json`; `DREAMUX_CONFIG_DIR` relocates
only `config.json`. `version` is Channel/schema-owned, policy fields are
operator-owned, `allow_users` is shared authority, and the remaining ledger
fields are Channel-owned.

Manual access editing uses an independent quiesced handoff: stop and confirm the
owner, re-read after stop, apply an exact atomic owner-only patch while
preserving schema/ledger fields, validate current V3, and start. A missing file
after stop begins from the full secure current default and is initialized
atomically; it is not an upgrade action.

Every config/state contract change updates the Dispatcher-only
`dreamux-maintenance` skill's single owning reference and its root route when
needed. The [maintenance progressive-disclosure design](/.agents/archive/proposals/dreamux-maintenance-progressive-disclosure.md)
keeps the root and Feishu access owner current-state-only. Its separate generic
self-upgrade SOP may read this release's concrete transition from the validated
staged changelog and target owner references; it does not duplicate this
decision's schema or release instructions.

### Consequences And Guards

- Gate truth-table tests cover both non-block policies, every `dm_policy`, the
  global mention switch, block, and the untrusted `follow-user` sender path.
- Raw session tests cover unknown classifications, bot observation,
  `/introduce`, pairing, and delivery side effects.
- The gate/introduce table locks the intentional trusted-chat divergence.
- State/version and package-root consumer tests lock V3 and the unchanged gate
  input ABI.
- Public docs, model-facing skill tests, KB checks, and Rush change-file tests
  lock the in-place warning and maintenance boundary.

### Alternatives Considered

- A new state version, access field, migration, marker, or rebuild was rejected
  by the approved compatibility tradeoff.
- A trusted-chat-only mention setting was rejected; the one global
  `group.require_mention` switch remains authoritative.
- Passing raw sender kinds through the public gate was rejected; exact
  classification belongs at the raw Channel session boundary.
- Wiring Codex `turn_timeout_ms` was rejected as unrelated behavior; only its
  stale comments and current guidance are corrected.

---

## feishu-inbound-attachments

## Feishu inbound attachments live in feishu-channel

- **Status:** Accepted
- **Date:** 2026-06-05
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  `@excitedjs/dreamux`, Feishu inbound message format, attachment cache
- **PR / Issue:** [#92](https://github.com/excitedjs/dreamux/issues/92)

### Context

Feishu `image` / `file` inbound messages used to reach Codex as plain text
markers such as `(image)` or `(file: name.ext)`. That preserved delivery, but
it did not tell Codex whether there was a readable local file, where it was
cached, which Feishu resource key could be used to retry, or why an automatic
download failed.

The monorepo already had the package boundary needed for a cleaner split:
`@excitedjs/feishu-transport` is the Lark SDK / JSAPI boundary,
`@excitedjs/feishu-channel` is the channel layer, and `@excitedjs/dreamux` is
the host runtime. Before this decision, `feishu-channel` was only scaffolded
and Dreamux still owned the model-facing Feishu serializer.

### Decision

Move Feishu inbound serialization and attachment handling into
`@excitedjs/feishu-channel`.

- `@excitedjs/feishu-transport` exposes structured resource metadata from
  parsed content, preserves ordered text/code/resource occurrences, and owns
  the narrow Lark message-read, contact-name, and message-resource seams. It
  does not choose cache paths, write files, or emit model-facing XML.
- `@excitedjs/feishu-channel` owns the inner Channel body: `<content>`,
  positional `<attachment>` elements, lookup-only `<refs>`, optional
  `<group_bots>`, and the final `<channel-reminder>`. It also owns attachment
  download, cache-first lookup, filename sanitization, byte/deadline caps,
  owner-only file modes, and honest omission facts.
- Dreamux core stays provider-neutral. It accepts the Channel-owned attrs/body
  and neutral attachment paths, while each runtime owns the outer `<channel>`
  envelope.

### Message Body Contract

The runtime-owned outer `<channel>` contains a Channel-owned structured body.
User-visible content keeps source order, and an attachment appears once at the
position where Feishu placed it:

```xml
<content>
Inspect this archive:
<attachment path="/abs/cache/file" />
</content>
```

When a resource cannot be downloaded, the body must be honest: no `path`, a
fixed `not_downloaded` status, and the resource key. A missing Feishu key is
represented by the empty string rather than an invented value. The Channel
body carries facts only; it does not prescribe a retrieval tool, command,
output path, or other execution policy.

```xml
<attachment status="not_downloaded" key="FILE_KEY" />
```

Those are the two complete model-visible attachment shapes. A downloaded
resource exposes only its escaped local `path`; it deliberately omits the key
once that path is available. A non-downloaded resource exposes only
`status="not_downloaded"` and the escaped `key`. The exported
`FormattedFeishuAttachment` continues to carry `type`, optional `name`/`key`/
`path`, `status`, and optional `reason`; diagnostics retain the detailed
failure reason, and the neutral runtime attachment retains the applicable
`kind`/`name`/`localPath`. Those structured facts are not duplicated into inline
XML.

Repeated occurrences of one `(type, key)` retain repeated positional
`<attachment>` elements but share one download/cache result and one neutral
runtime attachment. Code is rendered as a Channel-owned
`<code><![CDATA[...]]></code>` element with safe `]]>` splitting, so source
operators stay literal without becoming Channel markup.

Merged-forward and reply/quote bodies are not expanded. They appear only as
bounded lookup identities under `<refs>`:

```xml
<refs>
  <merged-forward message_id="om_current" />
  <reply-to message_id="om_parent" message_type="merge_forward" />
</refs>
```

Parser incompleteness is an `incomplete="true"` content attribute. The body
does not emit prose that directs the model to a particular retrieval tool.

### Cache Contract

Dreamux provides the cache root through `dispatcherFeishuAttachmentCacheDir()`,
which lives under the dreamux cache tree `~/.dreamux/cache/<dispatcher-id>/
feishu-attachments/` (issue #182 PR-2 moved it out of durable
`state/<dispatcher-id>/`). The channel package creates a sanitized per-resource
file under that root, never trusts raw filenames as paths, resolves the final
path back under the cache root, writes a temp file first, and renames into place
only after the download completes under the configured limits.

The cache is server-owned, rebuildable artifact data — not durable state. It is
safe to delete; deletion only turns a future duplicate delivery into another
Feishu resource fetch or a fallback block.

### Consequences

- Gate drop / pair / unauthorized paths must not download resources because
  the session invokes message reads, contact lookup, and formatting only after
  `dreamuxFeishuGate()` returns `deliver`.
- Feishu Channel tests own serialization, cache, sanitization, lifecycle
  fencing, and omission details. Transport tests own SDK request shape and
  source-order parsing.
- Future Feishu resource types should first extend the channel contract and
  tests. Transport remains a JSAPI wrapper and should not grow Dreamux- or
  model-specific serialization helpers.
