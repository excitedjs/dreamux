import type { FeishuInboundEvent } from './bot.js';

const FEISHU_MESSAGE_TYPE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Select the parent relation that should be explained to the model. */
export function replyAncestryParentId(
  event: FeishuInboundEvent,
): string | undefined {
  const parentId = event.parentId;
  if (parentId === undefined || parentId === '' || parentId === event.messageId) {
    return undefined;
  }
  if (
    event.threadId !== undefined &&
    event.threadId !== '' &&
    parentId === event.rootId
  ) {
    return undefined;
  }
  return parentId;
}

/** Keep future Feishu message types useful without accepting prompt payloads. */
export function normalizeFeishuMessageTypeToken(
  value: string,
): string | undefined {
  return FEISHU_MESSAGE_TYPE_TOKEN.test(value) ? value : undefined;
}
