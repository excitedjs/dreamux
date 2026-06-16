import type { Tokens } from 'marked'

import {
  CELL_MAX_BYTES,
  TABLE_COLUMN_HARD_CAP,
  TABLE_DEFAULT_PAGE_SIZE,
} from './constants.js'
import type { CellAlign, TableColumn, TableElement } from './types.js'

/**
 * Convert one GFM table token into one or more `tag: table` body elements. A
 * table wider than the API's 50-column cap is split into adjacent halves; each
 * half repeats the original first column so the reader can still align rows.
 */
export function tableTokenToElements(table: Tokens.Table): TableElement[] {
  validateCellSizes(table)
  const headerCells = table.header
  const rows = table.rows
  const totalCols = headerCells.length
  if (totalCols <= TABLE_COLUMN_HARD_CAP) {
    return [buildTableElement(headerCells, rows, 0, totalCols, false)]
  }
  const out: TableElement[] = []
  out.push(buildTableElement(headerCells, rows, 0, TABLE_COLUMN_HARD_CAP, false))
  const chunkSize = TABLE_COLUMN_HARD_CAP - 1
  for (let start = TABLE_COLUMN_HARD_CAP; start < totalCols; start += chunkSize) {
    const end = Math.min(totalCols, start + chunkSize)
    out.push(buildTableElement(headerCells, rows, start, end, true))
  }
  return out
}

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

function buildTableElement(
  headerCells: Tokens.TableCell[],
  rows: Tokens.TableCell[][],
  start: number,
  end: number,
  includeIdentifier: boolean,
): TableElement {
  const indices: number[] = []
  if (includeIdentifier && start > 0) indices.push(0)
  for (let i = start; i < end; i++) indices.push(i)

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
      record[`col_${outIdx}`] = cell?.text ?? ''
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

function alignToHorizontal(
  align: CellAlign | null | undefined,
): { horizontal_align?: CellAlign } {
  if (align === 'left' || align === 'center' || align === 'right') {
    return { horizontal_align: align }
  }
  return {}
}

function cellHasInlineMarkup(cell: Tokens.TableCell | undefined): boolean {
  if (!cell || !cell.tokens) return false
  for (const t of cell.tokens) {
    if (t.type !== 'text') return true
  }
  return false
}
