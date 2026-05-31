import type { InboundRow } from '../db/types.js';

export interface ChannelOutboundTarget {
  /** Stable channel-local conversation id. Feishu maps this to chat_id. */
  conversationId: string;
  /** Optional source message id for channel-native reply threading. */
  replyToMessageId?: string;
  /** Optional channel-local user ids to mention in the reply. */
  mentionUserIds?: string[];
  /** Optional host/runtime routing hint, opaque to the channel adapter. */
  conversationKey?: string;
}

export interface OutboundSink {
  /** Send `text` to a channel target; return the channel message ids sent. */
  send(target: ChannelOutboundTarget, text: string): Promise<string[]>;
}

export function outboundTargetForInbound(row: InboundRow): ChannelOutboundTarget {
  return {
    conversationId: row.source_chat_id,
    ...(row.source_message_id !== null
      ? { replyToMessageId: row.source_message_id }
      : {}),
    ...(row.sender_id !== null && row.sender_id !== ''
      ? { mentionUserIds: [row.sender_id] }
      : {}),
  };
}
