# Feishu inbound message fidelity

- **Status:** Implemented; current behavior is documented in
  [Channel runtime](../../reference/channel-runtime.md)
- **Date:** 2026-07-22
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  Feishu model-facing inbound content

## Intent

Authorized Feishu messages must reach the model with an honest, bounded, and
useful representation of their visible text, ancestry, and downloadable
resources. Rich messages must not silently lose inline images, files,
Markdown/code, card content, the existence and lookup identity of a
merged-forward message, or reply ancestry.

The same branch also refines the existing channel reminder: an immediately
answerable request gets one direct channel reply, while work that needs
investigation or execution gets a brief channel acknowledgement before the
substantive result.

## Current gaps

The current transport parser handles plain text, standalone image/file
messages, basic rich-text posts, and a subset of v2 interactive cards. The
channel downloads only the resources that parser exposes. As a result:

- post `md`, inline image/file/media, horizontal-rule, and code-bearing content
  can be dropped or reduced to an unlinked marker;
- interactive-card images and several readable control/container elements are
  not projected as text or resources;
- `nonsupport` events are not resolved through the message-read API;
- merged-forward messages are not expanded;
- `parent_id` is retained as diagnostic metadata but reply/quote ancestry is
  not explained to the model;
- audio, video, sticker, and shared-entity messages receive only a generic
  unknown-type marker.

## Ownership and public surface

- `@excitedjs/feishu-transport` remains the only Lark SDK owner. It adds a
  narrow `readMessage` capability beside `fetchMessageResource`, normalizes the
  SDK response, and owns pure Feishu content parsing. It does not render model
  envelopes or decide routing.
- `readMessage` accepts a `messageId` and an optional card-content mode
  (`default` or `user_card_content`). It returns normalized `items` carrying
only the fields needed here: message id, message type, body content,
  mentions, and a deleted/malformed indication. SDK errors remain transport
  diagnostics and do not become prompt text.
- `@excitedjs/feishu-channel` owns when enrichment is allowed, root-message
  identity checks, model-facing rendering, attachment download/cache behavior,
  ancestry guidance, fallback notes, budgets, and the channel reminder.
- No Dreamux core, Agent Runtime, Channel ABI, routing, target, or persisted
  state change is part of this slice.

## Access, identity, and session lifecycle

- Parsing the WebSocket payload remains local and side-effect free. Message
  reads and resource downloads start only after the existing access gate
  returns `deliver`. Dropped and pairing messages perform zero enrichment I/O.
- A single-message reread is usable only when it contains a non-deleted root
  item whose message id exactly equals the accepted event's `messageId`.
  Missing, mismatched, deleted, or malformed roots are treated as read failure.
- A reread may supplement or replace only the accepted event's message type,
  body content, mentions, and resources. It must never replace the event's
  chat, root/thread/parent ids, sender identity, or routing identity.
- Each started session owns a revocable lifecycle token and tracks active
  inbound handlers. `close()` revokes the token before closing the transport.
  A revoked handler performs no further message reads, resource downloads,
  cache writes, new reactions, or turn submission. Best-effort cleanup of a
  reaction already created by that handler remains allowed.
- Enrichment uses one end-to-end deadline covering message reads, resource API
  calls, stream reads, and cache writes. SDK calls that cannot be physically
  cancelled are fenced after completion, so a late result cannot cross a
  stop/restart generation and submit stale work.
- After the access gate accepts a message, the channel creates one internal
  per-message enrichment context. It carries the session signal, absolute
  deadline, remaining aggregate bytes, unique `(type, key)` set, and download
  concurrency permit through message read, parsing, resource fetch, stream
  read, and cache publication. The existing per-resource timeout becomes
  `min(20 seconds, remaining end-to-end time)`; it is not restarted as an
  independent 20-second budget for every resource.
- The default end-to-end enrichment deadline is 60 seconds. Resources remain
  limited to 25 MiB each, 100 MiB in aggregate, 32 unique `(type, key)` pairs,
  and one active download per message. A deadline or budget hit produces an
  honest omission marker and never blocks delivery of the usable remainder.

## Untrusted content and rendering

