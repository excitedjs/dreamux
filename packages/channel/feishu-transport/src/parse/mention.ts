/**
 * Resolving one mention occurrence against the platform's mention records.
 *
 * Feishu writes the same fact three ways — a `@_user_N` placeholder in text, a
 * structured `at` node, an inline `<at>` tag in Markdown — and delivers the
 * identities separately, in the message's `mentions` records. Whichever form
 * the source used, the occurrence is what carries the position and the records
 * are what carry identity; neither invents the other.
 */

import type { Mention } from '../contract/types.js'
import type { InboundContentPart } from './parts.js'

/**
 * Resolve one occurrence. `token` is whatever the source used to name the
 * mentioned party — a placeholder key or an identifier — and `inlineName` is
 * the display text written at the occurrence, if any.
 *
 * An occurrence whose record carries no supported user identity becomes
 * ordinary `@name` text. That is the platform's own statement — a record typed
 * as an application has no user-identity field to fill — not a judgment made
 * here about how an identifier looks.
 */
export function resolveMentionPart(
  mentions: Mention[] | undefined,
  token: string,
  inlineName: string,
): InboundContentPart {
  const record = findMentionRecord(mentions, token)
  const name = inlineName !== '' ? inlineName : record?.name ?? ''
  const id = record !== undefined
    ? supportedIdentity(record)
    : unmatchedIdentity(token)
  if (id === undefined) {
    return { kind: 'text', text: `@${name === '' ? 'unknown' : name}` }
  }
  return { kind: 'mention', id, name }
}

/**
 * Split plain message text on the mention placeholders the records name,
 * turning each occurrence into its own part and leaving every other character
 * of the message untouched.
 */
export function textPartsWithMentions(
  text: string,
  mentions: Mention[] | undefined,
): InboundContentPart[] {
  let parts: InboundContentPart[] = text === ''
    ? []
    : [{ kind: 'text', text }]
  for (const record of mentions ?? []) {
    const key = record.key
    if (key === undefined || key === '') continue
    // A record that names nobody and identifies nobody substitutes nothing;
    // the placeholder stays as the sender wrote it.
    if (record.name === undefined && supportedIdentity(record) === undefined) {
      continue
    }
    const resolved = resolveMentionPart(mentions, key, '')
    parts = parts.flatMap((part) =>
      part.kind === 'text' ? splitOnKey(part.text, key, resolved) : [part])
  }
  return parts
}

function splitOnKey(
  text: string,
  key: string,
  resolved: InboundContentPart,
): InboundContentPart[] {
  const pieces = text.split(key)
  return pieces.flatMap((piece, index) => [
    ...(piece === '' ? [] : [{ kind: 'text' as const, text: piece }]),
    ...(index === pieces.length - 1 ? [] : [{ ...resolved }]),
  ])
}

/**
 * The identity a lone token carries when no record matches it.
 *
 * A placeholder key names nobody without its record, so only a real identifier
 * survives on its own — and it survives as what it is: the sender's own
 * assertion of who this occurrence names, carried through rather than
 * classified here. What the identifier is good for is the platform's answer,
 * and the platform gives that answer in a record's identity fields.
 */
function unmatchedIdentity(token: string): string | undefined {
  return token !== '' && !token.startsWith('@') ? token : undefined
}

function findMentionRecord(
  mentions: Mention[] | undefined,
  token: string,
): Mention | undefined {
  if (token === '' || mentions === undefined) return undefined
  return mentions.find((record) => record.key === token) ??
    mentions.find((record) => supportedIdentity(record) === token)
}

function supportedIdentity(record: Mention): string | undefined {
  const id = record.id
  if (id === undefined) return undefined
  return nonEmpty(id.open_id) ?? nonEmpty(id.union_id) ?? nonEmpty(id.user_id)
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}
