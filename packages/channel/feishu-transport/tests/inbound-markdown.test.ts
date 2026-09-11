/**
 * Inbound Markdown and mention identity.
 *
 * Peer clients keep sending what they always sent — plain text, legacy rich
 * posts, interactive cards — and Feishu now also delivers natively authored
 * Markdown. These cover the one parsing boundary that has to read all of them
 * and produce the same ordered meaning: text, code, mentions, resources.
 */

import { describe, expect, test } from 'vitest'
import { mergeInteractiveInbound, parseInbound } from '../src/parse/content'
import type { InboundContentPart, InboundMessage } from '../src/parse/content'
import type { Mention } from '../src/contract/types'
import { normalizeMessageReadItem } from '../src/transport/message-read'

function message(
  type: string,
  content: unknown,
  mentions?: Mention[],
): InboundMessage {
  return { message_type: type, content: JSON.stringify(content), mentions }
}

function partsOf(msg: InboundMessage): InboundContentPart[] {
  return parseInbound(msg).parts ?? []
}

/** A native post as `im.v1.message.get` returns it: both projections, nested. */
function nativePost(markdown: string): Record<string, unknown> {
  return {
    title: '',
    // The lossy flattening Feishu keeps for older readers.
    content: [[{ tag: 'text', text: 'legacy flattening' }]],
    content_v2: [[{ tag: 'md', text: markdown }]],
  }
}

describe('native post projection', () => {
  test('reads content_v2 and never mixes it with the legacy projection', () => {
    const parsed = parseInbound(message('post', nativePost('# Heading\n\nBody')))

    expect(parsed.text).toBe('# Heading\n\nBody')
    expect(parsed.text).not.toContain('legacy flattening')
  })

  test('reads the legacy projection when the post has no content_v2', () => {
    const post = {
      zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'body' }]] },
    }
    expect(parseInbound(message('post', post)).text).toBe('T\nbody')
  })

  test('prefers content_v2 inside a locale block too', () => {
    const post = {
      zh_cn: {
        content: [[{ tag: 'text', text: 'flattened' }]],
        content_v2: [[{ tag: 'md', text: '**rich**' }]],
      },
    }
    expect(parseInbound(message('post', post)).text).toBe('**rich**')
  })
})

describe('native post mentions', () => {
  const mentions: Mention[] = [
    { key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' },
  ]

  test('an inline user_id tag becomes a mention at its position', () => {
    const parsed = partsOf(message(
      'post',
      nativePost('Hi <at user_id="ou_example">Example</at>, please look.'),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', id: 'ou_example', name: 'Example' },
      { kind: 'text', text: ', please look.' },
    ])
  })

  test('an empty-name tag takes its display name from the record', () => {
    const parsed = partsOf(message(
      'post',
      nativePost('<at user_id="ou_example"></at> ping'),
      mentions,
    ))

    expect(parsed[0]).toEqual({
      kind: 'mention',
      id: 'ou_example',
      name: 'Example',
    })
  })

  test('a card-style id attribute is not a mention in a native post', () => {
    const parsed = partsOf(message(
      'post',
      nativePost('<at id="ou_example">Example</at>'),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'text', text: '<at id="ou_example">Example</at>' },
    ])
  })

  test('a tag inside fenced or inline code stays an example', () => {
    const parsed = partsOf(message(
      'post',
      nativePost(
        'Write `<at user_id="ou_example">x</at>` like this:\n' +
          '```md\n<at user_id="ou_example">x</at>\n```\n',
      ),
      mentions,
    ))

    expect(parsed.some((part) => part.kind === 'mention')).toBe(false)
    expect(parsed).toContainEqual({
      kind: 'code',
      code: '<at user_id="ou_example">x</at>',
      language: 'md',
    })
  })

  test('a structured at node resolves its placeholder through the records', () => {
    const post = {
      zh_cn: {
        content: [[
          { tag: 'at', user_id: '@_user_1' },
          { tag: 'text', text: ' hello' },
        ]],
      },
    }
    expect(partsOf(message('post', post, mentions))).toEqual([
      { kind: 'mention', id: 'ou_example', name: 'Example' },
      { kind: 'text', text: ' hello' },
    ])
  })

  test('a code span ends at its own delimiter run, not the first backtick', () => {
    const parsed = partsOf(message(
      'post',
      nativePost('``a ` <at user_id="ou_example">Example</at>``'),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'text', text: '``a ` <at user_id="ou_example">Example</at>``' },
    ])
  })

  test('an escaped tag is the example its author escaped it to be', () => {
    const source = '\\<at user_id="ou_example">Example</at>'
    const parsed = parseInbound(message('post', nativePost(source), mentions))

    expect(parsed.parts).toEqual([{ kind: 'text', text: source }])
  })

  test('an escaped backslash still leaves the tag itself a mention', () => {
    const parsed = partsOf(message(
      'post',
      nativePost('\\\\<at user_id="ou_example">Example</at>'),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'text', text: '\\\\' },
      { kind: 'mention', id: 'ou_example', name: 'Example' },
    ])
  })

  test('an identifier no record accounts for is carried as the source wrote it', () => {
    // Nothing here classifies the identifier: the records are what state a
    // supported identity, and this message carries none, so the occurrence
    // keeps the id and name its source asserted.
    const parsed = partsOf(message(
      'post',
      nativePost('<at user_id="ou_unlisted">Peer</at> done'),
    ))

    expect(parsed).toEqual([
      { kind: 'mention', id: 'ou_unlisted', name: 'Peer' },
      { kind: 'text', text: ' done' },
    ])
  })

  test('a record with no user identity stays ordinary @name text', () => {
    const post = {
      zh_cn: {
        content: [[{ tag: 'at', user_id: '@_user_1', user_name: 'Peer Bot' }]],
      },
    }
    const appOnly: Mention[] = [{ key: '@_user_1', name: 'Peer Bot' }]
    expect(partsOf(message('post', post, appOnly))).toEqual([
      { kind: 'text', text: '@Peer Bot' },
    ])
  })
})

