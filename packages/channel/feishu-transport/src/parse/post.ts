import type { InboundResource, ParsedInbound } from './content.js'

interface PostRenderState {
  resources: InboundResource[]
  seenResources: Set<string>
  omittedTags: Set<string>
  incomplete: boolean
}

/** Parse one locale-selected Feishu post while preserving rich inline order. */
export function parsePostContent(
  content: Record<string, unknown>,
): ParsedInbound {
  const post = pickPostLocale(content)
  const state: PostRenderState = {
    resources: [],
    seenResources: new Set(),
    omittedTags: new Set(),
    incomplete: false,
  }
  const lines: string[] = []
  if (typeof post.title === 'string' && post.title !== '') {
    lines.push(post.title)
  }
  if (Array.isArray(post.content)) {
    for (const row of post.content) {
      const nodes = Array.isArray(row) ? row : [row]
      const rendered = nodes.map((node) => renderPostNode(node, state)).join('')
      if (rendered !== '') lines.push(rendered)
    }
  }
  const text = lines.join('\n')
  return {
    text: text === '' ? '(empty rich-text post)' : text,
    ...(state.resources.length > 0 ? { resources: state.resources } : {}),
    ...(state.incomplete || text === '' ? { incomplete: true } : {}),
  }
}

function pickPostLocale(
  content: Record<string, unknown>,
): Record<string, unknown> {
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const block = asRecord(content[locale])
    if (block !== undefined && Array.isArray(block.content)) return block
  }
  if (Array.isArray(content.content)) return content
  for (const block of Object.values(content)) {
    const record = asRecord(block)
    if (record !== undefined && Array.isArray(record.content)) return record
  }
  return content
}

function renderPostNode(node: unknown, state: PostRenderState): string {
  const value = asRecord(node)
  if (value === undefined) return ''
  switch (value.tag) {
    case 'text':
      return renderTextNode(value)
    case 'md':
      return stringValue(value.text) ?? stringValue(value.content) ?? ''
    case 'code':
    case 'code_block':
      return renderCodeBlock(value)
    case 'a': {
      const text = stringValue(value.text) ?? ''
      const href = stringValue(value.href) ?? ''
      if (text !== '' && href !== '') return `[${text}](${href})`
      return text || href
    }
    case 'at':
      return `@${stringValue(value.user_name) ?? 'unknown'}`
    case 'hr':
      return '---'
    case 'img': {
      const key = stringValue(value.image_key)
      if (key === undefined) state.incomplete = true
      addResource(state, 'image', key, key === undefined ? undefined : `${key}.jpg`)
      return resourceMarker('image', key)
    }
    case 'file': {
      const key = stringValue(value.file_key)
      const name = stringValue(value.file_name)
      if (key === undefined) state.incomplete = true
      addResource(state, 'file', key, name)
      return resourceMarker('file', key, name)
    }
    case 'media': {
      const rendered: string[] = []
      const imageKey = stringValue(value.image_key)
      const fileKey = stringValue(value.file_key)
      if (imageKey !== undefined) {
        addResource(state, 'image', imageKey, `${imageKey}.jpg`)
        rendered.push(resourceMarker('image', imageKey))
      }
      if (fileKey !== undefined) {
        const name = stringValue(value.file_name)
        addResource(state, 'file', fileKey, name)
        rendered.push(resourceMarker('file', fileKey, name))
      }
      if (rendered.length === 0) state.incomplete = true
      return rendered.join('') || '[media attachment without a resource key]'
    }
    default: {
      const tag = safeTag(value.tag)
      state.incomplete = true
      if (state.omittedTags.has(tag)) return ''
      state.omittedTags.add(tag)
      return `[unsupported rich-text element: ${tag}]`
    }
  }
}

function renderTextNode(value: Record<string, unknown>): string {
  const text = stringValue(value.text) ?? stringValue(value.content) ?? ''
  const style = Array.isArray(value.style)
    ? value.style
    : Array.isArray(value.text_style)
      ? value.text_style
      : []
  if ((!style.includes('code') && !style.includes('codeInline')) || text === '') {
    return text
  }
  const longestRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  )
  const fence = '`'.repeat(longestRun + 1)
  const allSpaces = /^ +$/.test(text)
  const needsPadding =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (!allSpaces && text.startsWith(' ') && text.endsWith(' '))
  return `${fence}${needsPadding ? ` ${text} ` : text}${fence}`
}

function renderCodeBlock(value: Record<string, unknown>): string {
  const text = stringValue(value.text) ?? stringValue(value.content) ?? ''
  const language = stringValue(value.language) ?? stringValue(value.lang) ?? ''
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function safeTag(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe === '' ? 'unknown' : safe
}

function addResource(
  state: PostRenderState,
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
  const label = type === 'image' ? 'image' : 'file'
  const detail = name ?? key
  return detail === undefined
    ? `[${label} attachment without a resource key]`
    : `[${label} attachment: ${detail}]`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
