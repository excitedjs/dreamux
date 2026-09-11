/**
 * Reading the Markdown Feishu hands back inside a message.
 *
 * Native posts and card `markdown` / `lark_md` fields keep their authored
 * Markdown, mention tags and image references included. This pass finds the
 * few constructs that carry meaning beyond text — fenced code, inline mentions,
 * message-resource images — and leaves every other character of the source
 * exactly as written. Code is settled first, because an `<at>` tag inside a
 * fence or a backtick span is an example, not a mention.
 *
 * The tag spelling differs by source: native post Markdown writes
 * `<at user_id="…">`, card Markdown writes `<at id="…">`. That is a real
 * difference in meaning, not a variant to normalize away — an `id` attribute
 * in a native post addresses nobody.
 */

import type { Mention } from '../contract/types.js'
import { resolveMentionPart } from './mention.js'
import {
  appendTextPart,
  resourcePart,
  type InboundContentPart,
} from './parts.js'

export type MentionDialect = 'post' | 'card'

const MENTION_ATTRIBUTE: Record<MentionDialect, string> = {
  post: 'user_id',
  card: 'id',
}

/** A Feishu message-resource image key, as written in Markdown image syntax. */
const IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]+$/

/**
 * Whatever the source reaches first: a backslash escape, an inline code span, a
 * mention tag, or an image reference. Everything between matches is literal
 * text, and so are the first two — they are matched precisely so that what they
 * cover is not read as anything else.
 *
 * A code span runs from a backtick string to the next backtick string of the
 * same length, as Markdown defines it; matching any run would end ``a ` b`` at
 * its inner backtick and expose the rest of the span to interpretation.
 */
const INLINE_RE =
  /\\[\s\S]|(?<!`)(?<fence>`+)(?!`)[\s\S]*?(?<!`)\k<fence>(?!`)|<at\b(?<attributes>[^>]*)>(?<label>[\s\S]*?)<\/at\s*>|!\[[^\]]*\]\(\s*(?<target>[^)\s]+)\s*\)/g

/** Parse one Markdown source into ordered text, code, mention, and resource parts. */
export function markdownParts(
  source: string,
  mentions: Mention[] | undefined,
  dialect: MentionDialect,
): InboundContentPart[] {
  const parts: InboundContentPart[] = []
  for (const block of splitFencedCode(source)) {
    if (block.kind === 'code') {
      parts.push(block)
      continue
    }
    appendInlineParts(parts, block.text, mentions, dialect)
  }
  return parts
}

function appendInlineParts(
  parts: InboundContentPart[],
  source: string,
  mentions: Mention[] | undefined,
  dialect: MentionDialect,
): void {
  const pattern = new RegExp(INLINE_RE.source, 'g')
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const resolved = resolveInline(match, mentions, dialect)
    if (resolved === undefined) continue
    appendTextPart(parts, source.slice(cursor, match.index))
    if (resolved.kind === 'text') appendTextPart(parts, resolved.text)
    else parts.push(resolved)
    cursor = match.index + match[0].length
  }
  appendTextPart(parts, source.slice(cursor))
}

/**
 * Interpret one inline match, or return `undefined` to leave it as the literal
 * source text it already is (an escaped character, a code span, an `<at>`
 * spelling this dialect does not address anybody with, an ordinary web image).
 */
function resolveInline(
  match: RegExpExecArray,
  mentions: Mention[] | undefined,
  dialect: MentionDialect,
): InboundContentPart | undefined {
  const matched = match[0]
  if (matched.startsWith('\\') || matched.startsWith('`')) return undefined
  const groups = match.groups ?? {}
  if (matched.startsWith('!')) {
    const key = groups['target']
    return key !== undefined && IMAGE_KEY_RE.test(key)
      ? resourcePart('image', key, `${key}.jpg`)
      : undefined
  }
  const token = readAttribute(
    groups['attributes'] ?? '',
    MENTION_ATTRIBUTE[dialect],
  )
  if (token === undefined) return undefined
  return resolveMentionPart(mentions, token, (groups['label'] ?? '').trim())
}

function readAttribute(
  attributes: string,
  name: string,
): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
  )
  const match = pattern.exec(attributes)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

type MarkdownBlock =
  | { kind: 'text'; text: string }
  | Extract<InboundContentPart, { kind: 'code' }>

/**
 * Cut a Markdown source at its fenced code blocks. An unterminated fence runs
 * to the end of the source, which is how a client renders it too.
 */
function splitFencedCode(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const opener = /(^|\n)( {0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opener.exec(source)) !== null) {
    const marker = match[3] ?? ''
    const info = (match[4] ?? '').trim()
    // A backtick fence cannot carry a backtick in its info string; that is an
    // inline code span sitting at the start of a line.
    if (marker.startsWith('`') && info.includes('`')) continue
    const prefixEnd = match.index + (match[1]?.length ?? 0)
    if (prefixEnd > cursor) {
      blocks.push({ kind: 'text', text: source.slice(cursor, prefixEnd) })
    }
    const codeStart = match.index + match[0].length
    const closePattern = new RegExp(
      `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`,
      'gm',
    )
    closePattern.lastIndex = codeStart
    const closer = closePattern.exec(source)
    let codeEnd = closer?.index ?? source.length
    if (codeEnd > codeStart && source[codeEnd - 1] === '\n') codeEnd -= 1
    if (codeEnd > codeStart && source[codeEnd - 1] === '\r') codeEnd -= 1
    blocks.push({
      kind: 'code',
      code: source.slice(codeStart, codeEnd),
      ...(info !== '' ? { language: info } : {}),
    })
    cursor = closer === null ? source.length : closer.index + closer[0].length
    opener.lastIndex = cursor
    if (closer === null) break
  }
  if (cursor < source.length) {
    blocks.push({ kind: 'text', text: source.slice(cursor) })
  }
  return blocks
}

/**
 * Promote the fenced code blocks in an already-assembled projection.
 *
 * The legacy post projection flattens an authored fence into ordinary text
 * rows, so the opening and closing fence lines arrive as separate nodes and
 * only the assembled text shows the block. Inline meaning is deliberately not
 * read here: a plain node's characters are what the sender typed, and the
 * flattening states a mention or an image as its own node rather than as
 * Markdown, so scanning flattened text for those would invent them.
 */
export function expandCodeParts(
  parts: InboundContentPart[],
): InboundContentPart[] {
  const expanded: InboundContentPart[] = []
  for (const part of parts) {
    if (part.kind !== 'text') {
      expanded.push(part)
      continue
    }
    for (const block of splitFencedCode(part.text)) {
      if (block.kind === 'text') appendTextPart(expanded, block.text)
      else expanded.push(block)
    }
  }
  return expanded
}
