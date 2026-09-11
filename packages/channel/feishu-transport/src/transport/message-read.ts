import type { Mention } from '../contract/types.js'

export type FeishuMessageReadMode = 'default' | 'user_card_content'

export interface FeishuMessageReadRequest {
  messageId: string
  cardContent?: FeishuMessageReadMode
}

/** Projection of one `im.v1.message.get` item: its content, and where it is. */
export interface FeishuMessageReadItem {
  messageId: string
  messageType: string
  content: string
  mentions: Mention[]
  deleted: boolean
  malformed: boolean
  /** The chat the message is in. Empty when the response omitted it. */
  chatId: string
  /** The topic it is in, present only for a message inside one. */
  threadId?: string
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
  chat_id?: string
  thread_id?: string
  body?: { content?: string }
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
  const threadId = raw.thread_id ?? ''
  return {
    messageId,
    messageType,
    content,
    mentions: (raw.mentions ?? []).map(normalizeMessageReadMention),
    deleted: raw.deleted === true,
    chatId: raw.chat_id ?? '',
    ...(threadId !== '' ? { threadId } : {}),
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
        // An application id is not a user identity and nothing can reply to
        // one, so the record keeps its key and name and claims no identity.
        : raw.id_type === 'app_id'
          ? undefined
          : { open_id: id }
  return {
    key: raw.key ?? '',
    ...(identity !== undefined ? { id: identity } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  }
}
