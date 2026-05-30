/**
 * Render a Markdown source into one or more Feishu v2 interactive cards.
 *
 * Feishu's `tag: markdown` body element accepts only the "lark_md" subset —
 * bold, italic, strikethrough, inline code, fenced code, links, and (on
 * Feishu 7.6+) lists. It does NOT support headings or GFM tables: a `#` is
 * shown as a literal `#`, and `| a | b |` is shown as the source pipes.
 * Routing every block through `tag: markdown` therefore leaks raw markup into
 * the rendered card whenever the body has a heading or a table.
 *
 * This module parses the source into block tokens (via `marked.lexer`) and
 * routes each block to the v2 card component that actually renders it:
 *
 *   - The first `# h1` becomes the card's `header.title` plain-text slot.
 *     A later `# h1`, and every `##`/`###`/... heading, becomes a body
 *     element wrapping the flattened heading text in `**...**` so lark_md
 *     renders it as visible bold.
 *   - A GFM `| ... |` table becomes a dedicated `tag: table` element with
 *     the header alignment markers mapped to each column's
 *     `horizontal_align`. Cells that contain inline markup flip the
 *     column's `data_type` from `text` to `lark_md`. A cell over
 *     `CELL_MAX_BYTES` is a render-time error — splitting one row's cell
 *     across multiple rows would break alignment, and silently truncating
 *     hides the data the caller asked to deliver.
 *   - A horizontal rule (`---`) becomes a `tag: hr` element.
 *   - Every other block — paragraphs, lists, blockquotes, fenced code —
 *     is emitted as a `tag: markdown` element with the block's raw source,
 *     since lark_md renders those natively.
 *
 * Elements are then packed greedily into cards by a dual budget: Feishu's
 * ~30 KB request body cap AND the v2 card per-card element-count cap.
 * Only the first card carries the header — splitting the body produces
 * follow-up cards with no header, the way a long thread reads. A markdown
 * element body too large for one card is split with `splitMarkdownByBytes`,
 * which counts UTF-8 bytes (so a CJK-heavy body is not budgeted as if it
 * were ASCII) and respects grapheme cluster boundaries (so a ZWJ emoji
 * does not get cut in half).
 *
 * `renderMarkdownToCards` validates every produced card against both
 * budgets before returning; if any card would still exceed them despite
 * splitting, it throws. Callers therefore know that the array they get
 * back is wire-ready — there is no path where the renderer hands the
 * sender a card Feishu would reject. This is the structural half of the
 * "atomic" semantic the channel offers; the network half (every send
 * succeeds or all sends fail) cannot be guaranteed on Feishu's IM API,
 * which has no message-batch transaction.
 *
 * The result is `RenderedCard[]`. `cardToContent(card)` turns one card into
 * the JSON string the `im.message.create` `content` field expects.
 *
 * The 9-row × 9-column limit in `markdown-ref.md` belongs to a different
 * surface (the docs-create pipeline that turns markdown into Feishu document
 * blocks); v2 card tables accept up to 50 columns, paginate rows in-card via
 * `page_size`, and have no per-table row cap of their own. This renderer
 * therefore column-splits at 50 (with the first column preserved on each
 * split half as the identifier) and never row-splits when row-splitting
 * would not actually reduce a card's size.
 */

import { marked, type Token, type Tokens } from 'marked'

/** A v2 card's header field — only the plain-text title slot is populated. */
interface CardHeader {
  title: { tag: 'plain_text'; content: string }
}

/** Body element rendering a chunk of lark_md text. */
interface MarkdownElement {
  tag: 'markdown'
  content: string
}

/** Body element rendering a horizontal rule. */
interface HrElement {
  tag: 'hr'
}

/** Per-cell horizontal alignment, matched to GFM's `:---`, `:---:`, `---:`. */
type CellAlign = 'left' | 'center' | 'right'

/** One column of a `tag: table` element. */
interface TableColumn {
  /** Key the row records use to look up the cell value. */
  name: string
  /** Header label shown to the reader. */
  display_name: string
  /**
   * `text` for plain cells; `lark_md` when any cell in this column carries
   * inline markup. Per the API, `data_type` is column-scoped, not cell-scoped.
   */
  data_type: 'text' | 'lark_md'
  /** Cell alignment, derived from the GFM header separator row. */
  horizontal_align?: CellAlign
}

