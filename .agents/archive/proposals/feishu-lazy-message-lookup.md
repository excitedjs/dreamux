# Feishu lazy message identity hints

- **Status:** Implemented; current behavior is documented in
  [Channel runtime](/.agents/domains/channel.md)
- **Date:** 2026-07-23
- **Affects:** `@excitedjs/feishu-transport`, `@excitedjs/feishu-channel`,
  Feishu model-facing inbound content
- **Supersedes:** the merged-forward expansion and reply-ancestry portions of
  [Feishu inbound message fidelity](feishu-inbound-message-fidelity.md)

## Intent

Dreamux must preserve useful Feishu rich-message fidelity without eagerly
copying history into every Agent turn. A merged-forward message is a reference
to retrievable conversation history, not content that the Channel should
expand. The Channel supplies the minimum lookup identity and an honest type
hint; the Agent decides whether the task needs the details and independently
uses its available Feishu tooling when required.

The same presentation rule applies to reply/quote ancestry. The Channel never
embeds the parent body. It supplies the parent message id and, when one bounded
parent read proves the parent message type, supplies that type for every valid
Feishu message kind.

## Verified identity contract

The only message-specific identity required by the verified external lookup
path is the Feishu `message_id`; `chat_id` is not required. Tool selection,
commands, identity mode, output format, reaction enrichment, and resource
download policy are Agent/tool concerns and are not duplicated in the Channel
prompt.

A direct lookup of a merged-forward message returns its `msg_type` and an
expanded `forwarded_messages` representation. Dreamux therefore does not need
a second merged-forward parser, tree builder, resource owner, or persistent
entity.

## Ownership and scope

- `@excitedjs/feishu-transport` remains the only Lark SDK owner. Its existing
  bounded `readMessage` seam remains for interactive-card and `nonsupport`
  enrichment and may be reused for a parent-type probe.
- `@excitedjs/feishu-channel` owns the model-facing identity hints and decides
  whether the post-gate parent-type probe is applicable.
- Agent-side Feishu tooling owns any broader history lookup. The Channel does
  not name a tool, embed a command, or reproduce execution policy or flags.
- No Dreamux core, Agent Runtime, Channel ABI, routing, persistence, new MCP
  tool, merged-forward aggregate, or message cache is introduced.

Rich-text posts, interactive cards, standalone resources, `nonsupport`
resolution, audio/video/sticker/shared-entity projection, session fencing,
deadlines, download budgets, XML escaping, and the conditional channel reminder
remain in scope exactly as specified by the earlier fidelity proposal.

## Top-level merged-forward messages

After an accepted inbound is identified as `merge_forward`, the Channel:

- performs zero `readMessage` calls for that current message (an independently
  actionable `parentId` may still receive the one parent-type read below);
- performs zero child-message reads and zero internal-resource downloads;
- does not walk `items`, `upper_message_id`, or render forwarded participants;
- emits one short escaped marker identifying the message as merged-forward and
  carrying the current `message_id`, with no tool or command guidance.

The current message id already appears in the trusted Channel envelope. The
marker may repeat it once to make the identity fact self-contained, but it
must not add a `chat_id`, app link, message position, sender token, raw event
JSON, or any forwarded content. It must not classify this intentional lazy
representation as a parser failure or append a second generic incomplete-text
warning.

If a `nonsupport` reread authoritatively identifies the current message as
`merge_forward`, the Channel stops after that one root read and emits the same
lazy lookup marker. It does not use the returned child items or body content.

## Reply and quote ancestry

The existing neutral ancestry truth table remains authoritative:

| Event shape | Hint and I/O |
|---|---|
| no `parentId` | no hint; zero parent reads |
| `parentId === messageId` | no hint; zero parent reads |
| `threadId` present and `parentId === rootId` | ordinary thread-root reply; no hint and zero parent reads |
| any other non-empty `parentId` | neutral reply/quote hint; at most one parent-type read |

For the last row, and only after the access gate accepts the current message,
the Channel may perform one default-mode `readMessage` for `parentId`. Feishu
does not expose a type-only metadata endpoint: `im.v1.message.get` necessarily
returns `body.content`, and a merged-forward response may include all child
items. This full read is the unavoidable cost of the operator's explicit
requirement to identify a merged-forward parent before the Agent chooses to
look it up; after the zero-read alternative and this full-read tradeoff were
made explicit, the operator selected the full-read behavior. The result is
usable only when it contains a non-deleted,
non-malformed root whose message id exactly matches `parentId`. The Channel
inspects only `messageType`; it never parses, renders, downloads, caches, or
submits the returned parent content, mentions, sender, children, or resources.

