import type { Mention } from '../contract/types.js'
import { createBody, type ParsedInbound } from './body.js'
import { readInlineMarkdown } from './inline.js'

/**
 * Read a card as the text it displays and the resources it embeds.
 *
 * A card event carries the whole card: `user_dsl` for a card authored in the
 * current schema, the outer object for an older one. Every `content` / `text`
 * string the card holds is one line of the body, in document order, and
 * every image or file component is a resource at its position. Layout,
 * controls, callback values, and link targets are not read; a template card
 * carries no readable text at all.
 */
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
      } else {
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
