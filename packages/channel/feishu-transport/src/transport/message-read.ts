import type { Mention } from '../contract/types.js'

export type FeishuMessageReadMode = 'default' | 'user_card_content'

export interface FeishuMessageReadRequest {
  messageId: string
  cardContent?: FeishuMessageReadMode
}

export interface FeishuMessageReadSender {
  id: string
  type: string
  name?: string
}

/** Content-only projection of one `im.v1.message.get` item. */
export interface FeishuMessageReadItem {
  messageId: string
  messageType: string
  content: string
  upperMessageId?: string
  sender?: FeishuMessageReadSender
  mentions: Mention[]
  deleted: boolean
  malformed: boolean
}

export interface FeishuMessageReadResponse {
  items: FeishuMessageReadItem[]
}

export interface FeishuMessageReader {
  readMessage(
    request: FeishuMessageReadRequest,
  ): Promise<FeishuMessageReadResponse>
}

export interface RawMessageReadItem {
  message_id?: string
  msg_type?: string
  deleted?: boolean
  body?: { content?: string }
  upper_message_id?: string
  sender?: {
    id?: string
    sender_type?: string
    sender_name?: string
  }
  mentions?: Array<{
    key?: string
    id?: string
    id_type?: string
    name?: string
  }>
}

export function normalizeMessageReadItem(
  raw: RawMessageReadItem,
): FeishuMessageReadItem {
  const messageId = raw.message_id ?? ''
  const messageType = raw.msg_type ?? ''
  const content = raw.body?.content ?? ''
  const senderId = raw.sender?.id ?? ''
  const senderType = raw.sender?.sender_type ?? ''
  const senderName = raw.sender?.sender_name
  return {
    messageId,
    messageType,
    content,
    ...(raw.upper_message_id !== undefined && raw.upper_message_id !== ''
      ? { upperMessageId: raw.upper_message_id }
      : {}),
    ...(senderId !== '' || senderType !== '' || senderName !== undefined
      ? {
          sender: {
            id: senderId,
            type: senderType,
            ...(senderName !== undefined && senderName !== ''
              ? { name: senderName }
              : {}),
          },
        }
      : {}),
    mentions: (raw.mentions ?? []).map(normalizeMessageReadMention),
    deleted: raw.deleted === true,
    malformed:
      messageId === '' ||
      messageType === '' ||
      (content === '' && messageType !== 'merge_forward'),
  }
}

function normalizeMessageReadMention(
  raw: NonNullable<RawMessageReadItem['mentions']>[number],
): Mention {
  const id = raw.id ?? ''
  const identity = id === ''
    ? undefined
    : raw.id_type === 'union_id'
      ? { union_id: id }
      : raw.id_type === 'user_id'
        ? { user_id: id }
        : { open_id: id }
  return {
    key: raw.key ?? '',
    ...(identity !== undefined ? { id: identity } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  }
}
