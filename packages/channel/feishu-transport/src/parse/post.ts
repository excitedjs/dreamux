import type { Mention } from '../contract/types.js'
import { createBody, type BodyBuilder, type ParsedInbound } from './body.js'
import { mentionKey, readInlineMarkdown } from './inline.js'

/** Flatten one locale of a Feishu post: its title, then one line per row. */
export function parsePostContent(
  content: Record<string, unknown>,
  mentions: Mention[] | undefined,
): ParsedInbound {
  const post = pickPostLocale(content)
  const body = createBody()
  let incomplete = false
  if (typeof post.title === 'string') body.line(post.title)
  for (const row of postRows(post) ?? []) {
    const nodes = Array.isArray(row) ? row : [row]
    body.line(nodes.map((node) => renderPostNode(node, mentions, body, () => {
      incomplete = true
    })).join(''))
  }
  return body.build(incomplete)
}

function pickPostLocale(
  content: Record<string, unknown>,
): Record<string, unknown> {
  for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
    const block = asRecord(content[locale])
    if (block !== undefined && postRows(block) !== undefined) return block
  }
  if (postRows(content) !== undefined) return content
  for (const block of Object.values(content)) {
    const record = asRecord(block)
    if (record !== undefined && postRows(record) !== undefined) return record
  }
  return content
}

/**
 * The post's row grid. Feishu supplies `content_v2` beside `content` for a
 * natively authored post: `content` is a lossy flattening that drops heading
 * markers, table alignment, inline code delimiters, and a code block's line
 * breaks, so `content_v2` is the projection to read. They are two views of
 * one body, never concatenated.
 */
function postRows(block: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(block.content_v2)) return block.content_v2
  if (Array.isArray(block.content)) return block.content
  return undefined
}

function renderPostNode(
  node: unknown,
  mentions: Mention[] | undefined,
  body: BodyBuilder,
  markIncomplete: () => void,
): string {
  const value = asRecord(node)
  if (value === undefined) return ''
  switch (value.tag) {
    case 'text':
      return stringValue(value.text) ?? ''
    case 'md':
      return readInlineMarkdown(stringValue(value.text) ?? '', mentions, body)
    case 'code_block':
      return fencedCode(stringValue(value.text) ?? '', stringValue(value.language) ?? '')
    case 'a': {
      const text = stringValue(value.text) ?? ''
      const href = stringValue(value.href) ?? ''
      return text !== '' && href !== '' ? `[${text}](${href})` : text || href
    }
    case 'at': {
      const token = stringValue(value.user_id) ?? ''
      return mentionKey(mentions, token) ?? token
    }
    case 'hr':
      return '---'
    case 'img': {
      const key = stringValue(value.image_key)
      return key === undefined ? '' : body.attach('image', key, `${key}.jpg`)
    }
    case 'file': {
      const key = stringValue(value.file_key)
      return key === undefined
        ? ''
        : body.attach('file', key, stringValue(value.file_name))
    }
    case 'media': {
      const fileKey = stringValue(value.file_key)
      const imageKey = stringValue(value.image_key)
      return [
        fileKey === undefined
          ? ''
          : body.attach('file', fileKey, stringValue(value.file_name)),
        imageKey === undefined
          ? ''
          : body.attach('image', imageKey, `${imageKey}.jpg`),
      ].filter((key) => key !== '').join('\n')
    }
    default:
      markIncomplete()
      return ''
  }
}

function fencedCode(code: string, language: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), (match) => match[0].length),
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${code}\n${fence}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
