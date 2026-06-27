# Feishu pairing-code access control (v3 schema + `access` MCP tool)

- **Status:** Production ready
- **Date:** 2026-06-27
- **Affects:** `@excitedjs/feishu-transport` scope (downward),
  `@excitedjs/feishu-channel` package (access schema v3, gate, `access` MCP tool,
  pairing prompt send), `~/.dreamux/state/<dispatcher-id>/access.json`
  file format, dispatcher operator workflow,
  `/.agents/domains/feishu-pairing-access.md`
- **PR / Issue:** TBD. Supersede the "Invite-code pairing" deferral in
  [/.agents/domains/feishu-introduce.md](../domains/feishu-introduce.md).

## Context

Dreamux v2 Feishu access (`DispatcherAccessState.version === 2`, implemented in
`/packages/channel/feishu-channel/src/feishu-gate.ts`) is strictly
allowlist-based: any sender not on `allow_users` and any group chat not on
`group.allow_chats` is silently dropped with a diagnostic log only. There is
no out-of-band mechanism for a human operator to discover a stranger's
`open_id` or a new group's `chat_id` — the operator must edit
`access.json` by hand after extracting ids through a separate workflow.

Claudemux (`~/Development/claudemux`) ships a pairing-code flow in its
`@excitedjs/feishu-transport` access gate: unknown DM senders receive a
six-hex-digit code via reply, the operator manually promotes the matching
`pending` entry. The transport-level gate has the right primitives, but
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
2. MCP surface is a provider-owned channel capability. Team routing and
   binding stay core-owned; allowlist manipulation is Feishu-specific and
   must not migrate to generic core MCP.
3. The operator (a human running a Team) will approve codes by sending a
   code string to the dispatcher or team leader in Feishu, not by editing
   a JSON file. The approval UX must be one model tool call, not a
   multi-step skill procedure.

## Decision

### A. Transport / channel boundary — hard invariants

`@excitedjs/feishu-transport` is a **stateless, side-effect-free SDK wrapper**. It
owns Feishu platform I/O only. It contains no access control, no gate, no
pairing, and no persistence. Hard invariants, enforced by code review + the
`no-sync-io` lint gate:

