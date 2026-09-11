# Simplify Feishu replies with native Markdown

The 2026-09-11 [review adjudication](reviews/2026-09-11-adjudication.md)
incorporates the completed Claude and DeepSeek reviews. The operator ended the
wait for Seed. The later operator ruling defers identity arrays and keeps string
concatenation in this release. This revision removes the associated state-format
changes. The operator also removed external-consumer compatibility, allowing the
unused Markdown-to-card API to retire. The operator subsequently approved the
complete current scope through the dedicated interactive card; see the
[authorization record](../README.md#complete-scope-authorization-granted-2026-09-11).

## Presentation reaffirmed after raw-card comparison

The operator requested five direct-HTTP Card 2.0 examples with unmodified
Markdown and visually accepted all five. The leader then proposed retaining
cards. The operator explicitly rejected that direction:

> 不，还是用富文本吧。

The current solution therefore remains native `post + md`, including the
`user_id` mention syntax below. The raw-card results are comparative evidence,
not the chosen outgoing format. See [verification](../verification.md).
The presentation choice and development authorization are separate decisions;
the latter is now recorded in the task README.

## Problem and intended behavior

The reply tool carries mentions separately through multiple adapters, then
transforms Markdown into interactive-card elements. The operator requested inline
XML mentions and simpler reply logic, and selected native Feishu rich-text
presentation on 2026-09-11.

The reply contract becomes `reply(chat_id, message_id?, text)`. Text becomes
native `post` content containing `md` elements. Feishu renders headings, tables,
code, links, and `<at user_id="ou_example">Example</at>` at their authored
positions. A long reply can still produce several messages, in order.

This final implementation plan incorporates both external solution reviews and
the operator's explicit requirement to retain existing peer message formats.
The complete plan now has explicit interactive-card development authorization.
The later operator consumer-scope ruling permits removing the affected APIs that
have no remaining current-repository production caller.

## Evidence

- Source baseline: `3cac2f7b00a7be159a52bd6aee0a9cdcd43214e1`.
- Tool and channel owners: `packages/channel/feishu-channel/src/tools/messaging-tools.ts`,
  `tools/types.ts`, `feishu-channel.ts`, `feishu-session-ops.ts`, and `bot.ts`.
- Transport owners: `packages/channel/feishu-transport/src/transport/feishu.ts`,
  `transport/outbound-card.ts`, `contract/outbound.ts`, and `render/`.
- [Official message content format](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md)
  documents native `post` Markdown, inline XML mentions, tables, and code blocks.
- [Official reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md)
  accepts `post` and documents the 30 KB content-size constraint and source-message
  addressing. A reply to an existing topic message stays in that topic.
- Five native-post examples were sent through direct Node HTTP calls, bypassing
  CLI/SDK/renderers. The operator reported that they looked fine. Readback and
  current-source replay separately exposed the inbound defects below.
- [Official inbound content](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content.md)
  recommends the nested `content_v2` projection for native Markdown fidelity.
- [Official message GET](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)
  documents different bot-mention identities when `user_id_type` is supplied.

## Ownership and flow

The channel owns tool inputs and outbound address observation. Transport owns
Feishu message serialization, platform limits, and actual API calls. Core does
not learn a Feishu rendering mode or mention syntax.

The resulting flow is:

1. Parse the three reply fields and pass the body without mention rewriting.
2. Resolve the existing chat/source-message address at the channel boundary.
3. Encode native Markdown post content at transport; split only if the serialized
   content would exceed the existing safe platform budget.
4. Call the existing message create/reply endpoint and observe each successful
   creation before sending another part.
5. Return the created message IDs in order. Preserve normal platform errors.

## Remove the separate mention mechanism

Delete `mention_user_ids` from the tool schema, parsing, and handling; remove
`mentionUserIds`/`mentionUsers` from reply session and outbound-address contracts.
Remove `textWithLeadingMentions` and its count-only logging. Remove the array
validator if it has no remaining caller.

The pairing resend reminder currently passes `mentionUserIds` at
`feishu-session-inbound.ts:228`. Change that caller to prefix its existing body
with the literal `<at user_id="${inbound.sender_id}"></at>\n` instead. The sender ID
comes from the platform event, not arbitrary user text. This empty-name spelling
was accepted by the direct API and returned the intended person as a mention;
its supplementary client check remains pending. It needs no display-name lookup.
The tool's `text` description explains the same native syntax with a synthetic
example. No custom `<@...>` alias is processed by the new reply path. Remove the
helper at `transport/feishu.ts:652` and count-only field at
`feishu-session-ops.ts:177`.

Keep `channelOutboundToFeishuTarget` as the shared address adapter for all three
callers; remove its mention field mapping. Bypassing it for reply alone would
leave two target-construction mechanisms. Remove `conversationKey` from the
channel/transport target contracts and adapter: source inspection finds only its
declarations and forwarding, with no production producer or consumer. External
compatibility no longer justifies retaining that unused routing hint.

## Keep the initial reply address in the auto-provisioned identity

The operator rejected the Thread-ID lookup proposal and explicitly requested
creation-time identity guidance instead. The current `reply(chat_id,
message_id?, text)` address contract remains unchanged; no thread-target field,
automatic destination lookup, or separate address cache is added.

`FeishuProvisioning.createTeam` is the owning boundary. It already holds the
space policy and initial submission and currently passes `space.identity`
directly to `team.create.leader.identity`. Pass one concatenated string instead:
`space.identity === null ? replyGuidance : space.identity + '\n\n' + replyGuidance`.
Preserve the configured text, append the generated instruction once during
creation, and leave the space policy unchanged. Obtain the bound chat from
`input.target.chatId` and the actual initial message from
`input.submission.anchor.messageId`; do not substitute `threadId`, the latest
observed message, or a subsequent provisioning announcement. The display anchor
also remains an actual message ID for submissions whose deduplication `sourceId`
is not an ordinary message ID.

Proposed model-facing copy, using synthetic placeholders here:

```text
This Team was automatically created for a topic in the Feishu channel's bound
collaboration-space chat.
chat_id: oc_example
message_id: om_initial_message (the message that initially triggered Team creation)
When using the reply tool in this bound conversation, use the message_id visible
in the current context. If no other message_id is visible, you MUST pass the
initial message_id above. Never omit message_id.
```

This uses the existing identity lifecycle: `TeamService.createNew` persists the
creation identity as a string, and `teamLeaderSystemPrompt` appends that whole
string after the existing Dreamux role, tool, and workspace instructions. Codex
joins the existing append list into developer instructions on thread start/resume;
Claude Code joins it into one native append-system-prompt argument. Feishu alone
authors the reply instruction; Core keeps its current identity representation.
This avoids depending solely on
an old user-message envelope remaining in the transcript. It is model guidance,
not a new backend routing guarantee; actual compaction behavior remains a runtime
validation scenario.

Only the first request of the existing per-target provisioning run creates the
identity; concurrent later messages follow the created binding. Keep creation
idempotency and replay semantics unchanged. Existing Teams and manually created
Teams are outside this append-at-creation change. Runtime IDs stay in their
existing private identity storage; repository fixtures and public documentation
use synthetic examples only.

Extend the provisioning tests for absent/custom identity, distinct topics,
initial-message selection during concurrent arrival, and deterministic replay.
Verify the identity-to-system-prompt path and a compaction scenario after
implementation. Update the channel/product documentation and the owning
maintenance reference to explain that space identity is preserved and augmented
when a Team is created. Keep the server-owned identity/state editing boundary.

## Preserve string identity and compose the complete prompt

The operator deferred Identity arrays from this release and explicitly requires
string concatenation through the existing chain. Keep all current string/null
identity contracts, stored formats, and versions. MCP delegates, shared types,
Core creation schemas, Team/Agent readers, TeamMate/workflow producers, and space
binding schemas need no representation change.

Composition follows the existing owners and order:

1. Feishu provisioning concatenates the configured identity and its reply
   guidance into one string, separated by a blank line. An absent custom
   identity produces just the reply guidance. Do not mutate the shared policy.
2. Team creation persists that string through the existing Team record and Agent
   identity paths. Restore uses the stored string without appending the Channel
   guidance a second time.
3. `teamLeaderSystemPrompt` includes Dreamux's role, tool, and workspace text,
   followed by the stored identity string. Preserve that order and every
   contribution. Existing TeamMate/workflow composition stays as it is.
4. Both providers render the existing runtime append list into a single native
   string. Codex supplies `developerInstructions`; Claude Code supplies exactly
   one `--append-system-prompt` argument. The existing runtime append-list type
   does not require an upstream identity-array conversion.

The prior native probes confirmed string support on Codex 0.153.4 and Claude
Code 2.1.267, including actual model responses retaining both supplied markers.
Repeated Claude append flags retain only the last value, so continue using the
existing single-argument serialization. See [provider probe evidence](../verification.md#native-provider-append-probes-2026-09-11).

Required implementation verification covers custom/absent identity, the combined
creation string, unchanged space policy, stored-string restoration, built-in
instructions plus the complete identity at each provider boundary, and actual
reply behavior after compaction. Existing source already provides storage and
provider composition; change only a demonstrated loss/overwrite if these checks
expose one. No new prompt composer, compatibility layer, record-version change,
`LegacyStateError` refactor, or old-state rebuild is part of this scope.

The earlier array-related review findings no longer apply to this release.
Retain them in the review history rather than implementing their proposed
failure handling after the triggering format change has been removed.

## Native post construction and long messages

An ordinary reply produces the following content shape, serialized once for the
message API's `content` field:

```json
{"zh_cn":{"content":[[{"tag":"md","text":"The authored Markdown body"}]]}}
```

The common one-message path does not convert Markdown into card elements or
change heading/table/mention syntax. Do not retain a card fallback for unsupported
clients; native client rendering was the operator's selected behavior.

Long-message handling has a concrete existing scenario: reply currently sends
long reports as several messages. After discussing conservative splitting, the
operator explicitly chose to retain the existing budget:

> 那就先保持28kb 吧。

Keep 28 * 1024 UTF-8 bytes for the serialized native-post `content`, including
its JSON escaping, and reuse trial serialization. This is the chosen operating
budget, not a newly measured platform boundary. Raising it toward the documented
30 KB limit and additional live threshold experiments are outside this decision.
Keep one authoritative size decision, not independent content and
full-HTTP-request budgets.

Try the whole authored body first. Short paragraphs or a large number of Markdown
blocks must not trigger splitting on their own. Only an oversized message enters
the splitter. Preserve block boundaries where they fit;
reuse the existing Markdown tokenization/splitting primitives only where needed
for oversized input. A split code block must retain its fence context; a table
split across messages must remain readable with its header: retain the existing
long-table capability by repeating only that block's first two raw lines, without
token-to-Markdown serialization. Use the existing lexer's table classification,
then capture the source prefix with `/^(?:[^\r\n]*\r?\n){2}/`; do not introduce
a second GFM table recognizer that would reject optional outer pipes.
Unicode must not be truncated or corrupted.
Do not add a separate XML-aware byte splitter for an unobserved oversized single
line containing a mention.
Do not render card-native table elements or apply card element/column/cell limits
to native posts.

The preservation mechanisms are local to the oversized-input path: classify
blocks using the existing lexer and retain their raw source; split fenced-code
bodies by line and repeat their opening/language and closing fence; split table
data by complete rows and prefix each piece with the original two header lines;
split an oversized ordinary line at `Intl.Segmenter` grapheme boundaries. Count
the repeated fences/headers and JSON escaping in each final post's 28 KB budget.
The current raw-text byte splitter alone does not establish that serialized
payload invariant. Existing code-fence and grapheme helpers are implementation
inputs; native-post table-header handling and final payload verification still
need implementation and tests.

This preserves readable structure for splittable blocks, not an unconditional
guarantee for every input. A table header plus one data row can itself exceed
the entire post budget; row-preserving splitting cannot solve that case. The
proposed boundary behavior is an explicit size error rather than silently cutting
columns or dropping content. This clarification is a proposal, not a separate
operator ruling. Native-client rendering and arbitrary malformed Markdown are
not guaranteed by local fence balancing.

Keep the implementation limited to encoding and splitting. It must not grow a
second Markdown-to-platform renderer. The implementation review should compare
the complexity removed from the reply path with the new size-handling code.

## Reuse the actual send boundary

The current transport helper handles create/reply addressing twice depending on
whether an AbortSignal was supplied. The native post path and explicit card path
should use one platform message-send primitive, parameterized by the actual
Feishu message data rather than a new high-level rendering mode. Preserve the
existing AbortSignal behavior for explicit card sends. Do not change topic
semantics or add a chat-mode lookup to send a reply.

Use the already established `client.request` form and remove
`MessageApiWithReply` and its cast. The only addressing distinction is
create versus reply; supplying a signal must not duplicate that logic.

Retain `onMessageCreated` ordering and its non-authoritative observer behavior.
The source message and every successfully created part remain addressable even
when a later send fails. No retries, rollback, or durable delivery ledger are
introduced by this change.

## Preserve actionable message-send failures

Named production scenario: two replies returned HTTP 400 with Feishu code
`230028`, reason `The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS`,
and a platform `error.log_id`. The installed SDK logger recorded this response.
`feishu-session-ops.ts` and `feishu-session-mcp.ts` then project errors to
message/stack only; Core's existing `failureText` also uses the thrown message.
The model therefore read only `INTERNAL: Request failed with status code 400`.

Repair the information loss once at the existing transport message-send boundary
already being consolidated for post and explicit cards:

- When an HTTP/SDK rejection carries a Feishu response envelope, extract the
  available HTTP status, `code`, `msg`, and `error.log_id`. Include the concrete
  operation (`message.create` or `message.reply`) in one descriptive Error
  message. Preserve the original Error as its cause. Do not serialize the
  Axios request, authorization headers, raw outbound content, or full response.
- A resolved nonzero Feishu business code is a failed send too; the generic SDK
  request path does not make a successful message receipt out of such a body.
  Use the same description and do not return success with an empty receipt list.
- Cancellation and errors without a Feishu response retain their original
  thrown identity/message. No retry, card fallback, failure-code table, new
  error-class hierarchy, or cross-provider error framework is introduced.

The existing channel logs now receive the useful description through
`errInfo(err).message`, and the existing MCP path carries it without learning
Feishu wire fields in Core. Its current generic outer prefix may remain; the
substantive result is, for example, using a synthetic log ID:

```text
INTERNAL: Feishu message.reply failed (HTTP 400, code 230028, log_id=log_example): The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS
```

Keep the existing SDK diagnostic redaction and stack logging. This is additive
failure detail, not an invitation to dump raw request bodies or invent a cause
when the platform supplied none. The already-published earlier message IDs and
observer ordering remain intact when a later chunk fails.

Implementation verification must reproduce the captured envelope with synthetic
identifiers through transport, channel logging, and an actual MCP result. Cover
create/reply and the shared explicit-card send, a resolved business rejection,
a no-response network error, cancellation identity, and failure after a successful
chunk. Assert that code/reason/log ID survive and request credentials/content do
not leak. No additional live blocked message is needed to prove this behavior.

## Inbound Markdown and mention identity

The operator explicitly requires compatibility with peer bots' existing sending
formats. The current card-based peer-bot mention/receipt path is an established
working baseline, not an unproven new capability. Sending native posts ourselves
does not narrow accepted input to native posts. Separate three facts: platform
message receipt, access-gate admission, and model-facing mention representation.
The formatting defects below do not establish failure of the first two.

Both `bot.normalizeInboundEvent` and message-read enrichment feed JSON-encoded
content to transport's `parseInbound`. Keep that one parsing boundary. For native
posts, actual message GET responses contain `content` and `content_v2` inside the
decoded post object, not on the outer event or body. The current `parse/post.ts:26`
selects only `content`; recognizing `md` at line 74 is insufficient. Replays of all
five captured responses demonstrate lost heading syntax, table alignment, inline
code delimiters in the captured examples, and extra blank lines in code. This is
not universal inline-code loss: legacy nodes retaining `style: ['code']` are
already re-fenced by the parser. Prefer the supplied `content_v2`
array inside the locale-aware parser; use legacy `content` when it is absent.
Never concatenate the projections or add an ordinary-post readback network hop.

Make ordered mention parts a transport parsing result shared by text, post,
and interactive cards. Interpret each source with its actual native semantics:

| Inbound source | Mention representation to parse |
| --- | --- |
| Text receive/readback | `@_user_N` resolved from the platform mention map |
| Structured rich post or simplified card | `at` nodes and their identifier/name fields |
| Native post Markdown | `<at user_id="ou_example">Example</at>` |
| Card `markdown` / `lark_md` | `<at id="ou_example"></at>`, including the unquoted ID form observed in live readback |

For the operator's inbound-only question, these sources reduce to three data
representations: text placeholders, structured `at` nodes, and retained inline
Markdown tags. An `at` node may itself contain a mention-map placeholder. They
share one semantic mention result; the four source rows are not four parsers.

The [card Markdown sending reference](https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text.md)
also documents `ids` and `email`. Their actual event/GET normalization has not
been captured. Do not promote those outbound attributes into additional inbound
parser mechanisms without readback evidence. Use platform-resolved nodes and
mention records where supplied; do not guess identities from display names or
add contact lookups. This is an evidence boundary, not a claim of full handling
for unobserved raw card markup.

These are native input formats, not outgoing aliases. Plain-text card fields,
escaped examples, and code-contained XML retain literal meaning; do not scan all
flattened text indiscriminately. The parser must retain whether a visible field
was plain text or Markdown until its inline meaning has been parsed.

Resolve real platform placeholder keys against the accompanying mention records;
native Markdown's actual inline tags also retain their identifier, display name,
and source position. A tag/node identifies a mention occurrence; resolve its ID
against the accompanying records first by `key`, then by supported identity.
The matching record supplies its display name, including for empty-name tags.
The metadata map never invents an occurrence absent from the source. Retain a
source-provided supported identity when no record matches; do not resolve names
over the network. Preserve all remaining Markdown source slices. Interpret
inline and fenced code boundaries before promoting a tag or image reference;
code examples remain code. Existing `marked` tokenization is available at this
layer; a new parser dependency or reconstructed Markdown document is unnecessary.
Transport owns these code boundaries and emits code parts. Delete the channel's
`promoteMarkdownCode` scanner as well as its raw-text mention reparsing; the
channel only serializes text, code, mention, and resource parts. Preserve the
existing plain-text message contract rather than interpreting its literal
Markdown as rich content.
Explicit regression inputs include native `md` fences, legacy post text rows
that together form a fence, and card Markdown fences. They must reach the same
existing code-part shape as native `code`/`code_block` nodes. This clarifies the
selected transport owner; it does not add another scanner. Styled inline code
remains distinct from fenced code.
Keep ordinary image/file/media nodes and native Markdown image resources in the
ordered resource projection, with existing download/deduplication behavior.

The actual reviewer card was read through both existing GET modes. Its
`user_card_content` response contains a Markdown `<at id=...></at>` and one open-ID
mention record, while the default response has no mention metadata and exposes
rendered resources. Current-source replay preserves the XML only as escaped text.
At `parse/card.ts:150-155` and `:262-269`, Markdown and plain-text fields currently
collapse into the same part; both structured `at` branches keep only the display
name. Pass the associated mention map into card parsing and resolve semantic
parts before that type distinction is lost. Do not add a card-only rewrite in
the channel renderer.

Retain the existing structured/default card read and merge owners. Each read is
parsed using its own metadata. Extend their visible-content comparison to account
for mention identity so the same mention in both views is not appended as new
content merely because it is no longer a text part. Preserve intentional repeated
mentions in the primary view and distinct identities sharing a name; do not add
global mention-ID deduplication. Hidden callback/control values remain excluded.

The channel serializes actual mention parts as
`<at user_id="ou_example">Example</at>`, matching native reply syntax. This
explicitly changes the model-facing mention attribute from `id` to `user_id`.
Remove the text-only raw-body reparsing in `feishu-message-render.ts:121-176`;
the channel should serialize parsed meaning, not independently recover it.
Keep normal text escaping and code CDATA. A selection-only replay shows why this
is needed: simply switching arrays leaves real `<at user_id>` tags as escaped
text. There is no outgoing `id`-to-`user_id` rewrite or shorthand converter.

For message GET alone, omit the explicit `user_id_type: 'open_id'` at
`transport/feishu.ts:616`. A live read of an incoming message mentioning this bot
returned `id_type: open_id` with the known bot ID when omitted, but `id_type:
app_id` when explicitly supplied. Current normalization mislabels the latter as
`open_id`. Also give received `app_id` an explicit normalizer case: retain the
record's key/name but do not place the application identifier into any supported
user identity slot. A regression assertion must show that this actual response
shape never becomes an open-ID mention or a model-facing `user_id="cli_..."`.
Retain `card_msg_content_type` when requested; do not add another bot
identity lookup or change other APIs' identity parameters.

The raw realtime event's `mentions` still drives admission before enrichment.
It is independent of the deleted reply argument, and body markup cannot replace
it. Interactive-card enrichment keeps its existing reads and lifecycle while its
parser/visible-content merge carries semantic mentions. Lazy merged forwards,
parent-reference behavior, resource handling, and slash-command entry-type
restrictions keep their existing contracts. Add end-to-end parser/body tests with the actual dual-array payload
shape instead of treating a synthetic `md` node in legacy `content` as sufficient.
Although admission does not consume parsed content, `normalizeInboundEvent`
does call the parser before reaching the gate. Parser termination and handling
of existing inputs remain necessary regression checks; raw-mention ownership
alone does not prove that every parser change is incapable of affecting receipt.

## Retire the unused renderer; keep raw card I/O

The operator states that claudemux is archived and this repository is the only
intended consumer of `feishu-transport`. Use current production calls as the
retention boundary. The earlier public-export/external-proxy preservation rule
is superseded; the historical import evidence does not keep an unused mechanism
in the current solution.

The renderer has two production callers today: `send` and
`editText -> renderSingleCard`. Both reply and `sendIntroduceAck` use `send`, so
both become native post. No current repository production caller uses `editText`.
Remove that method from the interface and implementation, including its
card-patch-to-text-update fallback, then remove the now-unreachable renderer.

Concrete deletion scope:

- Markdown token-to-card conversion, H1-to-card-header extraction, inline
  flattening, card-table generation, column partitioning, table pagination,
  element packing, and outgoing `<@...>` shorthand rewriting.
- `renderMarkdownToCards`, `renderSingleCard`, `cardToContent`, `cardContentBytes`,
  `RenderedCard` and renderer-only types/caps/exports. Remove `textMessageContent`
  when deleting its sole production consumer, the `editText` fallback.
- `applyMentions` after semantic text parsing replaces its last internal caller;
  `mentionName` and `extractPostText`, whose remaining references are exports and
  tests rather than production calls. Keep the real post parser and projection
  used by `parseInbound`; move relevant behavior checks to that actual entry.
- The empty renderer directory after relocating or integrating the existing
  pure `render/split.ts` functions into the native-post implementation. Reuse
  their line/fence/grapheme behavior directly; add no compatibility barrel,
  delegating wrapper, or second splitter.

The old `render/constants.ts` also supplies a byte-limit value used by explicit
card sends. Keep needed byte-size checks with the surviving send boundary and
retain the selected 28 KiB serialized-content budget; renderer deletion must not
remove actual card checks or create a second independent budget. Remove unused
renderer element/column/cell caps. Retain `marked`, which the native-post and
inbound parsing paths still need. The module move is now justified by retirement
of its original owner, not by a claim that the pure splitter depends on cards.

Raw `sendCard` and `editCard` serialize already-authored card objects directly;
question, binding, and reminder cards have real calls to them. Native COT uses
its own platform endpoints. These operations do not invoke the Markdown renderer
and remain. Preserve their cancellation, byte checks, expiry/settlement, and
message routing behavior.

Update the package's exported surface, type-based test stubs, package-boundary
expected export list, README, package description, and current architecture
comments to match the current-repository purpose. Do not preserve a method solely
because a test fake implements it. Keep the package-boundary enforcement itself.
Record the removed methods/exports, post presentation, and semantic mention
output in ordinary release notes. No state-format upgrade or publication-pipeline
change follows from this consumer-scope decision.

## Validation and delivery

- Exercise the actual tool session and transport with native post payloads,
  inline mentions, create/reply addressing, Markdown fidelity, and long content.
- Preserve existing assertions for per-message receipts, partial success,
  observer failures, topic addressing, raw card send/edit, cancellation, and
  native COT. Retire assertions for the explicitly removed renderer/editText
  surface. Preserve still-required long-text/Unicode/fence capabilities through
  native-post tests, and update the export inventory without weakening its gate.
- Verify JSON escaping, Unicode, long fenced code/tables, and inline XML at
  ordinary block boundaries. Distinguish platform payload tests from real client
  rendering/notification evidence.
- Cover both post projections, legacy posts, mention placeholders and native
  tags, literal tags/images inside code, and ordinary image/file resources in
  source order. Verify omitted GET identity type and unchanged incoming mention
  admission. The external reviewer confirmed native-post peer receipt using a
  dispatcher submission log and the verified raw-mention gate; preserve this live
  evidence separately from the implementation's automated checks.
- Cover existing card `markdown`/`lark_md`, simplified `at` nodes, nested visible
  fields, plain-text lookalikes, and quoted/unquoted native card IDs. Test the
  structured/default merge with repeated primary mentions and overlapping views.
  Existing card-based peer communication remains the admission regression baseline;
  the live receive-side uncertainty belongs only to the new native-post path.
- Verify the observed platform-rejection envelope through logging and MCP,
  alongside cancellation/network-error identity and partial-send observation.
- Run monorepo build, lint, test, and `typecheck:tests`; run `.agents/scripts/check.sh`.
- Generate Rush change notes for the changed channel/transport contracts and
  creation-time reply guidance, and actionable send failures. Identity formats
  remain readable as they are;
  the deferred array conversion contributes no version bump or rebuild note.
- Update the channel domain and package docs; add the previously missing reply
  presentation entry to the product catalog and record the inbound XML change.
  Remove current shared-proxy/rendering claims from the package description,
  README, and source comments; keep historical release/review records historical.
- Run an independent implementation review in the originating discussion after
  local verification, then prepare the reviewable PR against `next`.

## Known limits

Some native Markdown styles require a recent Feishu client. Unit tests can verify
request construction but not the actual native appearance or notification of a
person/peer bot; those require a live check. Native Markdown does not support
Setext headings, indented code blocks, email autolinks, raw HTML, or nested tables
and images within tables. Ordinary replies use one `md` node per row, respecting
the platform rule against mixing it with other inline nodes in that row. Feishu
now owns outgoing code-literal mention behavior; the initial probe exercises
tags in inline/fenced code and the supplement exercises empty names and bots.
No local mention-rewriting mechanism is added to compensate for native styling.
The flag research is complete at the
document/source/dry-run level, and no flag write or user OAuth is part of this
implementation.

## External review disposition

[Round-one review](https://github.com/excitedjs/dreamux/issues/410#issuecomment-5629682287)
requested changes. B1 now states the actual current caller and concrete future
empty-name XML; B2 is addressed by the shared inbound semantic parser across
text/post/cards and unified model-facing `user_id`. The operator explicitly
required existing peer-card compatibility after round one; the earlier text/post
only proposal was too narrow. Accept the existing-budget, single-adapter, code-literal,
public-send-contract, and native-subset corrections. Preserve long-table headers
with raw lines because dropping existing long-table delivery would be capability
loss; no Markdown writer is introduced. The later consumer-scope ruling supersedes
public-surface preservation for affected APIs with no remaining repository caller.
Peer-bot event evidence is tracked separately from the already accepted
five visual examples.

Round two returned
[sound-with-nits, no blocking findings](https://github.com/excitedjs/dreamux/issues/410#issuecomment-5629862950).
All six clarifications are incorporated above. The scope is already grounded in
the operator's reply change and subsequent explicit text/post/card compatibility
instructions. Implement them together; the feature must preserve communication
with peers still using existing card senders. Native-post peer receipt is
confirmed by the reviewer's receiver-side submission log plus the raw-mention
gate trace. The original webhook body was not captured in that evidence; its
mention contents are a supported inference from admission, not a quoted payload.
The supplementary empty-name client's visual appearance remains unconfirmed.

## Additional operator-requested identity experiment

The operator did not approve development on the authorization card, instead asking
whether the new native post could directly mention a peer bot by application ID.
Two direct-HTTP variants were tried: native `md` XML with the application ID in
`user_id`, and a dedicated post `at` node with the same value. Both posts were
accepted, but both send responses and default GET readbacks contained zero mention
records. The existing open-ID comparison has a real mention and verified peer
admission. The receiver independently reported no inbound submission or gate-drop
record for either app-ID probe, with normal neighboring events and positive
ordinary-mention controls. Its readbacks also contain no mention metadata. This
supports failure to trigger delivery; the original webhook was not captured, so
do not claim a complete negative delivery trace from log absence.

The experiment does not support replacing replyable bot identities with
application IDs in these tested post forms. Preserve the already verified open-ID
path, obtaining replyable IDs directly from default message reads rather than
adding an application-to-open-ID lookup. Keep the proposal pending the operator's
remaining questions; neither probe completion nor review grants development
authorization.
