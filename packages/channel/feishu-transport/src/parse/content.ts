/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. This module turns that into the plain text the
 * channel forwards to the engine. Attachment message types (image, file) are
 * summarized as a short text marker — the channel forwards text, not binaries.
 *
 * Ported verbatim from claudemux's `feishu-channel/src/content.ts` (the source
 * of truth — it carries the `interactive`-card parse dreamux's drifted copy had
 * lost); only the `./types` import was repointed to `../contract/types`.
 */

import type { Mention } from '../contract/types.js'

/** The subset of an inbound Feishu message this module reads. */
export interface InboundMessage {
  message_type?: string
  /** JSON-encoded content string, as delivered by Feishu. */
  content?: string
  mentions?: Mention[]
}

export interface ParsedInbound {
  /** Human-readable text to forward to the engine. */
  text: string
  /** Structured message resources discovered in Feishu content. */
  resources?: InboundResource[]
  /** Optional flat/narrow metadata supplied by the host's event normalizer. */
  meta?: Record<string, unknown>
}

export type InboundResourceType = 'file' | 'image'

export interface InboundResource {
  type: InboundResourceType
  /** Feishu message resource key (`file_key` / `image_key`) when present. */
  key?: string
  /** Original user-facing filename. Treat as display text, never a path. */
  name?: string
}

export interface ChannelInbound {
  /** Flattened markdown-ish text suitable for a narrow channel payload. */
  text: string
  /** Flat string-only metadata with protocol-safe underscore keys. */
  meta: Record<string, string>
}

/**
 * Parse one inbound Feishu message into forwardable text. Never throws —
 * malformed content falls back to a best-effort string so a weird message
 * still reaches the engine.
 */
export function parseInbound(message: InboundMessage): ParsedInbound {
  const type = message.message_type ?? 'unknown'

  let parsed: unknown
  try {
    parsed = JSON.parse(message.content ?? '')
  } catch {
    return { text: message.content ?? '(unparseable message)' }
  }
  const content = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  switch (type) {
    case 'text': {
      const text = typeof content.text === 'string' ? content.text : ''
      return { text: applyMentions(text, message.mentions) }
    }
    case 'post':
      return { text: extractPostText(content) }
    case 'image':
      return {
        text: '(image message)',
        resources: [{
          type: 'image',
          ...(typeof content.image_key === 'string' ? { key: content.image_key } : {}),
        }],
      }
    case 'file': {
      return {
        text: '(file message)',
        resources: [{
          type: 'file',
          ...(typeof content.file_key === 'string' ? { key: content.file_key } : {}),
          ...(typeof content.file_name === 'string' ? { name: content.file_name } : {}),
        }],
      }
    }
    case 'interactive':
      return { text: extractInteractiveText(content) }
    default:
      return { text: `(${type} message)` }
  }
}

/**
 * Extract canonical, narrow metadata from a Feishu inbound event envelope.
 *
 * Content parsing only sees `message.content`; identifiers such as
 * `message_id`, `chat_id`, and `sender_id` live in the event envelope. Keeping
 * this Feishu-specific field mapping in core prevents dreamux and claudemux
 * from copy-drifting it in their host adapters.
 */
export function narrowMetaFromEvent(rawEvent: unknown): Record<string, unknown> {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return {}
  const root = rawEvent as Record<string, unknown>
  const event = asRecord(root.event) ?? root
  const message = asRecord(event.message) ?? {}
  const sender = asRecord(event.sender) ?? {}
  const senderId = asRecord(sender.sender_id)

  return omitEmptyStrings({
    message_id: asString(message.message_id),
    chat_id: asString(message.chat_id),
    chat_type: asString(message.chat_type),
    sender_id: asString(senderId?.open_id),
    // Diagnostic only. A bot's open_id is app-scoped, so a dropped peer-bot
    // message's union_id helps an operator tell "same bot, different scope" from
    // "different entity" after the fact. It is never used for access matching.
    sender_union_id: asString(senderId?.union_id),
    sender_type: asString(sender.sender_type),
    root_id: asString(message.root_id),
    parent_id: asString(message.parent_id),
    create_time: asString(message.create_time),
  })
}

/**
 * Convert parsed inbound content into the channel protocol's narrow payload.
 *
 * `parseInbound` owns Feishu content flattening; the host may add raw event
 * metadata under `parsed.meta` before calling this. This function is deliberately
 * engine-agnostic: it preserves only text plus a flat string metadata bag. Keys
 * with hyphens or other protocol-unsafe characters are dropped, and nested /
 * non-string values are not stringified blindly.
 */
export function toChannelInbound(parsed: ParsedInbound): ChannelInbound {
  const text = parsed.text === '' ? '(empty message)' : parsed.text
  return { text, meta: sanitizeChannelMeta(parsed.meta) }
}

const CHANNEL_META_KEY_RE = /^[A-Za-z0-9_]+$/

