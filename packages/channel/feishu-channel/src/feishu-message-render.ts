import type {
  InboundContentPart,
  InboundResource,
} from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from './bot.js';
import type { PeerBot } from './chat-bots-store.js';
import type { FormattedFeishuAttachment } from './feishu-message.js';
import {
  normalizeFeishuMessageTypeToken,
  replyAncestryParentId,
} from './feishu-reply-ancestry.js';

const MAX_SERIALIZED_BODY_CHARS = 160_000;
const BODY_TRUNCATION_MARKER =
  '\n[message content truncated: 160000-character limit reached]';

export interface RenderFeishuBodyResult {
  body: string;
  groupBotsRendered: boolean;
}

export function renderFeishuStructuredBody(
  event: FeishuInboundEvent,
  trustedBots: PeerBot[],
  resolveAttachment: (resource: InboundResource) => FormattedFeishuAttachment,
): RenderFeishuBodyResult {
  const parts = event.contentParts;
  const refs = renderRefs(event);
  let groupBots = renderGroupBots(trustedBots);
  let groupBotsRendered = groupBots !== '';
  const renderPart = (part: InboundContentPart): string =>
    renderContentPart(part, resolveAttachment);
  const fullContent = parts.map(renderPart).join('');
  const contentOpen = event.contentIncomplete === true
    ? '<content incomplete="true">'
    : '<content>';
  const emptyContent = event.contentIncomplete === true
    ? '<content incomplete="true" />'
    : '<content />';
  const fixedBlocks = (): string =>
    [refs, groupBots]
      .filter((block) => block !== '')
      .map((block) => `\n${block}`)
      .join('');
  const whole = parts.length === 0
    ? `${emptyContent}${fixedBlocks()}`
    : `${contentOpen}\n${fullContent}\n</content>${fixedBlocks()}`;
  if (whole.length <= MAX_SERIALIZED_BODY_CHARS) {
    return { body: whole, groupBotsRendered };
  }

  const wrapperCost = contentOpen.length + '\n'.length + '\n</content>'.length;
  let available = MAX_SERIALIZED_BODY_CHARS - wrapperCost - fixedBlocks().length;
  if (available < BODY_TRUNCATION_MARKER.length && groupBots !== '') {
    groupBots = '';
    groupBotsRendered = false;
    available = MAX_SERIALIZED_BODY_CHARS - wrapperCost - fixedBlocks().length;
  }
  const truncated = renderPartsWithinBudget(
    parts,
    Math.max(BODY_TRUNCATION_MARKER.length, available),
    renderPart,
  );
  return {
    body: `${contentOpen}\n${truncated}\n</content>${fixedBlocks()}`,
    groupBotsRendered,
  };
}

export function formatFeishuCreateTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const epochMs = Math.abs(numeric) < 1_000_000_000_000
      ? numeric * 1000
      : numeric;
    const date = new Date(epochMs);
    if (!Number.isNaN(date.getTime())) return formatLocalDate(date);
  }

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return formatLocalDate(date);
  return trimmed;
}

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
  ].join('-') + ` ${[
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].join(':')}`;
}

function renderGroupBots(trustedBots: PeerBot[]): string {
  if (trustedBots.length === 0) return '';
  const lines = trustedBots.map((bot) => {
    const name = bot.name ?? '';
    return `  <bot name="${escapeXmlAttribute(name)}" open_id="${escapeXmlAttribute(bot.openId)}" />`;
  });
  return [
    '<group_bots note="trusted bots in this group; a bot speaks without @-mentioning us">',
    ...lines,
    '</group_bots>',
  ].join('\n');
}

function renderRefs(event: FeishuInboundEvent): string {
  const rows: string[] = [];
  if (event.messageType === 'merge_forward') {
    rows.push(
      `  <merged-forward message_id="${escapeXmlAttribute(event.messageId)}" />`,
    );
  }
  const parentId = replyAncestryParentId(event);
  if (parentId !== undefined) {
    const type = event.parentMessageType === undefined
      ? undefined
      : normalizeFeishuMessageTypeToken(event.parentMessageType);
    rows.push(
      `  <reply-to message_id="${escapeXmlAttribute(parentId)}"${
        type === undefined
          ? ''
          : ` message_type="${escapeXmlAttribute(type)}"`
      } />`,
    );
  }
  return rows.length === 0 ? '' : ['<refs>', ...rows, '</refs>'].join('\n');
}

function renderContentPart(
  part: InboundContentPart,
  resolveAttachment: (resource: InboundResource) => FormattedFeishuAttachment,
): string {
  if (part.kind === 'text') return escapeXmlText(part.text);
  if (part.kind === 'mention') {
    // The same syntax the reply tool takes, so a mention read here can be
    // written straight back.
    return `<at user_id="${escapeXmlAttribute(part.id)}">${
      escapeXmlText(part.name)
    }</at>`;
  }
  if (part.kind === 'resource') {
    return renderAttachment(resolveAttachment(part.resource));
  }
  return renderCode(part.code, part.language);
}

function renderAttachment(attachment: FormattedFeishuAttachment): string {
  if (attachment.status === 'downloaded' && attachment.path !== undefined) {
    return `<attachment path="${escapeXmlAttribute(attachment.path)}" />`;
  }
  const key = escapeXmlAttribute(attachment.key ?? '');
  return `<attachment status="not_downloaded" key="${key}" />`;
}

function renderCode(code: string, language?: string): string {
  const languageAttr = language === undefined || language === ''
    ? ''
    : ` language="${escapeXmlAttribute(language)}"`;
  return `<code${languageAttr}><![CDATA[${escapeCdata(code)}]]></code>`;
}

function escapeCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>');
}

function renderPartsWithinBudget(
  parts: InboundContentPart[],
  budget: number,
  renderPart: (part: InboundContentPart) => string,
): string {
  const contentBudget = Math.max(0, budget - BODY_TRUNCATION_MARKER.length);
  let output = '';
  for (const part of parts) {
    const rendered = renderPart(part);
    if (output.length + rendered.length <= contentBudget) {
      output += rendered;
      continue;
    }
    const remaining = Math.max(0, contentBudget - output.length);
    if (part.kind === 'text') {
      output += truncateEscapedText(part.text, remaining);
    } else if (part.kind === 'code') {
      output += truncateCode(part, remaining);
    }
    break;
  }
  return `${output}${BODY_TRUNCATION_MARKER}`;
}

function truncateEscapedText(value: string, budget: number): string {
  return escapeXmlText(longestRawPrefix(value, budget, escapeXmlText));
}

function truncateCode(
  part: Extract<InboundContentPart, { kind: 'code' }>,
  budget: number,
): string {
  const empty = renderCode('', part.language);
  if (empty.length > budget) return '';
  const raw = longestRawPrefix(
    part.code,
    budget - empty.length,
    escapeCdata,
  );
  return renderCode(raw, part.language);
}

function longestRawPrefix(
  value: string,
  budget: number,
  render: (value: string) => string,
): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const prefix = safeUtf16Prefix(value, middle);
    if (render(prefix).length <= budget) low = middle;
    else high = middle - 1;
  }
  return safeUtf16Prefix(value, low);
}

function safeUtf16Prefix(value: string, length: number): string {
  let prefix = value.slice(0, length);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
