/**
 * Feishu message `content`: how an authored body becomes one, and how big one
 * may be.
 *
 * A reply is native rich text — one `md` node carrying the authored Markdown
 * verbatim, so Feishu's own client renders headings, tables, code, links, and
 * `<at user_id="…">` mentions where they were written. Nothing here rewrites
 * Markdown into another presentation.
 *
 * The only reason a body is ever cut is size. The budget is measured on the
 * serialized `content` string, JSON escaping included, because that is what
 * the platform receives.
 */

import { marked, type Token } from 'marked'

/**
 * The operator-selected serialized-content budget for one message, under the
 * platform's documented 30 KB ceiling. One budget covers native posts and raw
 * cards alike: they are the same `content` field.
 */
export const FEISHU_MESSAGE_CONTENT_SAFE_BYTES = 28 * 1024

/** Serialize one authored body as a native `post` message content string. */
export function nativePostContent(body: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: body }]] } })
}

const POST_ENVELOPE_BYTES = Buffer.byteLength(nativePostContent(''), 'utf8')

/**
 * Serialize one authored body into the native `post` contents to send, in
 * order. The whole body is tried first: a body that fits is one message no
 * matter how many Markdown blocks it holds.
 */
export function nativePostContents(body: string): string[] {
  const whole = nativePostContent(body)
  if (Buffer.byteLength(whole, 'utf8') <= FEISHU_MESSAGE_CONTENT_SAFE_BYTES) {
    return [whole]
  }
  const budget = FEISHU_MESSAGE_CONTENT_SAFE_BYTES - POST_ENVELOPE_BYTES
  return splitMarkdownBody(body, budget).map((piece) => {
    const content = nativePostContent(piece)
    assertMessageContentFits(content)
    return content
  })
}

export function assertMessageContentFits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FEISHU_MESSAGE_CONTENT_SAFE_BYTES) {
    throw new Error(contentTooLarge(bytes))
  }
}

function contentTooLarge(bytes: number): string {
  return (
    `Feishu message content is ${bytes} bytes, over the ` +
    `${FEISHU_MESSAGE_CONTENT_SAFE_BYTES}-byte budget for one message.`
  )
}

/** What one Markdown fragment would cost as a whole native-post `content`. */
function postContentBytes(body: string): number {
  return Buffer.byteLength(nativePostContent(body), 'utf8')
}

/**
 * Split an oversized body into pieces that each fit `budget` escaped bytes.
 *
 * Blocks are the unit: `marked`'s block tokens tile the source through their
 * `raw` fields, so packing whole blocks reproduces the authored text exactly
 * while keeping block boundaries wherever they fit. Only a block that is
 * itself oversized is opened up, and then along the seams that keep it
 * readable — fence lines, table rows, ordinary lines, grapheme clusters.
 */
function splitMarkdownBody(body: string, budget: number): string[] {
  const pieces: string[] = []
  let current = ''
  let bytes = 0
  for (const block of marked.lexer(body)) {
    const raw = block.raw
    if (raw === '') continue
    const rawBytes = escapedBytes(raw)
    if (bytes + rawBytes <= budget) {
      current += raw
      bytes += rawBytes
      continue
    }
    if (current !== '') {
      pieces.push(current)
      current = ''
      bytes = 0
    }
    if (rawBytes <= budget) {
      current = raw
      bytes = rawBytes
      continue
    }
    for (const piece of splitBlock(block, budget)) pieces.push(piece)
  }
  if (current !== '') pieces.push(current)
  // The blank lines between two blocks are a separator, not content. When a
  // run of them lands in a piece of its own — a body ending in an oversized
  // code block and a trailing blank line does exactly that — there is nothing
  // to send.
  return pieces.filter((piece) => piece.trim() !== '')
}

function splitBlock(block: Token, budget: number): string[] {
  if (block.type === 'code') return splitFencedCode(block.raw, budget)
  if (block.type === 'table') return splitTableRows(block.raw, budget)
  return packSegments(lineSegments(block.raw), budget)
}

