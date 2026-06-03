import type { Mention } from '@excitedjs/feishu-transport';

import type { FeishuInboundEvent } from '../feishu/bot.js';

export const FEISHU_SKILL_FALLBACK_NOTE =
  'Parser note: message text may be incomplete. Use the Feishu skill with the chat_id and message_id above to fetch the original message when needed.';

export function formatFeishuMessageForCodex(event: FeishuInboundEvent): string {
  const attrs: Array<[string, string]> = [
    ['chat_id', event.chatId],
    ['chat_type', event.chatType],
    ['message_id', event.messageId],
    ['sender_id', event.senderId],
    ['sender_name', event.senderName],
    ['create_time', formatFeishuCreateTime(event.createTime)],
  ];
  const body = renderMessageBody(event);
  const fallback = shouldAddFallbackNote(event)
    ? `\n\n${FEISHU_SKILL_FALLBACK_NOTE}`
    : '';

  const attrLines = attrs.map(
    ([key, value]) => `  ${key}="${escapeXmlAttribute(value)}"`,
  );
  attrLines[attrLines.length - 1] = `${attrLines[attrLines.length - 1]}>`;

  return [
    '<feishu_message',
    ...attrLines,
    `${body}${fallback}`,
    '</feishu_message>',
  ].join('\n');
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
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return trimmed;
}

function renderMessageBody(event: FeishuInboundEvent): string {
  const rawText = extractRawText(event);
  if (rawText !== null) {
    return renderTextWithMentions(rawText, event.mentions);
  }
  return escapeXmlText(event.parsedText);
}

function extractRawText(event: FeishuInboundEvent): string | null {
  if (event.messageType !== 'text') return null;
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

function renderTextWithMentions(text: string, mentions: Mention[]): string {
  let out = escapeXmlText(text);
  for (const mention of mentions) {
    const id = mention.id?.open_id ?? mention.id?.union_id ?? mention.id?.user_id;
    if (mention.key === '' || id === undefined || mention.name === undefined) {
      continue;
    }
    out = out.split(escapeXmlText(mention.key)).join(
      `<at id="${escapeXmlAttribute(id)}">${escapeXmlText(mention.name)}</at>`,
    );
  }
  return out;
}

function shouldAddFallbackNote(event: FeishuInboundEvent): boolean {
  if (event.parsedText === '(unparseable message)') return true;
  if (event.messageType === 'text' && extractRawText(event) === null) return true;
  return event.parsedText === `(${event.messageType} message)`;
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
