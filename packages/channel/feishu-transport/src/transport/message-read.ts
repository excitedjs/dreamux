import type { Mention } from '../parse/mentions.js';

export interface FeishuMessageReadRequest {
  messageId: string;
}

/** Projection of one `im.v1.message.get` item: its content, and where it is. */
export interface FeishuMessageReadItem {
  messageId: string;
  messageType: string;
  content: string;
  mentions: Mention[];
  deleted: boolean;
  malformed: boolean;
  /** The chat the message is in. Empty when the response omitted it. */
  chatId: string;
  /** The topic it is in, present only for a message inside one. */
  threadId?: string;
}

export interface FeishuMessageReadResponse {
  items: FeishuMessageReadItem[];
}

export interface FeishuMessageReader {
  readMessage(
    request: FeishuMessageReadRequest,
  ): Promise<FeishuMessageReadResponse>;
}

// Mirrors `im.v1.message.get`'s own response item type, which declares each
// field as possibly explicit `undefined`, not merely absent.
export interface RawMessageReadItem {
  message_id?: string | undefined;
  root_id?: string | undefined;
  msg_type?: string | undefined;
  deleted?: boolean | undefined;
  chat_id?: string | undefined;
  thread_id?: string | undefined;
  body?: { content?: string | undefined } | undefined;
  mentions?:
    | Array<{
        key?: string | undefined;
        id?: string | undefined;
        id_type?: string | undefined;
        name?: string | undefined;
      }>
    | undefined;
}

/**
 * The message a topic's replies hang under, read off the earliest message the
 * topic lists.
 *
 * A reply carries its topic's `root_id`; a message that names none is the root
 * itself, so its own id is the answer. The earliest message is therefore
 * enough — either it is the root or it points at it.
 */
export function threadRootOf(
  earliest: RawMessageReadItem | undefined,
): string | undefined {
  const named = earliest?.root_id ?? '';
  const root = named !== '' ? named : (earliest?.message_id ?? '');
  return root === '' ? undefined : root;
}

export function normalizeMessageReadItem(
  raw: RawMessageReadItem,
): FeishuMessageReadItem {
  const messageId = raw.message_id ?? '';
  const messageType = raw.msg_type ?? '';
  const content = raw.body?.content ?? '';
  const threadId = raw.thread_id ?? '';
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
  };
}

function normalizeMessageReadMention(
  raw: NonNullable<RawMessageReadItem['mentions']>[number],
): Mention {
  const id = raw.id ?? '';
  const identity =
    id === ''
      ? undefined
      : raw.id_type === 'union_id'
        ? { union_id: id }
        : raw.id_type === 'user_id'
          ? { user_id: id }
          : // An application id is not a user identity and nothing can reply to
            // one, so the record keeps its key and name and claims no identity.
            raw.id_type === 'app_id'
            ? undefined
            : { open_id: id };
  return {
    key: raw.key ?? '',
    ...(identity !== undefined ? { id: identity } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  };
}
