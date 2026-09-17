/**
 * The one-line token summary the Feishu card appends for a neutral
 * `token.usage` activity. Formatting lives only in this display layer: the
 * runtime emits structured cumulative counters and nothing else.
 */
import { expect, it } from 'vitest';

import type { TeammateActivity } from '@excitedjs/dreamux-types';

import { tokenUsageSummary } from '../src/feishu-cot-activity.js';

type TokenUsage = Extract<TeammateActivity, { kind: 'token.usage' }>;

function event(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    kind: 'token.usage',
    event_id: 'turn-1:usage',
    input_tokens: 0,
    output_tokens: 0,
    context: null,
    redacted: false,
    ...overrides,
  };
}

it('renders context as a percentage when the runtime supplies a window', () => {
  expect(tokenUsageSummary(event({
    input_tokens: 28_568,
    output_tokens: 69,
    context: { used_tokens: 14_500, window_tokens: 29_000 },
  }))).toBe('Context usage 50% | Token usage: total=28.6k input=28.6k output=69');
});

it('renders context as the compacted used count when no window is known', () => {
  expect(tokenUsageSummary(event({
    input_tokens: 28_531,
    output_tokens: 69,
    context: { used_tokens: 14_500, window_tokens: null },
  }))).toBe('Context usage 14.5k | Token usage: total=28.6k input=28.5k output=69');
});

it('renders context as n/a when the runtime reports no context at all', () => {
  expect(tokenUsageSummary(event({ input_tokens: 10, output_tokens: 5 })))
    .toBe('Context usage n/a | Token usage: total=15 input=10 output=5');
});

it.each([
  [0, '0'], [69, '69'], [999, '999'], [1_000, '1k'], [28_637, '28.6k'],
  [999_949, '999.9k'], [999_950, '1m'], [1_450_000, '1.5m'],
  [999_950_000, '1b'], [1_250_000_000, '1.3b'],
])('compacts %i tokens as %s', (count, formatted) => {
  expect(tokenUsageSummary(event({ input_tokens: count, output_tokens: 0 })))
    .toBe(`Context usage n/a | Token usage: total=${formatted} input=${formatted} output=0`);
});
