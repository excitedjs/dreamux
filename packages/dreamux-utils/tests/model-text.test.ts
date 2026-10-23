import { describe, expect, it } from 'vitest';
import { quoteModelValue } from '../src/model-text.js';

describe('literal model-facing values', () => {
  it.each([
    ['plain', 'name', '"name"'],
    ['Windows path', String.raw`C:\foo\bar`, String.raw`"C\:\\foo\\bar"`],
    ['UNC path', String.raw`\\server\share`, String.raw`"\\\\server\\share"`],
    ['backslash before emphasis', String.raw`a\*b`, String.raw`"a\\\*b"`],
    ['newline', 'one\nline', String.raw`"one\nline"`],
    ['quote', 'a"b', String.raw`"a\"b"`],
    [
      'link',
      '[x](https://example.test)',
      String.raw`"\[x\]\(https\://example\.test\)"`,
    ],
    ['tag', '<at>name</at>', String.raw`"\<at\>name\</at\>"`],
    ['code', '`x`', String.raw`"\`x\`"`],
    ['entity', '&amp;', String.raw`"\&amp;"`],
  ])(
    '%s preserves value spelling while escaping Markdown syntax',
    (_name, value, expected) => {
      expect(quoteModelValue(value)).toBe(expected);
    },
  );
});
