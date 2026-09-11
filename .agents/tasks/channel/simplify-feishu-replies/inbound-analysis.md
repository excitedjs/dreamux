# Native post inbound analysis

Source baseline: `3cac2f7b00a7be159a52bd6aee0a9cdcd43214e1`.
Investigation date: 2026-09-11. Findings describe current source, not implemented
fixes. Private HTTP captures remain outside the repository. The operator confirmed
that existing peer-bot card mentions already deliver and wake the receiving bot;
that behavior is the regression baseline. Representation defects below must not
be conflated with receipt, wakeup, or access-gate failures.

## Actual path and ownership

Realtime messages enter `bot.ts:369` through `normalizeInboundEvent`:

```text
im.message.receive_v1
  -> normalizeInboundEvent: message.content + message.mentions
  -> parseInbound -> parsePostContent -> ordered parts
  -> sessionOnMessage: access / pairing / actual-mention gates
  -> enrichFeishuInbound: supported content and reference enrichment
  -> formatFeishuMessageForRuntime -> renderFeishuStructuredBody
  -> channel submission -> neutral Core delivery -> runtime
```

Readback enters `transport/feishu.ts:610` through `readMessage`, then
`normalizeMessageReadItem` takes `item.body.content` and `item.mentions`. Enrichment
feeds that same content string to `parseInbound`. Ordinary native posts do not
need an extra GET on receipt. Interactive content retains its existing two-read
projection; merged forwards remain lazy references. Parent enrichment records
the referenced message type without injecting its full body.

The event's `mentions` collection is an authoritative platform input used by
`isBotMentioned` before enrichment. Removing the outbound tool's mention list does
not remove or reconstruct this input. XML written in body text must not become
authority for the inbound access gate.

## F1: The shared post parser selects the lossy projection

The five direct-HTTP probes were read back through the message GET endpoint.
Each returned a JSON-encoded post with both arrays inside the content object:

```json
{
  "title": "",
  "content": [[{"tag": "text", "text": "Heading"}]],
  "content_v2": [[{"tag": "md", "text": "# Heading"}]]
}
```

This is a synthetic minimal example of the observed nesting. `content_v2` is
neither `message.content_v2` nor `item.body.content_v2`. The existing entry points
already retain the right outer string. The loss occurs in `parse/post.ts:26`:

```ts
if (Array.isArray(post.content)) {
  for (const row of post.content) {
```

The `md` branch at line 74 cannot help when the parser selects the legacy array.
The locale selector at line 48 also recognizes only `content`.

Replay of the actual GET payloads through the current source confirms lost
heading markers and table alignment, removed inline-code delimiters, and extra
blank lines in fenced code. Four probes retain their authored Markdown exactly
in `content_v2`; the mention probe differs only where Feishu resolves the actual
mention's display name. This is also the projection the
[official receive-content documentation](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content.md)
recommends for Markdown fidelity.

Proposed correction: select `content_v2` when supplied, otherwise `content`, once
inside the locale-aware post parser. Do not concatenate both versions or repeat
the selection in realtime and readback adapters.

## F2: Rich-post mentions do not preserve structured identity

The legacy post branch at `parse/post.ts:100` emits only `@user_name`; it discards
the node's user identifier. `parseInbound` does not pass the separate mention
mapping to that parser. By contrast, `feishu-message-render.ts:121` reparses raw
text messages to recover mention identity. The same fact has different owners
depending on message type.

Merely selecting `content_v2` is insufficient. With the current renderer, actual
native `<at user_id="...">...</at>` markup remains a text part and becomes
`&lt;at user_id=...&gt;`. The identifier remains in that escaped text, but it is not
an actual structured mention in the model-facing envelope. A diagnostic replay
that changes only the selected input array demonstrates this outcome.

The existing structured text mention renderer at `feishu-message-render.ts:208`
emits `<at id="...">...</at>`. That spelling also differs from the new native post
reply syntax. A model copying it into a reply would use the wrong attribute.

