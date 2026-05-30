/**
 * The outbound addressing contract.
 *
 * Replaces the old `sendText(chatId, text)` shape with a structured target, so
 * the transport can thread a reply under the triggering message and @-back the
 * asker — every field the target needs is already persisted on inbound
 * (`source_chat_id` / `source_message_id` / `sender_id`). See dreamux#25 §4.
 *
 * The transport's `send` reads only the platform-addressing fields
 * (`chatId` / `replyToMessageId` / `mentionUserIds`). `conversationKey` is a
 * routing hint for the host's channel layer (which Codex/engine thread the
 * reply belongs to); the transport ignores it. A host without an engine thread
 * (claudemux) omits it entirely.
 */

/** Where an outbound message goes, and how it threads back to its trigger. */
export interface OutboundTarget {
  /** Destination chat_id — required. Today: the inbound `source_chat_id`. */
  chatId: string
  /**
   * message_id to reply under, so a group reply threads beneath the original
   * question. Maps from the inbound `source_message_id`. Optional: when unset,
   * the transport sends a fresh top-level message.
   */
  replyToMessageId?: string
  /**
   * open_ids to @-mention in the reply — typically the asker, to @-back them
   * in a busy group. Maps from the inbound `sender_id`. Optional and additive
   * to any inline `<@open_id>` already written in the markdown body.
   */
  mentionUserIds?: string[]
  /**
   * Host engine-thread routing key (dreamux: the Codex thread for this
   * conversation; fixes the shared-thread cross-talk gap). Opaque to the
   * transport — a channel-layer concern — and omitted by hosts with no engine
   * thread.
   */
  conversationKey?: string
}