function sanitizeChannelMeta(meta: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!meta) return out
  for (const [key, value] of Object.entries(meta)) {
    if (!CHANNEL_META_KEY_RE.test(key)) continue
    if (typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function omitEmptyStrings(input: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

/**
 * Feishu WebSocket events for interactive cards wrap the real v2 card JSON as a
 * JSON-encoded string under `user_dsl`. Unwrap it so the extractor below always
 * sees the card schema directly.
 */
function unwrapUserDsl(card: Record<string, unknown>): Record<string, unknown> {
  const dsl = card.user_dsl
  if (typeof dsl !== 'string') return card
  try {
    const inner: unknown = JSON.parse(dsl)
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return card
}

/**
 * Extract plain text from a v2 interactive card content object.
 * Handles feishu-channel cards (tag: markdown) and Dbotmux / other bots'
 * cards (tag: div with text.content, tag: column_set, etc.).
 */
function extractInteractiveText(card: Record<string, unknown>): string {
  const c = unwrapUserDsl(card)
  const parts: string[] = []

  const header = c.header
  if (header && typeof header === 'object') {
    const title = (header as Record<string, unknown>).title
    if (title && typeof title === 'object') {
      const tc = (title as Record<string, unknown>).content
      if (typeof tc === 'string' && tc.trim()) parts.push(tc)
    }
  }

  const body = c.body
  const elements = body && typeof body === 'object'
    ? (body as Record<string, unknown>).elements
    : c.elements
  if (Array.isArray(elements)) {
    for (const el of elements) extractCardElementText(el, parts)
  }

  return parts.join('\n') || '(interactive card)'
}

/** Recursively extract readable text from a v2 card element. */
function extractCardElementText(el: unknown, parts: string[]): void {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return
  const e = el as Record<string, unknown>
  const tag = e.tag as string | undefined

  if (tag === 'markdown' || tag === 'plain_text' || tag === 'div') {
    // `content` is a direct string in feishu-channel cards;
    // `text.content` is used when the text is a nested object (other bots).
    const textObj = e.text
    const text =
      textObj && typeof textObj === 'object'
        ? (textObj as Record<string, unknown>).content
        : e.content
    if (typeof text === 'string' && text.trim()) parts.push(text)

    // div.fields[] — lark_md cells in field-layout cards from other bots.
    if (Array.isArray(e.fields)) {
      for (const f of e.fields) {
        if (!f || typeof f !== 'object') continue
        const fo = f as Record<string, unknown>
        const ft =
          fo.text && typeof fo.text === 'object'
            ? (fo.text as Record<string, unknown>).content
            : fo.content
        if (typeof ft === 'string' && ft.trim()) parts.push(ft)
      }
    }
  }

  // column_set → columns[].elements[]
  if (Array.isArray(e.columns)) {
    for (const col of e.columns) {
      if (!col || typeof col !== 'object') continue
      const co = col as Record<string, unknown>
      if (Array.isArray(co.elements)) {
        for (const child of co.elements) extractCardElementText(child, parts)
      }
    }
  }

  // Generic child elements (action blocks, nested containers)
  if (Array.isArray(e.elements)) {
    for (const child of e.elements) extractCardElementText(child, parts)
  }
}

/**
 * Replace Feishu's `@_user_N` placeholders in text with the mentioned display
 * names, so the forwarded message reads naturally.
 */
export function applyMentions(text: string, mentions: Mention[] | undefined): string {
  if (!mentions) return text
  let out = text
  for (const m of mentions) {
    if (m.key && m.name) {
      out = out.split(m.key).join(`@${m.name}`)
    }
  }
  return out
}

/** Return the display name for an open_id in a Feishu mention list, if present. */
export function mentionName(
  mentions: Mention[] | undefined,
  openId: string,
): string | undefined {
  return mentions?.find((m) => m.id?.open_id === openId)?.name
}

/**
 * Flatten a Feishu rich-text "post" payload into plain text. A post is
 * locale-wrapped (`{ zh_cn: { title, content } }`) and its body is an array of
 * paragraphs, each an array of tagged inline elements.
 */
export function extractPostText(content: Record<string, unknown>): string {
  const post = pickPostLocale(content)
  const lines: string[] = []

  if (typeof post.title === 'string' && post.title.length > 0) {
    lines.push(post.title)
  }
  const body = post.content
  if (Array.isArray(body)) {
    for (const paragraph of body) {
      if (!Array.isArray(paragraph)) continue
      lines.push(paragraph.map(renderPostElement).join(''))
    }
  }
  return lines.join('\n')
}

/** Pick the first present locale block of a post, falling back to the raw object. */
function pickPostLocale(content: Record<string, unknown>): Record<string, unknown> {
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const block = content[locale]
    if (block && typeof block === 'object') return block as Record<string, unknown>
  }
  return content
}

/** Render one inline post element to text. */
function renderPostElement(el: unknown): string {
  if (!el || typeof el !== 'object') return ''
  const e = el as Record<string, unknown>
  switch (e.tag) {
    case 'text':
      return typeof e.text === 'string' ? e.text : ''
    case 'a':
      return typeof e.text === 'string'
        ? e.text
        : typeof e.href === 'string'
          ? e.href
          : ''
    case 'at':
      return `@${typeof e.user_name === 'string' ? e.user_name : ''}`
    case 'img':
      return '(image)'
    default:
      return ''
  }
}