/** Body element rendering a GFM table. */
interface TableElement {
  tag: 'table'
  page_size: number
  row_height: 'low'
  header_style: {
    bold: true
    background_style: 'grey'
  }
  columns: TableColumn[]
  rows: Array<Record<string, string>>
}

/** Any body element this renderer emits. */
type CardElement = MarkdownElement | HrElement | TableElement

/** One v2 interactive card, ready to JSON-serialise into `content`. */
export interface RenderedCard {
  schema: '2.0'
  config: { update_multi: true }
  header?: CardHeader
  body: { elements: CardElement[] }
}

/**
 * Feishu's documented hard limit for a card request body. Past this the API
 * rejects the call outright; the packer keeps each card's serialised content
 * below `CARD_CONTENT_SAFE_BYTES` so HTTP headers and the request envelope
 * still fit underneath the hard cap.
 */
export const FEISHU_CARD_REQUEST_LIMIT_BYTES = 30 * 1024
const CARD_CONTENT_SAFE_BYTES = 28 * 1024

/**
 * v2 card per-card element-count cap. Observed in PR #73 review: a card with
 * 250 short markdown elements is rejected by Feishu, though the JSON itself
 * is well under the byte cap. The exact upper bound is not in the open
 * docs; the reviewer-cited 200 figure is treated as the hard limit and a
 * lower number is used as the safe budget so a card on the boundary does
 * not silently fail under server-side counting differences.
 */
export const FEISHU_CARD_ELEMENT_HARD_CAP = 200
const CARD_ELEMENT_SAFE_CAP = 180

/**
 * v2 table column cap from the Feishu card API. A wider table is split into
 * several adjacent table elements; each split half repeats the original
 * first column as an identifier the reader can still align rows against.
 */
const TABLE_COLUMN_HARD_CAP = 50

/** In-card paginator page size for tables. The API caps this at 10. */
const TABLE_DEFAULT_PAGE_SIZE = 10

/**
 * Per-cell byte cap. A cell larger than this is rejected at render time:
 * splitting one row's cell across multiple rows breaks alignment with the
 * other columns, and silently truncating drops the data the caller asked
 * to deliver. The author is expected to move the oversized content into a
 * paragraph or fenced code block, where the byte-aware splitter handles
 * arbitrary sizes.
 *
 * 4 KB is comfortably above any reasonable cell value (a long sentence is
 * ~200 bytes) while small enough that a 50-column table of full-budget
 * cells still leaves room for the card envelope inside the byte cap.
 */
export const CELL_MAX_BYTES = 4 * 1024

/**
 * Render a Markdown source into one or more v2 cards.
 *
 * The output is always non-empty: an empty source produces one card with a
 * single empty `tag: markdown` element, so the caller always has something
 * to send. Splitting happens automatically when the serialised card would
 * exceed Feishu's 30 KB request cap, when the body would exceed the
 * 200-element cap, or when a table has more than 50 columns.
 *
 * Throws when a single block cannot be made to fit even after splitting —
 * for example a table whose row, after every cell has been validated under
 * `CELL_MAX_BYTES`, still serialises above the per-card byte cap. The
 * caller therefore sees a render-time error before any send is attempted,
 * instead of the channel posting some cards and then failing on a later
 * one (partial visible state).
 */
export function renderMarkdownToCards(text: string): RenderedCard[] {
  const tokens = marked.lexer(text)
  const { header, elements } = tokensToElements(tokens)
  const cards = packIntoCards(elements, header)
  // Final structural check. By construction every card already fits both
  // budgets, but a defensive assertion makes a future packing-loop bug
  // surface here as a clear error rather than a Feishu reject downstream.
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i] as RenderedCard
    const bytes = cardContentBytes(card)
    const count = card.body.elements.length
    if (bytes > CARD_CONTENT_SAFE_BYTES) {
      throw new Error(
        `rendered card ${i + 1} of ${cards.length} is ${bytes} bytes; ` +
          `Feishu rejects a card body over ${FEISHU_CARD_REQUEST_LIMIT_BYTES} bytes. ` +
          'Reduce the content (shorter paragraphs, fewer rows in any one table).',
      )
    }
    if (count > FEISHU_CARD_ELEMENT_HARD_CAP) {
      throw new Error(
        `rendered card ${i + 1} of ${cards.length} has ${count} elements; ` +
          `Feishu rejects a card with more than ${FEISHU_CARD_ELEMENT_HARD_CAP} elements. ` +
          'Combine adjacent paragraphs or send fewer items per reply.',
      )
    }
  }
  return cards
}