- Transport output is untrusted plain data. Only the channel may produce
  literal model-control markup such as mention, attachment, group-bot, and
  channel-reminder tags.
- Titles, body text, Markdown/code, links, sender names, filenames, shared ids,
  control labels, and nested-forward content are XML-escaped exactly once at
  the final channel-body boundary. Markdown fences, indentation, and newlines
  are retained; characters such as `&`, `<`, and `>` are represented by XML
  entities so code remains semantically intact without being able to close or
  forge an envelope tag.
- The literal channel reminder remains the only unescaped
  `<channel-reminder>` and is appended after the bounded message body.
- Raw unknown JSON, raw SDK errors, card callback values, hidden form state,
  and template variables are never injected into the model.
- The final escaped message content before the reminder is capped at 160,000
  characters for post and card messages. The truncation marker itself is
  included in that cap.

## Rich-text posts

Post parsing uses the stable locale priority `zh_cn`, `en_us`, `ja_jp`, then
the first unwrapped body with a content array. It preserves title and paragraph
order and supports text, `md`/Markdown (including fenced and inline code),
links, mentions, horizontal rules, inline images, inline files, and
image-bearing media nodes. Inline resources enter the existing attachment
pipeline and receive positional placeholders where they appeared.

## Interactive cards

Both legacy/simplified and v2/user-DSL card shapes are parsed. The visible
allowlist includes header text, Markdown/text, fields, notes, button labels,
input placeholders, select labels and option display text, columns, actions,
and nested containers. Image elements become resources and positional
placeholders. Action values, callback payloads, hidden inputs, and template
variables are excluded. Card traversal is bounded to depth 32 and 5,000 visited
nodes; reaching either bound emits one stable omission marker and does not
recurse further.

After access acceptance, an interactive event is best-effort read twice:

- the structured read uses `card_msg_content_type=user_card_content` and is the
  primary representation;
- the default read omits `card_msg_content_type`. Its same
  `items[].body.content` field is parsed as Feishu's default/simplified card
  representation; there is no separate rendered-text SDK field.

Each read must pass the root identity rule independently. Structured content
is rendered first. Default-parsed lines that are not exact normalized-text
duplicates are appended in a separate `Additional rendered card content`
section. Normalization converts CRLF/CR to LF and trims only the leading and
trailing whitespace of each line before comparing the complete Unicode code
point sequence. It does not collapse internal whitespace, remove punctuation,
URLs or Markdown, fold case, or infer field equivalence. The channel never
guesses that an unrelated rendered value belongs to a structured field. If
either read fails, the other representation and then the original event remain
valid fallbacks.

## Unsupported and merged-forward events

A `nonsupport` event is best-effort reread and reparsed as its authoritative
message type after the root identity check. The original event is delivered
with a stable incomplete-content note when resolution is unavailable.

A merged-forward event is deliberately lazy. The Channel performs no
current-message reread, child-message walk, or internal-resource download. It
emits the current `message_id`, the `merge_forward` type, and the minimal
`lark-cli im +messages-mget --message-ids <message_id>` command. The Agent uses
the Feishu skill and runs that lookup only when the task needs the records.

If a single `nonsupport` root reread authoritatively resolves the current
message to `merge_forward`, the Channel emits the same lazy marker, discards any
returned child items, and performs no second read or resource fetch. Neither
path is a parser failure or receives the generic incomplete-content warning.

## Reply and quote ancestry

Quoted bodies are never parsed, rendered, cached, downloaded, or submitted. The
channel emits one neutral reply/quote ancestry line with the accepted `parentId`
only when the following truth table selects it:

| Event shape | Hint |
|---|---|
| no `parentId` | none |
| `parentId === messageId` | none |
| `threadId` present and `parentId === rootId` | none; ordinary thread-root reply |
| any other non-empty `parentId` | neutral reply/quote ancestry hint plus at most one parent read |

The last row intentionally includes ordinary group and p2p events where Feishu
supplies a root/parent relation without a `threadId`. After current-message
enrichment, a best-effort default-mode `message.get(parentId)` may add the
matching root's bounded `parent_message_type` for every valid Feishu type. The
API necessarily returns body content and may return merged-forward children,
but the Channel inspects only the type and discards the rest. This optional read
is capped at two seconds and starts only when the existing 20-second resource
window can remain. The hint always carries the minimal lark-cli lookup command;
ordinary read failure leaves only `parent_message_id`. Session revocation still
terminates the stale handler rather than submitting across a restart.

