/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. This module turns that into the plain text the
 * channel forwards to Claude. Attachment message types (image, file) are
 * summarized as a short text marker — the channel forwards text, not binaries.
 */

import type { Mention } from './types'

/** The subset of an inbound Feishu message this module reads. */
export interface InboundMessage {
  message_type?: string
  /** JSON-encoded content string, as delivered by Feishu. */
  content?: string
  mentions?: Mention[]
}

export interface ParsedInbound {
  /** Human-readable text to forward to Claude. */
  text: string
}

/**
 * Parse one inbound Feishu message into forwardable text. Never throws —
 * malformed content falls back to a best-effort string so a weird message
 * still reaches Claude.
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
      return { text: '(image)' }
    case 'file': {
      const fileName = typeof content.file_name === 'string' ? content.file_name : 'unknown'
      return { text: `(file: ${fileName})` }
    }
    default:
      return { text: `(${type} message)` }
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