When the parent root is valid, the ancestry hint includes its
`parent_message_type` for every supported or future Feishu type. The value must
be a non-empty bounded type token (`[A-Za-z0-9_.-]`, at most 64 characters);
otherwise the type is omitted rather than copying an unbounded value into the
prompt. The same `parent_message_id` remains the only lookup identity regardless
of type. A missing reader, unavailable read,
mismatched root, invalid type token, or ordinary enrichment deadline never
blocks the current message: the neutral parent-id hint remains and the optional
type is omitted. An ordinary failure must not mark the current message body
incomplete. Session revocation is different: it terminates the stale handler,
which submits no turn across a close/restart boundary.

The parent probe uses the accepted session's existing generation fence and
end-to-end enrichment deadline. Current-message reread/parsing always completes
before this optional probe begins. The probe has its own maximum two-second
sub-deadline and does not start unless at least the existing 20-second
per-resource window will remain afterward; otherwise the parent type is simply
omitted. A parent timeout therefore cannot consume the whole message deadline
or replace/degrade already resolved current-message text. Dropped and pairing
messages perform zero parent reads. A late result cannot cross close/restart
and cannot submit a stale turn.

## Minimal transport projection

Because merged-forward trees are no longer consumed in-process, the normalized
message-read item contains only fields still needed by interactive,
`nonsupport`, and parent-type resolution: message id, message type, body
content, mentions, and deleted/malformed state. Forward-tree-only sender and
`upper_message_id` fields are removed from the new, not-yet-released surface.

The transport may receive more fields from Lark, but it does not expose them to
the Channel without a consumer. This keeps the seam narrow and avoids retaining
an unused parallel representation of external lookup output.

## Model-facing examples

Synthetic examples describe semantics only; exact punctuation may follow the
existing formatter style.

Top-level merged-forward message:

```text
Merged-forward message: message_id=om_example.
```

Reply/quote when the parent read is unavailable:

```text
Reply/quote ancestry: parent_message_id=om_parent.
```

Reply/quote whose parent type was proven (an interactive card in this example):

```text
Reply/quote ancestry: parent_message_id=om_parent, parent_message_type=interactive.
```

Every dynamic value remains untrusted and is XML-escaped exactly once. Only
Channel-owned envelope and reminder tags remain literal.

## Acceptance

- A real-shape accepted `merge_forward` wire event without actionable ancestry
  reaches the submitted turn as the bounded lazy lookup marker with its current
  `message_id` and performs zero message reads and zero resource fetches. A
  merged-forward event with actionable ancestry still performs zero reads for
  its own id and at most the separately authorized parent-type read.
- The marker contains no tool name, command, forwarded record text, or
  `chat_id`; it carries only the message identity and type fact.
- Top-level and `nonsupport`-resolved merged-forward markers clear inherited
  incomplete state and do not append `FEISHU_SKILL_FALLBACK_NOTE` or any second
  generic parser warning.
- A `nonsupport` event whose single authoritative root read resolves to
  `merge_forward` emits the same marker and ignores returned child items and
  resources without making another read.
- Reply ancestry tests cover every truth-table row. Only the actionable last
  row makes one parent-type request, using exactly `parentId` in default mode.
- Matching text, post, interactive, merged-forward, resource, and unknown
  future-type parents each add their exact valid bounded
  `parent_message_type`. A missing/mismatched root, deletion, malformed
  response, invalid type token, timeout, or absent reader leaves only the
  parent id and does not mark the current body incomplete.
- Parent-type tests prove the necessarily returned response body, sender, mentions,
  `upper_message_id`, children, and resources never enter the submitted turn or
  attachment pipeline.
- Access drop/pair tests prove zero message-read and resource-fetch calls (the
  access store/pairing card behavior is unchanged). Ordinary thread-root tests
  prove zero parent-type reads while allowing message-type-specific enrichment
  for the current event. Session close and stop/restart tests prove that no new
  read, fetch, cache write, reaction, or submission starts after revocation and
  that work begun by a stale generation cannot submit.
- Combined interactive/`nonsupport` plus actionable-parent tests prove current
  enrichment happens first and a slow parent read is bounded to two seconds,
  preserves the already resolved current body, and leaves time for the existing
  resource pipeline.
- Transport contract and normalization tests prove forward-only DTO fields
  were removed without weakening interactive-card or `nonsupport` reads.
- Existing rich post/card, standalone attachment, audio/video/sticker/shared
  entity, topic routing, reaction, XML-injection, reminder placement, and
  conditional-ack tests remain green.
- Feishu runtime documentation, the earlier archived proposal, Rush change
  notes, and PR text describe lazy lookup rather than Channel expansion.

## Out of scope

- Expanding or summarizing merged-forward records inside the Channel.
- Parsing, rendering, caching, or submitting quoted/replied message bodies
  returned by the authorized parent-type read.
- Downloading resources nested in merged-forward or parent messages before the
  Agent independently requests them through its available tooling.
- A local message cache, history store, merged-forward tree type, new Channel
  capability, or provider-specific logic in Dreamux core.
- Changing external Feishu tools or their identity/resource-download policy.
  The Channel carries facts only and does not prescribe an invocation.