/**
 * Split a fenced code block by line, repeating its opening (with language) and
 * closing fence on every piece, so each piece is a well-formed fenced block.
 */
function splitFencedCode(raw: string, budget: number): string[] {
  const lines = lineSegments(raw)
  const open = lines[0]
  const close = lines.at(-1)
  if (
    lines.length < 3 ||
    open === undefined ||
    close === undefined ||
    !/^ {0,3}[`~]{3,}/.test(open) ||
    !/^ {0,3}[`~]{3,}[ \t]*\r?\n?$/.test(close)
  ) {
    return packSegments(lines, budget)
  }
  // Every piece pays for both fence lines, and for the newline that puts the
  // closing fence on its own line when a split lands mid-line.
  const frame = `${open}\n${close}`
  const inner = budget - escapedBytes(frame)
  if (inner <= 0) {
    throw new Error(contentTooLarge(postContentBytes(frame)))
  }
  return packSegments(lines.slice(1, -1), inner).map((piece) =>
    `${open}${piece.endsWith('\n') ? piece : `${piece}\n`}${close}`)
}

/**
 * Split a table by whole data rows, repeating its header and delimiter rows so
 * every piece still reads as a table. The header is taken as the block's first
 * two source lines rather than re-parsed, so optional outer pipes and
 * alignment markers survive exactly as authored.
 */
function splitTableRows(raw: string, budget: number): string[] {
  const header = /^(?:[^\r\n]*\r?\n){2}/.exec(raw)?.[0]
  if (header === undefined) return packSegments(lineSegments(raw), budget)
  const rowBudget = budget - escapedBytes(header)
  const rows = lineSegments(raw.slice(header.length))
  const oversized = rowBudget <= 0
    ? ''
    : rows.find((row) => escapedBytes(row) > rowBudget)
  if (oversized !== undefined) {
    throw new Error(
      `${contentTooLarge(postContentBytes(`${header}${oversized}`))} A table ` +
        'header plus a single data row already exceeds it, so the table ' +
        'cannot be split by row. Shorten the row, or send the data as a ' +
        'fenced code block.',
    )
  }
  return packSegments(rows, rowBudget).map((piece) => `${header}${piece}`)
}

/** Pack source segments into pieces that each fit `budget` escaped bytes. */
function packSegments(segments: string[], budget: number): string[] {
  const pieces: string[] = []
  let current = ''
  let bytes = 0
  for (const segment of segments) {
    const segmentBytes = escapedBytes(segment)
    if (bytes + segmentBytes <= budget) {
      current += segment
      bytes += segmentBytes
      continue
    }
    if (current !== '') {
      pieces.push(current)
      current = ''
      bytes = 0
    }
    if (segmentBytes <= budget) {
      current = segment
      bytes = segmentBytes
      continue
    }
    for (const sub of splitByGraphemeBytes(segment, budget)) pieces.push(sub)
  }
  if (current !== '') pieces.push(current)
  return pieces
}

/** Split one oversized line at grapheme boundaries, never mid-cluster. */
function splitByGraphemeBytes(text: string, budget: number): string[] {
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
  const pieces: string[] = []
  let current = ''
  let bytes = 0
  for (const { segment } of segmenter.segment(text)) {
    const segmentBytes = escapedBytes(segment)
    if (bytes + segmentBytes > budget) {
      if (current !== '') pieces.push(current)
      current = segment
      bytes = segmentBytes
      continue
    }
    current += segment
    bytes += segmentBytes
  }
  if (current !== '') pieces.push(current)
  return pieces
}

/** Cut a string into lines, each keeping its own newline. */
function lineSegments(text: string): string[] {
  const segments: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    segments.push(text.slice(start, index + 1))
    start = index + 1
  }
  if (start < text.length) segments.push(text.slice(start))
  return segments
}

/**
 * The bytes a string costs inside the serialized `content`: its JSON encoding
 * without the surrounding quotes. A raw UTF-8 count would under-measure every
 * quote, backslash, and newline the platform actually receives escaped.
 */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2
}
