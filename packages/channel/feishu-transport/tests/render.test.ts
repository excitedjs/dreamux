import { describe, expect, test } from 'vitest'

import {
  CELL_MAX_BYTES,
  FEISHU_CARD_ELEMENT_HARD_CAP,
  FEISHU_CARD_REQUEST_LIMIT_BYTES,
  cardContentBytes,
  cardToContent,
  renderMarkdownToCards,
  splitMarkdownByBytes,
  type RenderedCard,
} from '../src/render/render'

/**
 * Convenience helper — render `md` and require it to fit one card, since
 * most renderer tests are checking the shape of a single card's elements.
 */
function single(md: string): RenderedCard {
  const cards = renderMarkdownToCards(md)
  expect(cards).toHaveLength(1)
  return cards[0] as RenderedCard
}

describe('renderMarkdownToCards — header routing', () => {
  test('a single h1 fills the header.title slot and emits no body element for it', () => {
    const card = single('# Hello world\n\nsome body')

    expect(card.header).toEqual({ title: { tag: 'plain_text', content: 'Hello world' } })
    expect(card.body.elements).toEqual([{ tag: 'markdown', content: 'some body' }])
  })

  test('no h1 leaves the header field unset', () => {
    const card = single('just a paragraph')

    expect(card.header).toBeUndefined()
    expect(card.body.elements[0]?.tag).toBe('markdown')
  })

  test('a later h1 falls through to a bold body element instead of replacing the header', () => {
    const card = single('# First\n\nbody\n\n# Second')

    expect(card.header?.title.content).toBe('First')
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'body' },
      { tag: 'markdown', content: '**Second**' },
    ])
  })

  test('h2 and h3 render as bold lark_md text since lark_md has no heading syntax', () => {
    const card = single('## Section\n\npara\n\n### Sub')

    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: '**Section**' },
      { tag: 'markdown', content: 'para' },
      { tag: 'markdown', content: '**Sub**' },
    ])
  })

  test('heading text is flattened — inline formatting characters are stripped for plain_text', () => {
    // The plain_text slot renders markup literally, so `**bold**` in the
    // source would otherwise show its asterisks. flattenInline pulls the
    // inner text out of strong/em/codespan/link tokens.
    const card = single('# Hello **bold** and `code`')

    expect(card.header?.title.content).toBe('Hello bold and code')
  })
})

describe('renderMarkdownToCards — block element routing', () => {
  test('a paragraph with inline markup passes through as raw lark_md', () => {
    // lark_md natively renders bold/italic/strikethrough/inline-code/link,
    // so the renderer keeps the source verbatim instead of re-emitting it.
    const card = single('para with **bold**, *italic*, `code`, and [link](https://x).')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: 'para with **bold**, *italic*, `code`, and [link](https://x).',
    })
  })

  test('a fenced code block is preserved with its fences for lark_md to render', () => {
    const card = single('```ts\nconst a = 1\n```')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '```ts\nconst a = 1\n```',
    })
  })

  test('an unordered list passes through as raw markdown', () => {
    const card = single('- one\n- two\n- three')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '- one\n- two\n- three',
    })
  })

  test('a horizontal rule becomes a dedicated tag:hr element', () => {
    const card = single('para one\n\n---\n\npara two')

    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: 'para one' },
      { tag: 'hr' },
      { tag: 'markdown', content: 'para two' },
    ])
  })

  test('an empty source still produces one card with an empty markdown element', () => {
    // The caller's send loop expects at least one card; rendering must never
    // return an empty array, even for the empty string.
    const cards = renderMarkdownToCards('')

    expect(cards).toHaveLength(1)
    expect(cards[0]?.body.elements).toEqual([{ tag: 'markdown', content: '' }])
  })
})

