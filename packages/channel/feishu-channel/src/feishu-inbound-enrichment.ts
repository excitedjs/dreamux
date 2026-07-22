import {
  parseInbound,
  type FeishuMessageReadItem,
  type FeishuMessageReadMode,
  type FeishuMessageReadResponse,
  type InboundResource,
  type ParsedInbound,
} from '@excitedjs/feishu-transport';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

import type { FeishuBot, FeishuInboundEvent } from './bot.js';
import {
  FeishuSessionRevokedError,
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
  const text = mergeCardText(primary.parsed.text, supplemental?.parsed.text);
  const resources = mergeResources(
    primary.parsed.resources ?? [],
    supplemental?.parsed.resources ?? [],
  );
  return {
    ...event,
    messageType: 'interactive',
    rawContent: primary.item.content,
    parsedText: text,
    mentions: primary.item.mentions,
    resources,
    ...(primary.parsed.incomplete === true ||
    supplemental?.parsed.incomplete === true ||
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

function mergeCardText(primary: string, supplemental: string | undefined): string {
  const normalizedPrimary = normalizeCardLines(primary);
  if (supplemental === undefined) return normalizedPrimary.join('\n');
  const seen = new Set(normalizedPrimary.map(normalizeCardLineForComparison));
  const extra = normalizeCardLines(supplemental).filter((line) => {
    const normalized = normalizeCardLineForComparison(line);
    if (normalized === '' || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  if (extra.length === 0) return normalizedPrimary.join('\n');
  return [
    ...normalizedPrimary,
    '',
    'Additional rendered card content:',
    ...extra,
  ].join('\n');
}

function normalizeCardLines(value: string): string[] {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
}

function normalizeCardLineForComparison(value: string): string {
  return value.trim();
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
    if (error instanceof FeishuSessionRevokedError) throw error;
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

function mergeResources(...groups: InboundResource[][]): InboundResource[] {
  const out: InboundResource[] = [];
  const seen = new Set<string>();
  for (const resource of groups.flat()) {
    const identity = resource.key === undefined
      ? undefined
      : `${resource.type}:${resource.key}`;
    if (identity !== undefined && seen.has(identity)) continue;
    if (identity !== undefined) seen.add(identity);
    out.push(resource);
  }
  return out;
}
