import type { Mention } from '../contract/types.js'
import { markdownParts } from './markdown.js'
import { resolveMentionPart } from './mention.js'
import {
  appendTextPart,
  resourceIdentity,
  resourcePart,
  type InboundContentPart,
  type ParsedContent,
} from './parts.js'

const CARD_UPGRADE_FALLBACK = '请升级至最新版本客户端'
const CARD_NODE_LIMIT = 5_000
const CARD_DEPTH_LIMIT = 32
const CARD_CONTAINER_TAGS = new Set([
  '',
  'action',
  'column',
  'column_set',
  'collapsible_panel',
  'form',
  'table',
])

interface CardRenderState {
  parts: InboundContentPart[]
  mentions: Mention[] | undefined
  visitedNodes: number
  budgetExhausted: boolean
  incomplete: boolean
}

/** A visible card field, and whether its value is Markdown or literal text. */
interface CardField {
  text: string
  markdown: boolean
}

/** Parse the default/simplified and v2/user-DSL card representations. */
export function parseInteractiveContent(
  outer: Record<string, unknown>,
  mentions?: Mention[],
): ParsedContent {
  const card = unwrapUserDsl(outer)
  if (card.type === 'template') {
    return {
      parts: [],
      compatibilityText: '(interactive template card)',
      incomplete: true,
    }
  }
  const state: CardRenderState = {
    parts: [],
    mentions,
    visitedNodes: 0,
    budgetExhausted: false,
    incomplete: false,
  }
  const title = visibleLocalizedText(card.title) ??
    visibleLocalizedText(asRecord(card.header)?.title)
  if (title !== undefined) pushCardText(state, title)


  const body = asRecord(card.body)
  const elements = Array.isArray(body?.elements)
    ? body.elements
    : Array.isArray(card.elements)
      ? card.elements
      : pickLocalizedElements(body?.i18n_elements) ??
        pickLocalizedElements(card.i18n_elements)
  if (elements !== undefined) renderCardValue(elements, state, 0)
  if (state.budgetExhausted) markCardOmission(state)

  return {
    parts: state.parts,
    ...(state.parts.length === 0
      ? { compatibilityText: '(interactive card with no readable content)' }
      : {}),
    ...(state.incomplete || state.parts.length === 0
      ? { incomplete: true }
      : {}),
  }
}

/**
 * Merge the structured and simplified card projections once, preserving
 * primary occurrences and appending only new visible supplemental parts.
 */
export function mergeInteractiveContentParts(
  primary: InboundContentPart[],
  supplemental: InboundContentPart[],
): InboundContentPart[] {
  const seen = seenLines()
  for (const line of partLines(primary)) seen.remember(line)
  const primaryResources = new Set(primary.flatMap((part) => {
    if (part.kind !== 'resource') return []
    const identity = resourceIdentity(part.resource)
    return identity === undefined ? [] : [identity]
  }))
  const extra: InboundContentPart[][] = []
  for (const line of partLines(supplemental)) {
    const only = line.length === 1 ? line[0] : undefined
    if (only?.kind === 'resource') {
      const identity = resourceIdentity(only.resource)
      if (identity !== undefined && primaryResources.has(identity)) continue
      extra.push(line)
      continue
    }
    if (only?.kind === 'code') {
      extra.push(line)
      continue
    }
    if (normalizeLine(lineText(line)) === '') continue
    if (seen.accountsFor(line)) continue
    seen.remember(line)
    extra.push(line)
  }
  if (extra.length === 0) return primary

  const merged: InboundContentPart[] = [
    ...primary,
    { kind: 'text', text: '\n\nAdditional rendered card content:\n' },
  ]
  extra.forEach((line, index) => {
    const previous = index === 0 ? undefined : extra[index - 1]
    if (previous !== undefined && isTextLine(previous) && isTextLine(line)) {
      appendTextPart(merged, '\n')
    }
    for (const part of line) {
      if (part.kind === 'text') appendTextPart(merged, part.text)
      else merged.push(part)
    }
  })
  return merged
}

/**
 * Group parts into the visible lines they compose.
 *
 * The two card reads see the same message through different projections: the
 * structured one resolves a mention into its own part, the rendered one leaves
 * `@Name` inside the surrounding sentence. Comparing whole lines — with each
 * mention projected back to the name it displays — is what keeps one line from
 * being appended twice merely because one view knows more about it.
 */
