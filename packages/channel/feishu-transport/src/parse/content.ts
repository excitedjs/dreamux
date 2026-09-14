/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. Every type flattens to one body: text in Feishu's
 * own vocabulary — mention placeholders and resource keys left where they
 * were — beside the list of resources those keys name. The channel layer
 * resolves both against the message's `mentions` records and its own
 * attachment downloads when it renders.
 */

import type { Mention } from '../contract/types.js'
import {
  createBody,
  type InboundResourceType,
  type ParsedInbound,
} from './body.js'
import { parseCardContent } from './card.js'
import { parsePostContent } from './post.js'
export type {
  InboundResource,
  InboundResourceType,
  ParsedInbound,
} from './body.js'

/** The subset of an inbound Feishu message this module reads. */
export interface InboundMessage {
  message_type?: string
  /** JSON-encoded content string, as delivered by Feishu. */
  content?: string
  mentions?: Mention[]
}

/**
 * Parse one inbound Feishu message into its body. Never throws — content the
 * platform did not encode as JSON becomes a marked, incomplete body so the
 * message still reaches the engine.
 */
export function parseInbound(message: InboundMessage): ParsedInbound {
  const type = message.message_type ?? 'unknown'
  // The channel points at the message instead of expanding its children; the
  // platform may deliver it with an empty body.
  if (type === 'merge_forward') return text('')
  let parsed: unknown
  try {
    parsed = JSON.parse(message.content ?? '')
  } catch {
    return text(`(unparseable ${type} message)`, true)
  }
  const content = asRecord(parsed) ?? {}

  switch (type) {
    case 'text':
      return text(typeof content.text === 'string' ? content.text : '')
    case 'post':
      return parsePostContent(content, message.mentions)
    case 'interactive':
      return parseCardContent(content, message.mentions)
    case 'image':
      return attachment('image', content.image_key)
    case 'file':
      return attachment('file', content.file_key, nonEmptyString(content.file_name))
    case 'audio':
      return attachment('file', content.file_key, 'voice.opus')
    case 'media': {
      const body = createBody()
      const fileKey = nonEmptyString(content.file_key)
      const imageKey = nonEmptyString(content.image_key)
      if (fileKey !== undefined) body.line(body.attach('file', fileKey, 'video.mp4'))
      if (imageKey !== undefined) {
        body.line(body.attach('image', imageKey, 'video-cover.jpg'))
      }
      return body.build(fileKey === undefined || imageKey === undefined)
    }
    case 'sticker':
      return text('(sticker message; sticker resources are not downloadable)')
    case 'share_chat':
      return text(describeShared('shared chat', content.chat_id))
    case 'share_user':
      return text(describeShared('shared user', content.user_id))
    // The channel re-reads the message for its authoritative type.
    case 'nonsupport':
      return text('(unsupported message content not resolved)', true)
    default:
      return text(`(${type} message)`, true)
  }
}

/**
 * Extract canonical, narrow metadata from a Feishu inbound event envelope.
 *
 * Content parsing only sees `message.content`; identifiers such as
 * `message_id`, `chat_id`, and `sender_id` live in the event envelope. Keeping
 * this Feishu-specific field mapping here keeps the host adapter free of
 * platform field names.
 */
export function narrowMetaFromEvent(rawEvent: unknown): Record<string, string> {
  const root = asRecord(rawEvent) ?? {}
  const event = asRecord(root.event) ?? root
  const message = asRecord(event.message) ?? {}
  const sender = asRecord(event.sender) ?? {}
  const senderId = asRecord(sender.sender_id)

  return omitEmptyStrings({
    message_id: asString(message.message_id),
    chat_id: asString(message.chat_id),
    chat_type: asString(message.chat_type),
    sender_id: asString(senderId?.open_id),
    // Diagnostic only. A bot's open_id is app-scoped, so a dropped peer-bot
    // message's union_id helps an operator tell "same bot, different scope" from
    // "different entity" after the fact. It is never used for access matching.
    sender_union_id: asString(senderId?.union_id),
    sender_type: asString(sender.sender_type),
    thread_id: asString(message.thread_id),
    root_id: asString(message.root_id),
    parent_id: asString(message.parent_id),
    create_time: asString(message.create_time),
  })
}

function text(value: string, incomplete?: boolean): ParsedInbound {
  const body = createBody()
  body.line(value)
  return body.build(incomplete)
}

function attachment(
  type: InboundResourceType,
  keyValue: unknown,
  name?: string,
): ParsedInbound {
  const key = nonEmptyString(keyValue)
  if (key === undefined) return text('', true)
  const body = createBody()
  body.line(body.attach(type, key, name))
  return body.build()
}

function describeShared(what: string, idValue: unknown): string {
  const id = nonEmptyString(idValue)
  return id === undefined ? `(${what})` : `(${what}: ${id})`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function omitEmptyStrings(
  input: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}
