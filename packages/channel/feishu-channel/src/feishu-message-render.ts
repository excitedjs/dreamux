import type { Mention } from '@excitedjs/feishu-transport';

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
const CARD_NOTE =
  'this message is a rich card; its text and attachments are above, pull the full card with lark-cli when you need more';

export interface RenderFeishuBodyResult {
  body: string;
  groupBotsRendered: boolean;
}

/**
 * Write the model-facing body. The text is escaped once, then the tokens the
 * message's own records name are substituted in place: a mention placeholder
 * becomes the same `<at user_id="…">` the reply tool takes, a resource key
 * becomes its `<attachment>`. Nothing else in the text is interpreted.
 */
export function renderFeishuBody(
  event: FeishuInboundEvent,
  trustedBots: PeerBot[],
  attachments: FormattedFeishuAttachment[],
): RenderFeishuBodyResult {
  const content = substituteTokens(
    escapeXmlText(event.text),
    tokenTable(event.mentions, attachments),
  );
  const refs = renderRefs(event);
  let groupBots = renderGroupBots(trustedBots);
  let groupBotsRendered = groupBots !== '';
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
  const wrap = (inner: string): string => inner === ''
    ? `${emptyContent}${fixedBlocks()}`
    : `${contentOpen}\n${inner}\n</content>${fixedBlocks()}`;
  const whole = wrap(content);
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
  const kept = truncate(
    content,
    Math.max(0, available - BODY_TRUNCATION_MARKER.length),
  );
  return { body: wrap(`${kept}${BODY_TRUNCATION_MARKER}`), groupBotsRendered };
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

/**
 * What each token in the escaped text is replaced with. Tokens are looked up
 * in their escaped spelling because the text they are found in is escaped.
 */
function tokenTable(
  mentions: Mention[],
  attachments: FormattedFeishuAttachment[],
): Map<string, string> {
  const table = new Map<string, string>();
  for (const record of mentions) {
    if (record.key !== '') table.set(escapeXmlText(record.key), renderMention(record));
  }
  for (const attachment of attachments) {
    table.set(escapeXmlText(attachment.key), renderAttachment(attachment));
  }
  return table;
}

/**
 * Longest token first, each occurrence claimed once, so `@_user_1` inside
 * `@_user_19:00` and `@_user_10` beside `@_user_1` both resolve to the record
 * that names them.
 */
function substituteTokens(text: string, table: Map<string, string>): string {
  const matches: Array<{ start: number; end: number; replacement: string }> = [];
  const claimed = new Uint8Array(text.length);
  const tokens = [...table.entries()].sort(([a], [b]) => b.length - a.length);
  for (const [token, replacement] of tokens) {
    if (token === '') continue;
    for (
      let start = text.indexOf(token);
      start !== -1;
      start = text.indexOf(token, start + 1)
    ) {
      const end = start + token.length;
      if (claimed.subarray(start, end).includes(1)) continue;
      claimed.fill(1, start, end);
      matches.push({ start, end, replacement });
    }
  }
  matches.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start) + match.replacement;
    cursor = match.end;
  }
  return out + text.slice(cursor);
}

function renderMention(record: Mention): string {
  const name = escapeXmlText(record.name ?? '');
  const id = nonEmpty(record.id?.open_id) ??
    nonEmpty(record.id?.union_id) ??
    nonEmpty(record.id?.user_id);
  // An application record carries no user identity; nothing can reply to it,
  // so it reads as the name it displays.
  if (id === undefined) return `@${name}`;
  // The same syntax the reply tool takes, so a mention read here can be
  // written straight back.
  return `<at user_id="${escapeXmlAttribute(id)}">${name}</at>`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

function renderAttachment(attachment: FormattedFeishuAttachment): string {
  if (attachment.status === 'downloaded' && attachment.path !== undefined) {
    return `<attachment path="${escapeXmlAttribute(attachment.path)}" />`;
  }
  return `<attachment status="not_downloaded" key="${escapeXmlAttribute(attachment.key)}" />`;
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
  if (event.messageType === 'interactive') {
    rows.push(
      `  <card message_id="${escapeXmlAttribute(event.messageId)}" note="${CARD_NOTE}" />`,
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

/**
 * Cut the rendered content at `budget` without leaving an unfinished tag,
 * entity, or surrogate pair behind. A literal `<` or `>` in the rendered text
 * can only belong to a Channel-owned tag, because the message text was escaped
 * before the tags were substituted in.
 */
function truncate(value: string, budget: number): string {
  let kept = value.slice(0, budget);
  const openTag = kept.lastIndexOf('<');
  if (openTag > kept.lastIndexOf('>')) kept = kept.slice(0, openTag);
  const openEntity = kept.lastIndexOf('&');
  if (openEntity > kept.lastIndexOf(';')) kept = kept.slice(0, openEntity);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return kept;
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
