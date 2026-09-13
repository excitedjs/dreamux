# @excitedjs/feishu-transport

The **Feishu platform-I/O core** for the dreamux channel layer. The single
place that imports the Feishu SDK.

## Scope

- **transport** — connect / receive / send / `addReaction` /
  chain-of-thought message I/O / `getChatMode` / `fetchDocComment` /
  `fetchDocMeta` / bot open_id resolution / auth via the
  `@larksuiteoapi/node-sdk` SDK, plus the serialized message-`content`
  encoding and its size budget.
- **parse** — Feishu message content → ordered content parts, including:
  - inbound text / post / interactive / image / file events
  - `doc.comment` reply events → normalized comment shape
  - bot member-added events → normalized added-event shape
  - mention resolution across text placeholders, structured `at` nodes, and
    inline Markdown `<at>` tags

## WebSocket lifecycle

The package exposes one entry point: `createFeishuTransport(credentials, opts)`.
That transport owns the Feishu SDK client and its WebSocket inbound connection.
Callers supply route handlers (`onMessage`, `onBotMemberAdded`, `onComment`, …)
on `transport.start(routes)`; inbound events are parsed on arrival and projected
into the `parse/`-normalized shapes before being forwarded.

Outbound and lookup calls (`transport.send`, `transport.addReaction`,
`transport.cot`, `transport.getChatMode`, `transport.fetchDocMeta`,
`transport.fetchDocComment`, `transport.downloadMessageResource`) are thin
wrappers around the corresponding Lark SDK endpoints. They accept platform-native
parameters (Feishu `chat_id`, `message_id`, `file_key`, …) and return
platform-native results with the minimum of re-shaping required to make
success/error handling uniform.

## Parse helpers

One pure utility boundary sits above the SDK layer, with no host dependency:

- **`parse/`** — decode Feishu JSON into ordered content parts and metadata.
  `parseInbound` returns one message's visible content as ordered parts, and
  `narrowMetaFromEvent` returns the event envelope's identifiers. Mentions are
  resolved once, against the message's own `mentions` records, whichever form
  the sender used: `@_user_N` placeholders, structured `at` nodes, native post
  `<at user_id="…">`, or card Markdown `<at id="…">`. The two inline spellings
  are read only where the source states its value is Markdown; a plain text
  node or `plain_text` field keeps whatever it contains literal, as do escaped
  and code-spanned examples. `normalizeCommentEvent` /
  `normalizeBotMemberAddedEvent` do the same for comment and bot-added inbound
  events.

## Outgoing message content

`transport.send` serializes the authored body as one native `post` message —
`{"zh_cn":{"content":[[{"tag":"md","text":"…"}]]}}` — so the Feishu client
renders the Markdown as written, mention tags included. Nothing converts
Markdown into another presentation. A body whose serialized `content` would
exceed the platform content budget is split into several ordered
messages along block seams; raw cards passed to `sendCard` / `editCard` are
measured against the same budget. That budget is the package's own — no caller
chooses it, so it is not part of the exported surface.

## Events

The normalized inbound events produced by `parse/` are platform-specific but
host-agnostic. Each host is responsible for:

- routing a normalized inbound into its engine / dispatcher turn model,
- applying any access / delivery gate (that logic lives in the host's channel
  package, never here), and
- calling back into `transport.send` and friends for any resulting outbound.

## Engineering rules this package honors

- Ships compiled `dist/` (`tsc`), **no `tsx` runtime dependency**.
- Consumed as a **published, version-pinned package**.
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
