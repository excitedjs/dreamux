import type { Mention } from '../contract/types.js'

export type FeishuMessageReadMode = 'default' | 'user_card_content'

export interface FeishuMessageReadRequest {
  messageId: string
  cardContent?: FeishuMessageReadMode
}

/** Content-only projection of one `im.v1.message.get` item. */
export interface FeishuMessageReadItem {
  messageId: string
  messageType: string
  content: string
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
  return {
    messageId,
    messageType,
    content,
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
