/**
 * PR0 scaffold smoke test: the package builds and exposes its marker.
 * Real behavior tests land with the ported logic in PR1.
 */

import { describe, it, expect } from 'vitest';

import { FEISHU_TRANSPORT_PACKAGE } from '../src/index.js';

describe('@excitedjs/feishu-transport scaffold', () => {
  it('exposes its package marker', () => {
    expect(FEISHU_TRANSPORT_PACKAGE).toBe('@excitedjs/feishu-transport');
  });
});
