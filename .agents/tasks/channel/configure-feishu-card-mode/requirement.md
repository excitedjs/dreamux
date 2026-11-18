# Requirement

## Initial request

Operator source wording:

> feishu-channel 增加一个配置项目吧，card_mode，可选 interactive 和 非 interactive ，interactive 的 width_mode 还有其他参数么？

The same conversation asked how botmux sends images and makes cards wider. The
operator then explicitly added outbound local-image delivery to this task:

> 那我感觉我们可以仿照他的实现，但是不需要新增一个 image 参数，而是直接在 正文里写 !\[图片名称]\(本地绝对路径)，然后解析 markdown，拿到标签，走botmux 同款的上传逻辑。

The operator also added non-image artifacts:

> reply 工具可以加一个可选的 artifacts 参数，用于发送非图片的附件，比如视频、压缩包之类的。

Width configuration remains excluded without an explicit operator decision.

## Current alignment

- Status: Confirmed by the operator on 2026-11-18 through the revised requirement card ("确认完整需求 (Recommended)").
- Desired outcome: Let each Feishu channel instance select how an agent's
  ordinary `reply` Markdown is presented.
- Proposed configuration: `card_mode: "interactive" | "post"`; omitted means
  `interactive`. `post` is the concrete native non-interactive representation,
  not a third presentation mechanism.
- Scope: Feishu channel config validation and the ordinary `reply` send path,
  including the transport envelope and message type it selects; parse actual
  Markdown image nodes with local absolute-path sources, upload those images
  through Feishu, and replace the sources with returned image keys; add an
  optional `artifacts` reply argument for non-image local attachments such as
  videos and archives.
- Non-goals: No new `reply` image argument, no new width configuration, no
  change to explicit `sendCard`, `ask_user_question`, binding cards, COT,
  inbound parsing, routing, or reply tool addressing arguments.

## Confirmed current behavior and evidence

- `packages/channel/feishu-channel/src/provider.ts` validates `app_id`,
  `app_secret`, and `cot`; no `card_mode` exists.
- `packages/channel/feishu-transport/src/transport/message-content.ts` wraps
  every ordinary reply in Card JSON 2.0 with one Markdown element and
  `update_multi: true`; it does not set `width_mode`.
- `packages/channel/feishu-transport/src/transport/outbound-message.ts`
  hardcodes ordinary text and raw-card sends to `msg_type: "interactive"`.
- `packages/channel/feishu-transport/src/transport/feishu.ts` splits oversized
  replies in order and observes each successful send before the next.
- The product catalog selects compact Markdown cards over native posts because
  native-post text renders larger. Making cards the omitted default preserves
  that ruling while allowing an explicit operator choice.
- The pre-card implementation retained in git history used
  `{ zh_cn: { content: [[{ tag: "md", text: body }]] } }` with
  `msg_type: "post"` and the same serialized-content splitting discipline. This
  is implementation evidence, not authorization to restore the old renderer.

## Desired behavior

1. A channel configured with `card_mode: "interactive"`, or with no
   `card_mode`, keeps the current Markdown-card reply behavior.
2. A channel configured with `card_mode: "post"` sends ordinary replies as
   native Feishu rich-text posts containing one `md` node with the authored
   Markdown and inline mentions unchanged.
3. Both modes preserve create/reply addressing, ordered long-message splitting,
   the 28 KiB serialized-content budget, Unicode/code/table boundaries,
   delivery receipts, and platform error details.
4. Invalid `card_mode` values fail config loading with a field-specific error;
   omission does not make an existing config unreadable.
5. Explicit interactive cards and COT remain interactive regardless of the
   ordinary reply mode.
6. In either reply mode, an actual Markdown image written as
   `!\[图片名称]\(/local/absolute/path)` is read from that local path and uploaded
   with Feishu's `im.v1.image.create` using `image_type: "message"`; the
   Markdown source is replaced with the returned `image_key` before the card or
   native post is sent. No new tool argument or `img:N` placeholder is exposed.
7. Markdown image syntax inside code examples and ordinary links must not be
   treated as local images. Existing remote/image-key references remain
   unchanged. Image read/upload failures and the handling of non-image files
   are technical-solution decisions that must preserve honest delivery errors.
8. `reply` accepts optional `artifacts`, proposed as an array of local absolute
   paths for non-image attachments. Upload and deliver each artifact to the
   same resolved conversation as the reply, using Feishu's native file/media
   message form rather than putting it in the Markdown card. Preserve artifact
   order and return every resulting message id. The exact text/artifact send
   ordering and file-versus-media mapping are technical-solution decisions.

## Constraints and invariants

- Feishu channel config remains channel-owned; core and neutral channel
  contracts do not learn this Feishu setting.
- The transport owns Feishu message envelopes and wire message types. It must
  not learn Dreamux dispatcher config or routing state.
- Do not restore the retired title/table Markdown-to-card renderer or add a
  fallback renderer.
- Reuse the existing `marked` dependency in `message-content.ts` for actual
  Markdown token recognition; do not add a second Markdown AST stack.
- Image upload is a low-level Feishu transport capability. Local-file read
  policy and any Dreamux-facing error presentation stay above the raw SDK
  wrapper, without changing neutral core contracts.
- `width_mode` research is informational: Card JSON 2.0 accepts `default`,
  `compact`, and `fill`. This task leaves current width behavior unchanged
  unless the operator explicitly expands scope.
- Update the product behavior catalog, channel architecture record, Feishu
  maintenance reference, and Rush change notes with the implementation.

## Acceptance criteria

- Config tests prove omitted/`interactive`/`post` handling and rejection of an
  invalid value.
- Transport tests observe a Card 2.0 interactive payload in the default mode
  and a native `post` payload with one `md` node in post mode, for both create
  and reply addressing.
- The same long prose, Unicode, fenced-code, table, mention, receipt, and
  platform-error contracts hold in both modes.
- Image-token tests cover absolute local paths, alt text, remote/image-key
  references left untouched, code examples left untouched, and the exact
  uploaded-bytes-to-rewritten-Markdown behavior in both reply modes.
- An image read or upload failure produces an honest tool/send error and never
  presents an unsent local image as successfully delivered.
- Tool-schema and transport tests prove `artifacts` is optional, carries local
  non-image paths, uploads the intended bytes, uses the same create/reply
  destination, preserves artifact order, and returns all message ids. Cover a
  video and an archive as representative native attachment types.
- An artifact read/upload failure is reported honestly; already-sent text or
  artifact receipts remain observable rather than being erased.
- Explicit cards and COT remain on their existing interactive paths.
- Build, lint, test, test typechecking, and knowledge checks pass.

## Decisions and unknowns

- Confirmed operator decisions: On 2026-11-18 the operator selected "创建新任务
  (Recommended)" for this requirement lineage; explicitly required inline
  absolute-path Markdown images instead of an image argument; explicitly
  requested optional `artifacts` for non-image attachments; and selected
  "确认完整需求 (Recommended)" for the complete recorded scope, including the
  concrete `post` enum, default `interactive`, and exclusion of width changes.
- Technical-solution choices: Local file validation and failure behavior,
  upload/read ownership, exact text/artifact send ordering, and native
  file-versus-media mapping must be settled in the final solution without
  expanding the confirmed product scope.
- Blocking unknowns: None.
