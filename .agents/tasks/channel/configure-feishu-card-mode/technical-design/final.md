# Final technical solution

## Outcome and ownership

Add configurable reply presentation and outbound media without changing Core's
neutral channel contracts.

- **Feishu channel config** owns `card_mode: "interactive" | "post"` and its
  default, `interactive`.
- **Feishu channel reply/outbound** owns the model-facing `artifacts` argument,
  absolute-path policy, async local reads, upload/send ordering, and aggregated
  receipts. The configured presentation is passed only by the `reply` tool;
  Channel-authored `sendText` notices keep their current interactive default.
- **Feishu transport** owns Markdown token recognition/source replacement,
  card/post envelopes, Lark image/file upload calls, native file messages, and
  all wire message types. It accepts bytes and platform facts, not Dreamux
  config, routing, cache, or state.

No new renderer layer, delivery store, retry mechanism, root allowlist, or
Core capability is introduced.

## Configuration and reply-only selection

In `feishu-channel/src/provider.ts`, add `FeishuCardMode` and validate
`card_mode`. This is the existing `dispatchers[].channels[].config` object for
the Feishu channel instance, alongside `app_id`, `app_secret`, and `cot`:

```json
{
  "id": "primary",
  "provider": "builtin:feishu",
  "config": {
    "app_id": "<APP_ID>",
    "app_secret": "<APP_SECRET>",
    "card_mode": "post"
  }
}
```

Omission and `interactive` produce the current behavior; `post`
produces native rich text; every other value raises a field-specific
`RuleViolation`. Pass the normalized value through `FeishuChannelSession` to
the tool-session view.

`reply` alone passes that value through `FeishuOutbound.sendText` to
`FeishuTransport.send` as the platform-oriented message type. Other
`sendText` callers omit it and therefore remain interactive. `sendCard`, COT,
question cards, and binding cards do not consume the setting.

This per-call selection is required by the confirmed reply-only scope. A
transport-global presentation option would also change introduce, pairing,
and failure notices and is deliberately not used.

## Message envelopes and transport send

Generalize `message-content.ts`'s existing card splitter around one envelope
function selected by `interactive | post`:

- `interactive`: the current Card JSON 2.0 body with one `markdown` element and
  `update_multi: true`; width remains unchanged.
- `post`: `{ zh_cn: { content: [[{ tag: "md", text: body }]] } }`.

Measure the 28 KiB serialized budget against the selected envelope. Keep the
existing marked-based block, fence, table, line, and grapheme splitting and the
existing ordered send/receipt behavior.

Restore the historical `msgType` parameter at `sendFeishuMessage`; ordinary
reply sends supply `interactive` or `post`, raw cards always supply
`interactive`, and native artifact messages supply `file`.

## Inline local Markdown images

Use the existing `marked` token tree in `message-content.ts`; add no Markdown
dependency. Export pure helpers that:

1. identify actual `image` tokens whose href is a local absolute path, excluding
   protocol-relative URLs and leaving remote/image-key references untouched;
2. replace only those token hrefs in the original Markdown source, preserving
   alt text, titles, surrounding source, code blocks, inline code, nested inline
   tokens, links, and table cells.

The implementation must rewrite token raw source structurally rather than run
a global regular expression. Tests include repeated text inside code and real
image nodes so a green result cannot come from a regex that rewrites examples.

`FeishuOutbound.sendText` scans before sending. For every selected source it
reads the file with `node:fs/promises.readFile` and calls the transport's new
`uploadImage(bytes)`, which invokes:

```ts
client.im.v1.image.create({
  data: { image_type: 'message', image: bytes },
});
```

The SDK's direct `image_key` result replaces the local href. All image reads
and uploads finish before any text message is sent; a failure rejects the
reply with path context and no partial text that would falsely imply its image
was delivered. Replacement happens before envelope measurement and splitting.

## Non-image artifacts