/**
 * Serialise one card into the JSON string Feishu's `im.message.create`
 * `content` field expects. Pure: no side effects, no I/O.
 */
export function cardToContent(card: RenderedCard): string {
  return JSON.stringify(card)
}

/** Byte length of `card`'s serialised content, in UTF-8. */
export function cardContentBytes(card: RenderedCard): number {
  return Buffer.byteLength(cardToContent(card), 'utf8')
}

/**
 * Walk every block token, route it to the right v2 component, and emit
 * `{ header, elements }`. The header slot is filled by the first heading
 * with depth 1; any later h1 falls through to the bold-body fallback so its
 * text is not silently dropped.
 */
function tokensToElements(tokens: Token[]): {
  header: CardHeader | undefined
  elements: CardElement[]
} {
  let header: CardHeader | undefined
  const elements: CardElement[] = []

  for (const token of tokens) {
    if (token.type === 'space') continue

    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      const flat = flattenInline(heading.tokens)
      if (heading.depth === 1 && header === undefined) {
        header = { title: { tag: 'plain_text', content: flat } }
        continue
      }
      // h2+, or a later h1 — lark_md has no heading syntax, so the rendered
      // text would otherwise show the literal `##`. Wrap the flattened text
      // in `**...**` so it renders as visible bold.
      elements.push({ tag: 'markdown', content: `**${flat}**` })
      continue
    }

    if (token.type === 'hr') {
      elements.push({ tag: 'hr' })
      continue
    }

    if (token.type === 'table') {
      for (const t of tableTokenToElements(token as Tokens.Table)) {
        elements.push(t)
      }
      continue
    }

    // Everything else — paragraph, list, blockquote, code, html block — has
    // a `raw` field that preserves the original markdown source. lark_md
    // renders the supported subset; unsupported markup (e.g. blockquote `>`)
    // passes through and may show its leading characters literally.
    const raw = (token as { raw?: string }).raw ?? ''
    const trimmed = raw.replace(/\n+$/, '')
    if (trimmed.length === 0) continue
    elements.push({ tag: 'markdown', content: trimmed })
  }

  if (elements.length === 0 && header === undefined) {
    // Always emit something so the send loop has at least one card to post.
    elements.push({ tag: 'markdown', content: '' })
  }

  return { header, elements }
}

/**
 * Walk a `marked` inline-token tree and produce the plain-text equivalent —
 * `**bold**` becomes `bold`, `[link](url)` becomes `link`, etc. Used for the
 * card's plain-text header slot, which renders markup characters literally.
 */
function flattenInline(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  let out = ''
  for (const t of tokens) {
    if ('tokens' in t && Array.isArray(t.tokens)) {
      out += flattenInline(t.tokens as Token[])
      continue
    }
    out += (t as { text?: string }).text ?? ''
  }
  return out
}

/**
 * Convert one GFM table token into one or more `tag: table` body elements.
 * A table wider than the API's 50-column cap is split into adjacent halves;
 * each half repeats the original first column so the reader can still align
 * a row across the split. Returns at least one element.
 *
 * Throws when any cell exceeds `CELL_MAX_BYTES` — a giant cell does not
 * render usefully and would either force silent truncation or cell-level
 * row splitting that breaks alignment with the other columns. The author
 * should move the oversized content into a paragraph or fenced code block.
 */
