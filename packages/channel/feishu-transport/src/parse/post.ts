import type {
  InboundContentPart,
  InboundResource,
  ParsedInbound,
} from './content.js'

interface PostRenderState {
  parts: InboundContentPart[]
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
    parts: [],
    resources: [],
    seenResources: new Set(),
    omittedTags: new Set(),
    incomplete: false,
  }
  const lines: string[] = []
  if (typeof post.title === 'string' && post.title !== '') {
    lines.push(post.title)
    appendTextPart(state.parts, post.title)
  }
  if (Array.isArray(post.content)) {
    for (const row of post.content) {
      const nodes = Array.isArray(row) ? row : [row]
      const partsBeforeRow = state.parts.map(cloneContentPart)
      if (lines.length > 0) appendTextPart(state.parts, '\n')
      const rendered = nodes.map((node) => renderPostNode(node, state)).join('')
      if (rendered !== '') {
        lines.push(rendered)
      } else {
        state.parts = partsBeforeRow
      }
    }
  }
  const text = lines.join('\n')
  return {
    text: text === '' ? '(empty rich-text post)' : text,
    parts: state.parts,
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
      {
        const text = renderTextNode(value)
        appendTextPart(state.parts, text)
        return text
      }
    case 'md': {
      const text = stringValue(value.text) ?? stringValue(value.content) ?? ''
      appendTextPart(state.parts, text)
      return text
    }
    case 'code':
    case 'code_block': {
      const code = stringValue(value.text) ?? stringValue(value.content) ?? ''
      const language = stringValue(value.language) ?? stringValue(value.lang)
      state.parts.push({
        kind: 'code',
        code,
        ...(language !== undefined ? { language } : {}),
      })
      return renderCodeBlock(value)
    }
    case 'a': {
      const text = stringValue(value.text) ?? ''
      const href = stringValue(value.href) ?? ''
      const rendered = text !== '' && href !== '' ? `[${text}](${href})` : text || href
      appendTextPart(state.parts, rendered)
      return rendered
    }
    case 'at': {
      const rendered = `@${stringValue(value.user_name) ?? 'unknown'}`
      appendTextPart(state.parts, rendered)
      return rendered
    }
    case 'hr': {
      appendTextPart(state.parts, '---')
      return '---'
    }
    case 'img': {
      const key = stringValue(value.image_key)
      if (key === undefined) state.incomplete = true
      const resource = addResource(
        state,
        'image',
        key,
        key === undefined ? undefined : `${key}.jpg`,
      )
      state.parts.push({ kind: 'resource', resource })
      return resourceMarker('image', key)
    }
    case 'file': {
      const key = stringValue(value.file_key)
      const name = stringValue(value.file_name)
      if (key === undefined) state.incomplete = true
      const resource = addResource(state, 'file', key, name)
      state.parts.push({ kind: 'resource', resource })
      return resourceMarker('file', key, name)
    }
    case 'media': {
      const rendered: string[] = []
      const imageKey = stringValue(value.image_key)
      const fileKey = stringValue(value.file_key)
      if (imageKey !== undefined) {
        const resource = addResource(state, 'image', imageKey, `${imageKey}.jpg`)
        state.parts.push({ kind: 'resource', resource })
        rendered.push(resourceMarker('image', imageKey))
      }
      if (fileKey !== undefined) {
        const name = stringValue(value.file_name)
        const resource = addResource(state, 'file', fileKey, name)
        state.parts.push({ kind: 'resource', resource })
        rendered.push(resourceMarker('file', fileKey, name))
      }
      if (rendered.length === 0) {
        state.incomplete = true
        const marker = '[media attachment without a resource key]'
        appendTextPart(state.parts, marker)
        return marker
      }
      return rendered.join('')
    }
    default: {
      const tag = safeTag(value.tag)
      state.incomplete = true
      if (state.omittedTags.has(tag)) return ''
      state.omittedTags.add(tag)
      const marker = `[unsupported rich-text element: ${tag}]`
      appendTextPart(state.parts, marker)
      return marker
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

function appendTextPart(parts: InboundContentPart[], text: string): void {
  if (text === '') return
  const previous = parts.at(-1)
  if (previous?.kind === 'text') {
    previous.text += text
  } else {
    parts.push({ kind: 'text', text })
  }
}

function cloneContentPart(part: InboundContentPart): InboundContentPart {
  if (part.kind === 'resource') {
    return { kind: 'resource', resource: { ...part.resource } }
  }
  return { ...part }
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
