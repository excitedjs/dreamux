import type { InboundResource, ParsedInbound } from './content.js'

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
  parts: string[]
  resources: InboundResource[]
  seenResources: Set<string>
  visitedNodes: number
  incomplete: boolean
}

/** Parse the default/simplified and v2/user-DSL card representations. */
export function parseInteractiveContent(
  outer: Record<string, unknown>,
): ParsedInbound {
  const card = unwrapUserDsl(outer)
  if (card.type === 'template') {
    return { text: '(interactive template card)', incomplete: true }
  }
  const state: CardRenderState = {
    parts: [],
    resources: [],
    seenResources: new Set(),
    visitedNodes: 0,
    incomplete: false,
  }
  const title = visibleText(card.title) ?? visibleText(asRecord(card.header)?.title)
  if (title !== undefined) state.parts.push(title)

  const body = asRecord(card.body)
  const elements = Array.isArray(body?.elements)
    ? body.elements
    : Array.isArray(card.elements)
      ? card.elements
      : undefined
  if (elements !== undefined) renderCardValue(elements, state, 0)

  const filtered = state.parts
    .flatMap((part) => normalizeVisiblePart(part, state))
    .filter((part) => part.trim() !== '')
  const text = filtered.join('\n')
  return {
    text: text === '' ? '(interactive card with no readable content)' : text,
    ...(state.resources.length > 0 ? { resources: state.resources } : {}),
    ...(state.incomplete || text === '' ? { incomplete: true } : {}),
  }
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
  if (depth > CARD_DEPTH_LIMIT || state.visitedNodes >= CARD_NODE_LIMIT) {
    markCardOmission(state)
    return
  }
  if (Array.isArray(value)) {
    renderCardArray(value, state, depth)
    return
  }
  const node = asRecord(value)
  if (node === undefined) return
  if (!visitCardNode(state)) return
  const tag = typeof node.tag === 'string' ? node.tag : ''

  if (tag === '') {
    const text = visibleText(node.text) ?? visibleText(node.content)
    if (text !== undefined) state.parts.push(text)
  } else if (tag === 'markdown' || tag === 'plain_text' || tag === 'div') {
    const text = visibleText(node.text) ?? visibleText(node.content)
    if (text !== undefined) state.parts.push(text)
  } else if (tag === 'button') {
    const label = visibleText(node.text)
    if (label !== undefined) state.parts.push(`[button: ${label}]`)
  } else if (tag === 'input') {
    const placeholder = visibleText(node.placeholder)
    if (placeholder !== undefined) state.parts.push(`[input: ${placeholder}]`)
  } else if (
    tag === 'date_picker' ||
    tag === 'picker_time' ||
    tag === 'picker_datetime'
  ) {
    const placeholder = visibleText(node.placeholder)
    if (placeholder !== undefined) state.parts.push(`[picker: ${placeholder}]`)
  } else if (
    tag === 'select_static' ||
    tag === 'multi_select_static' ||
    tag === 'overflow'
  ) {
    renderSelect(node, state)
  } else if (tag === 'img' || tag === 'image') {
    const key = stringValue(node.image_key) ?? stringValue(node.img_key)
    addResource(state, 'image', key, key === undefined ? undefined : `${key}.jpg`)
    state.parts.push(resourceMarker('image', key))
  } else if (tag === 'file') {
    const key = stringValue(node.file_key)
    const name = stringValue(node.file_name)
    addResource(state, 'file', key, name)
    state.parts.push(resourceMarker('file', key, name))
  } else if (tag === 'a') {
    const rendered = renderLink(node)
    if (rendered !== '') state.parts.push(rendered)
  } else if (tag === 'at') {
    state.parts.push(`@${stringValue(node.user_name) ?? 'unknown'}`)
  } else if (tag === 'hr') {
    state.parts.push('---')
  } else if (tag === 'checker') {
    const label = visibleText(node.text)
    if (label !== undefined) state.parts.push(`[choice: ${label}]`)
  } else if (!CARD_CONTAINER_TAGS.has(tag) && tag !== 'note') {
    markUnsupportedComponent(state, tag)
  }

  if (tag === 'collapsible_panel') {
    const title = visibleText(node.header) ?? visibleText(node.title)
    if (title !== undefined) state.parts.push(title)
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
  const inline: string[] = []
  const nested: unknown[] = []
  for (const value of values) {
    const rendered = renderInlineNode(value, state)
    if (rendered === undefined) nested.push(value)
    else inline.push(rendered)
  }
  const line = inline.join('').trim()
  if (line !== '') state.parts.push(line)
  for (const value of nested) renderCardValue(value, state, depth + 1)
}

function renderInlineNode(
  value: unknown,
  state: CardRenderState,
): string | undefined {
  const node = asRecord(value)
  if (node === undefined) return undefined
  const tag = typeof node.tag === 'string' ? node.tag : ''
  if (!['text', 'a', 'at', 'img', 'image', 'file'].includes(tag)) {
    return undefined
  }
  if (!visitCardNode(state)) return ''
  if (tag === 'text') return visibleText(node.text) ?? visibleText(node.content) ?? ''
  if (tag === 'a') return renderLink(node)
  if (tag === 'at') return `@${stringValue(node.user_name) ?? 'unknown'}`
  if (tag === 'img' || tag === 'image') {
    const key = stringValue(node.image_key) ?? stringValue(node.img_key)
    addResource(state, 'image', key, key === undefined ? undefined : `${key}.jpg`)
    return resourceMarker('image', key)
  }
  if (tag === 'file') {
    const key = stringValue(node.file_key)
    const name = stringValue(node.file_name)
    addResource(state, 'file', key, name)
    return resourceMarker('file', key, name)
  }
  return undefined
}

function renderNested(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (value === undefined) return
  renderCardValue(value, state, depth + 1)
}

function renderColumns(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (!Array.isArray(value)) return
  for (const column of value) {
    if (state.visitedNodes >= CARD_NODE_LIMIT) {
      markCardOmission(state)
      return
    }
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
  state.parts.push(
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

function addResource(
  state: CardRenderState,
  type: InboundResource['type'],
  key: string | undefined,
  name: string | undefined,
): void {
  const identity = key === undefined ? undefined : `${type}:${key}`
  if (identity !== undefined && state.seenResources.has(identity)) return
  if (identity !== undefined) state.seenResources.add(identity)
  state.resources.push({
    type,
    ...(key !== undefined ? { key } : {}),
    ...(name !== undefined ? { name } : {}),
  })
}

function resourceMarker(
  type: InboundResource['type'],
  key: string | undefined,
  name?: string,
): string {
  const detail = name ?? key
  return detail === undefined
    ? `[${type} attachment without a resource key]`
    : `[${type} attachment: ${detail}]`
}

function normalizeVisiblePart(
  part: string,
  state: CardRenderState,
): string[] {
  if (!part.includes(CARD_UPGRADE_FALLBACK)) return [part]
  state.incomplete = true
  return part
    .split('\n')
    .map((line) => line.includes(CARD_UPGRADE_FALLBACK)
      ? '[card component is only visible in the Feishu client]'
      : line)
}

function markCardOmission(state: CardRenderState): void {
  state.incomplete = true
  const marker = '[additional card content omitted: parser bound reached]'
  if (!state.parts.includes(marker)) state.parts.push(marker)
}

function visitCardNode(state: CardRenderState): boolean {
  if (state.visitedNodes >= CARD_NODE_LIMIT) {
    markCardOmission(state)
    return false
  }
  state.visitedNodes += 1
  return true
}

function markUnsupportedComponent(
  state: CardRenderState,
  tag: string,
): void {
  state.incomplete = true
  const safe = tag.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown'
  const marker = `[unsupported card component: ${safe}]`
  if (!state.parts.includes(marker)) state.parts.push(marker)
}

function visibleText(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  const record = asRecord(value)
  if (record === undefined) return undefined
  return stringValue(record.content) ?? stringValue(record.text)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