function tableTokenToElements(table: Tokens.Table): TableElement[] {
  validateCellSizes(table)
  const headerCells = table.header
  const rows = table.rows
  const totalCols = headerCells.length
  if (totalCols <= TABLE_COLUMN_HARD_CAP) {
    return [buildTableElement(headerCells, rows, 0, totalCols, false)]
  }
  const out: TableElement[] = []
  // First slice: columns [0, 50). Later slices repeat column 0 plus the next
  // 49 columns, so every emitted table stays within the 50-column cap.
  out.push(buildTableElement(headerCells, rows, 0, TABLE_COLUMN_HARD_CAP, false))
  const chunkSize = TABLE_COLUMN_HARD_CAP - 1
  for (let start = TABLE_COLUMN_HARD_CAP; start < totalCols; start += chunkSize) {
    const end = Math.min(totalCols, start + chunkSize)
    out.push(buildTableElement(headerCells, rows, start, end, true))
  }
  return out
}

/**
 * Walk every cell of a parsed table and throw on the first one larger than
 * `CELL_MAX_BYTES`. Run at render time so the error names the row and
 * column position the author can locate in the source.
 */
function validateCellSizes(table: Tokens.Table): void {
  for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
    const row = table.rows[rowIdx]
    if (!row) continue
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const cell = row[colIdx]
      const text = cell?.text ?? ''
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > CELL_MAX_BYTES) {
        const header = table.header[colIdx]?.text ?? `column ${colIdx + 1}`
        throw new Error(
          `table cell at row ${rowIdx + 1}, column "${header}" is ${bytes} bytes; ` +
            `cells over ${CELL_MAX_BYTES} bytes do not render usefully in a card table. ` +
            'Move the content out of the table — a paragraph or fenced code block has no such cap.',
        )
      }
    }
  }
}

/**
 * Build one `tag: table` element from the rows of an already-parsed GFM
 * table. `start..end` selects which columns this element covers; when
 * `includeIdentifier` is true, the original first column is prepended to
 * the selection so a split table keeps an identifier column on every half.
 *
 * Column `data_type` is `text` unless any cell in that column carries
 * inline markup, in which case it flips to `lark_md` so the markup renders.
 */
function buildTableElement(
  headerCells: Tokens.TableCell[],
  rows: Tokens.TableCell[][],
  start: number,
  end: number,
  includeIdentifier: boolean,
): TableElement {
  // Indices into the source table that this element covers. The identifier
  // column is duplicated by index so each cell still resolves correctly.
  const indices: number[] = []
  if (includeIdentifier && start > 0) indices.push(0)
  for (let i = start; i < end; i++) indices.push(i)

  // Stable, in-row-unique column names so a row object can be keyed by name
  // without collisions even when display names repeat. `col_0`, `col_1`, ...
  // are internal keys; the `display_name` is the visible label.
  const columns: TableColumn[] = indices.map((srcIdx, outIdx) => {
    const cell = headerCells[srcIdx]
    const hasInline = rows.some((row) => cellHasInlineMarkup(row[srcIdx]))
    return {
      name: `col_${outIdx}`,
      display_name: cell?.text ?? '',
      data_type: hasInline ? 'lark_md' : 'text',
      ...alignToHorizontal(cell?.align),
    }
  })

  const builtRows: Array<Record<string, string>> = rows.map((row) => {
    const record: Record<string, string> = {}
    indices.forEach((srcIdx, outIdx) => {
      const cell = row[srcIdx]
      const colName = `col_${outIdx}`
      record[colName] = cell?.text ?? ''
    })
    return record
  })

  return {
    tag: 'table',
    page_size: TABLE_DEFAULT_PAGE_SIZE,
    row_height: 'low',
    header_style: { bold: true, background_style: 'grey' },
    columns,
    rows: builtRows,
  }
}

/**
 * Translate a GFM alignment marker into the column field. `marked` reports
 * `align` as `'left' | 'center' | 'right' | null`; an unaligned column gets
 * no `horizontal_align`, so the API picks its default rather than this
 * renderer forcing one.
 */
function alignToHorizontal(
  align: CellAlign | null | undefined,
): { horizontal_align?: CellAlign } {
  if (align === 'left' || align === 'center' || align === 'right') {
    return { horizontal_align: align }
  }
  return {}
}

/**
 * True when a table cell's parsed tokens include any non-text token —
 * bold, italic, link, inline code, etc. The column whose cells trigger this
 * needs `data_type: lark_md` so the markup renders instead of leaking
 * through as literal characters.
 */