- **No file reads or writes.** The transport layer takes every input as a
  function argument; it never touches `fs`, never discovers paths, and never
  mutates on-disk state. The `generatePairingCode` primitive is an
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
  `react(chat_id, message_id, emoji)`,
  `editMessage(chat_id, message_id, text)`,
  `downloadImage(message_id, image_key, target_stream)`, and the like. Each
  returns a plain promise result; the transport layer never decides **when**
  or **whether** to call these endpoints.

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
gate logic, access state load/save, pairing code generation, prompt
rendering and send, pending bookkeeping, `/introduce` authorization, and
the `access` MCP tool and its mutations. It imports the SDK-adapter surface
only from `@excitedjs/feishu-transport`.

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
  replies: number;      // resend count, capped at MAX_PAIRING_REPLIES
}
```

Semantics of the new fields:

- `dm_policy === 'all'` — every non-bot DM is delivered.
- `dm_policy === 'allowlist'` — only `allow_users` DM senders are
  delivered; unknowns are dropped.
- `dm_policy === 'pairing'` (**new installation default**) — unknown DM
  senders receive a pairing-code reply and are recorded in `pending`.
- `dm_policy === 'disabled'` — DMs are never delivered.
- `pending` — keyed by the 6-hex-digit pairing code. Values are the same
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
  | { action: 'pair'; kind: 'dm' | 'group'; code: string; is_resend: boolean; ttl_left_ms: number };

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

| Inbound | Policy | Condition | Action |
|---|---|---|---|
| DM | `disabled` | — | drop |
| DM | `all` | not a bot sender | deliver |
| DM | `allowlist` | sender ∈ `allow_users` | deliver |
| DM | `allowlist` | otherwise | drop |
| DM | `pairing` | sender ∈ `allow_users` | deliver |
| DM | `pairing` | existing `kind: 'dm'` pending for sender, `replies < MAX` | pair (resend same code) |
| DM | `pairing` | otherwise, `|pending| < MAX_PENDING` | pair (new code) |
| DM | `pairing` | otherwise | drop (slot cap) |
| Group | `block` | — | drop |
| Group | `follow-user` | bot not @-mentioned | drop |
| Group | `follow-user` | sender ∈ `allow_users` | deliver |
| Group | `follow-user` | otherwise + bot @-mentioned | pair (new or resend) |
| Group | `allowlist` | chat ∈ `allow_chats` + mention check passes | deliver |
| Group | `allowlist` | chat ∉ `allow_chats` + bot @-mentioned | pair (new or resend) |
| Group bot sender | any | not in `trustedBotIds` for chat | drop |
| Group bot sender | any | trusted + bot not @-mentioned | drop |
| Group bot sender | any | trusted + @-mentioned | deliver |

Hard constants (aligned with Claudemux production values):

- `MAX_PENDING_PER_KIND = 10` — pending-entry cap applied **per kind,
  independently** (DM saturation does not starve the group pool and
  vice versa). Within a kind, a given `sender_id` (DM) or `chat_id`
  (group) counts as a single slot regardless of how often it re-enters
  the resend path (spammer cap = 1 slot / 1h TTL). Enforcement walks
  the flat `pending` Record and groups values by kind, so no new
  top-level schema grouping is introduced.
- `MAX_PAIRING_REPLIES = 2` — cap is enforced with `replies >= MAX`
  (inclusive fencepost). A fresh pending entry starts at `replies: 1`
  after the first prompt; on the second inbound the same code is
  re-sent and `replies` bumps to `2`; the third inbound (or later)
  within the same TTL window drops silently. So the bot sends the
  prompt **at most MAX_PAIRING_REPLIES times total** (initial + 1
  resend) per code-sender pair before a fresh pair/slot is needed.
- `PAIRING_TTL_MS = 3_600_000` (1 hour). `pruneExpiredPending()` is
  invoked at the top of every `dreamuxFeishuGate` call.

Pairing codes are generated inline inside the gate at
`/packages/channel/feishu-channel/src/feishu-gate.ts` (no separate
`pairing.ts` file — the generator is a 1-line `randomBytes(3).toString('hex')`
placed next to the uniqueness loop that consumes it):

```ts
function generatePairingCode(): string {
  return randomBytes(ACCESS_CODE_HEX_LEN).toString('hex');  // 6 lowercase hex chars
}
```

Group pairing bookkeeping differs from Claudemux's to match Dreamux's
flat group allowlist: approval promotes the `chat_id` onto
`group.allow_chats`; there is no per-chat sub-document.

### D. A single `access` MCP tool — approve-by-code only

A single new Feishu channel MCP tool is added, alongside `reply`,
`react`, `list_chat_bots`. Tool definitions live at
`/packages/channel/feishu-channel/src/tools/registry.ts`; the
`feishu-mcp-tools.ts` file at the package root is a backward-compatible
re-export shim (the `FeishuChannelSession` reads tools from the
registry directly):

| Name | Schema | Purpose |
|---|---|---|
| `access` | `{ code: string }` | Approve a pending pairing entry by code. |

The tool accepts exactly one required field, `code`, validated against
pattern `^[0-9a-fA-F]{6}$` (lowercased internally by the handler, so
model-typed uppercase is accepted). The handler returns a typed
envelope that `FeishuChannelSession.handleMcpTool` then flattens to
the legacy wire shape (`{ status, message, ...details }` — see below)
so top-level consumers can read `kind` / `duplicate` / `ttl_left_ms`
off the result without a refactor in P1:

```json
// handler return (typed envelope)
{
  "status": "ok" | "not_found" | "error",
  "message": "human-readable summary, in Chinese for model display",
  "details": { ... }
}
// what handleMcpTool actually returns (flattened wire shape)
{
  "status": "ok" | "not_found" | "error",
  "message": "...",
  "...detailsSpread..."
}
```

Handler semantics for the single operation:

1. **Per-entry expiry guard (not a global prune).** Unlike the gate,
   the access-tool handler does not sweep `pruneExpiredPending` over
   the full pending Record. Instead it runs an explicit
   `expires_at <= now` check on the single matching entry after
   lookup — this catches stale entries the gate hasn't reached yet
   without paying the O(N) sweep cost inside the mutex.
2. Look up `pending[code]`.
   - `kind: 'dm'` entry → de-dupe + push `entry.sender_id` onto
     `allow_users`; delete the pending entry; persist; return
     `{status:'ok', details: {kind:'dm', added: sender_id, duplicate: bool, ttl_left_ms}}`.
   - `kind: 'group'` entry → de-dupe + push `entry.chat_id` onto
     `group.allow_chats`; delete the pending entry; persist; return
     `{status:'ok', details: {kind:'group', added: chat_id, duplicate: bool}}`.
   - Not found (or expired before prune caught it) →
     `{status:'not_found', message: '配对码不存在或已过期'}`.
   - `allow_users` / `allow_chats` already contained the id → still
     returns `ok`, `details.duplicate = true`.

`list_pending` and `revoke` are **intentionally out of scope**. The
operator inspects `access.json` by hand when needed. Revocation is
performed by editing `access.json` directly (documented in the
changelog rebuild section). Future increments may extend `access` with
optional `list` / `revoke` selectors, but the first increment ships a
narrow, one-operation tool the model can call by rote.

No CLI surface is added. No admin RPC surface is added. The operator
uses the model tool exclusively through normal Feishu ↔ agent
interaction. The dispatcher agent (and any team leader with Feishu
channel egress) can invoke `access`. Core does not gate `access`
differently from `reply` — Team routing authorization of the
generic `channel-mcp` path covers it.

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
  copy-pasteable: "replace `import { generatePairingCode, dreamuxGate,
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
- **Pairing prompt copy:** DM and group copy are in Chinese (matching
  Dreamux's user-facing reply language from the CLAUDE.md rule).
  Messages reference a **generic "bot 管理员"** — they never name a
  specific operator by Feishu id or real name, so the same prompt
  text works for any deployment without branding drift. Messages
  must **not include any other Feishu identifiers in plain text**
  beyond the pairing code (no raw `open_id`, no `chat_id`) — the
  operator works via code strings only.
- **Noisy diagnostics:** Pending entries are observable by reading
  `access.json` by hand (operator-only) and via the structured
  `feishu inbound dropped` log entry's `context` field when a drop is
  pending-related (`code`, `kind`, `ttl_left_ms`). No `list_pending`
  MCP selector is exposed in the first increment.
- **Pairing race:** If a stranger spams the bot from multiple DMs,
  `MAX_PENDING` caps the blast radius. If two strangers happen to
  share a code collision (probability ~16M), the second `gate()` call
  will generate a new code after re-checking uniqueness — add an
  internal loop (`while (pending[code]) code = generatePairingCode()`)
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
- **Three MCP tools: `approve_pairing` / `list_pending` /
  `revoke`.** Rejected: operator UX requires one name the model can
  call by rote; multi-tool names put memorization burden on the
  system prompt and increase the chance the model reaches for the
  wrong verb.
- **Union-schema `access` with `code` / `list` / `revoke+id`
  selectors.** Rejected for the first increment. `list` and `revoke`
  are operator-visible only and can be performed by editing
  `access.json` by hand. Starting with a single-argument,
  single-semantic tool keeps the MCP schema small and audit-able;
  future increments may add optional selectors without breaking the
  existing `code` argument.
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
