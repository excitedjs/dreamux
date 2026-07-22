/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. This module turns that into the plain text the
 * channel forwards to the engine. Attachment-capable message types expose
 * typed resource keys beside positional, human-readable markers.
 *
 * Ported verbatim from claudemux's `feishu-channel/src/content.ts` (the source
 * of truth — it carries the `interactive`-card parse dreamux's drifted copy had
 * lost); only the `./types` import was repointed to `../contract/types`.
 */

import type { Mention } from '../contract/types.js'
import { parseInteractiveContent } from './card.js'
import { parsePostContent } from './post.js'

/** The subset of an inbound Feishu message this module reads. */
export interface InboundMessage {
  message_type?: string
  /** JSON-encoded content string, as delivered by Feishu. */
  content?: string
  mentions?: Mention[]
}

export interface ParsedInbound {
  /** Human-readable text to forward to the engine. */
  text: string
  /** Structured message resources discovered in Feishu content. */
  resources?: InboundResource[]
  /** Optional flat/narrow metadata supplied by the host's event normalizer. */
  meta?: Record<string, unknown>
  /** True when the projection is an honest fallback or omitted visible data. */
  incomplete?: boolean
}

export type InboundResourceType = 'file' | 'image'

export interface InboundResource {
  type: InboundResourceType
  /** Feishu message resource key (`file_key` / `image_key`) when present. */
  key?: string
  /** Original user-facing filename. Treat as display text, never a path. */
  name?: string
}

export interface ChannelInbound {
  /** Flattened markdown-ish text suitable for a narrow channel payload. */
  text: string
  /** Flat string-only metadata with protocol-safe underscore keys. */
  meta: Record<string, string>
}

/**
 * Parse one inbound Feishu message into forwardable text. Never throws —
 * malformed content falls back to a best-effort string so a weird message
 * still reaches the engine.
 */
export function parseInbound(message: InboundMessage): ParsedInbound {
  const type = message.message_type ?? 'unknown'

  let parsed: unknown
  try {
    parsed = JSON.parse(message.content ?? '')
  } catch {
    return type === 'text'
      ? {
          text: message.content ?? '(unparseable message)',
          incomplete: true,
        }
      : {
          text: `(unparseable ${safeMessageType(type)} message)`,
          incomplete: true,
        }
  }
  const content = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  switch (type) {
    case 'text': {
      const text = typeof content.text === 'string' ? content.text : ''
      return { text: applyMentions(text, message.mentions) }
    }
    case 'post':
      return parsePostContent(content)
    case 'image':
      {
        const key = nonEmptyString(content.image_key)
      return {
        text: '(image message)',
        resources: [{
          type: 'image',
          ...(key !== undefined ? { key } : {}),
        }],
        ...(key === undefined ? { incomplete: true } : {}),
      }
      }
    case 'file': {
      const key = nonEmptyString(content.file_key)
      return {
        text: '(file message)',
        resources: [{
          type: 'file',
          ...(key !== undefined ? { key } : {}),
          ...(nonEmptyString(content.file_name) !== undefined
            ? { name: nonEmptyString(content.file_name) }
            : {}),
        }],
        ...(key === undefined ? { incomplete: true } : {}),
      }
    }
    case 'interactive':
      return parseInteractiveContent(content)
    case 'audio': {
      const key = nonEmptyString(content.file_key)
      return {
        text: key === undefined
          ? '(voice message without a resource key)'
          : `[voice message attachment: ${key}]`,
        resources: [{
          type: 'file',
          ...(key !== undefined ? { key } : {}),
          name: 'voice.opus',
        }],
        ...(key === undefined ? { incomplete: true } : {}),
      }
    }
    case 'media': {
      const fileKey = nonEmptyString(content.file_key)
      const imageKey = nonEmptyString(content.image_key)
      const resources: InboundResource[] = [
        {
          type: 'file',
          ...(fileKey !== undefined ? { key: fileKey } : {}),
          name: 'video.mp4',
        },
        {
          type: 'image',
          ...(imageKey !== undefined ? { key: imageKey } : {}),
          name: 'video-cover.jpg',
        },
      ]
      return {
        text: [
          fileKey === undefined
            ? '[video attachment without a resource key]'
            : `[video attachment: ${fileKey}]`,
          imageKey === undefined
            ? '[video cover without a resource key]'
            : `[video cover: ${imageKey}]`,
        ].join('\n'),
        resources,
        ...(fileKey === undefined || imageKey === undefined
          ? { incomplete: true }
          : {}),
      }
    }
    case 'sticker':
      return { text: '(sticker message; sticker resources are not downloadable)' }
    case 'share_chat': {
      const chatId = nonEmptyString(content.chat_id)
      return {
        text: chatId === undefined ? '(shared chat)' : `(shared chat: ${chatId})`,
        ...(chatId === undefined ? { incomplete: true } : {}),
      }
    }
    case 'share_user': {
      const userId = nonEmptyString(content.user_id)
      return {
        text: userId === undefined ? '(shared user)' : `(shared user: ${userId})`,
        ...(userId === undefined ? { incomplete: true } : {}),
      }
    }
    case 'merge_forward':
      return { text: '(merged-forward message not expanded)', incomplete: true }
    case 'nonsupport':
      return { text: '(unsupported message content not resolved)', incomplete: true }
    default:
      return {
        text: `(${safeMessageType(type)} message)`,
        incomplete: true,
      }
  }
}

