/** A v2 card's header field — only the plain-text title slot is populated. */
export interface CardHeader {
  title: { tag: 'plain_text'; content: string }
}

/** Body element rendering a chunk of lark_md text. */
export interface MarkdownElement {
  tag: 'markdown'
  content: string
}

/** Body element rendering a horizontal rule. */
export interface HrElement {
  tag: 'hr'
}

/** Per-cell horizontal alignment, matched to GFM's `:---`, `:---:`, `---:`. */
export type CellAlign = 'left' | 'center' | 'right'

/** One column of a `tag: table` element. */
export interface TableColumn {
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
export interface TableElement {
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
export type CardElement = MarkdownElement | HrElement | TableElement

/** One v2 interactive card, ready to JSON-serialise into `content`. */
export interface RenderedCard {
  schema: '2.0'
  config: { update_multi: true }
  header?: CardHeader
  body: { elements: CardElement[] }
}