Extend `reply` with optional `artifacts: string[]`. The schema and parser accept
only non-empty local absolute paths. Empty or omitted arrays preserve the
existing call. Update the tool description to document both inline local images
and non-image artifacts; no image argument or `img:N` syntax is added.

Transport adds two low-level capabilities:

- `uploadFile({ fileName, bytes })` reads no Dreamux paths. It derives Feishu's
  `file_type` from the filename using Feishu's native file-message-compatible
  suffix mapping (`pdf` and Office formats, otherwise `stream`; MP4 and OPUS
  deliberately use `stream` for this file-message path) and calls
  `client.im.v1.file.create` with `file_name` and bytes.
- `sendFile(target, fileKey)` sends `msg_type: "file"` with
  `{ file_key }` through the same create/reply boundary and error description.

Outbound resolves the target once for the whole call. It reads and uploads all
artifacts before sending text, then sends the text part(s), then sends each
native file message in array order against that same target. It concatenates
text and file receipts in `message_ids` and preserves existing logging.

Every artifact, including MP4, is a downloadable **file** message. No `media`
preview is attempted: Feishu's media form needs a cover image, which the
confirmed argument does not carry. No cover generator or extra parameter is
added.

If an artifact read/upload fails, no text or artifact message has been sent.
If a native text/file send fails after earlier sends, transport preserves the
receipts in a platform-oriented `FeishuPartialSendError`; outbound converts
that typed fact into the same `PublicInvokeFailure` shape used for artifact
failures, naming the failed artifact and listing the observed ids once. Direct
transport diagnostics and the original cause remain intact, and zero-receipt
errors propagate unchanged. Do not continue, retry, roll back, report success,
or detect partial delivery by matching error prose. This preserves partial
receipts without inventing a second result schema or delivery state.

## Contracts, compatibility, and state

Changed contracts:

- Feishu channel config gains optional `card_mode` with a readable default.
- `reply` gains optional `artifacts`; its result remains `message_ids`.
- Feishu transport text send gains a platform message-type option and raw
  upload/file-send capabilities. Channel fakes and transport public API tests
  are updated with the real contract; no optional no-op media surface is added.

There is no persisted state/schema change and no migration. Existing config
and calls remain valid. Rush change files for both Feishu packages are ordinary
0.x `minor` notes, without `BREAKING:` or `Rebuild:`.

Update the product catalog, `.agents/domains/channel.md`, transport/channel
owning docs where their contracts change, and the Feishu maintenance reference
in the same implementation change.

## Verification

- Provider: omitted/interactive/post values and invalid-value diagnostics.
- Reply tool: schema, absolute-path parsing, configured mode forwarding,
  artifact forwarding, unchanged output shape, and tool description.
- Message content: both envelopes and budgets; long prose, Unicode, fences,
  tables, mentions; actual image tokens versus code/remote references; alt,
  title, nested link/table, repeated paths, and post-key replacement.
- Transport: image/file SDK request bytes and fields, direct key responses,
  create/reply message types and contents, ordered receipts, sendCard remaining
  interactive, and existing platform-error details.
- Outbound/tool integration: one resolved target, all uploads before the first
  message, text-then-file ordering, aggregate ids, upload failure sending
  nothing, and later send failure preserving earlier ids.
- Run monorepo build, lint, test, `typecheck:tests`, and `.agents/scripts/check.sh`.
- An authorized native-post probe with an uploaded image key in its Markdown image reference passed API and operator visual verification on 2026-11-18. After implementation, send the interactive equivalent and representative MP4/archive file messages under the same live-probe authorization.

## Known limits and stop conditions

- Local absolute paths are the confirmed capability boundary; there is no
  workspace/cache-root allowlist. The model can name any daemon-readable local
  file for delivery to the resolved conversation. Path canonicalization,
  exfiltration policy, size caps, and media-cover generation are outside this
  change.
- Current long-message CRLF normalization remains as it is; the image rewriter
  must not introduce additional source normalization.
