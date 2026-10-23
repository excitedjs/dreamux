/**
 * The Feishu channel's optional `cot` config.
 *
 * `cot.reasoning` is an operator switch that defaults to off. A config written
 * before the switch existed — or one that omits it — must keep loading exactly
 * as it did, while a value of the wrong type must fail loading rather than
 * quietly reverting what the operator meant to set. That distinction is the
 * whole contract here, so it is asserted at the provider's own reader.
 */
import { describe, expect, it } from 'vitest';

import type { ChannelConfigContext } from '@excitedjs/dreamux-types';

import {
  createFeishuChannelProvider,
  type FeishuChannelConfig,
} from '../src/provider.js';

const context: ChannelConfigContext = {
  dispatcher_id: 'disp-1',
  channel_id: 'primary',
  provider: 'builtin:feishu',
};

const provider = createFeishuChannelProvider();

async function read(raw: unknown): Promise<FeishuChannelConfig> {
  const capability = provider.config;
  if (capability === undefined) throw new Error('no config capability');
  return capability.read(raw, context);
}

function credentials(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { app_id: 'cli_test', app_secret: 'secret_test', ...extra };
}

describe('Feishu channel config — cot.reasoning', () => {
  it.each([
    { what: 'a config written before the switch existed', raw: credentials() },
    { what: 'an empty cot object', raw: credentials({ cot: {} }) },
  ])('reads $what as reasoning off', async ({ raw }) => {
    expect((await read(raw)).cot).toEqual({ reasoning: false });
  });

  it('keeps an explicit true and an explicit false', async () => {
    expect((await read(credentials({ cot: { reasoning: true } }))).cot).toEqual(
      { reasoning: true },
    );
    expect(
      (await read(credentials({ cot: { reasoning: false } }))).cot,
    ).toEqual({ reasoning: false });
  });

  it('tolerates another field inside cot', async () => {
    expect(
      (await read(credentials({ cot: { reasoning: true, future: 'ignored' } })))
        .cot,
    ).toEqual({ reasoning: true });
  });

  it.each([
    { what: 'a string cot', cot: 'on' },
    { what: 'a list cot', cot: [] },
    { what: 'a null cot', cot: null },
  ])('fails a $what', async ({ cot }) => {
    await expect(read(credentials({ cot }))).rejects.toThrow(
      /cot must be an object/,
    );
  });

  it.each([
    { what: 'a string reasoning', reasoning: 'true' },
    { what: 'a number reasoning', reasoning: 1 },
    { what: 'a null reasoning', reasoning: null },
  ])('fails a $what', async ({ reasoning }) => {
    await expect(read(credentials({ cot: { reasoning } }))).rejects.toThrow(
      /cot\.reasoning must be a boolean/,
    );
  });

  it('still refuses missing credentials when cot is present', async () => {
    await expect(read({ cot: { reasoning: true } })).rejects.toThrow(/app_id/);
  });
});
