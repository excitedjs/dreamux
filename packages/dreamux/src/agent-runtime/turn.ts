/**
 * Shared inbound-turn contract types.
 *
 * The data shapes are published by `@excitedjs/dreamux-types`; this module
 * re-exports them so existing in-repo imports from `../agent-runtime/turn.js`
 * stay stable (issue #209), and keeps the runtime helpers (`renderChannelInput`,
 * the dedupe-window constant) here because they are executable code, not
 * declarations.
 */

import type { InboundTurnInput } from '@excitedjs/dreamux-types';

export type {
  InboundAttachment,
  InboundTurnInput,
  InboundDeliveryResult,
  NoticeInjectionResult,
  InboundDeliveryHooks,
  TurnSettledSignal,
} from '@excitedjs/dreamux-types';

export const DEFAULT_MESSAGE_ID_DEDUPE_WINDOW = 1024;

const SAFE_CHANNEL_ATTR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeChannelAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Wrap a channel turn body in the native `<channel source="…" …>` envelope —
 * the shape claude-code emits for MCP channel messages. Mirrors claude-code's
 * `wrapChannelMessage`: only safe attribute keys (`^[a-zA-Z_][a-zA-Z0-9_]*$`)
 * are rendered and every value is XML-escaped. Lives in the neutral turn
 * contract so both builtins reuse it without a cross-builtin import.
 */
export function renderChannelBlock(
  source: string,
  attrs: ReadonlyArray<readonly [string, string]>,
  body: string,
): string {
  const rendered = attrs
    .filter(([key]) => SAFE_CHANNEL_ATTR_KEY.test(key))
    .map(([key, value]) => ` ${key}="${escapeChannelAttr(value)}"`)
    .join('');
  return `<channel source="${escapeChannelAttr(source)}"${rendered}>\n${body}\n</channel>`;
}

/**
 * Render an inbound turn to delivery text. A channel-structured input (both
 * `attrs` and `body` present) is wrapped into the runtime-owned `<channel>`
 * block; a plain input (e.g. a system trigger turn) passes its `text` through
 * unchanged.
 */
export function renderChannelInput(input: InboundTurnInput): string {
  if (input.attrs === undefined || input.body === undefined) {
    return input.text;
  }
  return renderChannelBlock(input.source ?? 'channel', input.attrs, input.body);
}
