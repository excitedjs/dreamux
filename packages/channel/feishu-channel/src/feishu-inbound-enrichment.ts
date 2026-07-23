import {
  mergeInteractiveInbound,
  parseInbound,
  type FeishuMessageReadItem,
  type FeishuMessageReadMode,
  type FeishuMessageReadResponse,
  type ParsedInbound,
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
  const current = await enrichCurrentMessage(event, bot, work, log);
  work.assertSessionActive();
  return enrichParentMessageType(current, bot, work, log);
}

async function enrichCurrentMessage(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  if (event.messageType === 'merge_forward') {
    return asLazyMergedForward(event);
  }
  if (bot.readMessage === undefined) {
    return needsMessageRead(event.messageType)
      ? { ...event, contentIncomplete: true }
      : event;
  }
  if (event.messageType === 'interactive') {
    return enrichInteractive(event, bot, work, log);
  }
  if (event.messageType === 'nonsupport') {
    return resolveUnsupported(event, bot, work, log);
  }
  return event;
}

function needsMessageRead(messageType: string): boolean {
  return ['interactive', 'nonsupport'].includes(messageType);
}

async function enrichInteractive(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  const [structured, simplified] = await Promise.all([
    readRoot(event, bot, work, log, 'user_card_content'),
    readRoot(event, bot, work, log, 'default'),
  ]);
  work.assertSessionActive();
  const structuredParsed = parseInteractiveRoot(structured);
  const simplifiedParsed = parseInteractiveRoot(simplified);
  if (structuredParsed === undefined && simplifiedParsed === undefined) {
    return { ...event, contentIncomplete: true };
  }

  const primary = structuredParsed ?? simplifiedParsed;
  if (primary === undefined) return { ...event, contentIncomplete: true };
  const supplemental = structuredParsed === undefined
    ? undefined
    : simplifiedParsed;
  const parsed = mergeInteractiveInbound(
    primary.parsed,
    supplemental?.parsed,
  );
  return {
    ...event,
    messageType: 'interactive',
    rawContent: primary.item.content,
    parsedText: parsed.text,
    contentParts: parsed.parts ?? [],
    mentions: primary.item.mentions,
    resources: parsed.resources ?? [],
    ...(parsed.incomplete === true ||
    structuredParsed === undefined ||
    simplifiedParsed === undefined
      ? { contentIncomplete: true }
      : { contentIncomplete: false }),
  };
}

function parseInteractiveRoot(
  item: FeishuMessageReadItem | undefined,
): { item: FeishuMessageReadItem; parsed: ParsedInbound } | undefined {
  if (item === undefined || item.messageType !== 'interactive') return undefined;
  return {
    item,
    parsed: parseInbound({
      message_type: item.messageType,
      content: item.content,
      mentions: item.mentions,
    }),
  };
}

async function resolveUnsupported(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  const response = await readMessage(
    event.messageId,
    bot,
    work,
    log,
    'default',
  );
  const root = validRoot(response, event.messageId);
  work.assertSessionActive();
  if (root === undefined || root.messageType === 'nonsupport') {
    return { ...event, contentIncomplete: true };
  }
  if (root.messageType === 'merge_forward') {
    return asLazyMergedForward({ ...event, messageType: 'merge_forward' });
  }
  const parsed = parseReadItem(root);
  return {
    ...event,
    messageType: root.messageType,
    rawContent: root.content,
    parsedText: parsed.text,
    contentParts: parsed.parts ?? [],
    mentions: root.mentions,
    resources: parsed.resources ?? [],
    ...(parsed.incomplete === true
      ? { contentIncomplete: true }
      : { contentIncomplete: false }),
  };
}

function asLazyMergedForward(
  event: FeishuInboundEvent,
): FeishuInboundEvent {
  return {
    ...event,
    messageType: 'merge_forward',
    parsedText: '(merged-forward message not expanded)',
    contentParts: [],
    resources: [],
    contentIncomplete: false,
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
  const response = await readMessage(
    parentId,
    bot,
    work,
    log,
    'default',
    deadlineAt,
  );
  work.assertSessionActive();
  const parent = validRoot(response, parentId);
  const parentMessageType = parent === undefined
    ? undefined
    : normalizeFeishuMessageTypeToken(parent.messageType);
  return parentMessageType === undefined
    ? event
    : { ...event, parentMessageType };
}

async function readRoot(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
  mode: FeishuMessageReadMode,
): Promise<FeishuMessageReadItem | undefined> {
  return validRoot(
    await readMessage(event.messageId, bot, work, log, mode),
    event.messageId,
  );
}

async function readMessage(
  messageId: string,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
  mode: FeishuMessageReadMode,
  deadlineAt: number = work.deadlineAt,
): Promise<FeishuMessageReadResponse | undefined> {
  if (bot.readMessage === undefined) return undefined;
  try {
    return await runFeishuInboundWork(work, () => bot.readMessage?.({
      messageId,
      cardContent: mode,
    }) ?? Promise.resolve({ items: [] }), deadlineAt);
  } catch (error) {
    if (isFeishuOperationError(error, 'aborted')) throw error;
    log.debug(
      {
        message_id: messageId,
        mode,
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

function parseReadItem(item: FeishuMessageReadItem): ParsedInbound {
  return parseInbound({
    message_type: item.messageType,
    content: item.content,
    mentions: item.mentions,
  });
}