function partLines(parts: InboundContentPart[]): InboundContentPart[][] {
  const lines: InboundContentPart[][] = []
  let current: InboundContentPart[] = []
  const flush = (): void => {
    if (current.length > 0) lines.push(current)
    current = []
  }
  for (const part of parts) {
    if (part.kind === 'text') {
      normalizeLines(part.text).forEach((text, index) => {
        if (index > 0) flush()
        if (text !== '') current.push({ kind: 'text', text })
      })
      continue
    }
    if (part.kind === 'mention') {
      current.push(part)
      continue
    }
    flush()
    lines.push([part])
  }
  flush()
  return lines
}

/**
 * The visible lines already accounted for, each with the identities its own
 * occurrence named.
 *
 * The line is the unit of comparison. The two reads show one line differently
 * — the structured one resolves a mention into its own part, the rendered one
 * leaves `@Name` inside the sentence — so the text is what makes them
 * comparable, and the identities on *that* line are what tell two people
 * sharing a display name apart. Neither fact is document-wide: `@Same` on one
 * line says nothing about `@Same` on another.
 */
function seenLines(): {
  remember: (line: InboundContentPart[]) => void
  accountsFor: (line: InboundContentPart[]) => boolean
} {
  const byText = new Map<string, string[][]>()
  return {
    remember(line) {
      const text = normalizeLine(lineText(line))
      const known = byText.get(text)
      if (known === undefined) byText.set(text, [lineMentionIds(line)])
      else known.push(lineMentionIds(line))
    },
    accountsFor(line) {
      const ids = lineMentionIds(line)
      return (byText.get(normalizeLine(lineText(line))) ?? [])
        .some((known) => ids.every((id) => known.includes(id)))
    },
  }
}

function lineMentionIds(line: InboundContentPart[]): string[] {
  return line.flatMap((part) => part.kind === 'mention' ? [part.id] : [])
}

function isTextLine(line: InboundContentPart[]): boolean {
  return line.some((part) => part.kind === 'text' || part.kind === 'mention')
}

function lineText(line: InboundContentPart[]): string {
  return line.map((part) => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'mention') {
      return `@${part.name === '' ? part.id : part.name}`
    }
    return ''
  }).join('')
}

function unwrapUserDsl(
  card: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof card.user_dsl !== 'string') return card
  try {
    return asRecord(JSON.parse(card.user_dsl)) ?? card
  } catch {
    return card
  }
}

function renderCardValue(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (state.budgetExhausted) return
  if (depth > CARD_DEPTH_LIMIT || state.visitedNodes >= CARD_NODE_LIMIT) {
    exhaustCardBudget(state)
    return
  }
  if (Array.isArray(value)) {
    renderCardArray(value, state, depth)
    return
  }
  const node = asRecord(value)
  if (node === undefined || !visitCardNode(state)) return
  const tag = typeof node.tag === 'string' ? node.tag : ''

  if (tag === '' || tag === 'div') {
    const field = visibleField(node.text) ?? visibleField(node.content)
    if (field !== undefined) pushCardField(state, field)
  } else if (tag === 'markdown' || tag === 'lark_md') {
    const text = visibleText(node.text) ?? visibleText(node.content)
    if (text !== undefined) pushCardMarkdown(state, text)
  } else if (tag === 'plain_text') {
    const text = visibleText(node.text) ?? visibleText(node.content)
    if (text !== undefined) pushCardText(state, text)
  } else if (tag === 'button') {
    const label = visibleText(node.text)
    if (label !== undefined) pushCardText(state, `[button: ${label}]`)
  } else if (tag === 'input') {
    const placeholder = visibleText(node.placeholder)
    if (placeholder !== undefined) pushCardText(state, `[input: ${placeholder}]`)
  } else if (
    tag === 'date_picker' ||
    tag === 'picker_time' ||
    tag === 'picker_datetime'
  ) {
    const placeholder = visibleText(node.placeholder)
    if (placeholder !== undefined) pushCardText(state, `[picker: ${placeholder}]`)
  } else if (
    tag === 'select_static' ||
    tag === 'multi_select_static' ||
    tag === 'overflow'
  ) {
    renderSelect(node, state)
  } else if (tag === 'img' || tag === 'image') {
    const key = stringValue(node.image_key) ?? stringValue(node.img_key)
    pushCardPart(
      state,
      resourcePart('image', key, key === undefined ? undefined : `${key}.jpg`),
    )
  } else if (tag === 'file') {
    pushCardPart(
      state,
      resourcePart(
        'file',
        stringValue(node.file_key),
        stringValue(node.file_name),
      ),
    )
  } else if (tag === 'a') {
    const rendered = renderLink(node)
    if (rendered !== '') pushCardText(state, rendered)
  } else if (tag === 'at') {
    pushCardPart(state, cardMentionPart(node, state))
  } else if (tag === 'hr') {
    pushCardText(state, '---')
  } else if (tag === 'checker') {
    const label = visibleText(node.text)
    if (label !== undefined) pushCardText(state, `[choice: ${label}]`)
  } else if (!CARD_CONTAINER_TAGS.has(tag) && tag !== 'note') {
    markUnsupportedComponent(state, tag)
  }

  if (tag === 'collapsible_panel') {
    const title = visibleText(node.header) ?? visibleText(node.title)
    if (title !== undefined) pushCardText(state, title)
  }

  renderNested(node.extra, state, depth)
  renderNested(node.fields, state, depth)
  renderColumns(node.columns, state, depth)
  renderNested(node.actions, state, depth)
  renderNested(node.rows, state, depth)
  renderNested(node.cells, state, depth)
  renderNested(node.elements, state, depth)
}

