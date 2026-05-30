/**
 * PR0 scaffold smoke test: the package builds, exposes its marker, and the
 * channel → core dependency edge resolves. Real behavior tests land later.
 */

import { describe, it, expect } from 'vitest';

import { FEISHU_CHANNEL_PACKAGE, FEISHU_TRANSPORT_PACKAGE } from '../src/index.js';

describe('@excitedjs/feishu-channel scaffold', () => {
  it('exposes its package marker', () => {
    expect(FEISHU_CHANNEL_PACKAGE).toBe('@excitedjs/feishu-channel');
  });

  it('re-exports the core marker (channel → core dependency resolves)', () => {
    expect(FEISHU_TRANSPORT_PACKAGE).toBe('@excitedjs/feishu-transport');
  });
});
