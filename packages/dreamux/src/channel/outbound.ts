import type { InboundRow } from '../db/types.js';

export interface ChannelOutboundTarget {
  /** Stable channel-local conversation id. */
  conversationId: string;
  /** Optional channel-local source message to thread under. */
  replyTo?: string;
  /** Optional channel-local participants to bring into the reply. */
  mentionUsers?: string[];
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
      ? { replyTo: row.source_message_id }
      : {}),
    ...(row.sender_id !== null && row.sender_id !== ''
      ? { mentionUsers: [row.sender_id] }
      : {}),
  };
}
