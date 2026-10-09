/**
 * Decoding the `im.message.receive_v1` event envelope into a typed inbound
 * event: envelope metadata (`narrowMetaFromEvent`) plus the message body
 * (`parseInbound`), combined into one routable shape.
 */

import {
  narrowMetaFromEvent,
  parseInbound,
  type InboundResource,
} from './content.js';
import { asRecord, firstString } from '../json.js';
import type { Mention } from './mentions.js';

export interface FeishuInboundEvent {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' | 'group' | ...
  /** Stable Feishu topic identity when the event belongs to a thread/topic. */
  threadId?: string;
  /** Diagnostic reply ancestry; never used as a topic identity fallback. */
  rootId?: string;
  parentId?: string;
  /** Post-gate, best-effort type of the actionable reply/quote parent. */
  parentMessageType?: string;
  senderId: string;
  /**
   * The sender's `union_id`, when Feishu provides it. Diagnostic only — it is
   * surfaced in inbound-drop logs to help tell "same bot, different app-scoped
   * open_id" apart from "different entity", and is never used for access
   * gating. Absent when Feishu omits it.
   */
  senderUnionId?: string;
  senderType: string;
  /**
   * Best-effort event display name. Feishu normally omits it, so the accepted
   * inbound path may later enrich an empty value through the transport seam.
   */
  senderName: string;
  messageType: string;
  /** Raw JSON-encoded content as Feishu delivered it. */
  rawContent: string;
  /**
   * The message as text. A mention stands as the placeholder its `mentions`
   * record names; an image or file stands as its resource key.
   */
  text: string;
  /** Every resource the text refers to, once each. */
  resources: InboundResource[];
  /** The body omits visible content the parser could not read. */
  contentIncomplete?: boolean;
  mentions: Mention[];
  createTime: string;
  /** The full original Feishu event payload (for storage / audit). */
  raw: unknown;
}

/**
 * Reshape a raw `im.message.receive_v1` payload into a `FeishuInboundEvent`,
 * using `parseInbound` + `narrowMetaFromEvent` for the body and the
 * event-envelope metadata. Returns `null` for a payload missing the
 * message_id or chat_id that make it routable.
 */
export function parseFeishuInboundEvent(
  raw: unknown,
): FeishuInboundEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = (root['event'] ?? root) as Record<string, unknown>;
  const message = (event['message'] ?? {}) as Record<string, unknown>;
  const messageType = (message['message_type'] as string) ?? '';
  const rawContent = (message['content'] as string) ?? '';
  const mentions = (message['mentions'] as Mention[] | undefined) ?? [];
  const parsed = parseInbound({
    message_type: messageType,
    content: rawContent,
    mentions,
  });
  const meta = narrowMetaFromEvent(raw);
  const messageId = meta['message_id'] ?? '';
  const chatId = meta['chat_id'] ?? '';
  const chatType = meta['chat_type'] ?? '';
  const threadId = meta['thread_id'] ?? '';
  const rootId = meta['root_id'] ?? '';
  const parentId = meta['parent_id'] ?? '';
  const senderId = meta['sender_id'] ?? '';
  const senderUnionId = meta['sender_union_id'] ?? '';
  const senderType = meta['sender_type'] ?? '';
  const createTime = meta['create_time'] ?? '';
  const senderName = extractSenderName(raw);

  if (messageId === '' || chatId === '') return null;

  return {
    messageId,
    chatId,
    chatType,
    ...(threadId !== '' ? { threadId } : {}),
    ...(rootId !== '' ? { rootId } : {}),
    ...(parentId !== '' ? { parentId } : {}),
    senderId,
    ...(senderUnionId !== '' ? { senderUnionId } : {}),
    senderType,
    senderName,
    messageType,
    rawContent,
    text: parsed.text,
    resources: parsed.resources,
    ...(parsed.incomplete === true ? { contentIncomplete: true } : {}),
    mentions,
    createTime,
    raw,
  };
}

function extractSenderName(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const root = raw as Record<string, unknown>;
  const event = asRecord(root['event']) ?? root;
  const sender = asRecord(event['sender']);
  if (sender === undefined) return '';
  return firstString(
    sender['sender_name'],
    sender['display_name'],
    sender['name'],
    sender['user_name'],
  );
}
