/**
 * Render a Markdown source into one or more Feishu v2 interactive cards.
 *
 * This entry point parses block tokens with `marked.lexer`, routes headings,
 * horizontal rules, and GFM tables to Feishu card-native elements, and delegates
 * byte/element-budget packing to focused renderer helpers.
 */

import { marked, type Token, type Tokens } from 'marked'

import {
  CARD_CONTENT_SAFE_BYTES,
  FEISHU_CARD_ELEMENT_HARD_CAP,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
} from './constants.js'
import {
  cardContentBytes,
  packIntoCards,
} from './pack.js'
import { tableTokenToElements } from './table.js'
import type { CardElement, CardHeader, RenderedCard } from './types.js'

export {
  CELL_MAX_BYTES,
  FEISHU_CARD_ELEMENT_HARD_CAP,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
} from './constants.js'
export { cardContentBytes, cardToContent } from './pack.js'
export { splitMarkdownByBytes } from './split.js'
export type { RenderedCard } from './types.js'

/**
 * Convert `<@ou_...>` shorthand into the lark_md `<at id="ou_..."></at>`
 * mention tag, leaving inline code spans untouched. Fenced code block tokens
 * are excluded upstream by the `token.type === 'code'` guard.
 */
function replaceAtMentions(text: string): string {
  const parts: string[] = []
  let lastIndex = 0
  const codeSpan = /`+[\s\S]*?`+/g
  let match: RegExpExecArray | null
  while ((match = codeSpan.exec(text)) !== null) {
    parts.push(
      text
        .slice(lastIndex, match.index)
        .replace(/<@(ou_[A-Za-z0-9_-]+)>/g, '<at id="$1"></at>'),
    )
    parts.push(match[0])
    lastIndex = match.index + match[0].length
  }
  parts.push(
    text.slice(lastIndex).replace(/<@(ou_[A-Za-z0-9_-]+)>/g, '<at id="$1"></at>'),
  )
  return parts.join('')
}

/**
 * Render a Markdown source into one or more v2 cards.
 *
 * The output is always non-empty: an empty source produces one card with a
 * single empty `tag: markdown` element. Splitting happens automatically when
 * the serialised card would exceed Feishu's byte cap, the body would exceed
 * the element cap, or a table has more than 50 columns.
 */
export function renderMarkdownToCards(text: string): RenderedCard[] {
  const tokens = marked.lexer(text)
  const { header, elements } = tokensToElements(tokens)
  const cards = packIntoCards(elements, header)
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i] as RenderedCard
    const bytes = cardContentBytes(card)
    const count = card.body.elements.length
    if (bytes > CARD_CONTENT_SAFE_BYTES) {
      throw new Error(
        `rendered card ${i + 1} of ${cards.length} is ${bytes} bytes; ` +
          `Feishu rejects a card body over ${FEISHU_CARD_REQUEST_LIMIT_BYTES} bytes. ` +
          'Reduce the content (shorter paragraphs, fewer rows in any one table).',
      )
    }
    if (count > FEISHU_CARD_ELEMENT_HARD_CAP) {
      throw new Error(
        `rendered card ${i + 1} of ${cards.length} has ${count} elements; ` +
          `Feishu rejects a card with more than ${FEISHU_CARD_ELEMENT_HARD_CAP} elements. ` +
          'Combine adjacent paragraphs or send fewer items per reply.',
      )
    }
  }
  return cards
}

function tokensToElements(tokens: Token[]): {
  header: CardHeader | undefined
  elements: CardElement[]
} {
  let header: CardHeader | undefined
  const elements: CardElement[] = []

  for (const token of tokens) {
    if (token.type === 'space') continue

    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      const flat = flattenInline(heading.tokens)
      if (heading.depth === 1 && header === undefined) {
        header = { title: { tag: 'plain_text', content: flat } }
        continue
      }
      elements.push({ tag: 'markdown', content: `**${flat}**` })
      continue
    }

    if (token.type === 'hr') {
      elements.push({ tag: 'hr' })
      continue
    }

    if (token.type === 'table') {
      for (const table of tableTokenToElements(token as Tokens.Table)) {
        elements.push(table)
      }
      continue
    }

    const raw = (token as { raw?: string }).raw ?? ''
    const trimmed = raw.replace(/\n+$/, '')
    if (trimmed.length === 0) continue
    const content = token.type === 'code' ? trimmed : replaceAtMentions(trimmed)
    elements.push({ tag: 'markdown', content })
  }

  if (elements.length === 0 && header === undefined) {
    elements.push({ tag: 'markdown', content: '' })
  }

  return { header, elements }
}

function flattenInline(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  let out = ''
  for (const token of tokens) {
    if ('tokens' in token && Array.isArray(token.tokens)) {
      out += flattenInline(token.tokens as Token[])
      continue
    }
    out += (token as { text?: string }).text ?? ''
  }
  return out
}
