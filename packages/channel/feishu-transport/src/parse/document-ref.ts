/**
 * Reading a Feishu document reference — a share URL or a bare token.
 *
 * It sits beside `parse/comment.ts` for the same reason: this is Feishu-format
 * knowledge with no I/O. A URL names the document's type in its path, so a
 * caller that was given a link does not have to be told the type as well; a
 * bare token names nothing, and the caller supplies the type itself.
 *
 * The path segment is mapped where Feishu's URL word differs from its API word
 * and passed through otherwise. There is no accepted-type table: what a type
 * has to satisfy is the metadata read that follows, and a second list here
 * would only be a rejection Feishu never asked for.
 */

/** A document reference resolved as far as text alone can resolve it. */
export interface FeishuDocumentRef {
  /** The token the URL or the caller named. `wiki` makes it a node token. */
  readonly token: string
  /** The document type the reference itself states, or `null` for a bare token. */
  readonly type: string | null
}

/** Feishu URL words that differ from the type its APIs take. */
const URL_SEGMENT_TYPES: Readonly<Record<string, string>> = {
  docs: 'doc',
  sheets: 'sheet',
  base: 'bitable',
  mindnotes: 'mindnote',
}

/**
 * Read a document URL or a bare token. Returns `null` only for input that
 * names nothing at all. Pure: no I/O, never throws.
 */
export function parseFeishuDocumentRef(input: string): FeishuDocumentRef | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // Not a URL, so the whole string is the token and its type is unstated.
    return { token: trimmed, type: null }
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const token = segments.pop()
  if (token === undefined) return null
  const word = segments.pop()
  return {
    token: decodeURIComponent(token),
    type: word === undefined ? null : URL_SEGMENT_TYPES[word] ?? word,
  }
}