describe('native post code and resources', () => {
  test('a fence opened and closed across legacy rows is one code part', () => {
    const post = {
      zh_cn: {
        content: [
          [{ tag: 'text', text: '```ts' }],
          [{ tag: 'text', text: 'const a = 1' }],
          [{ tag: 'text', text: '```' }],
        ],
      },
    }
    expect(partsOf(message('post', post))).toEqual([
      { kind: 'code', code: 'const a = 1', language: 'ts' },
    ])
  })

  test('an escaped image reference is not a message resource', () => {
    const source = '\\![shot](img_v2_abc)'
    const parsed = parseInbound(message('post', nativePost(source)))

    expect(parsed.resources).toBeUndefined()
    expect(parsed.parts).toEqual([{ kind: 'text', text: source }])
  })

  test('a Markdown image key joins the ordered resource projection', () => {
    const parsed = parseInbound(message(
      'post',
      nativePost('before ![shot](img_v2_abc) after'),
    ))

    expect(parsed.parts).toEqual([
      { kind: 'text', text: 'before ' },
      {
        kind: 'resource',
        resource: { type: 'image', key: 'img_v2_abc', name: 'img_v2_abc.jpg' },
      },
      { kind: 'text', text: ' after' },
    ])
    expect(parsed.resources).toEqual([
      { type: 'image', key: 'img_v2_abc', name: 'img_v2_abc.jpg' },
    ])
  })

  test('an ordinary web image is not a message resource', () => {
    const parsed = parseInbound(message(
      'post',
      nativePost('![shot](https://example.com/a.png)'),
    ))

    expect(parsed.resources).toBeUndefined()
    expect(parsed.text).toBe('![shot](https://example.com/a.png)')
  })

  test('an image reference inside code stays code', () => {
    const parsed = parseInbound(message(
      'post',
      nativePost('```\n![shot](img_v2_abc)\n```\n'),
    ))

    expect(parsed.resources).toBeUndefined()
    expect(parsed.parts).toEqual([
      { kind: 'code', code: '![shot](img_v2_abc)' },
    ])
  })

  test('a plain post node keeps literal mention and image syntax literal', () => {
    // The legacy projection states a mention as an `at` node and an image as an
    // `img` node. XML and image syntax sitting in a text node is what the
    // sender typed, so it stays what it is.
    const post = {
      zh_cn: {
        content: [[{
          tag: 'text',
          text: '<at user_id="ou_example">Example</at> ![shot](img_v2_abc)',
        }]],
      },
    }
    const parsed = parseInbound(message(
      'post',
      post,
      [{ key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' }],
    ))

    expect(parsed.resources).toBeUndefined()
    expect(parsed.parts).toEqual([{
      kind: 'text',
      text: '<at user_id="ou_example">Example</at> ![shot](img_v2_abc)',
    }])
  })

  test('a structured image node keeps its existing projection', () => {
    const post = {
      zh_cn: { content: [[{ tag: 'img', image_key: 'img_v2_node' }]] },
    }
    expect(parseInbound(message('post', post)).resources).toEqual([
      { type: 'image', key: 'img_v2_node', name: 'img_v2_node.jpg' },
    ])
  })
})

function card(elements: unknown[]): Record<string, unknown> {
  return { schema: '2.0', body: { elements } }
}

describe('interactive card mentions', () => {
  const mentions: Mention[] = [
    { key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' },
  ]

  test('a markdown field carries an inline id tag as a mention', () => {
    const parsed = partsOf(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id="ou_example"></at> please review' }]),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'mention', id: 'ou_example', name: 'Example' },
      { kind: 'text', text: ' please review' },
    ])
  })

  test('the unquoted id form live readback returns is a mention too', () => {
    const parsed = partsOf(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id=ou_example></at> ping' }]),
      mentions,
    ))

    expect(parsed[0]).toEqual({
      kind: 'mention',
      id: 'ou_example',
      name: 'Example',
    })
  })

  test('the same characters in a plain_text field stay literal', () => {
    const parsed = partsOf(message(
      'interactive',
      card([{ tag: 'plain_text', content: '<at id="ou_example"></at> ping' }]),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'text', text: '<at id="ou_example"></at> ping' },
    ])
  })

  test('a div reads its inner field tag to decide', () => {
    const richDiv = partsOf(message(
      'interactive',
      card([{ tag: 'div', text: { tag: 'lark_md', content: '<at id="ou_example"></at>' } }]),
      mentions,
    ))
    const plainDiv = partsOf(message(
      'interactive',
      card([{ tag: 'div', text: { tag: 'plain_text', content: '<at id="ou_example"></at>' } }]),
      mentions,
    ))

    expect(richDiv).toEqual([
      { kind: 'mention', id: 'ou_example', name: 'Example' },
    ])
    expect(plainDiv).toEqual([
      { kind: 'text', text: '<at id="ou_example"></at>' },
    ])
  })

  test('a simplified at node resolves through the records', () => {
    const parsed = partsOf(message(
      'interactive',
      card([{ tag: 'div', elements: [{ tag: 'at', user_id: '@_user_1' }] }]),
      mentions,
    ))

    expect(parsed).toEqual([
      { kind: 'mention', id: 'ou_example', name: 'Example' },
    ])
  })

  test('a fence inside a card markdown field becomes a code part', () => {
    const parsed = partsOf(message(
      'interactive',
      card([{ tag: 'markdown', content: 'see:\n```sh\nls -l\n```\n' }]),
    ))

    expect(parsed).toContainEqual({
      kind: 'code',
      code: 'ls -l',
      language: 'sh',
    })
  })
})

