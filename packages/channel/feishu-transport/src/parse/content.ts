/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. This module turns it into the message's visible
 * content as source-ordered text/code/mention/resource parts — the one body
 * representation the channel renders.
 *
 * Mentions are part of that source order: the message's `mentions` records are
 * resolved into their own parts here, at the one parsing boundary, whichever
 * form the sending client used to write them.
 */

import type { Mention } from '../contract/types.js'
import {
  mergeInteractiveContentParts,
  parseInteractiveContent,
} from './card.js'
import { textPartsWithMentions } from './mention.js'
import {
  resourcePart,
  type ParsedInbound,
} from './parts.js'
import { parsePostContent } from './post.js'
export type {
  InboundContentPart,
  InboundResource,
  InboundResourceType,
  ParsedInbound,
} from './parts.js'

/** The subset of an inbound Feishu message this module reads. */
export interface InboundMessage {
  message_type?: string
  /** JSON-encoded content string, as delivered by Feishu. */
  content?: string
  mentions?: Mention[]
}

/**
 * Parse one inbound Feishu message into ordered content parts. Never throws —
 * malformed content falls back to a best-effort text part so a weird message
 * still reaches the engine.
 */
export function parseInbound(message: InboundMessage): ParsedInbound {
  const type = message.message_type ?? 'unknown'

  let parsed: unknown
  try {
    parsed = JSON.parse(message.content ?? '')
  } catch {
    const text = type === 'text'
      ? message.content ?? '(unparseable message)'
      : `(unparseable ${safeMessageType(type)} message)`
    return {
      parts: [{ kind: 'text', text }],
      incomplete: true,
    }
  }
  const content = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  switch (type) {
    case 'text': {
      const text = typeof content.text === 'string' ? content.text : ''
      return { parts: textPartsWithMentions(text, message.mentions) }
    }
    case 'post':
      return parsePostContent(content, message.mentions)
    case 'image':
    {
      const key = nonEmptyString(content.image_key)
      return {
        parts: [resourcePart('image', key)],
        ...(key === undefined ? { incomplete: true } : {}),
      }
    }
    case 'file': {
      const key = nonEmptyString(content.file_key)
      const name = nonEmptyString(content.file_name)
      return {
        parts: [resourcePart('file', key, name)],
        ...(key === undefined ? { incomplete: true } : {}),
      }
    }
    case 'interactive':
      return parseInteractiveContent(content, message.mentions)
    case 'audio': {
      const key = nonEmptyString(content.file_key)
      return {
        parts: [resourcePart('file', key, 'voice.opus')],
        ...(key === undefined ? { incomplete: true } : {}),
      }
    }
    case 'media': {
      const fileKey = nonEmptyString(content.file_key)
      const imageKey = nonEmptyString(content.image_key)
      return {
        parts: [
          resourcePart('file', fileKey, 'video.mp4'),
          resourcePart('image', imageKey, 'video-cover.jpg'),
        ],
        ...(fileKey === undefined || imageKey === undefined
          ? { incomplete: true }
          : {}),
      }
    }
    case 'sticker':
      return {
        parts: [{
          kind: 'text',
          text: '(sticker message; sticker resources are not downloadable)',
        }],
      }
    case 'share_chat': {
      const chatId = nonEmptyString(content.chat_id)
      const text = chatId === undefined
        ? '(shared chat)'
        : `(shared chat: ${chatId})`
      return {
        parts: [{
          kind: 'text',
          text,
        }],
        ...(chatId === undefined ? { incomplete: true } : {}),
      }
    }
    case 'share_user': {
      const userId = nonEmptyString(content.user_id)
      const text = userId === undefined
        ? '(shared user)'
        : `(shared user: ${userId})`
      return {
        parts: [{
          kind: 'text',
          text,
        }],
        ...(userId === undefined ? { incomplete: true } : {}),
      }
    }
    case 'merge_forward':
      return { parts: [], incomplete: true }
    case 'nonsupport':
      return {
        parts: [{
          kind: 'text',
          text: '(unsupported message content not resolved)',
        }],
        incomplete: true,
      }
    default: {
      const text = `(${safeMessageType(type)} message)`
      return {
        parts: [{ kind: 'text', text }],
        incomplete: true,
      }
    }
  }
}

/** Merge the two real Feishu card read projections at the transport boundary. */
export function mergeInteractiveInbound(
  primary: ParsedInbound,
  supplemental?: ParsedInbound,
): ParsedInbound {
  if (supplemental === undefined) return primary
  return {
    parts: mergeInteractiveContentParts(primary.parts, supplemental.parts),
    ...(primary.incomplete === true || supplemental.incomplete === true
      ? { incomplete: true }
      : {}),
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
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return {}
  const root = rawEvent as Record<string, unknown>
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function omitEmptyStrings(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

function safeMessageType(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe === '' ? 'unknown' : safe
}