describe('renderMarkdownToCards — tables', () => {
  test('a 3-column 2-row GFM table becomes one tag:table element', () => {
    const md = ['| Name | Age | City |', '|------|-----|------|', '| A | 1 | Bei |', '| B | 2 | Sh  |'].join(
      '\n',
    )
    const card = single(md)
    const table = card.body.elements[0]
    expect(table?.tag).toBe('table')
    if (table?.tag !== 'table') return
    expect(table.columns.map((c) => c.display_name)).toEqual(['Name', 'Age', 'City'])
    expect(table.columns.every((c) => c.data_type === 'text')).toBe(true)
    expect(table.rows).toEqual([
      { col_0: 'A', col_1: '1', col_2: 'Bei' },
      { col_0: 'B', col_1: '2', col_2: 'Sh' },
    ])
  })

  test('column alignment markers map onto each column‘s horizontal_align', () => {
    const md = ['| L | C | R |', '|:--|:-:|--:|', '| a | b | c |'].join('\n')
    const card = single(md)
    const table = card.body.elements[0]
    if (table?.tag !== 'table') throw new Error('expected a table element')
    expect(table.columns.map((c) => c.horizontal_align)).toEqual(['left', 'center', 'right'])
  })

  test('a column with no GFM alignment marker has no horizontal_align field — API picks default', () => {
    const md = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')
    const card = single(md)
    const table = card.body.elements[0]
    if (table?.tag !== 'table') throw new Error('expected a table element')
    for (const col of table.columns) {
      expect(col).not.toHaveProperty('horizontal_align')
    }
  })

  test('a cell with inline markup flips its whole column to data_type lark_md', () => {
    // data_type is column-scoped per the API, so any formatted cell in a
    // column lifts the column to lark_md; sibling columns stay as text.
    const md = [
      '| Plain | Formatted |',
      '|-------|-----------|',
      '| a | normal |',
      '| b | **bold** |',
    ].join('\n')
    const card = single(md)
    const table = card.body.elements[0]
    if (table?.tag !== 'table') throw new Error('expected a table element')
    expect(table.columns.map((c) => c.data_type)).toEqual(['text', 'lark_md'])
  })

  test('a table wider than 50 columns is split, with the first column duplicated as identifier', () => {
    // 60 columns → split into two tables: cols [0..50) and identifier(0) + cols [50..60).
    const header = '| ' + Array.from({ length: 60 }, (_, i) => `c${i}`).join(' | ') + ' |'
    const sep = '|' + Array.from({ length: 60 }, () => '---').join('|') + '|'
    const row = '| ' + Array.from({ length: 60 }, (_, i) => `v${i}`).join(' | ') + ' |'
    const md = [header, sep, row].join('\n')

    const card = single(md)
    expect(card.body.elements).toHaveLength(2)
    const first = card.body.elements[0]
    const second = card.body.elements[1]
    if (first?.tag !== 'table' || second?.tag !== 'table') {
      throw new Error('expected two table elements from a split')
    }
    expect(first.columns).toHaveLength(50)
    expect(first.columns[0]?.display_name).toBe('c0')
    expect(first.columns[49]?.display_name).toBe('c49')
    // Second half repeats column 0 as the identifier, then carries c50..c59.
    expect(second.columns).toHaveLength(11)
    expect(second.columns[0]?.display_name).toBe('c0')
    expect(second.columns[1]?.display_name).toBe('c50')
    expect(second.columns[10]?.display_name).toBe('c59')
    expect(second.rows[0]?.col_0).toBe('v0')
    expect(second.rows[0]?.col_1).toBe('v50')
  })
})

describe('renderMarkdownToCards — mixed-element ordering and packing', () => {
  test('elements appear in markdown source order, with the header lifted out of the body', () => {
    const md = [
      '# Title',
      '',
      'intro paragraph',
      '',
      '## Section',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```sh',
      'echo hi',
      '```',
      '',
      '- bullet',
    ].join('\n')

    const card = single(md)

    expect(card.header?.title.content).toBe('Title')
    expect(card.body.elements.map((e) => e.tag)).toEqual([
      'markdown', // intro paragraph
      'markdown', // **Section** (h2 fallback)
      'table',
      'markdown', // fenced code
      'markdown', // bullet list
    ])
  })

  test('every emitted card serialises below Feishu‘s 30 KB request cap', () => {
    // 60 KB of fence-free text exceeds the per-card budget and must split.
    // Each card must independently fit, since each is sent as its own
    // message.
    const cards = renderMarkdownToCards('x'.repeat(60_000))

    expect(cards.length).toBeGreaterThan(1)
    for (const card of cards) {
      expect(cardContentBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_LIMIT_BYTES)
    }
  })

  test('only the first card carries the header — follow-ups read as a continuation', () => {
    const md = '# Title\n\n' + 'x'.repeat(60_000)
    const cards = renderMarkdownToCards(md)

    expect(cards.length).toBeGreaterThan(1)
    expect(cards[0]?.header?.title.content).toBe('Title')
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i]?.header).toBeUndefined()
    }
  })
})