/**
 * Extract canonical, narrow metadata from a Feishu inbound event envelope.
 *
 * Content parsing only sees `message.content`; identifiers such as
 * `message_id`, `chat_id`, and `sender_id` live in the event envelope. Keeping
 * this Feishu-specific field mapping in core prevents dreamux and claudemux
 * from copy-drifting it in their host adapters.
 */
export function narrowMetaFromEvent(rawEvent: unknown): Record<string, unknown> {
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

/**
 * Convert parsed inbound content into the channel protocol's narrow payload.
 *
 * `parseInbound` owns Feishu content flattening; the host may add raw event
 * metadata under `parsed.meta` before calling this. This function is deliberately
 * engine-agnostic: it preserves only text plus a flat string metadata bag. Keys
 * with hyphens or other protocol-unsafe characters are dropped, and nested /
 * non-string values are not stringified blindly.
 */
export function toChannelInbound(parsed: ParsedInbound): ChannelInbound {
  const text = parsed.text === '' ? '(empty message)' : parsed.text
  return { text, meta: sanitizeChannelMeta(parsed.meta) }
}

const CHANNEL_META_KEY_RE = /^[A-Za-z0-9_]+$/

function sanitizeChannelMeta(meta: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!meta) return out
  for (const [key, value] of Object.entries(meta)) {
    if (!CHANNEL_META_KEY_RE.test(key)) continue
    if (typeof value === 'string') {
      out[key] = value
    }
  }
  return out
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

function omitEmptyStrings(input: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

/**
 * Replace Feishu's `@_user_N` placeholders in text with the mentioned display
 * names, so the forwarded message reads naturally.
 */
export function applyMentions(text: string, mentions: Mention[] | undefined): string {
  if (!mentions) return text
  let out = text
  for (const m of mentions) {
    if (m.key && m.name) {
      out = out.split(m.key).join(`@${m.name}`)
    }
  }
  return out
}

/** Return the display name for an open_id in a Feishu mention list, if present. */
export function mentionName(
  mentions: Mention[] | undefined,
  openId: string,
): string | undefined {
  return mentions?.find((m) => m.id?.open_id === openId)?.name
}

/**
 * Flatten a Feishu rich-text "post" payload into plain text. A post is
 * locale-wrapped (`{ zh_cn: { title, content } }`) and its body is an array of
 * paragraphs, each an array of tagged inline elements.
 */
export function extractPostText(content: Record<string, unknown>): string {
  return parsePostContent(content).text
}

function safeMessageType(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe === '' ? 'unknown' : safe
}
