/**
 * Parsing inbound Feishu message content.
 *
 * Feishu delivers `message.content` as a JSON-encoded string whose shape
 * depends on `message_type`. This module retains the legacy flat text view and
 * also exposes source-ordered text/code/resource parts. Attachment-capable
 * message types expose de-duplicated resource keys beside those positional
 * parts.
 *
 * Ported verbatim from claudemux's `feishu-channel/src/content.ts` (the source
 * of truth — it carries the `interactive`-card parse dreamux's drifted copy had
 * lost); only the `./types` import was repointed to `../contract/types`.
 */

import type { Mention } from '../contract/types.js'
import {
  mergeInteractiveContentParts,
  parseInteractiveContent,
} from './card.js'
import {
  projectLegacyText,
  projectUniqueResources,
  resourcePart,
  type InboundContentPart,
  type InboundResource,
  type ParsedContent,
} from './parts.js'
import { parsePostContent } from './post.js'
export type {
  InboundContentPart,
  InboundResource,
  InboundResourceType,
} from './parts.js'

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
  /** Untrusted visible content in Feishu source order. */
  parts?: InboundContentPart[]
  /** Structured message resources discovered in Feishu content. */
  resources?: InboundResource[]
  /** Optional flat/narrow metadata supplied by the host's event normalizer. */
  meta?: Record<string, unknown>
  /** True when the projection is an honest fallback or omitted visible data. */
  incomplete?: boolean
}

export interface ChannelInbound {
  /** Flattened markdown-ish text suitable for a narrow channel payload. */
  text: string
  /** Flat string-only metadata with protocol-safe underscore keys. */
  meta: Record<string, string>
}

/**
 * Parse one inbound Feishu message into forwardable legacy text plus optional
 * ordered parts. Never throws — malformed content falls back to a best-effort
 * string so a weird message still reaches the engine.
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
    return projectParsedContent({
      parts: [{ kind: 'text', text }],
      incomplete: true,
    })
  }
  const content = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  switch (type) {
    case 'text': {
      const text = typeof content.text === 'string' ? content.text : ''
      const rendered = applyMentions(text, message.mentions)
      return projectParsedContent({
        parts: rendered === '' ? [] : [{ kind: 'text', text: rendered }],
      })
    }
    case 'post':
      return projectParsedContent(parsePostContent(content))
    case 'image':
    {
      const key = nonEmptyString(content.image_key)
      return projectParsedContent({
        parts: [resourcePart('image', key)],
        compatibilityText: '(image message)',
        ...(key === undefined ? { incomplete: true } : {}),
      })
    }
    case 'file': {
      const key = nonEmptyString(content.file_key)
      const name = nonEmptyString(content.file_name)
      return projectParsedContent({
        parts: [resourcePart('file', key, name)],
        compatibilityText: '(file message)',
        ...(key === undefined ? { incomplete: true } : {}),
      })
    }
    case 'interactive':
      return projectParsedContent(parseInteractiveContent(content))
    case 'audio': {
      const key = nonEmptyString(content.file_key)
      return projectParsedContent({
        parts: [resourcePart('file', key, 'voice.opus')],
        compatibilityText: key === undefined
          ? '(voice message without a resource key)'
          : `[voice message attachment: ${key}]`,
        ...(key === undefined ? { incomplete: true } : {}),
      })
    }
    case 'media': {
      const fileKey = nonEmptyString(content.file_key)
      const imageKey = nonEmptyString(content.image_key)
      return projectParsedContent({
        parts: [
          resourcePart('file', fileKey, 'video.mp4'),
          resourcePart('image', imageKey, 'video-cover.jpg'),
        ],
        compatibilityText: [
          fileKey === undefined
            ? '[video attachment without a resource key]'
            : `[video attachment: ${fileKey}]`,
          imageKey === undefined
            ? '[video cover without a resource key]'
            : `[video cover: ${imageKey}]`,
        ].join('\n'),
        ...(fileKey === undefined || imageKey === undefined
          ? { incomplete: true }
          : {}),
      })
    }
    case 'sticker':
      return projectParsedContent({
        parts: [{
          kind: 'text',
          text: '(sticker message; sticker resources are not downloadable)',
        }],
      })
    case 'share_chat': {
      const chatId = nonEmptyString(content.chat_id)
      const text = chatId === undefined
        ? '(shared chat)'
        : `(shared chat: ${chatId})`
      return projectParsedContent({
        parts: [{
          kind: 'text',
          text,
        }],
        ...(chatId === undefined ? { incomplete: true } : {}),
      })
    }
    case 'share_user': {
      const userId = nonEmptyString(content.user_id)
      const text = userId === undefined
        ? '(shared user)'
        : `(shared user: ${userId})`
      return projectParsedContent({
        parts: [{
          kind: 'text',
          text,
        }],
        ...(userId === undefined ? { incomplete: true } : {}),
      })
    }
    case 'merge_forward':
      return projectParsedContent({
        parts: [],
        compatibilityText: '(merged-forward message not expanded)',
        incomplete: true,
      })
    case 'nonsupport':
      return projectParsedContent({
        parts: [{
          kind: 'text',
          text: '(unsupported message content not resolved)',
        }],
        incomplete: true,
      })
    default: {
      const text = `(${safeMessageType(type)} message)`
      return projectParsedContent({
        parts: [{ kind: 'text', text }],
        incomplete: true,
      })
    }
  }
}

/**
 * Merge the two real Feishu card read projections at the transport boundary.
 * `parts` stay authoritative; flat compatibility views are projected once.
 */
export function mergeInteractiveInbound(
  primary: ParsedInbound,
  supplemental?: ParsedInbound,
): ParsedInbound {
  if (supplemental === undefined || supplemental.parts === undefined) {
    return primary
  }
  const primaryParts = primary.parts === undefined
    ? primary.text === ''
      ? []
      : [{ kind: 'text' as const, text: primary.text }]
    : primary.parts
  return projectParsedContent({
    parts: mergeInteractiveContentParts(primaryParts, supplemental.parts),
    ...(primary.incomplete === true || supplemental.incomplete === true
      ? { incomplete: true }
      : {}),
  })
}

function projectParsedContent(content: ParsedContent): ParsedInbound {
  const resources = projectUniqueResources(content.parts)
  return {
    text: projectLegacyText(content),
    parts: content.parts,
    ...(resources.length > 0 ? { resources } : {}),
    ...(content.incomplete === true ? { incomplete: true } : {}),
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
  return projectParsedContent(parsePostContent(content)).text
}

function safeMessageType(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe === '' ? 'unknown' : safe
}