function renderCardArray(
  values: unknown[],
  state: CardRenderState,
  depth: number,
): void {
  let inline: InboundContentPart[] = []
  const flushInline = (): void => {
    appendCardBlockParts(state.parts, inline)
    inline = []
  }
  for (const value of values) {
    if (state.budgetExhausted) break
    const rendered = renderInlineNode(value, state)
    if (rendered !== undefined) {
      if (!state.budgetExhausted) inline.push(...rendered)
      continue
    }
    flushInline()
    if (!state.budgetExhausted) renderCardValue(value, state, depth + 1)
  }
  flushInline()
}

function renderInlineNode(
  value: unknown,
  state: CardRenderState,
): InboundContentPart[] | undefined {
  const node = asRecord(value)
  if (node === undefined) return undefined
  const tag = typeof node.tag === 'string' ? node.tag : ''
  if (![
    'text',
    'plain_text',
    'lark_md',
    'a',
    'at',
    'img',
    'image',
    'file',
  ].includes(tag)) {
    return undefined
  }
  if (!visitCardNode(state)) return []
  if (tag === 'text' || tag === 'plain_text' || tag === 'lark_md') {
    const text = normalizeCardText(
      visibleText(node.text) ?? visibleText(node.content) ?? '',
      state,
    )
    return tag === 'lark_md'
      ? markdownParts(text, state.mentions, 'card')
      : [{ kind: 'text', text }]
  }
  if (tag === 'a') {
    return [{ kind: 'text', text: normalizeCardText(renderLink(node), state) }]
  }
  if (tag === 'at') {
    return [cardMentionPart(node, state)]
  }
  if (tag === 'img' || tag === 'image') {
    const key = stringValue(node.image_key) ?? stringValue(node.img_key)
    return [resourcePart(
      'image',
      key,
      key === undefined ? undefined : `${key}.jpg`,
    )]
  }
  if (tag === 'file') {
    return [resourcePart(
      'file',
      stringValue(node.file_key),
      stringValue(node.file_name),
    )]
  }
  return undefined
}

function cardMentionPart(
  node: Record<string, unknown>,
  state: CardRenderState,
): InboundContentPart {
  return resolveMentionPart(
    state.mentions,
    stringValue(node.user_id) ?? stringValue(node.id) ?? stringValue(node.key) ??
      '',
    stringValue(node.user_name) ?? '',
  )
}

function renderNested(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (value !== undefined && !state.budgetExhausted) {
    renderCardValue(value, state, depth + 1)
  }
}

function renderColumns(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (!Array.isArray(value) || state.budgetExhausted) return
  for (const column of value) {
    if (state.budgetExhausted) return
    renderCardValue(column, state, depth + 1)
  }
}

function renderSelect(
  node: Record<string, unknown>,
  state: CardRenderState,
): void {
  const placeholder = visibleText(node.placeholder)
  const options: string[] = []
  if (Array.isArray(node.options)) {
    for (const option of node.options) {
      const record = asRecord(option)
      if (record === undefined) continue
      if (!visitCardNode(state)) break
      const text = visibleText(record.text)
      if (text !== undefined) options.push(text)
    }
  }
  if (placeholder === undefined && options.length === 0) return
  const prefix = placeholder === undefined ? '[select' : `[select: ${placeholder}`
  pushCardText(
    state,
    options.length === 0
      ? `${prefix}]`
      : `${prefix}; options: ${options.join(' / ')}]`,
  )
}

