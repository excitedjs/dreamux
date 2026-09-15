# @excitedjs/feishu-transport

The **Feishu platform-I/O core** for the dreamux channel layer. The single
place that imports the Feishu SDK.

## Scope

- **transport** — connect / receive / send / `addReaction` /
  chain-of-thought message I/O / `getChatMode` / `fetchDocMeta` /
  `resolveWikiNode` / `fetchDocCommentText` / bot open_id resolution / auth via
  the `@larksuiteoapi/node-sdk` SDK, plus the serialized message-`content`
  encoding and its size budget.
- **parse** — Feishu message content → one text body, including:
  - inbound text / post / interactive / image / file / audio / media events
  - `doc.comment` reply events → normalized comment shape (identifying fields
    only: the payload carries no comment text and no document title, which is
    why the transport offers `fetchDocCommentText` beside it)
  - document share URLs and bare tokens → `{ token, type }`
  - bot member-added events → normalized added-event shape
  - mentions left as the `@_user_N` placeholders the message's `mentions`
    records name, whichever form the sender used

## WebSocket lifecycle

The package exposes one entry point: `createFeishuTransport(credentials, opts)`.
That transport owns the Feishu SDK client and its WebSocket inbound connection.
Callers supply route handlers (`onMessage`, `onBotMemberAdded`, `onComment`, …)
on `transport.start(routes)`; inbound events are parsed on arrival and projected
into the `parse/`-normalized shapes before being forwarded.

Outbound and lookup calls (`transport.send`, `transport.addReaction`,
`transport.cot`, `transport.getChatMode`, `transport.fetchDocMeta`,
`transport.resolveWikiNode`, `transport.fetchDocCommentText`,
`transport.downloadMessageResource`) are thin wrappers around the corresponding
Lark SDK endpoints. They accept platform-native
parameters (Feishu `chat_id`, `message_id`, `file_key`, …) and return
platform-native results with the minimum of re-shaping required to make
success/error handling uniform.

`fetchDocMeta` is the one exception to "minimum re-shaping", and deliberately:
a caller uses it as a permission proof, so it answers `visible` / `invisible` /
`unsupported_type` rather than one nullable value. Only `invisible` — Feishu
reporting the token in `failed_list` — establishes that this app cannot see the
document; a failed request rejects, because it establishes nothing.

`fetchDocCommentText` answers one nullable value for the opposite reason: it
reads the single comment a `drive.notice.comment_add_v1` event names, and every
way of not finding it means the same thing to a caller — there is nothing to
show. A non-zero business code still rejects, because that is a failed request
and not an absent comment. What it answers with is the comment as ordered
`FeishuCommentSegment`s — text, or a mention carrying an open_id — rather than
one string: the element a model reads a mention as is an agent-facing body
format, and this package does not assemble those. A `docs_link` is text, because
it is a URL the commenter typed.

## Parse helpers

One pure utility boundary sits above the SDK layer, with no host dependency:

- **`parse/`** — decode Feishu JSON into one text body plus metadata. Use
  `parseInbound` for messages and `narrowMetaFromEvent` for the event
  envelope. The body is written in Feishu's own vocabulary: a mention stands
  as the placeholder its record names — a `@_user_N` in text, a structured
  `at` node, or an `<at>` tag inside native post or card Markdown all become
  that placeholder — and an image or file stands as its resource key, with the
  resources listed beside the text. Resolving a placeholder to a person, and a
  key to a download, is the caller's job. A card is read from the event alone,
  as the `content`/`text` strings under its display keys and its image and
  file components; a control's callback payload is never walked.
  `normalizeCommentEvent` / `normalizeBotMemberAddedEvent` do the same for
  comment and bot-added inbound events.

## Outgoing message content

`transport.send` serializes the authored body as one v2 interactive card
holding a single `markdown` element — `{"schema":"2.0","config":
{"update_multi":true},"body":{"elements":[{"tag":"markdown","content":"…"}]}}`
— sent as an `interactive` message. The body goes in as written, an
authored `<at user_id="…">Name</at>` mention included; nothing is rewritten.
A body whose serialized `content` would exceed the platform content budget is
split into several ordered cards along block seams; raw cards passed to
`sendCard` / `editCard` are measured against the same budget. That budget is
the package's own — no caller chooses it, so it is not part of the exported
surface.

## Events

The normalized inbound bodies produced by `parse/` are platform-specific but
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
