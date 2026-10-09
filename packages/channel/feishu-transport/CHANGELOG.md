# Change Log - @excitedjs/feishu-transport

This log was last generated on Fri, 09 Oct 2026 03:05:18 GMT and should not be manually modified.

## 0.11.0
Fri, 09 Oct 2026 03:05:18 GMT

### Minor changes

- Replies stay interactive cards, now one `markdown` element per card carrying the authored Markdown: the renderer that lifted a leading heading into the card title, turned a rule into an `hr`, and a GFM table into a native table element is removed, and an authored `<at user_id="...">Name</at>` mention goes into the card as written, replacing the old `<@ou_...>` shorthand and its rewrite. A body whose serialized `content` would exceed the 28 KiB budget is split into ordered cards along block, fence, table-row, line, and grapheme seams, each piece measured at its JSON-escaped length. Message create and reply now share one send primitive, and a platform refusal is rethrown as one description naming the operation, HTTP status, Feishu code, reason, and `log_id`, with the original error as its cause; a resolved nonzero business code is a failed send rather than an empty receipt. Removed `editText` along with `renderMarkdownToCards`, `cardToContent`, `cardContentBytes`, `splitMarkdownByBytes`, `RenderedCard`, `textMessageContent`, `applyMentions`, `mentionName`, `extractPostText`, and the card element/column/cell constants; `FEISHU_CARD_CONTENT_SAFE_BYTES` is gone: one content budget covers rendered and raw cards alike, and it belongs to the package rather than to its callers, so it is not exported. `OutboundTarget` drops `mentionUserIds` and `conversationKey`. Raw `sendCard` / `editCard` and native chain-of-thought I/O are unchanged.
- A document comment now answers where it is anchored instead of a single quote string. `FeishuDocCommentText.quote` is replaced by `anchor`, which is either `{ kind: 'whole_document' }` or `{ kind: 'content', anchorId, preview, deleted }`: Feishu's own `is_whole` decides which, `anchorId` is the id Feishu gives the anchored content (for a docx, its block id), `preview` is the text Feishu shortens from it, and `deleted` is what Feishu says about the content still existing. The read asks for `need_relation` so that last fact is answered, in the same call and the same response as before. The old `quote` field was described as the document text the comment is anchored to and is not: Feishu derives it and cuts it at a length of its own, without saying that it cut anything or how long the original was. Reading one comment moves out of `transport/feishu.ts` into its own `transport/doc-comment.ts`, which owns the comment types, the segment normalization, and the anchor; `FeishuCommentAnchor` joins the package's exported types and every other export keeps its name and path.
- The transport's document-comment surface is replaced. `commentFromBatchQuery` and the `FeishuDocComment` / `FeishuDocCommentReply` types are removed, and `fetchDocComment` is now `fetchDocCommentText`, which reads the one comment an event names and answers what the commenter wrote as ordered segments — a mention stays a mention, because the element a model reads it as is an agent-facing body format this package does not assemble — beside what Feishu says about where that comment is anchored. `fetchDocMeta` answers a discriminated result instead of a row or `null`, and the exported `FeishuDocMeta` type is removed with it: a Feishu metadata read on a document the app cannot see succeeds and reports the token in `failed_list`, so one `null` could not tell an invisible document from a request error or an unsupported type, and a caller refusing on it would accuse the wrong thing. The only question a caller asks of that read is whether this bot can see the document, so the result answers that and carries nothing else — the title and URL the old row held have no reader, and the request no longer asks Feishu for the URL. `resolveWikiNode` is added, answering the document a wiki node holds, because every comment API and the comment event itself name the object inside the node rather than the node.
- Add `readThreadRoot(threadId)` to `FeishuTransport`: it asks Feishu for a topic's earliest message and returns the message the topic's replies hang under, so a caller that holds only a topic id can find where to reply. Like the other reads it is optional on the interface.
- Inbound parsing now returns one text body per message instead of ordered parts. The body is written in Feishu's own vocabulary: a mention stands as the `@_user_N` placeholder its `mentions` record names, whichever form the sender used (a text placeholder, a structured `at` node, or an `<at>` tag inside native post or card Markdown), and an image or file stands as its resource key, with the resources listed beside the text. Cards are read from the event alone as their `content`/`text` strings and their image and file components; layout, controls, and link targets are no longer reconstructed. `readMessage` takes only a message id; the `user_card_content` read mode is gone. Removed `mergeInteractiveInbound`, `toChannelInbound`, `ChannelInbound`, `InboundContentPart`, and `FeishuMessageReadMode`.
- Code organization refactor stage 8b, item 1: the inbound event-envelope decode (previously feishu-channel's own FeishuInboundEvent/parseInbound-plus-narrowMetaFromEvent assembly in bot.ts) and the card-action-event decode (previously feishu-channel's own FeishuCardActionEvent shape) move down into this package as parseFeishuInboundEvent/FeishuInboundEvent (parse/message-event.ts) and normalizeCardActionEvent/normalizeCardActionAck/FeishuCardActionEvent (parse/card-action.ts) - new public exports; feishu-channel now re-exports the same type names unchanged. narrowMetaFromEvent and the FeishuMessageReader type are no longer exported from the package root (both are still used internally); no production code in this repo imported either by name. The now-empty contract/ directory is deleted - Mention and OutboundTarget keep the same name and shape, re-exported from parse/mentions.ts and transport/outbound-message.ts respectively. Stage 8b, item 4: FeishuSendResult now reports `messages: readonly FeishuSentMessage[]` (each entry's messageId/chatId/threadId, the landing place a send actually reported) instead of `messageIds: string[]`, since callers need the chat/thread a message landed in, not only its id - a new public FeishuSentMessage export. FeishuSendOptions drops `onMessageCreated` (its one caller now reads the same landing off the returned FeishuSendResult instead of a synchronous per-part callback); `send`/`sendCard` accept the full FeishuSendOptions rather than a `Pick` of one field each. Not BREAKING.
- The Lark SDK's own client/dispatcher/WebSocket logging is no longer forwarded anywhere (`[feishu-sdk]` stderr lines, or the `source: feishu-sdk` structured line on an injected logger) — the three SDK clients now get a shared no-op logger instead of a redacted-forwarding one. WebSocket connection-lifecycle lines and best-effort-failure diagnostics are unchanged.
- Removed the unused group-creation/member-invite transport API (`FeishuTransport.createGroup`/`.inviteMembers` and their `FeishuCreateGroupInput`/`FeishuCreateGroupResult`/`FeishuInviteMembersInput`/`FeishuInviteMembersResult` types), the dead `FEISHU_TRANSPORT_PACKAGE` marker constant, and the `webSocketRegistration` test/embedding seam on `FeishuTransportOptions` (and its `FeishuWebSocketRegistration` type) — no production caller in this repo used any of them.
- Code organization refactor stage 2b, item 2: enable exactOptionalPropertyTypes. FeishuTransportOptions.logger, FeishuSendOptions.onMessageCreated, and InboundMessage.mentions now type as accepting an explicit undefined, not only omission. Non-breaking widening; no runtime change.

## 0.10.0
Thu, 10 Sep 2026 04:59:50 GMT

### Minor changes

- Feishu transports can resolve a chat's current name through the chat lookup API for Channel-rendered binding displays.
- Message reads report the chat and topic a message is in, alongside its content.

## 0.9.0
Fri, 04 Sep 2026 10:24:24 GMT

### Minor changes

- BREAKING: Review: The removeReaction transport surface is removed. Feishu COT message operations are added and require @larksuiteoapi/node-sdk ^1.73.0; text sends expose a fail-open onMessageCreated observer with message ID and ordinal; addReaction remains available. No rebuild is needed.
- Add `editCard(messageId, card)`, which repaints an already-sent card in place. It generalizes the patch call `editText` already made, so a card can be closed out without a click to answer it.

### Patches

- A bot open_id lookup that fails or returns an empty result at startup is no longer permanent: it is not cached as an answer, and the next inbound chat message retries the same bounded lookup before that message is handled, so a successful retry applies to that message and every later one instead of requiring a channel restart. Concurrent messages share one in-flight lookup, a failed retry leaves the identity unresolved for a later message to retry, and a message that arrives while it is still unresolved is delivered unchanged — groups that require an @-mention keep dropping messages until a lookup succeeds. This is process-local transport state only: no configuration, persisted state, path shape, or public API changed, and no rebuild is required.

## 0.8.0
Sun, 26 Jul 2026 02:44:44 GMT

### Minor changes

- Add caller-owned AbortSignal cancellation for interactive card sends.

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

