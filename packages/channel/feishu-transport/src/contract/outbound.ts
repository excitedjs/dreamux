/**
 * The outbound addressing contract.
 *
 * A target carries only what the platform needs to place a message: which chat
 * it lands in, and which existing message it threads under. Mentions are
 * written inline in the message body using Feishu's own `<at>` syntax, so they
 * are not a separate addressing concern.
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
}
