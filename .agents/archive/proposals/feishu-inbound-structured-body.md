# Feishu inbound structured body

- **Status:** Implemented; current behavior is in
  [Channel runtime](../../reference/channel-runtime.md) and
  [Feishu inbound attachments](../../decisions/feishu-inbound-attachments.md)
- **Date:** 2026-07-23
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  model-visible Feishu inbound turns

## Intent

Make one accepted Feishu message immediately legible to the model: routing
attributes stay on the outer Channel envelope, user-visible content keeps its
original order, lookup-only references are isolated from that content, and the
reply reminder is short. The same fact must not appear once as prose and again
as XML.

This is a serialization refinement. It does not change the lazy policy for
merged-forward messages or quoted/replied-to messages.

## Verified current facts

- The Feishu receive event normally carries the sender `open_id` and type but
  no display name.
- Dbotmux resolves user names with `contact.v3.user.get`, after first consulting
  names learned for free from mentions and known bots. The API requires
  `contact:user.base:readonly` and must degrade when that optional scope is
  unavailable.
- `im.v1.message.get` may return `sender_name`, but reading every current
  message just to obtain a name would violate the established zero-current-read
  contract for a top-level merged-forward message.
- Dreamux transport currently flattens rich resources to prose markers while
  also returning resource metadata. The Channel later appends an
  `<attachment>` element, which duplicates the same occurrence.
- `InboundTurnInput.body` is Channel-owned markup which runtimes place inside
  the outer `<channel>` envelope without interpreting its child elements.

## Ownership

- `@excitedjs/feishu-transport` remains the only Lark SDK owner. It returns
  untrusted parsed content parts (`text`, `code`, and `resource`) in source
  order and exposes a best-effort user-name lookup beside the existing message
  read/resource seams. It never emits Channel XML.
- `@excitedjs/feishu-channel` owns access timing, sender-name resolution policy,
  attachment download/cache facts, XML elements, code rendering, truncation,
  refs, and the reminder.
- Dreamux core and Agent Runtime contracts do not gain Feishu-specific fields or
  behavior.

The ordered content-part union is the minimum additional internal shape needed
to place a resolved `<attachment>` at the original image/file position without
smuggling a magic placeholder string across the package boundary.

`ParsedInbound` gains an optional additive `parts` field so existing transport
consumers which read `text` and `resources` remain source-compatible:

```ts
type InboundContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string; language?: string }
  | { kind: 'resource'; resource: InboundResource }
```

Parsers preserve every resource occurrence in `parts`; the legacy `resources`
array remains de-duplicated by `(type, key)`. The Feishu Channel prefers
`parts`, and falls back to one text part plus legacy resources when a custom or
older transport does not provide it.

For the existing interactive-card dual read, structured
`user_card_content` parts are authoritative. Non-duplicate visible text lines
from the default representation are appended as one labeled text part.
Resources found only in the default representation follow that supplemental
text in their default source order. A `(type, key)` already present in the
structured representation is not repeated merely because the second API
representation contains it; repeated occurrences within the authoritative
representation remain positional occurrences.

## Model-visible shape

The runtime continues to own the outer envelope and its routing attributes:

````xml
<channel source="feishu" chat_id="oc_example" chat_type="group"
  message_id="om_current" sender_id="ou_sender" sender_name="Ada"
  create_time="2026-7-23 13:55:52">
<content>
Before the image.
<attachment type="image" name="img_key.jpg" key="img_key"
  path="/owned/cache/img_key.jpg" status="downloaded" />
After the image.

<code language="ts"><![CDATA[if (a < b && c > d) {
  console.log("unchanged");
}]]></code>
</content>
<refs>
  <merged-forward message_id="om_current" />
  <reply-to message_id="om_parent" message_type="merge_forward" />
</refs>
<channel-reminder>Reply through the channel reply tool, never as plain assistant text. Answer now if ready; otherwise acknowledge, then report back.</channel-reminder>
</channel>
````

The example shows every optional element together. Actual messages omit empty
attributes and optional blocks:

