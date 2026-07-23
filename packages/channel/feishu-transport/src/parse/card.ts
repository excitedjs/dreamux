import type {
  InboundContentPart,
  InboundResource,
  ParsedInbound,
} from './content.js'

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
  contentParts: InboundContentPart[]
  resources: InboundResource[]
  seenResources: Set<string>
  visitedNodes: number
  budgetExhausted: boolean
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
    contentParts: [],
    resources: [],
    seenResources: new Set(),
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

  const filtered = state.parts
    .flatMap((part) => normalizeVisiblePart(part, state))
    .filter((part) => part.trim() !== '')
  const text = filtered.join('\n')
  return {
    text: text === '' ? '(interactive card with no readable content)' : text,
    parts: state.contentParts,
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
  if (node === undefined) return
  if (!visitCardNode(state)) return
  const tag = typeof node.tag === 'string' ? node.tag : ''

  if (tag === '') {
    const text = visibleText(node.text) ?? visibleText(node.content)
    if (text !== undefined) pushCardText(state, text)
  } else if (
    tag === 'markdown' ||
    tag === 'lark_md' ||
    tag === 'plain_text' ||
    tag === 'div'
  ) {
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
    const resource = addResource(
      state,
      'image',
      key,
      key === undefined ? undefined : `${key}.jpg`,
    )
    pushCardResource(state, resource, resourceMarker('image', key))
  } else if (tag === 'file') {
    const key = stringValue(node.file_key)
    const name = stringValue(node.file_name)
    const resource = addResource(state, 'file', key, name)
    pushCardResource(state, resource, resourceMarker('file', key, name))
  } else if (tag === 'a') {
    const rendered = renderLink(node)
    if (rendered !== '') pushCardText(state, rendered)
  } else if (tag === 'at') {
    pushCardText(state, `@${stringValue(node.user_name) ?? 'unknown'}`)
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
  let inline: Array<{
    legacy: string
    part: InboundContentPart
  }> = []
  const flushInline = (): void => {
    const line = inline.map(({ legacy }) => legacy).join('').trim()
    if (line !== '') {
      state.parts.push(line)
      appendCardBlockParts(state.contentParts, inline.map(({ part }) => part))
    }
    inline = []
  }
  for (const value of values) {
    if (state.budgetExhausted) break
    const rendered = renderInlineNode(value, state)
    if (rendered !== undefined) {
      if (!state.budgetExhausted) inline.push(rendered)
      continue
    }
    flushInline()
    if (state.budgetExhausted) break
    renderCardValue(value, state, depth + 1)
  }
  flushInline()
}

function renderInlineNode(
  value: unknown,
  state: CardRenderState,
): { legacy: string; part: InboundContentPart } | undefined {
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
  if (!visitCardNode(state)) {
    return { legacy: '', part: { kind: 'text', text: '' } }
  }
  if (tag === 'text' || tag === 'plain_text' || tag === 'lark_md') {
    const text = visibleText(node.text) ?? visibleText(node.content) ?? ''
    return { legacy: text, part: { kind: 'text', text } }
  }
  if (tag === 'a') {
    const text = renderLink(node)
    return { legacy: text, part: { kind: 'text', text } }
  }
  if (tag === 'at') {
    const text = `@${stringValue(node.user_name) ?? 'unknown'}`
    return { legacy: text, part: { kind: 'text', text } }
  }
  if (tag === 'img' || tag === 'image') {
    const key = stringValue(node.image_key) ?? stringValue(node.img_key)
    const resource = addResource(
      state,
      'image',
      key,
      key === undefined ? undefined : `${key}.jpg`,
    )
    return {
      legacy: resourceMarker('image', key),
      part: { kind: 'resource', resource },
    }
  }
  if (tag === 'file') {
    const key = stringValue(node.file_key)
    const name = stringValue(node.file_name)
    const resource = addResource(state, 'file', key, name)
    return {
      legacy: resourceMarker('file', key, name),
      part: { kind: 'resource', resource },
    }
  }
  return undefined
}

function renderNested(
  value: unknown,
  state: CardRenderState,
  depth: number,
): void {
  if (value === undefined || state.budgetExhausted) return
  renderCardValue(value, state, depth + 1)
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

function addResource(
  state: CardRenderState,
  type: InboundResource['type'],
  key: string | undefined,
  name: string | undefined,
): InboundResource {
  const resource: InboundResource = {
    type,
    ...(key !== undefined ? { key } : {}),
    ...(name !== undefined ? { name } : {}),
  }
  const identity = key === undefined ? undefined : `${type}:${key}`
  if (identity === undefined || !state.seenResources.has(identity)) {
    if (identity !== undefined) state.seenResources.add(identity)
    state.resources.push(resource)
  }
  return resource
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
  if (!state.parts.includes(marker)) pushCardText(state, marker)
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
  if (!state.parts.includes(marker)) pushCardText(state, marker)
}

function pushCardText(state: CardRenderState, text: string): void {
  if (text === '') return
  const normalized = text.includes(CARD_UPGRADE_FALLBACK)
    ? text.split('\n').map((line) => {
        if (!line.includes(CARD_UPGRADE_FALLBACK)) return line
        state.incomplete = true
        return '[card component is only visible in the Feishu client]'
      }).join('\n')
    : text
  state.parts.push(normalized)
  appendCardBlockParts(state.contentParts, [{ kind: 'text', text: normalized }])
}

function pushCardResource(
  state: CardRenderState,
  resource: InboundResource,
  legacy: string,
): void {
  state.parts.push(legacy)
  appendCardBlockParts(state.contentParts, [{ kind: 'resource', resource }])
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

function appendTextPart(parts: InboundContentPart[], text: string): void {
  if (text === '') return
  const previous = parts.at(-1)
  if (previous?.kind === 'text') previous.text += text
  else parts.push({ kind: 'text', text })
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
