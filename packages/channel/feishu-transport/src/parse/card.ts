import type { Mention } from '../contract/types.js'
import { createBody, type ParsedInbound } from './body.js'
import { readInlineMarkdown } from './inline.js'

/**
 * Read a card as the text it displays and the resources it embeds.
 *
 * A card event carries the whole card: `user_dsl` for a card authored in the
 * current schema, the outer object for an older one. Every `content` / `text`
 * string the walk reaches is one line of the body, in document order, and
 * every image or file component is a resource at its position. The walk
 * descends only through the keys a card displays its children under, so
 * layout, controls beyond their labels, callback payloads (`value`,
 * `behaviors`), and link targets are never reached: a card another bot
 * authored cannot put text in front of the model that the client does not
 * show. A template card carries no readable text at all.
 */

/**
 * The keys a card displays its children under: the card body and header, the
 * header's title and subtitle, the containers, and the `text` object that
 * wraps a control's label. `i18n_elements` is handled apart because it is
 * keyed by locale.
 */
const DISPLAY_KEYS = new Set([
  'body', 'header', 'title', 'subtitle', 'elements', 'columns', 'fields',
  'actions', 'rows', 'cells', 'extra', 'text',
])

export function parseCardContent(
  outer: Record<string, unknown>,
  mentions: Mention[] | undefined,
): ParsedInbound {
  const card = unwrapUserDsl(outer)
  const body = createBody()
  if (card.type === 'template') return body.build(true)

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    const node = asRecord(value)
    if (node === undefined) return
    if (node.tag === 'img' || node.tag === 'image') {
      const key = stringValue(node.image_key) ?? stringValue(node.img_key)
      if (key !== undefined) body.line(body.attach('image', key, `${key}.jpg`))
    } else if (node.tag === 'file') {
      const key = stringValue(node.file_key)
      if (key !== undefined) {
        body.line(body.attach('file', key, stringValue(node.file_name)))
      }
    }
    for (const [name, child] of Object.entries(node)) {
      if ((name === 'content' || name === 'text') && typeof child === 'string') {
        body.line(readInlineMarkdown(child, mentions, body))
      } else if (name === 'i18n_elements') {
        for (const locale of Object.values(asRecord(child) ?? {})) walk(locale)
      } else if (DISPLAY_KEYS.has(name)) {
        walk(child)
      }
    }
  }
  walk(card)
  return body.build()
}

function unwrapUserDsl(
  outer: Record<string, unknown>,
): Record<string, unknown> {
  const dsl = outer.user_dsl
  if (typeof dsl !== 'string') return asRecord(dsl) ?? outer
  try {
    return asRecord(JSON.parse(dsl)) ?? outer
  } catch {
    return outer
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