function cellHasInlineMarkup(cell: Tokens.TableCell | undefined): boolean {
  if (!cell || !cell.tokens) return false
  for (const t of cell.tokens) {
    if (t.type !== 'text') return true
  }
  return false
}

/**
 * Pack elements into cards by a dual budget: Feishu's 30 KB request cap AND
 * the per-card element count cap. Both must be satisfied for an element to
 * join the current card; either tripping flushes the card. The first card
 * carries the header; later cards do not, so a long reply reads as a
 * threaded continuation rather than repeated banners.
 *
 * A single element that itself would exceed either budget is split inline:
 * a `tag: markdown` element by `splitMarkdownByBytes`, a `tag: table`
 * element by reducing the rows it carries until it fits.
 */
function packIntoCards(
  elements: CardElement[],
  header: CardHeader | undefined,
): RenderedCard[] {
  const cards: RenderedCard[] = []
  let current = newCard(header)
  let isFirstCard = true

  const flush = (): void => {
    if (current.body.elements.length === 0 && current.header === undefined) return
    cards.push(current)
    isFirstCard = false
    current = newCard(undefined)
  }

  const tryAdd = (element: CardElement): boolean => {
    if (current.body.elements.length + 1 > CARD_ELEMENT_SAFE_CAP) return false
    const trial: RenderedCard = {
      ...current,
      body: { elements: [...current.body.elements, element] },
    }
    return cardContentBytes(trial) <= CARD_CONTENT_SAFE_BYTES
  }

  const addPiece = (piece: CardElement): void => {
    if (!tryAdd(piece)) {
      if (current.body.elements.length > 0) flush()
    }
    current.body.elements.push(piece)
  }

  for (const element of elements) {
    if (tryAdd(element)) {
      current.body.elements.push(element)
      continue
    }
    // The element does not fit alongside what is already in the current
    // card. Flush so the current card seals at its safe size, then retry.
    if (current.body.elements.length > 0) flush()
    if (tryAdd(element)) {
      current.body.elements.push(element)
      continue
    }
    // The element alone exceeds at least one budget on a fresh card. Split
    // it into pieces that each fit on their own; each piece is then added
    // through the normal packing path so adjacent small pieces can share a
    // card.
    const pieces = splitOversizedElement(element, isFirstCard ? header : undefined)
    for (const piece of pieces) addPiece(piece)
  }

  flush()
  if (cards.length === 0) cards.push(newCard(header))
  return cards
}

/** Build an empty card, optionally pre-populated with a header slot. */
function newCard(header: CardHeader | undefined): RenderedCard {
  const card: RenderedCard = {
    schema: '2.0',
    config: { update_multi: true },
    body: { elements: [] },
  }
  if (header) card.header = header
  return card
}

/**
 * Split one too-big element into pieces that each individually fit under
 * the per-card budgets. A markdown element is split by `splitMarkdownByBytes`;
 * a table element is split by reducing its row count.
 *
 * `headerOnFirstCard` lets the splitter budget the first piece against the
 * card with the header attached, so a piece that just fits next to the
 * header doesn't get oversized for the very first card.
 */
function splitOversizedElement(
  element: CardElement,
  headerOnFirstCard: CardHeader | undefined,
): CardElement[] {
  if (element.tag === 'markdown') {
    return splitMarkdownElement(element, headerOnFirstCard)
  }
  if (element.tag === 'table') {
    return splitTableByRows(element, headerOnFirstCard)
  }
  return [element]
}

/**
 * Split a too-big `tag: markdown` element into smaller ones, each whose
 * serialised content fits the per-card byte budget. The body is split with
 * `splitMarkdownByBytes`, which counts UTF-8 bytes — so a 12 K-character
 * CJK paragraph (~36 KB) is correctly split, where a char-based budget
 * would believe it fits and ship one oversized card.
 */
