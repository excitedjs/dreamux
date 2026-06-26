/**
 * Small Feishu inbound helpers that used to live next to the gate.
 *
 * These are deliberately access-control-free: `isBotSenderType` classifies a
 * `sender_type` field, and `isBotMentioned` checks an @-mention list against
 * the bot's own open_id. Both are pure functions with no dependency on
 * persisted access state (which lives in the host's channel layer now).
 */

import type { Mention } from '../contract/types.js'

/**
 * True when `senderType` identifies a Feishu bot or app.
 * Feishu uses `'bot'` for cross-bot messages and `'app'` for custom-bot
 * messages in some event contexts; both are non-human senders.
 */
export function isBotSenderType(senderType: string | undefined): boolean {
  return senderType === 'bot' || senderType === 'app'
}

/** True when one of `mentions` resolves to the bot's own open_id. */
export function isBotMentioned(
  mentions: Mention[] | undefined,
  botOpenId: string | undefined,
): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => (m.id?.open_id ?? m.id?.union_id) === botOpenId)
}
