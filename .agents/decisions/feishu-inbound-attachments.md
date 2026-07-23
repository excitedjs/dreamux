# Feishu inbound attachments live in feishu-channel

- **Status:** Accepted
- **Date:** 2026-06-05
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  `@excitedjs/dreamux`, Feishu inbound message format, attachment cache
- **PR / Issue:** [#92](https://github.com/excitedjs/dreamux/issues/92)

## Context

Feishu `image` / `file` inbound messages used to reach Codex as plain text
markers such as `(image)` or `(file: name.ext)`. That preserved delivery, but
it did not tell Codex whether there was a readable local file, where it was
cached, which Feishu resource key could be used to retry, or why an automatic
download failed.

The monorepo already had the package boundary needed for a cleaner split:
`@excitedjs/feishu-transport` is the Lark SDK / JSAPI boundary,
`@excitedjs/feishu-channel` is the channel layer, and `@excitedjs/dreamux` is
the host runtime. Before this decision, `feishu-channel` was only scaffolded
and Dreamux still owned the model-facing Feishu serializer.

## Decision

Move Feishu inbound serialization and attachment handling into
`@excitedjs/feishu-channel`.

- `@excitedjs/feishu-transport` exposes structured resource metadata from
  parsed content, preserves ordered text/code/resource occurrences, and owns
  the narrow Lark message-read, contact-name, and message-resource seams. It
  does not choose cache paths, write files, or emit model-facing XML.
- `@excitedjs/feishu-channel` owns the inner Channel body: `<content>`,
  positional `<attachment>` elements, lookup-only `<refs>`, optional
  `<group_bots>`, and the final `<channel-reminder>`. It also owns attachment
  download, cache-first lookup, filename sanitization, byte/deadline caps,
  owner-only file modes, and honest omission facts.
- Dreamux core stays provider-neutral. It accepts the Channel-owned attrs/body
  and neutral attachment paths, while each runtime owns the outer `<channel>`
  envelope.

## Message Body Contract

The runtime-owned outer `<channel>` contains a Channel-owned structured body.
User-visible content keeps source order, and an attachment appears once at the
position where Feishu placed it:

```xml
<content>
Inspect this archive:
<attachment type="file" name="debug.zip" key="FILE_KEY"
  path="/abs/cache/file" status="downloaded" />
</content>
```

When a resource cannot be downloaded, the body must be honest: no `path`, a
short `reason`, and the resource key when available. The Channel body carries
facts only; it does not prescribe a retrieval tool, command, output path, or
other execution policy.

```xml
<attachment type="file" name="debug.zip" key="FILE_KEY" status="not_downloaded" reason="missing_scope" />
```

The attachment attributes are `type`, `name`, `key`, `path`, `status`, and
`reason`.
`path` only appears when the local file exists and is expected to be readable by
the Agent Runtime. `key` stays present even for downloaded resources so a cleaned cache can
be refetched later.

Repeated occurrences of one `(type, key)` retain repeated positional
`<attachment>` elements but share one download/cache result and one neutral
runtime attachment. Code is rendered as a Channel-owned
`<code><![CDATA[...]]></code>` element with safe `]]>` splitting, so source
operators stay literal without becoming Channel markup.

Merged-forward and reply/quote bodies are not expanded. They appear only as
bounded lookup identities under `<refs>`:

```xml
<refs>
  <merged-forward message_id="om_current" />
  <reply-to message_id="om_parent" message_type="merge_forward" />
</refs>
```

Parser incompleteness is an `incomplete="true"` content attribute. The body
does not emit prose that directs the model to a particular retrieval tool.

## Cache Contract

Dreamux provides the cache root through `dispatcherFeishuAttachmentCacheDir()`,
which lives under the dreamux cache tree `~/.dreamux/cache/<dispatcher-id>/
feishu-attachments/` (issue #182 PR-2 moved it out of durable
`state/<dispatcher-id>/`). The channel package creates a sanitized per-resource
file under that root, never trusts raw filenames as paths, resolves the final
path back under the cache root, writes a temp file first, and renames into place
only after the download completes under the configured limits.

The cache is server-owned, rebuildable artifact data — not durable state. It is
safe to delete; deletion only turns a future duplicate delivery into another
Feishu resource fetch or a fallback block.

## Consequences

- Gate drop / pair / unauthorized paths must not download resources because
  the session invokes message reads, contact lookup, and formatting only after
  `dreamuxFeishuGate()` returns `deliver`.
- Feishu Channel tests own serialization, cache, sanitization, lifecycle
  fencing, and omission details. Transport tests own SDK request shape and
  source-order parsing.
- Future Feishu resource types should first extend the channel contract and
  tests. Transport remains a JSAPI wrapper and should not grow Dreamux- or
  model-specific serialization helpers.
