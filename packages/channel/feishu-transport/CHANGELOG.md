# Change Log - @excitedjs/feishu-transport

This log was last generated on Thu, 23 Jul 2026 18:09:54 GMT and should not be manually modified.

## 0.7.0
Thu, 23 Jul 2026 18:09:54 GMT

### Minor changes

- Preserve ordered Feishu text, code, and positional resource parts as the internal source of truth, project compatible flat text and de-duplicated resources at the transport boundary, add bounded message reads, and expose a thin per-message sender-name lookup. Every accepted unnamed human message may query Feishu again after any nonzero, malformed, failed, or timed-out attempt.

## 0.6.0
Sun, 19 Jul 2026 03:45:02 GMT

### Minor changes

- Expose optional chat-mode lookup and preserve inbound thread_id for topic-aware channel providers.

## 0.5.0
Fri, 03 Jul 2026 04:51:35 GMT

### Minor changes

- Add thin SDK wrappers for sending caller-owned interactive cards and resolving Feishu app owner identity. These wrappers expose raw platform I/O only; access-control decisions and pairing approval remain in the channel layer.

## 0.4.0
Sat, 27 Jun 2026 12:09:24 GMT

### Minor changes

- Remove access-control and persistence public exports. Deleted source files: `src/policy/gate.ts`, `src/policy/pairing.ts`, `src/contract/access-store.ts`; deleted the now-empty `src/policy/` directory. Corresponding barrel re-exports removed from `src/index.ts`: Access, `src/index.ts` contract type exports removed: Access, DmPolicy, GroupPolicy, GroupEntry, PendingEntry, DispatcherAccessStore, DispatcherChatBotsEntry, ChatBotKind, GateResult, DropReason, computeGateDecision, buildGateContext, readDispatcherAccess, writeDispatcherAccess, readChatBotsObserved, appendChatBotsObserved, generatePairingCode, insertPendingPairing, pairingCodeMatches, pruneExpiredPending, findExistingPendingByKey, isGroupAuthorized, dreamuxGate (note: dreamuxGate / computeGateDecision were exported only indirectly via the policy file; the barrel re-exports matching deletion verified zero). All v1/v2 state types removed. Mention family (parse/mentions inbound parsing utilities: Mention, applyMentions, mentionName, isBotMentioned, isBotSenderType) are deliberately retained; parse/mentions inbound parsing still actively uses them.

The transport package boundary is now strictly transport-only: raw Lark JSAPI wrappers, bot start/close, message send/download, reaction, chat listing, parse/render. All access/trust behavior lives in `@excitedjs/feishu-channel` (the gate v3 implementation).

Deleted tests: `tests/gate.test.ts` and `tests/pairing.test.ts` — they exercised logic that moved into the channel package.

Publish hygiene: `prepublishOnly` now runs `clean && build` so stale `dist/` emit (orphan .d.ts from deleted source) never leaks into the published package.

### Patches

- Security: stop the transport from logging the app secret. The Lark SDK reports HTTP failures by handing its logger a structured error whose `config.data` is the outbound request body, and the app/tenant access-token calls POST `{app_id, app_secret}` — so a failed token fetch (e.g. behind a proxy) leaked the live `app_secret` to stderr and to the host's injected channel log. The SDK logger seam (`createTransportDiagnostics`) now runs every SDK arg through a depth- and cycle-bounded redactor that blanks the `data`/`headers`/`auth` of anything axios-config-shaped and any credential-named key (`*secret*`/`*token*`/`authorization`/...), on both the default-stderr and injected-logger paths, before it reaches a sink. Non-secret triage context (status, url, error message, error response) is preserved; plain (non-axios) errors still render their stack unchanged. No config/state/path/format change — no operator action on upgrade.

## 0.3.0
Wed, 10 Jun 2026 07:24:34 GMT

### Minor changes

- Add Feishu group creation and member-invite transport APIs used by Dreamux Team Mode create_group. The APIs fail loudly when the installed Feishu SDK/client does not expose the required chat methods.

## 0.2.3
Fri, 05 Jun 2026 14:06:54 GMT

### Patches

- narrowMetaFromEvent surfaces a diagnostic sender_union_id from the inbound event; it is observability-only and never used for access matching (issue #102)

## 0.2.2
Fri, 05 Jun 2026 05:30:23 GMT

### Patches

- Expose structured inbound resources and a raw message-resource fetch seam for channel-owned attachment handling.

## 0.2.1
Thu, 04 Jun 2026 23:08:48 GMT

### Patches

- Adopt the shared @excitedjs/eslint-config flat config and the synchronous-blocking-IO lint gate (issue #85); no runtime change

## 0.2.0
Thu, 04 Jun 2026 18:47:15 GMT

### Minor changes

- Add an explicit, additive `logger?` option to `FeishuTransportOptions` (a package-owned minimal `TransportLogger` interface) so a host can fold the transport's own diagnostics — Lark SDK logging, WebSocket connection lifecycle, and best-effort doc-comment/metadata/bot-info/socket-close failures — into its per-component log. Instance-level: each transport derives its SDK and connection sinks from the injected logger. With no logger the historical stderr behavior is preserved byte-for-byte (issue #74).

## 0.1.0
Thu, 04 Jun 2026 05:00:52 GMT

### Minor changes

- Export the access-state persistence contract used by host channel gates.

## 0.0.2
Sun, 31 May 2026 07:02:52 GMT

### Patches

- Add core parsing helpers for Feishu bot-member-added events and mention names.
- Thread Feishu replies with outbound targets

## 0.0.1
Sat, 30 May 2026 17:49:32 GMT

### Patches

- init

