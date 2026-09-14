import {
  parseInbound,
  type FeishuMessageReadItem,
  type FeishuMessageReadResponse,
} from '@excitedjs/feishu-transport';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { FeishuBot, FeishuInboundEvent } from './bot.js';
import { isFeishuOperationError } from './feishu-bounded-operation.js';
import {
  FEISHU_RESOURCE_TIMEOUT_MS,
  runFeishuInboundWork,
  type FeishuInboundWorkContext,
} from './feishu-inbound-work.js';
import {
  normalizeFeishuMessageTypeToken,
  replyAncestryParentId,
} from './feishu-reply-ancestry.js';

const PARENT_TYPE_PROBE_TIMEOUT_MS = 2_000;

export async function enrichFeishuInbound(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  const current = await resolveUnsupported(event, bot, work, log);
  work.assertSessionActive();
  return enrichParentMessageType(current, bot, work, log);
}

/**
 * A `nonsupport` event names a type the WebSocket delivery could not carry;
 * the message read returns the authoritative type and content. Every other
 * event already carries its whole body.
 */
async function resolveUnsupported(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  if (event.messageType !== 'nonsupport') return event;
  const root = validRoot(
    await readMessage(event.messageId, bot, work, log),
    event.messageId,
  );
  work.assertSessionActive();
  if (root === undefined || root.messageType === 'nonsupport') return event;
  const parsed = parseInbound({
    message_type: root.messageType,
    content: root.content,
    mentions: root.mentions,
  });
  const { contentIncomplete: _unresolved, ...rest } = event;
  return {
    ...rest,
    messageType: root.messageType,
    rawContent: root.content,
    text: parsed.text,
    resources: parsed.resources,
    mentions: root.mentions,
    ...(parsed.incomplete === true ? { contentIncomplete: true } : {}),
  };
}

async function enrichParentMessageType(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  const parentId = replyAncestryParentId(event);
  if (parentId === undefined || bot.readMessage === undefined) return event;

  const probeBudget = work.remainingTimeMs() - FEISHU_RESOURCE_TIMEOUT_MS;
  if (probeBudget <= 0) return event;
  const deadlineAt = Date.now() + Math.min(
    PARENT_TYPE_PROBE_TIMEOUT_MS,
    probeBudget,
  );
  const response = await readMessage(parentId, bot, work, log, deadlineAt);
  work.assertSessionActive();
  const parent = validRoot(response, parentId);
  const parentMessageType = parent === undefined
    ? undefined
    : normalizeFeishuMessageTypeToken(parent.messageType);
  return parentMessageType === undefined
    ? event
    : { ...event, parentMessageType };
}

async function readMessage(
  messageId: string,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
  deadlineAt: number = work.deadlineAt,
): Promise<FeishuMessageReadResponse | undefined> {
  if (bot.readMessage === undefined) return undefined;
  try {
    return await runFeishuInboundWork(work, () => bot.readMessage?.({
      messageId,
    }) ?? Promise.resolve({ items: [] }), deadlineAt);
  } catch (error) {
    if (isFeishuOperationError(error, 'aborted')) throw error;
    log.debug(
      {
        message_id: messageId,
        reason: 'message_read_unavailable',
      },
      'feishu inbound message enrichment read was unavailable',
    );
    return undefined;
  }
}

function validRoot(
  response: FeishuMessageReadResponse | undefined,
  messageId: string,
): FeishuMessageReadItem | undefined {
  const root = response?.items.find((item) => item.messageId === messageId);
  return root !== undefined && !root.deleted && !root.malformed
    ? root
    : undefined;
}
