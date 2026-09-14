/**
 * Native and legacy Feishu posts flatten to one text body: the title, then
 * one line per row, with mentions left as the placeholders the records name
 * and images and files standing as their keys.
 */

import { describe, expect, test } from 'vitest'
import { parseInbound } from '../src/parse/content'
import type { InboundMessage } from '../src/parse/content'
import type { Mention } from '../src/contract/types'

const records: Mention[] = [
  { key: '@_user_1', id: { open_id: 'ou_ada' }, name: 'Ada' },
  { key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob' },
]

function post(
  rows: unknown[],
  extra: Record<string, unknown> = {},
  mentions: Mention[] = records,
): InboundMessage {
  return {
    message_type: 'post',
    content: JSON.stringify({ zh_cn: { title: '', content: rows, ...extra } }),
    mentions,
  }
}

function markdown(text: string, mentions: Mention[] = records): InboundMessage {
  return post([], { content_v2: [[{ tag: 'md', text }]] }, mentions)
}

describe('post rows', () => {
  test('flattens the title and rows, one row per line', () => {
    expect(parseInbound(post(
      [[{ tag: 'text', text: 'a' }, { tag: 'text', text: 'b' }], [{ tag: 'text', text: 'c' }]],
      { title: 'Title' },
    ))).toEqual({ text: 'Title\nab\nc', resources: [] })
  })

  test('falls back through en_us and ja_jp, then an unwrapped post', () => {
    const rows = [[{ tag: 'text', text: 'hello' }]]
    for (const content of [
      { en_us: { content: rows } },
      { ja_jp: { content: rows } },
      { content: rows },
      { fr_fr: { content: rows } },
    ]) {
      expect(parseInbound({ message_type: 'post', content: JSON.stringify(content) }).text)
        .toBe('hello')
    }
  })

  test('reads content_v2 when present and never mixes it with content', () => {
    expect(parseInbound(post(
      [[{ tag: 'text', text: 'legacy flattening' }]],
      { content_v2: [[{ tag: 'md', text: '# native' }]] },
    )).text).toBe('# native')
  })

  test('an empty post is an empty body', () => {
    expect(parseInbound(post([]))).toEqual({ text: '', resources: [] })
  })
})

describe('post mentions', () => {
  test('a structured at node stands as the placeholder it carries', () => {
    expect(parseInbound(post([[
      { tag: 'at', user_id: '@_user_1', user_name: 'Ada', style: [] },
      { tag: 'text', text: ' look' },
    ]])).text).toBe('@_user_1 look')
  })

  test('an at node written with an identity resolves to its record key', () => {
    expect(parseInbound(post([[{ tag: 'at', user_id: 'ou_bob' }]])).text)
      .toBe('@_user_2')
  })

  test('an at node no record names is carried as written', () => {
    expect(parseInbound(post([[{ tag: 'at', user_id: 'ou_nobody' }]])).text)
      .toBe('ou_nobody')
  })

  test('a Markdown node keeps its placeholders and rewrites tags the records name', () => {
    expect(parseInbound(markdown(
      'hi @_user_1, <at user_id="ou_bob">Bob</at> and <at user_id=\'@_user_1\'></at>',
    )).text).toBe('hi @_user_1, @_user_2 and @_user_1')
  })

  test('a tag no record accounts for stays literal', () => {
    const source = 'see <at user_id="ou_nobody">Nobody</at> and <at id="x"></at>'

    expect(parseInbound(markdown(source)).text).toBe(source)
  })
})

describe('post resources', () => {
  test('a message image in Markdown becomes a resource at its position', () => {
    expect(parseInbound(markdown('see ![shot](img_v2_a) here'))).toEqual({
      text: 'see img_v2_a here',
      resources: [{ type: 'image', key: 'img_v2_a', name: 'img_v2_a.jpg' }],
    })
  })

  test('a web image stays literal', () => {
    const source = 'see ![shot](https://example.test/x.png)'

    expect(parseInbound(markdown(source))).toEqual({ text: source, resources: [] })
  })

  test('structured image, file, and media nodes stand as their keys', () => {
    expect(parseInbound(post([
      [{ tag: 'text', text: 'before' }, { tag: 'img', image_key: 'img_v2_a' }, { tag: 'text', text: 'after' }],
      [{ tag: 'file', file_key: 'file_v2_b', file_name: 'spec.pdf' }],
      [{ tag: 'media', file_key: 'file_v2_c', image_key: 'img_v2_c' }],
    ]))).toEqual({
      text: 'beforeimg_v2_aafter\nfile_v2_b\nfile_v2_c\nimg_v2_c',
      resources: [
        { type: 'image', key: 'img_v2_a', name: 'img_v2_a.jpg' },
        { type: 'file', key: 'file_v2_b', name: 'spec.pdf' },
        { type: 'file', key: 'file_v2_c' },
        { type: 'image', key: 'img_v2_c', name: 'img_v2_c.jpg' },
      ],
    })
  })

  test('the same resource twice is listed once', () => {
    expect(parseInbound(post([
      [{ tag: 'img', image_key: 'img_v2_a' }],
      [{ tag: 'img', image_key: 'img_v2_a' }],
    ]))).toEqual({
      text: 'img_v2_a\nimg_v2_a',
      resources: [{ type: 'image', key: 'img_v2_a', name: 'img_v2_a.jpg' }],
    })
  })
})

describe('post markup', () => {
  test('links, rules, and code blocks are written as Markdown', () => {
    expect(parseInbound(post([
      [{ tag: 'a', text: 'docs', href: 'https://example.test' }],
      [{ tag: 'a', href: 'https://bare.test' }],
      [{ tag: 'hr' }],
      [{ tag: 'code_block', language: 'ts', text: 'const x = 1' }],
    ])).text).toBe([
      '[docs](https://example.test)',
      'https://bare.test',
      '---',
      '```ts\nconst x = 1\n```',
    ].join('\n'))
  })

  test('a code block that contains a fence gets a longer one', () => {
    expect(parseInbound(post([
      [{ tag: 'code_block', text: '```\ninner\n```' }],
    ])).text).toBe('````\n```\ninner\n```\n````')
  })

  test('an unknown node is dropped and the body marked incomplete', () => {
    expect(parseInbound(post([
      [{ tag: 'text', text: 'nice ' }, { tag: 'emotion', emoji_type: 'SMILE' }],
    ]))).toEqual({ text: 'nice ', resources: [], incomplete: true })
  })
})
