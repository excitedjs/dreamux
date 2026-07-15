import { describe, expect, it } from 'vitest';

import * as feishuChannel from '../src/index.js';

// @ts-expect-error -- test doubles must not return to the published package API.
export type RemovedFakeFeishuBotMustStayUnexported =
  import('../src/index.js').FakeFeishuBot;

describe('@excitedjs/feishu-channel public API', () => {
  it('does not export the test-only fake bot factory', () => {
    expect(Object.hasOwn(feishuChannel, 'createFakeFeishuBot')).toBe(false);
  });
});
