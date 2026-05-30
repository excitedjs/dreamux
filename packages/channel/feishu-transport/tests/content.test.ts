import { describe, expect, test } from 'vitest'
import { applyMentions, extractPostText, parseInbound } from '../src/parse/content'
import type { InboundMessage } from '../src/parse/content'
import type { Mention } from '../src/contract/types'

function message(type: string, content: unknown, mentions?: Mention[]): InboundMessage {
  return { message_type: type, content: JSON.stringify(content), mentions }
}

describe('parseInbound — text', () => {
  test('extracts plain text', () => {
    expect(parseInbound(message('text', { text: 'hello there' }))).toEqual({ text: 'hello there' })
  })

  test('resolves @-mention placeholders to display names', () => {
    const msg = message('text', { text: '@_user_1 ping' }, [{ key: '@_user_1', name: 'Alice' }])
    expect(parseInbound(msg).text).toBe('@Alice ping')
  })

  test('text with no JSON content falls back gracefully', () => {
    expect(parseInbound({ message_type: 'text', content: 'raw garbage' }).text).toBe('raw garbage')
  })

  test('a message with no content yields the unparseable marker', () => {
    expect(parseInbound({ message_type: 'text' }).text).toBe('(unparseable message)')
  })
})

describe('parseInbound — attachments', () => {
  test('an image message becomes a short text marker', () => {
    expect(parseInbound(message('image', { image_key: 'img_v2_abc' }))).toEqual({
      text: '(image)',
    })
  })

  test('a file message names the file in its text', () => {
    expect(parseInbound(message('file', { file_name: 'report.pdf', file_key: 'k' }))).toEqual({
      text: '(file: report.pdf)',
    })
  })

  test('a file message with no name falls back to "unknown"', () => {
    expect(parseInbound(message('file', { file_key: 'k' })).text).toBe('(file: unknown)')
  })

  test('an unknown message type is summarized', () => {
    expect(parseInbound(message('audio', { duration: 3 })).text).toBe('(audio message)')
  })
})

describe('extractPostText', () => {
  test('flattens a zh_cn post with title and tagged elements', () => {
    const post = {
      zh_cn: {
        title: 'Title',
        content: [
          [
            { tag: 'text', text: 'hello ' },
            { tag: 'a', text: 'link', href: 'http://x' },
          ],
          [
            { tag: 'at', user_name: 'Bob' },
            { tag: 'text', text: ' look' },
            { tag: 'img', image_key: 'k' },
          ],
        ],
      },
    }
    expect(extractPostText(post)).toBe('Title\nhello link\n@Bob look(image)')
  })

  test('falls back to en_us when zh_cn is absent', () => {
    const post = { en_us: { title: 'Hi', content: [[{ tag: 'text', text: 'world' }]] } }
    expect(extractPostText(post)).toBe('Hi\nworld')
  })

  test('falls back to ja_jp when zh_cn and en_us are absent', () => {
    const post = { ja_jp: { title: 'やあ', content: [[{ tag: 'text', text: '世界' }]] } }
    expect(extractPostText(post)).toBe('やあ\n世界')
  })

  test('reads a post that has no locale wrapper at all', () => {
    const post = { title: 'Bare', content: [[{ tag: 'text', text: 'body' }]] }
    expect(extractPostText(post)).toBe('Bare\nbody')
  })

  test('a link with no text renders its href', () => {
    const post = { zh_cn: { content: [[{ tag: 'a', href: 'http://only-href' }]] } }
    expect(extractPostText(post)).toBe('http://only-href')
  })

  test('parseInbound routes post messages through extractPostText', () => {
    const post = { zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'body' }]] } }
    expect(parseInbound(message('post', post)).text).toBe('T\nbody')
  })
})

describe('parseInbound — interactive', () => {
  function card(header: unknown, elements: unknown[]): unknown {
    return {
      schema: '2.0',
      config: { update_multi: true },
      ...(header ? { header } : {}),
      body: { elements },
    }
  }

  test('extracts markdown element content', () => {
    const c = card(undefined, [
      { tag: 'markdown', content: 'hello **world**' },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('hello **world**')
  })

  test('prepends header title when present', () => {
    const c = card({ title: { tag: 'plain_text', content: 'My Title' } }, [
      { tag: 'markdown', content: 'body text' },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('My Title\nbody text')
  })

  test('skips hr elements silently', () => {
    const c = card(undefined, [
      { tag: 'markdown', content: 'before' },
      { tag: 'hr' },
      { tag: 'markdown', content: 'after' },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('before\nafter')
  })

  test('extracts div with nested text.content (other-bot format)', () => {
    const c = card(undefined, [
      { tag: 'div', text: { tag: 'lark_md', content: 'nested text' } },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('nested text')
  })

  test('extracts div.fields[] lark_md cells', () => {
    const c = card(undefined, [
      {
        tag: 'div',
        fields: [
          { text: { tag: 'lark_md', content: 'field one' } },
          { text: { tag: 'lark_md', content: 'field two' } },
        ],
      },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('field one\nfield two')
  })

  test('recurses into column_set columns', () => {
    const c = card(undefined, [
      {
        tag: 'column_set',
        columns: [
          { elements: [{ tag: 'markdown', content: 'col A' }] },
          { elements: [{ tag: 'markdown', content: 'col B' }] },
        ],
      },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('col A\ncol B')
  })

  test('unwraps user_dsl envelope from WebSocket events', () => {
    const inner = card({ title: { tag: 'plain_text', content: 'WS Title' } }, [
      { tag: 'markdown', content: 'ws body' },
    ])
    const wrapped = { user_dsl: JSON.stringify(inner) }
    expect(parseInbound(message('interactive', wrapped)).text).toBe('WS Title\nws body')
  })

  test('falls back to (interactive card) when no extractable text', () => {
    const c = card(undefined, [{ tag: 'hr' }, { tag: 'table' }])
    expect(parseInbound(message('interactive', c)).text).toBe('(interactive card)')
  })

  test('null element in body.elements does not crash', () => {
    const c = card(undefined, [null, { tag: 'markdown', content: 'ok' }, null])
    expect(parseInbound(message('interactive', c)).text).toBe('ok')
  })

  test('null entry in div.fields does not crash', () => {
    const c = card(undefined, [
      { tag: 'div', fields: [null, { text: { tag: 'lark_md', content: 'field' } }, null] },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('field')
  })

  test('null entry in column_set.columns does not crash', () => {
    const c = card(undefined, [
      {
        tag: 'column_set',
        columns: [
          null,
          { elements: [{ tag: 'markdown', content: 'col text' }] },
          null,
        ],
      },
    ])
    expect(parseInbound(message('interactive', c)).text).toBe('col text')
  })
})

describe('applyMentions', () => {
  test('returns the text unchanged when there are no mentions', () => {
    expect(applyMentions('plain', undefined)).toBe('plain')
  })

  test('replaces every occurrence of a placeholder', () => {
    const mentions: Mention[] = [{ key: '@_user_1', name: 'Sam' }]
    expect(applyMentions('@_user_1 and @_user_1', mentions)).toBe('@Sam and @Sam')
  })

  test('ignores a mention with no name', () => {
    const mentions: Mention[] = [{ key: '@_user_1' }]
    expect(applyMentions('@_user_1 here', mentions)).toBe('@_user_1 here')
  })
})
