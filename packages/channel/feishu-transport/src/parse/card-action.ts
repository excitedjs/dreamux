/**
 * Decoding the `card.action.trigger` event envelope, and encoding a card
 * action handler's answer back into Feishu's own callback ACK shape.
 */

import type { TransportLogger } from '../transport/diagnostics.js';

export interface FeishuCardActionEvent {
  operatorOpenId?: string;
  actionValue: Record<string, unknown>;
  /**
   * What the user typed, for an `input` that carries its own callback. Feishu
   * sends it as `action.input_value`, outside `action.value`, and only a
   * form-less input ever reports one: inside a `form` the text is withheld
   * until submit and arrives as `form_value` instead.
   */
  inputValue?: string;
  openChatId?: string;
  openMessageId?: string;
  raw: unknown;
}

export function normalizeCardActionEvent(raw: unknown): FeishuCardActionEvent {
  const root = asRecord(raw) ?? {};
  const event = asRecord(root['event']) ?? root;
  const operator = asRecord(root['operator']) ?? asRecord(event['operator']);
  const action =
    asRecord(root['action']) ??
    asRecord(event['action']) ??
    asRecord(root['card_action']) ??
    asRecord(event['card_action']);
  const context =
    asRecord(root['context']) ?? asRecord(event['context']) ?? root;
  const actionValue = asRecord(action?.['value']) ?? {};
  const inputValue = firstString(
    action?.['input_value'],
    action?.['inputValue'],
  );
  const operatorOpenId = firstString(
    operator?.['open_id'],
    operator?.['openId'],
  );
  const openChatId = firstString(
    context['open_chat_id'],
    context['openChatId'],
    root['open_chat_id'],
    event['open_chat_id'],
  );
  const openMessageId = firstString(
    context['open_message_id'],
    context['openMessageId'],
    root['open_message_id'],
    event['open_message_id'],
  );
  return {
    ...(operatorOpenId !== '' ? { operatorOpenId } : {}),
    actionValue,
    ...(inputValue !== '' ? { inputValue } : {}),
    ...(openChatId !== '' ? { openChatId } : {}),
    ...(openMessageId !== '' ? { openMessageId } : {}),
    raw,
  };
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const FEISHU_CARD_TOP_LEVEL_KEYS = new Set([
  'schema',
  'config',
  'card_link',
  'header',
  'i18n_header',
  'elements',
  'i18n_elements',
  'fallback',
  'body',
]);

export function normalizeCardActionAck(
  value: unknown,
  logger: TransportLogger | undefined,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const root = asRecord(value);
  if (root === undefined) {
    return invalidCardActionAck(logger, { reason: 'non_object' });
  }
  const allowed = new Set(['toast', 'card']);
  const unknownTopLevel = Object.keys(root).filter((key) => !allowed.has(key));
  const toast = parseCardActionToast(root['toast']);
  if (root['toast'] !== undefined && toast === null) {
    return invalidCardActionAck(logger, {
      reason: 'invalid_toast',
      unknownTopLevel,
    });
  }
  const card = parseCardActionCard(root['card'], logger);
  if (root['card'] !== undefined && card === null) {
    return invalidCardActionAck(logger, {
      reason: 'invalid_card',
      unknownTopLevel,
    });
  }
  if (unknownTopLevel.length > 0) {
    logger?.warn(
      { unknown_keys: unknownTopLevel },
      'feishu card action response ignored unknown top-level keys',
    );
  }
  return { toast, card };
}

function parseCardActionToast(
  value: unknown,
):
  | { type: 'info' | 'success' | 'error' | 'warning'; content: string }
  | undefined
  | null {
  if (value === undefined) return undefined;
  const toast = asRecord(value);
  if (toast === undefined) return null;
  const type = toast['type'];
  const content = toast['content'];
  if (
    (type !== 'info' &&
      type !== 'success' &&
      type !== 'error' &&
      type !== 'warning') ||
    typeof content !== 'string'
  ) {
    return null;
  }
  return { type, content };
}

function parseCardActionCard(
  value: unknown,
  logger: TransportLogger | undefined,
): { type: 'raw'; data: Record<string, unknown> } | undefined | null {
  if (value === undefined) return undefined;
  const card = asRecord(value);
  if (card === undefined || card['type'] !== 'raw') return null;
  const data = asRecord(card['data']);
  if (data === undefined) return null;
  const unknownDataKeys = Object.keys(data).filter(
    (key) => !FEISHU_CARD_TOP_LEVEL_KEYS.has(key),
  );
  if (unknownDataKeys.length > 0) {
    logger?.warn(
      { unknown_keys: unknownDataKeys },
      'feishu raw card action response stripped unknown card data keys',
    );
  }
  return {
    type: 'raw',
    data: Object.fromEntries(
      Object.entries(data).filter(([key]) =>
        FEISHU_CARD_TOP_LEVEL_KEYS.has(key),
      ),
    ),
  };
}

function invalidCardActionAck(
  logger: TransportLogger | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  logger?.warn(fields, 'invalid feishu card action response');
  return {
    toast: {
      type: 'error',
      content: '卡片回调响应格式错误',
    },
  };
}
