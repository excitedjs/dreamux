/**
 * The `Mention` shape every parser reads, plus small Feishu inbound helpers
 * that used to live next to the gate.
 *
 * The helpers are deliberately access-control-free: `isBotSenderType`
 * classifies a `sender_type` field, and `isBotMentioned` checks an @-mention
 * list against the bot's own open_id. Both are pure functions with no
 * dependency on persisted access state (which lives in the host's channel
 * layer now).
 */

/** One @-mention inside an inbound Feishu message. */
export interface Mention {
  /** The placeholder token (e.g. `@_user_1`) used in the message text. */
  key: string;
  /** Resolved identity of the mentioned party. */
  id?: { open_id?: string; union_id?: string; user_id?: string };
  /** Display name of the mentioned party. */
  name?: string;
}

/**
 * True when `senderType` identifies a Feishu bot or app.
 * Feishu uses `'bot'` for cross-bot messages and `'app'` for custom-bot
 * messages in some event contexts; both are non-human senders.
 */
export function isBotSenderType(senderType: string | undefined): boolean {
  return senderType === 'bot' || senderType === 'app';
}

/** True when one of `mentions` resolves to the bot's own open_id. */
export function isBotMentioned(
  mentions: Mention[] | undefined,
  botOpenId: string | undefined,
): boolean {
  if (!mentions || !botOpenId) return false;
  return mentions.some((m) => (m.id?.open_id ?? m.id?.union_id) === botOpenId);
}
