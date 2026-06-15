# GitHub channel (future) + the core feishu-name de-leak

> Working scratch under `.agents/wip/`. Delete before merge; promote the settled
> parts into a `.agents/decisions/` record at the end.

## GitHub channel — settled design intent (maintainer, 2026-06-15)

GitHub is a FUTURE channel form (not in code today). Decision: **GitHub is a
single-direction SUBSCRIPTION channel**, NOT a bidirectional conversational one.

- It goes through the **`SubscriptionChannelPlugin`** seam, not `ChannelProvider`.
  A GitHub "event" is `{ id, text, sourceUrl?, metadata? }` — **no `chat_id`, no
  `ChannelTarget`, no binding**. It pushes subscribed events (PR/issue updates) to
  dispatcher/team agents and contributes MCP tools; it does not get bound to a
  TeamLeader or egress replies through the channel-binding machinery.
- This RESOLVES the "GitHub has no chat_id" concern WITHOUT touching the
  bidirectional contract: `chat_id`/`chat_type` stay NEUTRAL fields for
  conversational channels (Feishu/Slack/Telegram, per issue #209), and GitHub
  simply never uses them. The two-interface design (issue #209 / `channel/plugin.ts`)
  is correct; no re-discussion needed. See [[chat-id-neutral-by-design]].

### Current state of `SubscriptionChannelPlugin` (code fact)

- Defined interface-only in `packages/dreamux/src/channel/plugin.ts`
  (`SubscriptionChannelMcpContext`, `SubscriptionChannelEvent`,
  `SubscriptionChannelPlugin`). Docstring: "intentionally interface-only".
- ZERO runtime importers (no barrel export, no registry/catalog/loader wiring);
  only `tests/channel-provider.test.ts` constructs a dummy for a type smoke test.
  It is a DELIBERATE reservation, not accidental dead code — keep it.

### Two gaps to close when GitHub is actually built (NOT now)

1. **Move `SubscriptionChannelPlugin` to `@excitedjs/dreamux-types`.** It is a
   plugin-authoring contract; per the #209 boundary it must live in dreamux-types
   so an external/builtin GitHub package can implement it without importing core.
   Today it sits in core (`channel/plugin.ts`).
2. **Add a subscription kind to the registry/catalog/loader.** They currently only
   handle `kind: 'channel'` → `ChannelProvider`. A subscription channel needs its
   own registration + load + lifecycle (start/publish/stop) path.

## The core feishu-name de-leak (this pass) — architecture-coherent, NOT renames

Audit of `feishu` (case-insensitive) in `packages/dreamux/src`, bucketed:

### Bucket A — legit, keep
- `registry/builtins.ts` — `feishu: '@excitedjs/feishu-channel'` alias map +
  `{ id:'feishu', kind:'channel' }` descriptor. The ONE place core resolves the
  `builtin:feishu` alias to a package name. Keep.
- `channel/plugin.ts`, `channel/catalog.ts`, `channel/external-channel-provider.ts`
  docstrings using Feishu as an illustrative example. Keep (illustrative).

### Bucket B — genuine leaks, fix by giving the concept its correct owner
1. **Channel log path** (`platform/paths.ts` `feishuChannelLogDir`/
   `feishuChannelLogPath`; callers `cli/server.ts`, `server.ts` comment). It is the
   CHANNEL-layer per-dispatcher log, provider-agnostic — core must not name a
   provider. → rename to neutral `channelLogDir`/`channelLogPath`, dir
   `logs/feishu-channel/` → `logs/channel/`. Rush change (rebuildable log path
   moves). This is a layout-ownership fix: the dir is "the channel log", not "the
   feishu log".
2. **Attachment cache** (`platform/paths.ts` `dispatcherFeishuAttachmentCacheDir`
   → `feishu-attachments`; caller `dispatcher/service.ts` passes it as the
   channel session `cache_root`). The channel OWNS its cache layout
   (feishu-channel/CLAUDE.md); core only provides a neutral cache ROOT. → core
   exposes neutral `dispatcherChannelCacheDir(id)` and passes THAT as `cache_root`;
   the feishu-channel package appends its own `feishu-attachments` (or
   `attachments`) subdir. Verify how the package consumes `cache_root` first.
3. **Secret redaction** (`platform/logger.ts` REDACT paths `feishu.app_secret` /
   `*.feishu.app_secret`; `config/config.ts` `redactFeishuSecrets` for
   `dreamux config show`). Core must not name a provider's config field. → redact
   GENERICALLY by policy (any key matching `*secret*`/`*app_secret`/`*token*`/
   `password`/`authorization`/`cookie`/`credential`), provider-agnostic + more
   robust (covers future providers). Mirrors the feishu-transport SDK-log
   sanitizer. Rename `redactFeishuSecrets` → `redactChannelSecrets`/generic.
4. **`platform/logger.ts` `TransportLogger` import from `@excitedjs/feishu-transport`**
   — VERIFY whether core still adapts a logger to feishu-transport post-Q1. If the
   channel session now takes the neutral `DreamuxLogger` and the package adapts,
   this import is dead → remove. If still used, assess. (feishu-transport is a
   shared transport util, NOT a provider package, so the eslint guardrail does not
   ban it — but the NAME is a smell.)

### Bucket C — shipped model-facing prose (the model reads these), genericize
5. **`dispatcher/base-prompt.ts`** — "# Feishu Protocol", `<channel source="feishu">`,
   "Feishu MCP reply tool", "operator or Feishu requests". The dispatcher is
   multi-channel and the reply path is the neutral Q1 conduit → genericize to a
   "# Channel Protocol", `<channel source="…">` with NEUTRAL attributes
   (chat_id/chat_type/message_id/sender_id are neutral per #209), "the channel
   reply tool". Keep the secret-hygiene line (it lists feishu ids as examples of
   what not to leak — fine, illustrative). NOTE: base-prompt is the maintainer's
   prose track; genericize the feishu NAMING only, do not restructure tm lines.
6. **`mcp/team-mcp.ts`** bind_channel/transfer_back descriptions "for Feishu,
   { chat_id }". chat_id is the NEUTRAL selector field → drop the "for Feishu"
   qualifier; describe the selector neutrally (`meta` carries the channel's target
   selector, e.g. `{ chat_id }` for a chat channel).

### Bucket D — comments naming Feishu as the example selector
`admin/methods.ts:337`, `channel-binding/store.ts`, `service.ts:419`,
`team/types.ts`, `team/service.ts` — comments explaining the opaque `meta` with
"(Feishu: { chat_id })". Illustrative; tidy to "(e.g. a chat channel: { chat_id })"
where cheap, but these are not code dependencies.

## STATUS: DONE + GREEN (2026-06-15)

Applied (architecture-coherent, not renames). build + lint + test green (2
consecutive clean test runs; one earlier "Operations failed" was a flake in the
async fake-session/turn-manager tests). Two were real BUGS, not cosmetics:

- **paths**: `feishuChannelLogDir/Path` → `channelLogDir/Path`
  (`logs/feishu-channel/` → `logs/channel/`, rush change written). Attachment
  cache: core passes the neutral `dispatcherCacheDir`; the feishu-channel package
  appends its own `feishu-attachments` subdir (effective path unchanged). Deleted
  `dispatcherFeishuAttachmentCacheDir`.
- **logger**: deleted the production-dead `pinoToTransportLogger` adapter + the
  `@excitedjs/feishu-transport` type import, and REMOVED core's direct
  `@excitedjs/feishu-transport` dependency (package.json + rush update). Redaction
  is now a generic secret policy (dropped the `feishu.app_secret` paths; the
  generic `*.app_secret`/`*.secret` cover it). Migrated the logger test.
- **eslint guardrail** extended to ban `@excitedjs/feishu-transport` from core
  src (alongside the 3 provider packages).
- **config**: `redactFeishuSecrets` → `redactConfigSecrets` (behavior was already
  generic — name lied).
- **REAL BUG #1 — runnable-channel gate**: `assertRunnableChannelShape` hardcoded
  `provider !== BUILTIN_FEISHU_PROVIDER_REF` → REJECTED any non-feishu channel
  even if loaded. Now neutral: a channel is runnable iff its provider resolves in
  the channel catalog. Migrated its test (now asserts a non-feishu npm channel IS
  runnable when loaded).
- **REAL BUG #2 — bindTeamChannel**: hardcoded `provider: 'builtin:feishu'` when
  recording a Team channel binding → a non-feishu binding would be mislabeled.
  Now reads the bound channel's actual configured provider via a new
  `channelProviderRef(dispatcherId, channelId)` helper.
- **types**: `ChannelProvider = 'builtin:feishu'` (binding store) →
  `ChannelProviderRef = string`; `TeamChannelBindingSummary.provider` and
  `TeamBindChannelInput.provider` `'builtin:feishu'` literals → `string`.
- **prose**: dispatcher base-prompt ("# Feishu Protocol", `source="feishu"`,
  "Feishu MCP reply tool", "operator or Feishu requests", …) and team-mcp
  bind/transfer tool descriptions → channel-generic (the `<channel source=…>`
  value carries the concrete provider; `chat_id` is the neutral selector).
  Migrated the smoke base-instructions assertion.
- **comments** swept across server/config/admin/dispatcher-service/team/store.

Final grep: the genuine-leak patterns (feishuMcp*, feishu paths, hardcoded
`provider: 'builtin:feishu'`, pinoToTransportLogger, redactFeishu, feishu.app_secret,
assertFeishuScope() calls) are ZERO. The only non-comment `feishu` in core is the
alias map `registry/builtins.ts: feishu: '@excitedjs/feishu-channel'` (Bucket A —
THE legit `builtin:feishu`→package resolution). Remaining hits are `builtin:feishu`
ref strings + accurate docs + deferred-onboard's ref const.

### Acceptance
- `grep -i feishu packages/dreamux/src` returns ONLY Bucket-A legit hits (the
  alias map/descriptor + a couple of illustrative docstrings).
- build + lint + test green; rush change for the log-path move.
- Architecture: every removed feishu name is replaced by the concept's correct
  owner (channel-layer neutral path / provider-owned cache subdir / generic
  redaction policy / multi-channel-generic prompt), NOT a blind string rename.