## Other concrete message types

- Audio exposes an explicit voice marker and maps its `file_key` to the existing
  `file` resource type.
- Video/media exposes a video marker, maps its `file_key` to `file`, and maps
  its cover `image_key` to `image`.
- Stickers remain non-downloadable and receive an explicit sticker marker.
- Shared chat and shared user messages surface only their opaque shared-entity
  id and type.
- Unknown future types keep a bounded type marker and Feishu-skill fallback;
  their raw JSON is not injected wholesale.

## Reply reminder

Every visible answer still uses the channel reply tool. The reminder directs
the model to answer immediately through that tool when it already has the
substantive answer, without a separate acknowledgement. Only work requiring
investigation or execution asks for a brief acknowledgement first, followed by
the result or blocker through the same channel.

## Acceptance

- Production-path tests inject a mocked Lark client into the real transport and
  assert the exact `message.get` query modes and complete
  `(messageId, fileKey, type)` resource-fetch tuples.
- Tests run wire payloads through the transport normalizer, access gate,
  channel renderer/downloader, and submitted turn. They do not hand-build a
  second serialization model.
- Dropped and pairing paths prove zero message-read and resource-fetch calls for
  interactive, `nonsupport`, merged-forward, post-resource, audio, and video
  events.
- A post containing Markdown/code, an inline image, and an inline file reaches
  the submitted turn with preserved text, positional markers, and the correct
  downloaded attachments.
- Interactive-card tests cover both wire shapes, nested readable controls, an
  image resource, deterministic two-read fallback/merge, and exclusion of
  callback/hidden values. Deep and wide fixtures hit the depth/node budgets
  through the real parser, gate, renderer, and submitted turn without throwing.
  They prove that CRLF/CR normalization and per-line edge trimming deduplicate
  equivalent lines, while differences in internal whitespace, punctuation,
  URLs, Markdown, or case remain visible.
- Merged-forward tests prove a real-shape event becomes only the bounded lazy
  lookup marker, performs zero current/child reads and resource fetches, and
  carries no forwarded content or generic parser warning. `nonsupport` to
  merged-forward performs exactly one current root read and then stops.
- `nonsupport` tests prove authoritative type/content replacement happens only
  after gate acceptance and only for a matching root item.
- Reply ancestry tests cover every truth-table row in group, topic, and p2p
  events. An actionable parent is read at most once; a valid root adds every
  bounded message type, while its body, children, sender, mentions, and
  resources never enter the turn or attachment pipeline.
- Final submitted bodies inject adversarial `&<>`, quotes, closing tags,
  `<attachment`, and `<channel-reminder>` strings through post/card/forward
  titles, bodies, code, links, sender names, filenames, shared ids, and control
  labels. Only channel-generated tags remain literal and untrusted fields are
  escaped exactly once.
- Session tests hold message reads and resource requests across `close()` and a
  new session start, proving stale handlers cannot write cache, react, or
  submit. Deadline and aggregate-byte tests exercise both API-request and
  stream-read phases.
- Audio, video, sticker, shared-chat, shared-user, and unknown-type tests lock
  their honest projections.
- Existing standalone image/file download, access/pairing, topic routing,
  mention, reaction, forged-reminder escaping, and channel-reminder placement
  tests remain green.
- The change includes Rush change files for every publishable package whose
  runtime or public surface changes, and the Feishu runtime/attachment
  reference material reflects the final contract.

## Out of scope

- OCR, speech-to-text, video decoding, sticker extraction, or semantic analysis
  of binary resources.
- Parsing, rendering, caching, downloading, or submitting the quoted message
  body returned by the authorized parent-type read.
- Historical chat search, thread-history injection, message edits, or card
  action behavior beyond the existing callback path.
- Rendering client-only/lazy card subcomponents that neither message-read
  representation exposes; these receive an honest incomplete-content marker.
- A user-token fallback, new Feishu permissions, new Channel tools, or any
  Dreamux core/runtime capability.