function renderLink(node: Record<string, unknown>): string {
  const text = visibleText(node.text) ?? ''
  const href = stringValue(node.href) ?? ''
  if (text !== '' && href !== '') return `[${text}](${href})`
  return text || href
}

function markCardOmission(state: CardRenderState): void {
  state.incomplete = true
  const marker = '[additional card content omitted: parser bound reached]'
  if (!hasText(state.parts, marker)) pushCardText(state, marker)
}

function visitCardNode(state: CardRenderState): boolean {
  if (state.visitedNodes >= CARD_NODE_LIMIT) {
    exhaustCardBudget(state)
    return false
  }
  state.visitedNodes += 1
  return true
}

function exhaustCardBudget(state: CardRenderState): void {
  state.budgetExhausted = true
  state.incomplete = true
}

function markUnsupportedComponent(
  state: CardRenderState,
  tag: string,
): void {
  state.incomplete = true
  const safe = tag.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown'
  const marker = `[unsupported card component: ${safe}]`
  if (!hasText(state.parts, marker)) pushCardText(state, marker)
}

function pushCardField(state: CardRenderState, field: CardField): void {
  if (field.markdown) pushCardMarkdown(state, field.text)
  else pushCardText(state, field.text)
}

function pushCardText(state: CardRenderState, text: string): void {
  const normalized = normalizeCardText(text, state)
  if (normalized !== '') {
    pushCardPart(state, { kind: 'text', text: normalized })
  }
}

/**
 * Push one Markdown field. Its inline meaning — mentions, fenced code, image
 * references — is read here, while the field's type is still known; once a
 * value is flattened into text nobody downstream can tell it apart from a
 * `plain_text` field that happens to contain the same characters.
 */
function pushCardMarkdown(state: CardRenderState, text: string): void {
  const normalized = normalizeCardText(text, state)
  if (normalized === '') return
  appendCardBlockParts(
    state.parts,
    markdownParts(normalized, state.mentions, 'card'),
  )
}

function normalizeCardText(text: string, state: CardRenderState): string {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (!normalized.includes(CARD_UPGRADE_FALLBACK)) return normalized
  state.incomplete = true
  return normalized.split('\n').map((line) =>
    line.includes(CARD_UPGRADE_FALLBACK)
      ? '[card component is only visible in the Feishu client]'
      : line).join('\n')
}

function pushCardPart(
  state: CardRenderState,
  part: InboundContentPart,
): void {
  appendCardBlockParts(state.parts, [part])
}

function appendCardBlockParts(
  target: InboundContentPart[],
  parts: InboundContentPart[],
): void {
  const visible = parts.filter((part) =>
    part.kind !== 'text' || part.text !== '')
  if (visible.length === 0) return
  if (target.length > 0) appendTextPart(target, '\n')
  for (const part of visible) {
    if (part.kind === 'text') appendTextPart(target, part.text)
    else target.push(part)
  }
}

function normalizeLines(value: string): string[] {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
}

function normalizeLine(value: string): string {
  return value.trim()
}

function hasText(parts: InboundContentPart[], text: string): boolean {
  return parts.some((part) => part.kind === 'text' && part.text.includes(text))
}

function visibleField(value: unknown): CardField | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : { text: value, markdown: false }
  }
  const record = asRecord(value)
  if (record === undefined) return undefined
  const text = stringValue(record.content) ?? stringValue(record.text)
  if (text === undefined) return undefined
  return {
    text,
    markdown: record.tag === 'lark_md' || record.tag === 'markdown',
  }
}

function visibleText(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  const record = asRecord(value)
  if (record === undefined) return undefined
  return stringValue(record.content) ?? stringValue(record.text)
}

function visibleLocalizedText(value: unknown): string | undefined {
  const direct = visibleText(value)
  if (direct !== undefined) return direct
  const i18n = asRecord(asRecord(value)?.i18n)
  if (i18n === undefined) return undefined
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const text = stringValue(i18n[locale])
    if (text !== undefined) return text
  }
  for (const candidate of Object.values(i18n)) {
    const text = stringValue(candidate)
    if (text !== undefined) return text
  }
  return undefined
}

function pickLocalizedElements(value: unknown): unknown[] | undefined {
  const i18n = asRecord(value)
  if (i18n === undefined) return undefined
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const elements = i18n[locale]
    if (Array.isArray(elements)) return elements
  }
  return Object.values(i18n).find(Array.isArray) as unknown[] | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