- `<content>` is always present. A top-level image/file contains only its
  inline `<attachment>`. A lazy merged-forward has an empty `<content />`.
- `<refs>` is present only when at least one lookup reference exists.
- A current merged-forward contributes
  `<merged-forward message_id="…"/>`; its records are not read or expanded.
- An actionable parent contributes
  `<reply-to message_id="…" message_type="…"/>`. The type is omitted when the
  bounded parent-type probe cannot prove it. Parent content is never injected.
- `<group_bots>` remains an optional separate Channel-owned context block after
  refs and before the reminder.
- The reminder is always the final child of the Channel body.

## Content and attachment rendering

- Rich posts and cards retain visible text, Markdown, newlines, and resource
  order. Each resource occurrence is represented exactly once by its resolved
  `<attachment>` element at that occurrence's original position.
- Repeated occurrences of the same `(type, key)` keep repeated positional XML
  elements but share one download/cache result and one neutral runtime
  attachment.
- There is no `[image attachment: …]`, `[file attachment: …]`,
  `Merged-forward message: …`, or `Reply/quote ancestry: …` prose alongside the
  corresponding XML.
- Download failure remains honest: the inline attachment keeps `type`, `key`
  and optional display `name`, omits `path`, and sets
  `status="not_downloaded"` plus the bounded `reason`.
- Parser incompleteness is represented structurally with
  `incomplete="true"` on `<content>` instead of a tool-directed prose note.

## Code and trust boundary

- Non-code user text and every untrusted XML attribute are escaped once at the
  final Channel boundary.
- Code is emitted as Channel-owned
  `<code language="…"><![CDATA[…]]></code>` rather than as untrusted markup or
  an entity-escaped text node. Ordinary source characters such as `&`, `<`,
  `>`, quotes, and backslashes therefore stay literal while the element remains
  structurally closed.
- A literal `]]>` in source is split across adjacent CDATA sections using the
  standard `]]]]><![CDATA[>` representation. Comments, processing
  instructions, arbitrary element-like text, naked ampersands, and every
  Channel protocol tag in code consequently remain data rather than markup.
- A valid Markdown fenced block found in a Feishu rich-text string is promoted
  to the same `<code>` representation. An opener without a compatible closer
  consumes the remainder of that content part and is closed by `</code>`;
  the Channel never emits an unbalanced Markdown fence.
- The final serialized body before the separately appended reminder remains
  capped at 160,000 UTF-16 code units. The typed truncator charges the actual
  serialized cost of escaped text, CDATA splits, attributes, element
  wrappers/closers, refs, group-bot context, and the truncation marker before it
  selects a content prefix. It never cuts an entity, UTF-16 surrogate, Channel
  element, or CDATA closing sequence.

## Sender name and time

- An event-provided sender name wins.
- For a bot/app sender, the existing known/trusted bot ledger may supply the
  name; no contact lookup is attempted.
- Accepted mention `(open_id, display name)` pairs seed the same transport-local
  positive cache before a paid lookup is considered. The optional transport
  capability exposes both `observeUserNames(entries)` for this free,
  synchronous cache seed and `resolveUserName(openId, { signal })` for the
  SDK-backed lookup; the `FeishuBot` adapter forwards both without owning
  identity state.
- For a user with no name, the Channel asks the optional transport seam to
  resolve the `open_id` through `contact.v3.user.get` after access acceptance.
  A missing seam degrades exactly like a failed lookup.
- The positive cache, concurrent-miss deduplication, and permission circuit are
  scoped to one transport instance/application; an app-scoped `open_id` is
  never reused across apps. The lookup budget is
  `min(800 ms, remaining inbound deadline)`.
- Only Feishu's authoritative missing-scope code `99991672` opens the
  permission circuit. Timeouts, transient transport failures, malformed
  responses, and not-found results degrade for that message without
  permanently disabling later attempts.
- A per-user monotonic lookup version prevents a timed-out or aborted request
  from overwriting a newer contact result or mention seed. Session revocation
  also prevents a late response from opening the missing-scope circuit.
- No new durable identity store is introduced. An unknown name is omitted
  rather than guessed from `sender_id`.
