/**
 * Reading the Markdown strings a message carries: native post `md` nodes and
 * card text fields.
 *
 * Two constructs mean more than their characters. An `<at>` tag names one of
 * the message's mention records — by `mention_key`, or by a `user_id` / `id`
 * equal to a record's key or identity — and is rewritten to that record's
 * placeholder so the channel resolves it like every other mention; a tag no
 * record accounts for stays literal. A Markdown image whose target is a
 * message image key is that image: the key stands in its place and the image
 * becomes a resource. A web image stays literal.
 */

import type { Mention } from '../contract/types.js'
import type { BodyBuilder } from './body.js'

const INLINE_RE =
  /<at\b([^>]*)>[\s\S]*?<\/at\s*>|!\[[^\]]*\]\(\s*(img_[A-Za-z0-9_-]+)\s*\)/g
const AT_ATTRIBUTE_RE =
  /\b(?:mention_key|user_id|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

export function readInlineMarkdown(
  source: string,
  mentions: Mention[] | undefined,
  body: BodyBuilder,
): string {
  return source.replace(
    INLINE_RE,
    (matched: string, attributes: string | undefined, imageKey: string | undefined) => {
      if (imageKey !== undefined) {
        return body.attach('image', imageKey, `${imageKey}.jpg`)
      }
      for (const attribute of (attributes ?? '').matchAll(AT_ATTRIBUTE_RE)) {
        const key = mentionKey(
          mentions,
          attribute[1] ?? attribute[2] ?? attribute[3] ?? '',
        )
        if (key !== undefined) return key
      }
      return matched
    },
  )
}

/** The placeholder key of the record `token` names, by key or by identity. */
export function mentionKey(
  mentions: Mention[] | undefined,
  token: string,
): string | undefined {
  if (token === '') return undefined
  const record = mentions?.find((candidate) =>
    candidate.key === token ||
    candidate.id?.open_id === token ||
    candidate.id?.union_id === token ||
    candidate.id?.user_id === token)
  return record === undefined || record.key === '' ? undefined : record.key
}
