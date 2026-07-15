# Change Log - @excitedjs/feishu-channel

This log was last generated on Wed, 15 Jul 2026 02:54:37 GMT and should not be manually modified.

## 2.1.0
Wed, 15 Jul 2026 02:54:37 GMT

### Minor changes

- BREAKING: Stop authoring channel MCP descriptors in the Feishu provider. The package now exposes only the static Feishu tool catalog plus reply/react/list_chat_bots handlers; Dreamux core renders the channel-mcp descriptor, admin socket, caller, team, and leader routing args.

### Patches

- Clear the optimistic Feishu inbound received reaction when core submission throws before delivery, preventing a stale received marker on failed inbound turns.

## 2.0.0
Fri, 03 Jul 2026 04:51:35 GMT

### Breaking changes

- BREAKING: remove the Feishu `access` MCP tool and make Owner-only interactive cards the only pairing approval surface. The channel now sends an interactive approval card for pending pairing requests, rejects non-Owner clicks with a toast-only response, and lets the App Owner approve through the card callback. The callback reuses the internal approve-by-token helper, then returns Feishu's raw-card callback response for the green success state. Existing callers must stop invoking the removed `access` tool; inspect or revoke pending entries by editing access.json directly.

## 1.0.0
Sat, 27 Jun 2026 12:09:24 GMT

### Breaking changes

- BREAKING: Replace the v2 access gate (inline `FeishuChannelSession.onMessage` branches + transport `policy/gate.ts` + `contract/access-store.ts`) with the access-gate-v3 pairing-code mechanism. The persisted dispatcher access state now uses `DispatcherAccessStateV3` (`version: 3`) and the loader fails loud when an older version is detected — no silent migration.

Rebuild: Your existing v2 dispatcher access file (usually `<dispatcher-state-root>/feishu/dispatcher_access.json`) is **not** deleted automatically — the v3 loader crashes loudly on v2. Preserve your existing access list before upgrading, then create a fresh state file. From your current v2 file, copy the following fields verbatim into a new file named `access.json` in the same directory: `allow_users`, `group.allow_chats`, `group.require_mention`, then add `"version": 3`, `"dm_policy": "allowlist"`, `"pending": {}`, `"known_banned_senders": []`. A sibling `chat-bots.json` will be created on first session start from the in-memory chat-bots ledger; the former v2 inline chat_bots entries are NOT ported automatically (it is OK to lose them; the channel rebuilds the ledger live from the first few bot encounters — no data loss for pairing or allowlist behavior).

Highlights:
- 22-line table-driven `dreamuxFeishuGate()` pure function covering (DM × 5 policies × pairing-resend) + (group × 5 policies × mention gate × pairing-resend × trusted-bot + bot-self) branches.
- `require_mention: true` default (product decision).
- Follow-user strangers in a group who @-mention the bot now receive a pairing code (product decision — no cooldown / default-drop switch).
- Per-kind pending-pairing quota: `MAX_PENDING_PER_KIND = 10`, independent for DM vs group, with expired entries excluded before the count.
- TTL double guard: `pruneExpiredPending` at gate entry + inline `expires_at > now` check inside `findExistingPendingByKey`.
- Pairing-code prompt rendered with the bot display name and a 6-hex code; resends use the same code.
- LOCK-SEND-LOCK pattern on the pairing path: gate + first save under `AsyncMutex`, then `sendText` outside the lock, then re-enter the lock to read the latest state and only persist the fresh pending entry when the send succeeded and no earlier concurrent entry already covers the same (kind, key) slot.
- `approvePairingByCode` is idempotent on membership (duplicate approve → reported as `duplicate: true`; pending key is always removed).
- MCP `access` tool now has a real handler; `reply` / `react` / `list_chat_bots` / `access` centralized in `tools/registry.ts`.
- Atomic write for the access-state file (tmpfile + rename, mode `0o600`; directory created at mode `0o700`).
- `TRUST_DOMAIN_WARNING` exported from the barrel index for operator-facing UIs.
- Transport hard boundary: `@excitedjs/feishu-transport` no longer ships any access-control or persistence logic.

### Minor changes

- The Feishu channel session now exposes provider-owned target resolution: `FeishuChannelSession.resolveTarget(meta)` maps a `{ chat_id, chat_type }` selector to a neutral `ChannelTarget` (group chats are bindable, P2P chats are not; `target_key` is the chat id). This is the provider half of Dreamux core's binding store v2 + `(channel_id, target_key)` routing (issue #209). Additive — existing session behavior is unchanged; the neutral `ChannelSession` wrapper now delegates to this method instead of duplicating the mapping.
- Promote @excitedjs/feishu-channel from scaffold to the publishable built-in Feishu ChannelProvider package (alias builtin:feishu, issue #209 slice 5). It now owns the live Feishu channel session, access/trust behavior, inbound normalization, attachment handling, target resolution, MCP descriptor, and provider tool backing (`reply` / `react` / `list_chat_bots`), implementing the neutral @excitedjs/dreamux-types ChannelProvider/ChannelSession contract on top of @excitedjs/feishu-transport. Depends on @excitedjs/dreamux-types + @excitedjs/feishu-transport only — never on @excitedjs/dreamux core. The host supplies provider-validated config plus neutral state/cache roots through the session context; core keeps only routing, binding state, authorization, and the generic admin conduit.
- The Feishu channel provider's `readConfig` is now the config-validation authority for `builtin:feishu` (issue #209 multi-channel config): Dreamux core registers this provider and calls `readConfig` at config load instead of validating Feishu fields itself. `readConfig` now fails loud on an empty/whitespace `app_id` or `app_secret` (the bot secret is config-sourced, so this preserves the host's previous config-load fail-loud) and on unknown config keys. Parsing of a valid `{ app_id, app_secret }` into `{ appId, appSecret }` is unchanged.
- The built-in Feishu Channel provider now owns onboarding prompts for bot app id and app secret and exposes a provider diagnostic capability. Dreamux core records the returned raw config and drives the channel through the shared provider diagnostic contract instead of hardcoding Feishu fields in onboard or doctor.

### Patches

- The Feishu provider's `mcpServerDescriptor` now targets Dreamux core's generic channel-tool shim: descriptor args change from `feishu-mcp ...` to `channel-mcp --provider builtin:feishu --channel-id <id> --dispatcher <id> ...`. The MCP server name (`feishu`) and provider tool surface (`reply` / `react` / `list_chat_bots`) are unchanged. The shim serves the provider's static `tools/list` metadata and forwards `tools/call` to the neutral `channel.invoke_tool` admin method; binding remains on the Team MCP and is not a channel-tool responsibility. Rebuild: none required — descriptors are regenerated at every dispatcher boot, never persisted.
- Type the package's default factory export against the published `ChannelProviderFactory` contract and use the kind-narrowed `ChannelProviderDescriptor` for the builtin descriptor (issue #209 types-API audit). No runtime behavior change.
- Adopt the shared @excitedjs/eslint-config flat config and the synchronous-blocking-IO lint gate (issue #85); no runtime change

