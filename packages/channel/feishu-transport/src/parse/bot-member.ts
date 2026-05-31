/**
 * Decoding the `im.chat.member.bot.added_v1` event envelope.
 *
 * Hosts use this event to notice when the Feishu bot is added to a chat. The
 * decode is deliberately narrow and pure: it only extracts stable envelope
 * identifiers, performs no I/O, and returns `null` for unroutable payloads.
 */

import { asString, isRecord } from '../json.js'

/** The Feishu event_type this decoder is for. */
export const BOT_MEMBER_ADDED_EVENT_TYPE = 'im.chat.member.bot.added_v1'

/** A normalized bot-added event — the identifying fields the payload carries. */
export interface FeishuBotMemberAddedEvent {
  /** Chat id the bot was added to. */
  chatId: string
  /** Feishu event id from the header, empty when the host passes a bare event. */
  eventId: string
}

/**
 * Reshape a raw `im.chat.member.bot.added_v1` payload into a
 * `FeishuBotMemberAddedEvent`. Tolerates either a full `{ header, event }`
 * envelope or the bare event body delivered by some host adapters. Pure: no
 * I/O, never throws.
 */
export function normalizeBotMemberAddedEvent(
  raw: unknown,
): FeishuBotMemberAddedEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw
  const chatId = asString(event.chat_id)
  if (chatId === '') return null

  const header = isRecord(raw.header) ? raw.header : {}
  return {
    chatId,
    eventId: asString(header.event_id),
  }
}
