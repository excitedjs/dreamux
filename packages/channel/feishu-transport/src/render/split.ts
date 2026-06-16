/**
 * Split a Markdown block's source into pieces whose UTF-8 byte length each
 * stays at or under `byteBudget`. The input is one block's `raw` field from
 * `marked.lexer`, so the block kind drives the split strategy:
 *
 *   - A fenced code block (opens with ``` or ~~~ and closes with the same run)
 *     is split by line and the open / close lines are repeated on every piece,
 *     so each piece is itself a well-formed fenced block.
 *   - Any other block is split at line boundaries; a single line longer than
 *     the budget is split by grapheme cluster, so a ZWJ-bound emoji cluster or
 *     a Hangul syllable is not cut in half.
 */
export function splitMarkdownByBytes(text: string, byteBudget: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= byteBudget) return [text]
  const fenceLineMatch = /^([`~]{3,}[^\n]*)\n([\s\S]*?)\n([`~]{3,})\s*$/.exec(text)
  if (fenceLineMatch) {
    const open = fenceLineMatch[1] as string
    const body = fenceLineMatch[2] as string
    const close = fenceLineMatch[3] as string
    const overhead =
      Buffer.byteLength(open, 'utf8') + Buffer.byteLength(close, 'utf8') + 2 // two \n separators
    const inner = Math.max(64, byteBudget - overhead)
    const bodyPieces = splitLinesByBytes(body.split('\n'), inner)
    return bodyPieces.map((piece) => [open, piece, close].join('\n'))
  }
  return splitLinesByBytes(text.split('\n'), byteBudget)
}

/**
 * Pack consecutive lines into pieces that each fit `byteBudget`. A line larger
 * than the budget on its own is split by grapheme cluster, never by code unit.
 */
function splitLinesByBytes(lines: string[], byteBudget: number): string[] {
  const pieces: string[] = []
  let current: string[] = []
  let currentBytes = 0

  const flush = (): void => {
    if (current.length === 0) return
    pieces.push(current.join('\n'))
    current = []
    currentBytes = 0
  }

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8')
    const sepBytes = current.length === 0 ? 0 : 1
    if (lineBytes + sepBytes + currentBytes <= byteBudget) {
      current.push(line)
      currentBytes += lineBytes + sepBytes
      continue
    }
    flush()
    if (lineBytes <= byteBudget) {
      current.push(line)
      currentBytes = lineBytes
      continue
    }
    for (const sub of splitByGraphemeBytes(line, byteBudget)) {
      pieces.push(sub)
    }
  }
  flush()
  return pieces
}

/**
 * Split one string into UTF-8 byte chunks at grapheme cluster boundaries.
 */
function splitByGraphemeBytes(text: string, byteBudget: number): string[] {
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
  const pieces: string[] = []
  let current = ''
  let currentBytes = 0
  for (const { segment } of segmenter.segment(text)) {
    const segBytes = Buffer.byteLength(segment, 'utf8')
    if (currentBytes + segBytes > byteBudget) {
      if (current.length > 0) pieces.push(current)
      current = segment
      currentBytes = segBytes
      continue
    }
    current += segment
    currentBytes += segBytes
  }
  if (current.length > 0) pieces.push(current)
  return pieces
}