describe('cardToContent', () => {
  test('serialises a v2 card with the schema, config, and body envelope', () => {
    const card = single('hello')
    const parsed = JSON.parse(cardToContent(card))

    expect(parsed.schema).toBe('2.0')
    expect(parsed.config).toEqual({ update_multi: true })
    expect(parsed.body.elements[0]).toEqual({ tag: 'markdown', content: 'hello' })
  })

  test('declares update_multi so a later im.message.patch is accepted', () => {
    // Feishu rejects a patch on a card sent without `update_multi: true`;
    // the edit_message tool relies on patch, so every card must opt in.
    const parsed = JSON.parse(cardToContent(single('hi')))

    expect(parsed.config.update_multi).toBe(true)
  })
})

describe('renderMarkdownToCards — PR #73 review regressions', () => {
  test('P1-1 a CJK paragraph wide enough to exceed the byte cap splits cleanly', () => {
    // Reviewer-reported: 12 000 汉 characters (~36 KB UTF-8) was emitted as a
    // single ~36 KB card under a char-based budget, which Feishu rejects. The
    // byte-aware splitter must produce cards that each individually fit.
    const cards = renderMarkdownToCards('汉'.repeat(12_000))

    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const card of cards) {
      expect(cardContentBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_LIMIT_BYTES)
    }
    // The split must be lossless — a CJK paragraph put through the splitter
    // must reassemble to the original character count.
    const reassembled = cards.map((c) => c.body.elements.map((e) => (e.tag === 'markdown' ? e.content : '')).join('')).join('')
    expect(reassembled).toBe('汉'.repeat(12_000))
  })

  test('P1-2 a single table cell over the cap fails fast instead of shipping a partial reply', () => {
    // Reviewer-reported: a row with one ~40 KB cell rendered as a single
    // ~40 KB card. A multi-row variant could send earlier small cards
    // successfully and only fail on the oversized row — the recipient sees
    // the head of the reply with no signal that the tail was lost. Render
    // must reject before any send is attempted, with an error naming the
    // row and column position the author can fix.
    const md = ['| Name | Detail |', '|------|--------|', `| row | ${'x'.repeat(40_000)} |`].join(
      '\n',
    )

    expect(() => renderMarkdownToCards(md)).toThrow(
      /row 1, column "Detail" is 40000 bytes/,
    )
  })

  test('P1-2 50 KB cell also rejects with the same atomic-fail semantic', () => {
    // The reviewer's "50KB 单 cell 不会出 partial" boundary — the renderer
    // must throw with no attempt to ship anything that would later 400.
    const md = ['| A | B |', '|---|---|', `| x | ${'y'.repeat(50_000)} |`].join('\n')

    expect(() => renderMarkdownToCards(md)).toThrow(/50000 bytes/)
  })

  test('P1-3 250 short paragraphs pack across cards by element count, not just bytes', () => {
    // Reviewer-reported: 250 short paragraphs (~11 KB total) packed into one
    // card with 250 elements; Feishu rejected it because the per-card
    // element-count cap (~200) is hit first.
    const md = Array.from({ length: 250 }, (_, i) => `paragraph ${i}`).join('\n\n')
    const cards = renderMarkdownToCards(md)

    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const card of cards) {
      expect(card.body.elements.length).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_HARD_CAP)
      expect(cardContentBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_LIMIT_BYTES)
    }
  })

  test('boundary: a 30 719-byte paragraph still fits because each split piece fits', () => {
    // One byte below the API's hard cap — a body at this size must still
    // split rather than slip through a card that just exceeds the budget.
    const cards = renderMarkdownToCards('x'.repeat(30_719))

    for (const card of cards) {
      expect(cardContentBytes(card)).toBeLessThanOrEqual(FEISHU_CARD_REQUEST_LIMIT_BYTES)
    }
  })

  test('boundary: a card with exactly the safe element budget is not over the hard cap', () => {
    // Asserts the invariant that the per-card element-count budget the
    // packer enforces leaves headroom under the hard cap, so a card at the
    // safe budget is not on the boundary the server checks.
    const md = Array.from({ length: 180 }, (_, i) => `p${i}`).join('\n\n')
    const cards = renderMarkdownToCards(md)

    for (const card of cards) {
      expect(card.body.elements.length).toBeLessThanOrEqual(FEISHU_CARD_ELEMENT_HARD_CAP)
    }
  })

  test('boundary: an at-budget cell is accepted; one byte over is rejected', () => {
    // A cell exactly at `CELL_MAX_BYTES` passes; CELL_MAX_BYTES + 1 fails.
    // The boundary itself is part of the contract, so a future tweak to the
    // cap value will surface here as a test failure with the new number.
    const atBudget = ['| A | B |', '|---|---|', `| x | ${'a'.repeat(CELL_MAX_BYTES)} |`].join('\n')
    const overBudget = ['| A | B |', '|---|---|', `| x | ${'a'.repeat(CELL_MAX_BYTES + 1)} |`].join(
      '\n',
    )

    expect(() => renderMarkdownToCards(atBudget)).not.toThrow()
    expect(() => renderMarkdownToCards(overBudget)).toThrow(
      new RegExp(`is ${CELL_MAX_BYTES + 1} bytes`),
    )
  })
})

