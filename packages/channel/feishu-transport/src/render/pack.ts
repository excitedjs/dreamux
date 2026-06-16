import {
  CARD_CONTENT_SAFE_BYTES,
  CARD_ELEMENT_SAFE_CAP,
} from './constants.js'
import { splitMarkdownByBytes } from './split.js'
import type {
  CardElement,
  CardHeader,
  MarkdownElement,
  RenderedCard,
  TableElement,
} from './types.js'

export function packIntoCards(
  elements: CardElement[],
  header: CardHeader | undefined,
): RenderedCard[] {
  const cards: RenderedCard[] = []
  let current = newCard(header)
  let isFirstCard = true

  const flush = (): void => {
    if (current.body.elements.length === 0 && current.header === undefined) return
    cards.push(current)
    isFirstCard = false
    current = newCard(undefined)
  }

  const tryAdd = (element: CardElement): boolean => {
    if (current.body.elements.length + 1 > CARD_ELEMENT_SAFE_CAP) return false
    const trial: RenderedCard = {
      ...current,
      body: { elements: [...current.body.elements, element] },
    }
    return cardContentBytes(trial) <= CARD_CONTENT_SAFE_BYTES
  }

  const addPiece = (piece: CardElement): void => {
    if (!tryAdd(piece)) {
      if (current.body.elements.length > 0) flush()
    }
    current.body.elements.push(piece)
  }

  for (const element of elements) {
    if (tryAdd(element)) {
      current.body.elements.push(element)
      continue
    }
    if (current.body.elements.length > 0) flush()
    if (tryAdd(element)) {
      current.body.elements.push(element)
      continue
    }
    const pieces = splitOversizedElement(element, isFirstCard ? header : undefined)
    for (const piece of pieces) addPiece(piece)
  }

  flush()
  if (cards.length === 0) cards.push(newCard(header))
  return cards
}

/** Serialise one card into Feishu's `im.message.create` content string. */
export function cardToContent(card: RenderedCard): string {
  return JSON.stringify(card)
}

/** Byte length of `card`'s serialised content, in UTF-8. */
export function cardContentBytes(card: RenderedCard): number {
  return Buffer.byteLength(cardToContent(card), 'utf8')
}

function newCard(header: CardHeader | undefined): RenderedCard {
  const card: RenderedCard = {
    schema: '2.0',
    config: { update_multi: true },
    body: { elements: [] },
  }
  if (header) card.header = header
  return card
}

function splitOversizedElement(
  element: CardElement,
  headerOnFirstCard: CardHeader | undefined,
): CardElement[] {
  if (element.tag === 'markdown') {
    return splitMarkdownElement(element, headerOnFirstCard)
  }
  if (element.tag === 'table') {
    return splitTableByRows(element, headerOnFirstCard)
  }
  return [element]
}

function splitMarkdownElement(
  element: MarkdownElement,
  headerOnFirstCard: CardHeader | undefined,
): MarkdownElement[] {
  const envelope = cardContentBytes(newCardWithEmpty(headerOnFirstCard))
  const innerBudget = Math.max(256, CARD_CONTENT_SAFE_BYTES - envelope - 256)
  return splitMarkdownByBytes(element.content, innerBudget).map((content) => ({
    tag: 'markdown',
    content,
  }))
}

function newCardWithEmpty(header: CardHeader | undefined): RenderedCard {
  const card = newCard(header)
  card.body.elements.push({ tag: 'markdown', content: '' })
  return card
}

function splitTableByRows(
  table: TableElement,
  headerOnFirstCard: CardHeader | undefined,
): TableElement[] {
  if (table.rows.length <= 1) return [table]
  const envelope = cardContentBytes(newCardWithEmpty(headerOnFirstCard))
  const budget = Math.max(2048, CARD_CONTENT_SAFE_BYTES - envelope - 256)
  const out: TableElement[] = []
  let start = 0
  while (start < table.rows.length) {
    let end = table.rows.length
    while (end > start + 1) {
      const candidate: TableElement = { ...table, rows: table.rows.slice(start, end) }
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= budget) break
      end -= 1
    }
    out.push({ ...table, rows: table.rows.slice(start, end) })
    if (end === start) break
    start = end
  }
  return out
}