- `create_time` is rendered in the process's current local time zone as
  `YYYY-M-d H:m:s` with unpadded month/day/hour/minute/second. Numeric Feishu
  seconds or milliseconds and parseable timestamp strings are accepted;
  unparseable input remains unchanged.

## Session lifecycle

Accepted route projection, initial/progress reactions, message reads, sender
lookup, and resource work all run behind the current session fence. Chat-mode
and reaction API calls have short operation deadlines inside the overall
inbound deadline. Closing a session revokes waiters immediately; a late SDK
result cannot submit the turn, record stale routing, mutate sender-name state,
or install a reaction ledger entry.

## Reminder

The exact reminder is:

```xml
<channel-reminder>Reply through the channel reply tool, never as plain assistant text. Answer now if ready; otherwise acknowledge, then report back.</channel-reminder>
```

It preserves the visible routing requirement and the direct-answer/long-work
branch without repeating implementation details.

## Acceptance

- Production-path tests run wire events through the real transport parser,
  access gate, enrichment, attachment resolver, Channel renderer, and submitted
  turn.
- A `text -> image -> text -> code -> file` post retains that order; each
  attachment appears once as XML, downloaded paths are retained, code operators
  are unescaped, and both the `<code>` and `<content>` elements are closed.
- Top-level image, file, audio, media, post image/file, and card image/file
  fixtures contain no resource prose marker plus trailing duplicate XML.
- A production-path interactive fixture whose structured form contains
  `text -> image -> text -> file` preserves that exact order. Its default form
  repeats the image, adds one unique text line and one unique file; the repeated
  image is not duplicated by the second representation, while the unique
  supplemental line and file are appended in their default order.
- A repeated resource occurrence renders twice in content but triggers one
  fetch and one neutral runtime attachment.
- A top-level merged-forward performs zero current/child reads and resource
  fetches, renders `<content />` plus one `<merged-forward>` ref, and contains no
  expanded record or lookup command.
- Reply truth-table tests keep the current bounded parent-type probe but render
  only `<reply-to>`; a merged-forward parent is identified by
  `message_type="merge_forward"` without exposing its content.
- Adversarial text, names, filenames, and attrs remain escaped. Ordinary code
  `&<>` stays raw inside CDATA, while `]]>`, comments, CDATA openers,
  processing instructions, arbitrary element text, naked entities, and
  protocol-tag attempts cannot escape `<code>`.
- Truncated and originally unclosed valid fences become structurally closed
  `<code>` elements before refs and the final reminder.
- Expansion-heavy text made of `&<>`, CDATA payloads containing repeated
  `]]>`, long attachment attributes, refs, and group-bot context all stay
  within the same 160,000-character pre-reminder serialized-body cap while
  retaining required closing elements and the truncation marker.
- Event-provided, known-bot, contact-lookup, permission-denied, timeout, and
  session-revoked sender-name paths are covered. Mention-learned names avoid a
  contact read; caches and permission circuits do not cross transport
  instances. Drop/pair paths make no contact lookup.
- Transport production-path tests inject the existing mock SDK client, assert
  `contact.v3.user.get({ path: { user_id: openId }, params:
  { user_id_type: 'open_id' } })`, and cover response code `0`, authoritative
  missing-scope code `99991672`, transient failure, timeout/in-flight eviction,
  mention cache hits, and isolation between two transport instances.
- With `TZ=Asia/Shanghai`, Feishu seconds `1766575805` render in local
  `YYYY-M-d H:m:s` form; a separate non-UTC zone proves the formatter follows
  process time rather than hard-coding China time or UTC.
- Existing topic/thread routing, received/in-progress reactions, attachment
  cache limits, access/pairing, and lazy message lookup tests remain green.

## Out of scope

- Expanding merged-forward or quoted/replied-to message bodies.
- Naming bots/apps which are absent from both the event and the existing
  known-bot ledger.
- Adding a required Feishu scope, a user-token fallback, persistent identity
  state, a new Channel tool, or a core/runtime ABI.
- OCR, speech-to-text, video decoding, or semantic inspection of attachments.