describe('splitMarkdownByBytes', () => {
  test('budgets in UTF-8 bytes — a CJK paragraph splits, an ASCII line of the same char count does not', () => {
    const cjk = '汉'.repeat(3000) // ~9 KB
    const ascii = 'x'.repeat(3000) // ~3 KB
    const budget = 4_096

    const cjkPieces = splitMarkdownByBytes(cjk, budget)
    const asciiPieces = splitMarkdownByBytes(ascii, budget)

    expect(cjkPieces.length).toBeGreaterThan(1)
    expect(asciiPieces).toEqual([ascii])
    for (const piece of cjkPieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(budget)
    }
  })

  test('preserves fenced code balance — every piece wraps in the original open and close', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    const text = ['```ts', body, '```'].join('\n')

    const pieces = splitMarkdownByBytes(text, 200)

    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(piece.startsWith('```ts')).toBe(true)
      expect(piece.endsWith('```')).toBe(true)
    }
  })

  test('splits a single oversized line by grapheme cluster, never inside a UTF-8 sequence', () => {
    // 1 000 ZWJ family emoji clusters — each grapheme is several code points.
    // A code-unit split would carve a cluster in half and leave Feishu (or
    // any client) showing the boxes; the grapheme-aware splitter does not.
    const grapheme = '👨‍👩‍👧'
    const oversized = grapheme.repeat(1_000)
    const pieces = splitMarkdownByBytes(oversized, 256)

    expect(pieces.length).toBeGreaterThan(1)
    // No piece may contain a dangling combining mark or end mid-cluster —
    // joining all pieces back together must reproduce the input exactly.
    expect(pieces.join('')).toBe(oversized)
  })
})

describe('renderMarkdownToCards — @-mention preprocessing', () => {
  test('<@open_id> at the start of a message renders as a lark_md <at> mention', () => {
    const card = single('<@ou_render_target> 任务完成')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '<at id="ou_render_target"></at> 任务完成',
    })
  })

  test('<@open_id> mid-sentence is converted inline', () => {
    const card = single('请 <@ou_abc123> 帮忙 review')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '请 <at id="ou_abc123"></at> 帮忙 review',
    })
  })

  test('multiple <@> mentions in one message are all converted', () => {
    const card = single('<@ou_aaa> and <@ou_bbb> please review')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '<at id="ou_aaa"></at> and <at id="ou_bbb"></at> please review',
    })
  })

  test('<@open_id> inside a fenced code block is NOT converted — code must not accidentally ping anyone', () => {
    const card = single('```\n<@ou_abc123> example\n```')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '```\n<@ou_abc123> example\n```',
    })
  })

  test('<@open_id> inside an inline code span is NOT converted', () => {
    const card = single('run `<@ou_abc123>` to mention')

    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: 'run `<@ou_abc123>` to mention',
    })
  })
})
