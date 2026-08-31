# Channel input is assembled by each runtime; no-leak clarified to routing-only

- **Status:** Accepted
- **Date:** 2026-06-09
- **Affects:** the runtime turn contract `turn.ts`
  (since #209 the contract lived in `@excitedjs/dreamux-types`, not core; the
  file was deleted in the #350 follow-up cleanup — see the note below),
  both builtins' `channelInput`, the Feishu channel message layer
  [`/packages/channel/feishu-channel/src/feishu-message.ts`](/packages/channel/feishu-channel/src/feishu-message.ts),
  and the no-leak boundary in
  [`/packages/dreamux/CLAUDE.md`](/packages/dreamux/CLAUDE.md)
- **PR / Issue:** [#164](https://github.com/excitedjs/dreamux/issues/164)

## Context

Inbound Feishu messages were rendered to their final `<feishu_message>` XML by
the channel layer (`formatFeishuMessageForRuntime`), which handed the runtime a
single pre-rendered `InboundTurnInput.text`. Both builtins consumed that string
verbatim, so the channel — not the runtime — owned the model-visible inbound
format. We wanted each runtime to own assembling its own channel block (so the
two engines can diverge later — e.g. claude inlining image content blocks vs
codex text references) while both render claude-code's native `<channel>`
envelope today.

This collided with the standing invariant *"channel routing attributes (chat id,
sender id, message id) … never cross into the runtime"*: assembling the block
inside the runtime means those values must reach it.

## Decision

**Split routing from display.** The invariant is *clarified*, not retired:

- **Routing/identity decisions stay in the channel layer (still banned from the
  runtime).** A runtime must never branch, route, or reply-target on `chat_id` /
  `sender_id` / message ids. Reply targeting remains a channel-layer concern: the
  Feishu reply MCP tool takes `chat_id` as an explicit parameter.
- **Opaque display passthrough is allowed.** `InboundTurnInput` gains a neutral
  `source` label, an opaque `attrs: Array<[string, string]>` bag, a pre-rendered
  `body`, and structured `attachments`. The runtime renders `attrs`/`body`
  verbatim into its block via the shared neutral `renderChannelInput` /
  `renderChannelBlock` (in `turn.ts`, so both builtins reuse them with no
  cross-builtin import) but never interprets them.

The Feishu channel stops emitting XML and returns structured pieces (`attrs`,
`body`, `attachments`); `body` carries the full prior inner content (message +
mentions + parser fallback + attachment refs + group-bots block) so no
model-visible content is dropped. The structured `attachments` field is reserved
for future per-runtime rendering and is not consumed by the wrap today.

Both runtimes call `renderChannelInput`, so they render byte-identical
`<channel source="feishu" …>` blocks today; the per-runtime seam is preserved
for later divergence. The literal string `"feishu"` lives only in the channel
layer (passed as `source` data) — neither builtin nor `turn.ts` hardcodes it.

## Consequences

- The runtime contract `InboundTurnInput` is wider, but stays channel-neutral
  (no `feishu`-typed field names).
- A future channel populates the same neutral fields; a future runtime may
  render `attachments` differently without a contract change.
- This is an in-process contract change only — no persisted file format, so no
  changelog/rebuild entry (the 0.x fail-loud policy does not apply).

## Since This Was Recorded (2026-08-31)

The vehicles named above are gone. `InboundTurnInput` / `InboundAttachment` and
the shared `renderChannelInput` / `renderChannelBlock` pre-renderers were deleted
in the #350 follow-up cleanup. What disappeared is the *structured* turn contract
a runtime used to receive and destructure; the Agent Runtime seam now carries
text alone.

- **The routing/display split still binds, in its original form.** A Channel
  still emits opaque `attrs` plus a faithful `body`, and routing ids —
  `chat_id`, `sender_id`, `message_id` — still reach a model, rendered as
  attribute text inside the provenance envelope exactly as this record decided.
  What a runtime must never do is receive them as structured fields or branch,
  route, or reply-target on them; reply targeting stays a channel-layer concern.
- **The assembly locus moved.** Core, not each runtime, now renders the one
  provenance envelope every runtime reads:
  [`/packages/dreamux/src/service/channel-submission.ts`](/packages/dreamux/src/service/channel-submission.ts)
  and
  [`/packages/dreamux/src/service/teammate-service/submission.ts`](/packages/dreamux/src/service/teammate-service/submission.ts).
  The current behavior is owned by
  [`channel-routing-and-binding`](../domains/channel-routing-and-binding.md);
  this record is kept for the *why* of the routing/display split, not as a
  description of where the rendering happens today.
