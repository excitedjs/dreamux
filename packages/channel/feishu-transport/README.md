# @excitedjs/feishu-transport

Shared **Feishu platform-I/O core** for the dreamux + claudemux channel layers.
The single place that imports the Feishu SDK.

## Scope

- **transport** — connect / receive / send / `addReaction` / `removeReaction` /
  `editText` / `getChatMode` / `fetchDocComment` / `fetchDocMeta` / bot open_id
  resolution / auth via the `@larksuiteoapi/node-sdk` SDK.
- **render** — markdown → Feishu v2 card (including inline `<@open_id>` parsing
  for @-mentions embedded in message text).
- **parse** — Feishu message content → forwardable text, including:
  - inbound text / post / interactive / image / file events
  - `doc.comment` reply events → normalized comment shape
  - bot member-added events → normalized added-event shape
  - `Mention` parsing and mention-placeholder replacement in raw message text

## WebSocket lifecycle

The package exposes one entry point: `createFeishuTransport(credentials, opts)`.
That transport owns the Feishu SDK client and its WebSocket inbound connection.
Callers supply route handlers (`onMessage`, `onBotMemberAdded`, `onComment`, …)
on `transport.start(routes)`; inbound events are parsed on arrival and projected
into the `parse/`-normalized shapes before being forwarded.

Outbound and lookup calls (`transport.send`, `transport.addReaction`,
`transport.removeReaction`, `transport.getChatMode`, `transport.fetchDocMeta`,
`transport.fetchDocComment`, `transport.downloadMessageResource`) are thin
wrappers around the corresponding Lark SDK endpoints. They accept platform-native
parameters (Feishu `chat_id`, `message_id`, `file_key`, …) and return
platform-native results with the minimum of re-shaping required to make
success/error handling uniform.

## Parse / render helpers

Two pure utility boundaries sit above the SDK layer, with no host dependency:

- **`parse/`** — decode Feishu JSON into forwardable strings and metadata.
  Use `parseInbound` for messages, `toChannelInbound` to project into the
  channel-agnostic envelope shape, `applyMentions` + `mentionName` to rewrite
  `@_user_N` placeholders to `@name` text, and `extractPostText` to flatten a
  Feishu post (`post` / `zh_cn` / `title` + `content` grid) to plain text.
  `normalizeCommentEvent` / `normalizeBotMemberAddedEvent` do the same for
  comment and bot-added inbound events.
- **`render/`** — turn a markdown string into a Feishu v2 interactive-card
  payload, split by byte size to respect the
  `FEISHU_CARD_REQUEST_LIMIT_BYTES` ceiling. `renderMarkdownToCards` returns
  one or more `RenderedCard` blocks; `cardToContent` + `cardContentBytes`
  produce the JSON payload the SDK's `im.v1.message.create` endpoint expects.

## Events

The normalized inbound events produced by `parse/` are platform-specific but
host-agnostic. Each host is responsible for:

- routing a normalized inbound into its engine / dispatcher turn model,
- applying any access / delivery gate (that logic lives in the host's channel
  package, never here), and
- calling back into `transport.send` and friends for any resulting outbound.

## Engineering rules this package honors

- Ships compiled `dist/` (`tsc`), **no `tsx` runtime dependency**.
- Consumed as a **published, version-pinned package** by both repos; the two
  hosts never depend on each other.
- Built via rush in topological order (`rush build` builds this before any
  dependent).
- No synchronous blocking IO in package source. All fs/process APIs use the
  `fs/promises` / `node:child_process` async forms.

## Build / test

Built and tested through the monorepo (rush) path — the only supported install
path (see the install-model decision). From the repo root:

```sh
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/install-run-rush.js test
```
