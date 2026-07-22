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
  runFeishuInboundWork,
  type FeishuInboundWorkContext,
} from './feishu-inbound-work.js';

const MAX_FORWARDED_DEPTH = 5;
const MAX_FORWARDED_ITEMS = 500;

export async function enrichFeishuInbound(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
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
  if (event.messageType === 'merge_forward') {
    return expandMergedForward(event, bot, work, log);
  }
  return event;
}

function needsMessageRead(messageType: string): boolean {
  return ['interactive', 'nonsupport', 'merge_forward'].includes(messageType);
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
  const response = await readMessage(event, bot, work, log, 'default');
  const root = validRoot(response, event.messageId);
  work.assertSessionActive();
  if (root === undefined || root.messageType === 'nonsupport') {
    return { ...event, contentIncomplete: true };
  }
  if (root.messageType === 'merge_forward' && response !== undefined) {
    const projection = projectForwardedItems(root, response.items);
    return {
      ...event,
      messageType: root.messageType,
      rawContent: root.content,
      parsedText: projection.text,
      mentions: root.mentions,
      resources: projection.resources,
      ...(projection.incomplete
        ? { contentIncomplete: true }
        : { contentIncomplete: false }),
    };
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

async function expandMergedForward(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
): Promise<FeishuInboundEvent> {
  let usedFallback = false;
  let response = await readMessage(event, bot, work, log, 'user_card_content');
  let root = validRoot(response, event.messageId);
  if (root === undefined || root.messageType !== 'merge_forward') {
    usedFallback = true;
    response = await readMessage(event, bot, work, log, 'default');
    root = validRoot(response, event.messageId);
  }
  work.assertSessionActive();
  if (
    response === undefined ||
    root === undefined ||
    root.messageType !== 'merge_forward'
  ) {
    return { ...event, contentIncomplete: true };
  }

  const projection = projectForwardedItems(root, response.items);
  return {
    ...event,
    parsedText: projection.text,
    resources: projection.resources,
    ...(projection.incomplete || usedFallback
      ? { contentIncomplete: true }
      : { contentIncomplete: false }),
  };
}

async function readRoot(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
  mode: FeishuMessageReadMode,
): Promise<FeishuMessageReadItem | undefined> {
  return validRoot(
    await readMessage(event, bot, work, log, mode),
    event.messageId,
  );
}

async function readMessage(
  event: FeishuInboundEvent,
  bot: FeishuBot,
  work: FeishuInboundWorkContext,
  log: DreamuxLogger,
  mode: FeishuMessageReadMode,
): Promise<FeishuMessageReadResponse | undefined> {
  if (bot.readMessage === undefined) return undefined;
  try {
    return await runFeishuInboundWork(work, () => bot.readMessage?.({
      messageId: event.messageId,
      cardContent: mode,
    }) ?? Promise.resolve({ items: [] }));
  } catch (error) {
    if (error instanceof FeishuSessionRevokedError) throw error;
    log.debug(
      {
        message_id: event.messageId,
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

interface ForwardProjection {
  text: string;
  resources: InboundResource[];
  incomplete: boolean;
}

interface ForwardState {
  lines: string[];
  resources: InboundResource[];
  resourceKeys: Set<string>;
  visited: Set<string>;
  incomplete: boolean;
}

function projectForwardedItems(
  root: FeishuMessageReadItem,
  allItems: FeishuMessageReadItem[],
): ForwardProjection {
  const state: ForwardState = {
    lines: ['Merged forwarded messages:'],
    resources: [],
    resourceKeys: new Set(),
    visited: new Set([root.messageId]),
    incomplete: false,
  };
  const accepted: FeishuMessageReadItem[] = [];
  const ids = new Set([root.messageId]);
  let omittedByCount = 0;
  let processedDescendants = 0;
  let missingIds = 0;
  let duplicates = 0;
  for (const item of allItems) {
    if (item === root) continue;
    if (processedDescendants >= MAX_FORWARDED_ITEMS) {
      omittedByCount = Math.max(
        1,
        allItems.length - 1 - processedDescendants,
      );
      state.incomplete = true;
      break;
    }
    processedDescendants += 1;
    if (item.messageId === '') {
      missingIds += 1;
      state.incomplete = true;
      continue;
    }
    if (ids.has(item.messageId)) {
      duplicates += 1;
      state.incomplete = true;
      continue;
    }
    ids.add(item.messageId);
    accepted.push(item);
  }

  const children = new Map<string, FeishuMessageReadItem[]>();
  for (const item of accepted) {
    const parentId = item.upperMessageId;
    if (parentId === undefined || !ids.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(item);
    children.set(parentId, siblings);
  }
  for (const child of children.get(root.messageId) ?? []) {
    renderForwardedItem(child, 1, children, state, new Set([root.messageId]));
  }

  const unattached = accepted.filter((item) => !state.visited.has(item.messageId));
  if (unattached.length > 0 || missingIds > 0 || duplicates > 0) {
    state.incomplete = true;
    state.lines.push('', 'Unattached forwarded items:');
    for (const item of unattached) {
      if (state.visited.has(item.messageId)) continue;
      renderForwardedItem(item, 1, children, state, new Set());
    }
    if (missingIds > 0) {
      state.lines.push(`- [${missingIds} forwarded item(s) omitted: missing message id]`);
    }
    if (duplicates > 0) {
      state.lines.push(`- [${duplicates} forwarded item(s) omitted: duplicate message id]`);
    }
  }
  if (omittedByCount > 0) {
    state.lines.push(
      `- [${omittedByCount} forwarded item(s) omitted: item limit reached]`,
    );
  }
  return {
    text: state.lines.join('\n'),
    resources: state.resources,
    incomplete: state.incomplete,
  };
}

function renderForwardedItem(
  item: FeishuMessageReadItem,
  depth: number,
  children: Map<string, FeishuMessageReadItem[]>,
  state: ForwardState,
  ancestors: Set<string>,
): void {
  const indent = '  '.repeat(Math.max(0, depth - 1));
  if (ancestors.has(item.messageId)) {
    state.lines.push(`${indent}- [forwarded item omitted: cycle detected]`);
    state.incomplete = true;
    return;
  }
  if (state.visited.has(item.messageId)) return;
  state.visited.add(item.messageId);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(item.messageId);
  const sender = forwardSender(item);
  if (item.deleted) {
    state.lines.push(`${indent}- ${sender}: [forwarded message deleted]`);
    state.incomplete = true;
  } else if (item.malformed) {
    state.lines.push(`${indent}- ${sender}: [forwarded message malformed]`);
    state.incomplete = true;
  } else if (item.messageType === 'merge_forward') {
    state.lines.push(`${indent}- ${sender}: [nested merged-forward message]`);
  } else {
    const parsed = parseReadItem(item);
    state.lines.push(`${indent}- ${sender} (${safeType(item.messageType)}):`);
    const bodyIndent = `${indent}  `;
    for (const line of parsed.text.split(/\r?\n/)) {
      state.lines.push(`${bodyIndent}${line}`);
    }
    mergeForwardResources(state, parsed.resources ?? []);
    if (parsed.incomplete === true) state.incomplete = true;
  }

  const nested = children.get(item.messageId) ?? [];
  if (nested.length === 0) return;
  if (depth >= MAX_FORWARDED_DEPTH) {
    state.lines.push(`${indent}  [nested forwarded content omitted: depth limit reached]`);
    state.incomplete = true;
    return;
  }
  for (const child of nested) {
    renderForwardedItem(child, depth + 1, children, state, nextAncestors);
  }
}

function forwardSender(item: FeishuMessageReadItem): string {
  const sender = item.sender;
  if (sender === undefined) return 'Unknown sender';
  return sender.name ?? (sender.id || sender.type || 'Unknown sender');
}

function safeType(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  return safe === '' ? 'unknown' : safe;
}

function mergeForwardResources(
  state: ForwardState,
  resources: InboundResource[],
): void {
  for (const resource of resources) {
    const identity = resource.key === undefined
      ? undefined
      : `${resource.type}:${resource.key}`;
    if (identity !== undefined && state.resourceKeys.has(identity)) continue;
    if (identity !== undefined) state.resourceKeys.add(identity);
    state.resources.push(resource);
  }
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