describe('card read merge', () => {
  const mentions: Mention[] = [
    { key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' },
  ]

  test('one line present in both card reads is not appended twice', () => {
    const structured = parseInbound(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id="ou_example"></at> please review' }]),
      mentions,
    ))
    // The default read has no mention metadata and shows the rendered name.
    const rendered = parseInbound(message(
      'interactive',
      card([{ tag: 'plain_text', content: '@Example please review' }]),
    ))

    const merged = mergeInteractiveInbound(structured, rendered)

    expect(merged.text).toBe('@Example please review')
    expect(merged.parts).toEqual(structured.parts)
  })

  test('a repeated mention in the primary read survives the merge', () => {
    const structured = parseInbound(message(
      'interactive',
      card([
        { tag: 'markdown', content: '<at id="ou_example"></at> first' },
        { tag: 'markdown', content: '<at id="ou_example"></at> second' },
      ]),
      mentions,
    ))
    const rendered = parseInbound(message(
      'interactive',
      card([{ tag: 'plain_text', content: '@Example first\n@Example second' }]),
    ))

    const merged = mergeInteractiveInbound(structured, rendered)

    expect(merged.parts?.filter((part) => part.kind === 'mention')).toHaveLength(2)
    expect(merged.text).not.toContain('Additional rendered card content')
  })

  test('a line is compared with its own identities, not the whole document', () => {
    // The primary read already mentions `ou_second` — on another line. That
    // says nothing about this line, whose `@Same` names somebody else there.
    const structured = parseInbound(message(
      'interactive',
      card([
        { tag: 'markdown', content: '<at id="ou_first">Same</at>' },
        { tag: 'markdown', content: '<at id="ou_second">Same</at> has context' },
      ]),
      [
        { key: '@_user_1', id: { open_id: 'ou_first' }, name: 'Same' },
        { key: '@_user_2', id: { open_id: 'ou_second' }, name: 'Same' },
      ],
    ))
    const rendered = parseInbound(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id="ou_second">Same</at>' }]),
      [{ key: '@_user_1', id: { open_id: 'ou_second' }, name: 'Same' }],
    ))

    const merged = mergeInteractiveInbound(structured, rendered)

    expect(merged.text).toContain('Additional rendered card content');
    expect(merged.parts?.filter((part) => part.kind === 'mention')).toEqual([
      { kind: 'mention', id: 'ou_first', name: 'Same' },
      { kind: 'mention', id: 'ou_second', name: 'Same' },
      { kind: 'mention', id: 'ou_second', name: 'Same' },
    ])
  })

  test('two people sharing a display name keep both identities', () => {
    const first: Mention[] = [
      { key: '@_user_1', id: { open_id: 'ou_first' }, name: 'Same' },
    ]
    const second: Mention[] = [
      { key: '@_user_1', id: { open_id: 'ou_second' }, name: 'Same' },
    ]
    const structured = parseInbound(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id="ou_first">Same</at>' }]),
      first,
    ))
    const rendered = parseInbound(message(
      'interactive',
      card([{ tag: 'markdown', content: '<at id="ou_second">Same</at>' }]),
      second,
    ))

    const merged = mergeInteractiveInbound(structured, rendered)

    expect(merged.parts?.filter((part) => part.kind === 'mention')).toEqual([
      { kind: 'mention', id: 'ou_first', name: 'Same' },
      { kind: 'mention', id: 'ou_second', name: 'Same' },
    ])
  })

  test('content only the default read renders is still appended', () => {
    const structured = parseInbound(message(
      'interactive',
      card([{ tag: 'markdown', content: 'shared line' }]),
    ))
    const rendered = parseInbound(message(
      'interactive',
      card([{ tag: 'plain_text', content: 'shared line\nrendered only' }]),
    ))

    const merged = mergeInteractiveInbound(structured, rendered)

    expect(merged.text).toBe(
      'shared line\n\nAdditional rendered card content:\nrendered only',
    )
  })
})

describe('message read mention identity', () => {
  test('an app_id record claims no user identity', () => {
    const item = normalizeMessageReadItem({
      message_id: 'om_read',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: '@_user_1 hi' }) },
      mentions: [{
        key: '@_user_1',
        id: 'cli_example',
        id_type: 'app_id',
        name: 'Dreamux',
      }],
    })

    expect(item.mentions).toEqual([{ key: '@_user_1', name: 'Dreamux' }])

    const parsed = parseInbound({
      message_type: item.messageType,
      content: item.content,
      mentions: item.mentions,
    })
    expect(parsed.parts).toEqual([
      { kind: 'text', text: '@Dreamux' },
      { kind: 'text', text: ' hi' },
    ])
    expect(JSON.stringify(parsed.parts)).not.toContain('cli_example')
  })

  test('an omitted id_type still reads as an open id', () => {
    const item = normalizeMessageReadItem({
      message_id: 'om_read',
      msg_type: 'text',
      body: { content: '{}' },
      mentions: [{ key: '@_user_1', id: 'ou_example', name: 'Example' }],
    })

    expect(item.mentions).toEqual([
      { key: '@_user_1', id: { open_id: 'ou_example' }, name: 'Example' },
    ])
  })
})
