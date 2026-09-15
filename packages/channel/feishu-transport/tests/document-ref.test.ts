/**
 * `parseFeishuDocumentRef` reads what a caller pasted. The cases that matter
 * are the ones where Feishu's URL word differs from the word its APIs take,
 * and the wiki case, which the caller has to resolve before anything else.
 */
import { describe, expect, test } from 'vitest'

import { parseFeishuDocumentRef } from '../src/parse/document-ref'

describe('parseFeishuDocumentRef', () => {
  test('a docx URL names its token and its type', () => {
    expect(
      parseFeishuDocumentRef('https://example.invalid/docx/Abc123Token'),
    ).toEqual({ token: 'Abc123Token', type: 'docx' })
  })

  test('a wiki URL is flagged as wiki so the caller resolves the node first', () => {
    expect(
      parseFeishuDocumentRef('https://example.invalid/wiki/WikNodeToken'),
    ).toEqual({ token: 'WikNodeToken', type: 'wiki' })
  })

  test.each([
    ['docs', 'doc'],
    ['sheets', 'sheet'],
    ['base', 'bitable'],
    ['mindnotes', 'mindnote'],
  ])('the URL word %s reads as the API type %s', (word, type) => {
    expect(
      parseFeishuDocumentRef(`https://example.invalid/${word}/Tok`),
    ).toEqual({ token: 'Tok', type })
  })

  test('a query string and fragment are not part of the token', () => {
    expect(
      parseFeishuDocumentRef('https://example.invalid/docx/Tok?from=share#heading'),
    ).toEqual({ token: 'Tok', type: 'docx' })
  })

  test('an unfamiliar path word is passed through rather than rejected', () => {
    expect(
      parseFeishuDocumentRef('https://example.invalid/drive/folder/Tok'),
    ).toEqual({ token: 'Tok', type: 'folder' })
  })

  test('a bare token states no type, which is the caller\'s to supply', () => {
    expect(parseFeishuDocumentRef('  Abc123Token  ')).toEqual({
      token: 'Abc123Token',
      type: null,
    })
  })

  test('a URL with a single path segment names a token and no type', () => {
    expect(parseFeishuDocumentRef('https://example.invalid/Tok')).toEqual({
      token: 'Tok',
      type: null,
    })
  })

  test('input that names nothing is null', () => {
    expect(parseFeishuDocumentRef('   ')).toBeNull()
    expect(parseFeishuDocumentRef('https://example.invalid/')).toBeNull()
  })
})