function splitMarkdownElement(
  element: MarkdownElement,
  headerOnFirstCard: CardHeader | undefined,
): MarkdownElement[] {
  // Reserve room for the JSON envelope of one card carrying one element:
  // `{"schema":"2.0","config":{"update_multi":true},"body":{"elements":[{"tag":"markdown","content":"..."}]}}`
  // plus the optional header. The envelope is measured with an empty
  // content string; the 256-byte cushion covers JSON-escape expansion of
  // body characters that need escaping (quotes, backslashes, control
  // characters) versus their raw byte count.
  const envelope = cardContentBytes(newCardWithEmpty(headerOnFirstCard))
  const innerBudget = Math.max(256, CARD_CONTENT_SAFE_BYTES - envelope - 256)
  const pieces = splitMarkdownByBytes(element.content, innerBudget)
  return pieces.map((content) => ({ tag: 'markdown', content }))
}

/**
 * Build an empty card carrying one empty markdown element, used to size the
 * fixed envelope overhead when splitting an oversized markdown element. The
 * cushion in `splitMarkdownElement` covers the difference between an empty
 * content string and the brackets/quotes around real content plus any
 * JSON escapes the content contributes on its own.
 */
function newCardWithEmpty(header: CardHeader | undefined): RenderedCard {
  const card = newCard(header)
  card.body.elements.push({ tag: 'markdown', content: '' })
  return card
}

/**
 * Split a Markdown block's source into pieces whose UTF-8 byte length each
 * stays at or under `byteBudget`. The input is one block's `raw` field from
 * `marked.lexer`, so the block kind drives the split strategy:
 *
 *   - A fenced code block (opens with ``` or ~~~ and closes with the same
 *     run) is split by line and the open / close lines are repeated on
 *     every piece, so each piece is itself a well-formed fenced block.
 *   - Any other block is split at line boundaries; a single line longer
 *     than the budget is split by grapheme cluster, so a ZWJ-bound emoji
 *     cluster or a Hangul syllable is not cut in half.
 *
 * Every returned piece is non-empty and fits the budget — the caller can
 * use them directly as `tag: markdown` element bodies.
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
 * Pack consecutive lines into pieces that each fit `byteBudget`. A line
 * larger than the budget on its own is split by grapheme cluster — never
 * by code unit, since that risks cutting a UTF-8 sequence or a ZWJ-bound
 * emoji cluster in half.
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
    const sepBytes = current.length === 0 ? 0 : 1 // joining newline
    if (lineBytes + sepBytes + currentBytes <= byteBudget) {
      current.push(line)
      currentBytes += lineBytes + sepBytes
      continue
    }
    // Adding this line would overflow the current piece.
    flush()
    if (lineBytes <= byteBudget) {
      current.push(line)
      currentBytes = lineBytes
      continue
    }
    // The single line is itself larger than the budget — split it inside.
    for (const sub of splitByGraphemeBytes(line, byteBudget)) {
      pieces.push(sub)
    }
  }
  flush()
  return pieces
}

/**
 * Split one string into UTF-8 byte chunks at grapheme cluster boundaries.
 * Walks `Intl.Segmenter`'s grapheme segments, accumulating bytes until the
 * next grapheme would exceed `byteBudget`. A line of CJK characters or
 * ZWJ-bound emoji clusters therefore splits without ever cutting a
 * code-point or an emoji-cluster in half.
 */
function splitByGraphemeBytes(text: string, byteBudget: number): string[] {
  // `und` (undetermined locale) gives the Unicode default grapheme rules,
  // which is what we want — clusters formed by combining marks, ZWJ, etc.
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

/**
 * Split a too-big `tag: table` element into smaller tables by row. The
 * header columns are repeated on each split half so every emitted table is
 * independently readable; cell-size validation has already rejected a row
 * whose cells alone make it too big to fit, so the row-count window can
 * always shrink to a piece that fits.
 */
function splitTableByRows(
  table: TableElement,
  headerOnFirstCard: CardHeader | undefined,
): TableElement[] {
  if (table.rows.length <= 1) return [table]
  const envelope = cardContentBytes(newCardWithEmpty(headerOnFirstCard))
  const budget = Math.max(2048, CARD_CONTENT_SAFE_BYTES - envelope - 256)
  const out: TableElement[] = []
  let start = 0
  while (start < table.rows.length) {
    let end = table.rows.length
    while (end > start + 1) {
      const candidate: TableElement = { ...table, rows: table.rows.slice(start, end) }
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= budget) break
      end -= 1
    }
    out.push({ ...table, rows: table.rows.slice(start, end) })
    if (end === start) break
    start = end
  }
  return out
}