Proposed correction: let transport parsing produce ordered mention parts for
text, rich posts, and cards, resolving placeholder keys with the platform's mention
records. The channel serializes those parts using `user_id`, the same syntax the
reply tool accepts. Remove text-only raw-body reparsing instead of adding a
second post-specific pass in the channel. Preserve names, identifiers, and
positions; keep the flat text view as a projection of these parts.

Native Markdown must distinguish actual inline mentions from tags inside inline
or fenced code. Preserve other authored Markdown slices rather than rebuilding
a document from tokens. Continue escaping ordinary text and XML attributes;
do not implement a global `id` to `user_id` replacement.

The same boundary matters for attachments: native Markdown supports image
syntax, while the current `md` branch extracts no resources. Regression checks
must cover actual image elements and image references outside code when selecting
`content_v2`. Preserve existing ordered resource parts, download behavior, and
deduplication. No live image message was sent in this investigation, so this is
a documented-format regression scenario, not a claimed live image failure.

## F3: An explicit GET default changes bot identity

`transport/feishu.ts:616` explicitly sends `user_id_type: 'open_id'`. The
[official GET documentation](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)
states that omitting this parameter returns open IDs for people and bots, whereas
specifying it returns bot application IDs. The normalizer at
`transport/message-read.ts:79` treats any identifier type other than `union_id`
or `user_id` as `open_id`, including the resulting `app_id`.

A direct GET of one actual incoming text message mentioning this bot confirms:

| Request | Mention id_type | Matches the known bot open ID |
| --- | --- | --- |
| Omit user_id_type | open_id | Yes |
| user_id_type=open_id | app_id | No |

Proposed correction: omit the unnecessary parameter in `readMessage`, retaining
the separately requested `card_msg_content_type`. No name lookup or new identity
translation layer is required. Other APIs' `user_id_type` parameters are outside
this finding. The normal realtime access gate uses event mentions before
enrichment, so this evidence does not establish an access-gate failure.

## F4: Existing cards need source-aware mention parsing too

The operator explicitly requires accepting peer bots' current message formats.
This is not limited to the new native posts this channel will send. The existing
reviewer card was read through both supported GET modes without changing it:

| Projection | Actual visible source | Returned mentions |
| --- | --- | --- |
| user_card_content | Card 2.0 Markdown containing an unquoted `<at id=...></at>` | One open-ID mention |
| default | Simplified rendered resources and fallback text | None |

Replay through current `parseInbound`, `mergeInteractiveInbound`, and
`renderFeishuStructuredBody` escapes the card mention as ordinary XML text. This
explains model-facing representation only: receipt already occurred successfully.

The card parser has two concrete points to correct: Markdown and plain-text
fields collapse together (`parse/card.ts:150-155`, `:262-269`), and both structured
`at` branches emit names without identifiers (`:210-211`, `:278-283`). The
`interactive` branch of `parseInbound` does not pass its mention mapping onward.
Each card source must retain its native field meaning until semantic parsing:
`markdown`/`lark_md` interpret card `id` tags; plain-text labels and code examples
remain literal. Native rich-post Markdown separately interprets `user_id` tags.
There is no globally permissive XML replacement or requirement that a peer bot
change its own sender.

Both card readbacks feed the same semantic parts contract with their own mention
metadata. The existing visible-content merge needs to compare mention identity
when deciding whether supplemental content is already represented. New mention
parts must not fall through as always-new supplemental parts, nor should a
global ID set erase intentional repeats within the primary view. Preserve hidden
value exclusion, resource handling, and existing read/lifecycle limits.

## Verification boundary

The [replay script](artifacts/inspect-native-post-inbound.mjs) loads type-stripped
copies of the current source and replays captured GET results through the real
parser and model-body renderer. Its selection-only comparison is diagnostic
input manipulation, not a patched implementation or a live WebSocket event.

The operator reported that the five outgoing probes looked fine. That visual
assessment does not validate the inbound projection: current-source replay
exposes the information loss described above. Full event delivery, bot-to-bot
notifications, image download, and revised parser tests remain implementation
validation work.
