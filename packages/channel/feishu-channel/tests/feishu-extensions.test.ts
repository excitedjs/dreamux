/**
 * The Feishu plugin's factory: a zero-argument default export whose api is
 * typed for other plugins that tap the `feishu` augmentation.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ServerHost } from '@excitedjs/dreamux-types';

import feishuPluginFactory, { type FeishuApi } from '../src/index.js';

describe('the Feishu plugin', () => {
  it('is a zero-argument default factory named feishu whose api is typed for other plugins', () => {
    const plugin = feishuPluginFactory();
    expect(plugin.name).toBe('feishu');
    expect(plugin.api).toBeDefined();

    // Type-level: the augmentation types `for('feishu')` as FeishuApi.
    const typed = (host: ServerHost): void => {
      host.hooks.plugin.for('feishu').tap('alpha', (api) => {
        expectTypeOf(api).toEqualTypeOf<FeishuApi>();
      });
      // @ts-expect-error -- no plugin api is declared under this name.
      host.hooks.plugin.for('missing');
    };
    void typed;
  });
});
