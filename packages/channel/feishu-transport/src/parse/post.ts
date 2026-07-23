import {
  appendTextPart,
  resourcePart,
  type InboundContentPart,
  type ParsedContent,
} from './parts.js'

interface PostRenderState {
  omittedTags: Set<string>
  incomplete: boolean
}

/** Parse one locale-selected Feishu post while preserving rich inline order. */
export function parsePostContent(
  content: Record<string, unknown>,
): ParsedContent {
  const post = pickPostLocale(content)
  const state: PostRenderState = {
    omittedTags: new Set(),
    incomplete: false,
  }
  const parts: InboundContentPart[] = []
  if (typeof post.title === 'string' && post.title !== '') {
    appendTextPart(parts, post.title)
  }
  if (Array.isArray(post.content)) {
    for (const row of post.content) {
      const rowParts: InboundContentPart[] = []
      const nodes = Array.isArray(row) ? row : [row]
      for (const node of nodes) renderPostNode(node, state, rowParts)
      if (rowParts.length === 0) continue
      if (parts.length > 0) appendTextPart(parts, '\n')
      for (const part of rowParts) {
        if (part.kind === 'text') appendTextPart(parts, part.text)
        else parts.push(part)
      }
    }
  }
  return {
    parts,
    ...(parts.length === 0
      ? { compatibilityText: '(empty rich-text post)' }
      : {}),
    ...(state.incomplete || parts.length === 0 ? { incomplete: true } : {}),
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

function renderPostNode(
  node: unknown,
  state: PostRenderState,
  parts: InboundContentPart[],
): void {
  const value = asRecord(node)
  if (value === undefined) return
  switch (value.tag) {
    case 'text':
      appendTextPart(parts, renderTextNode(value))
      return
    case 'md':
      appendTextPart(
        parts,
        stringValue(value.text) ?? stringValue(value.content) ?? '',
      )
      return
    case 'code':
    case 'code_block': {
      const code = stringValue(value.text) ?? stringValue(value.content) ?? ''
      const language = stringValue(value.language) ?? stringValue(value.lang)
      parts.push({
        kind: 'code',
        code,
        ...(language !== undefined ? { language } : {}),
      })
      return
    }
    case 'a': {
      const text = stringValue(value.text) ?? ''
      const href = stringValue(value.href) ?? ''
      appendTextPart(
        parts,
        text !== '' && href !== '' ? `[${text}](${href})` : text || href,
      )
      return
    }
    case 'at':
      appendTextPart(parts, `@${stringValue(value.user_name) ?? 'unknown'}`)
      return
    case 'hr':
      appendTextPart(parts, '---')
      return
    case 'img': {
      const key = stringValue(value.image_key)
      if (key === undefined) state.incomplete = true
      parts.push(resourcePart(
        'image',
        key,
        key === undefined ? undefined : `${key}.jpg`,
      ))
      return
    }
    case 'file': {
      const key = stringValue(value.file_key)
      if (key === undefined) state.incomplete = true
      parts.push(resourcePart(
        'file',
        key,
        stringValue(value.file_name),
      ))
      return
    }
    case 'media': {
      const imageKey = stringValue(value.image_key)
      const fileKey = stringValue(value.file_key)
      if (imageKey !== undefined) {
        parts.push(resourcePart('image', imageKey, `${imageKey}.jpg`))
      }
      if (fileKey !== undefined) {
        parts.push(resourcePart(
          'file',
          fileKey,
          stringValue(value.file_name),
        ))
      }
      if (imageKey === undefined && fileKey === undefined) {
        state.incomplete = true
        appendTextPart(parts, '[media attachment without a resource key]')
      }
      return
    }
    default: {
      const tag = safeTag(value.tag)
      state.incomplete = true
      if (state.omittedTags.has(tag)) return
      state.omittedTags.add(tag)
      appendTextPart(parts, `[unsupported rich-text element: ${tag}]`)
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

function safeTag(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe === '' ? 'unknown' : safe
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
