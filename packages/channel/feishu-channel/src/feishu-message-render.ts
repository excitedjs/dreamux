import type {
  InboundContentPart,
  InboundResource,
  Mention,
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

type RenderContentPart =
  | InboundContentPart
  | { kind: 'mention'; id: string; name: string };

export interface RenderFeishuBodyResult {
  body: string;
  groupBotsRendered: boolean;
}

export function renderFeishuStructuredBody(
  event: FeishuInboundEvent,
  trustedBots: PeerBot[],
  resolveAttachment: (resource: InboundResource) => FormattedFeishuAttachment,
): RenderFeishuBodyResult {
  const parts = contentPartsForEvent(event);
  const refs = renderRefs(event);
  let groupBots = renderGroupBots(trustedBots);
  let groupBotsRendered = groupBots !== '';
  const renderPart = (part: RenderContentPart): string =>
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

function contentPartsForEvent(event: FeishuInboundEvent): RenderContentPart[] {
  if (event.messageType === 'merge_forward') return [];
  if (event.messageType === 'text') {
    const raw = extractRawText(event);
    if (raw !== null) return textPartsWithMentions(raw, event.mentions);
  }
  const parts = event.contentParts;
  if (parts !== undefined) return parts.flatMap(promoteMarkdownCode);
  const fallback: RenderContentPart[] = [
    { kind: 'text', text: event.parsedText },
    ...(event.resources ?? []).map((resource) => ({
      kind: 'resource' as const,
      resource,
    })),
  ];
  return fallback.flatMap(promoteMarkdownCode);
}

function extractRawText(event: FeishuInboundEvent): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.rawContent);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const text = (parsed as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : null;
}

function textPartsWithMentions(
  text: string,
  mentions: Mention[],
): RenderContentPart[] {
  let parts: RenderContentPart[] = [{ kind: 'text', text }];
  for (const mention of mentions) {
    const id = mention.id?.open_id ?? mention.id?.union_id ?? mention.id?.user_id;
    if (
      mention.key === '' ||
      id === undefined ||
      mention.name === undefined
    ) {
      continue;
    }
    parts = parts.flatMap((part): RenderContentPart[] => {
      if (part.kind !== 'text') return [part];
      const pieces = part.text.split(mention.key);
      return pieces.flatMap((piece, index) => [
        ...(piece === '' ? [] : [{ kind: 'text' as const, text: piece }]),
        ...(index === pieces.length - 1
          ? []
          : [{ kind: 'mention' as const, id, name: mention.name ?? '' }]),
      ]);
    });
  }
  return parts;
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
  part: RenderContentPart,
  resolveAttachment: (resource: InboundResource) => FormattedFeishuAttachment,
): string {
  if (part.kind === 'text') return escapeXmlText(part.text);
  if (part.kind === 'mention') {
    return `<at id="${escapeXmlAttribute(part.id)}">${escapeXmlText(part.name)}</at>`;
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

function promoteMarkdownCode(part: RenderContentPart): RenderContentPart[] {
  if (part.kind !== 'text') return [part];
  const out: RenderContentPart[] = [];
  const text = part.text;
  const opener = /(^|\n)( {0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const marker = match[3] ?? '';
    const info = (match[4] ?? '').trim();
    if (marker.startsWith('`') && info.includes('`')) continue;
    const prefixEnd = match.index + (match[1]?.length ?? 0);
    if (prefixEnd > cursor) {
      out.push({ kind: 'text', text: text.slice(cursor, prefixEnd) });
    }
    const codeStart = match.index + match[0].length;
    const markerCharacter = marker[0] === '`' ? '`' : '~';
    const closePattern = new RegExp(
      `^ {0,3}${markerCharacter}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`,
      'gm',
    );
    closePattern.lastIndex = codeStart;
    const closer = closePattern.exec(text);
    let codeEnd = closer?.index ?? text.length;
    if (codeEnd > codeStart && text[codeEnd - 1] === '\n') codeEnd -= 1;
    if (codeEnd > codeStart && text[codeEnd - 1] === '\r') codeEnd -= 1;
    out.push({
      kind: 'code',
      code: text.slice(codeStart, codeEnd),
      ...(info !== '' ? { language: info } : {}),
    });
    cursor = closer === null ? text.length : closer.index + closer[0].length;
    opener.lastIndex = cursor;
    if (closer === null) break;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out.length === 0 ? [part] : out;
}

function renderPartsWithinBudget(
  parts: RenderContentPart[],
  budget: number,
  renderPart: (part: RenderContentPart) => string,
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
  part: Extract<RenderContentPart, { kind: 'code' }>,
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
