import { describe, expect, it } from 'vitest';

import {
  antigravityVersionSatisfies,
  MIN_ANTIGRAVITY_VERSION,
} from '../src/version.js';

describe('antigravityVersionSatisfies', () => {
  it('accepts the native baseline and later versions', () => {
    expect(MIN_ANTIGRAVITY_VERSION).toBe('1.5.15');
    expect(antigravityVersionSatisfies('1.5.15')).toBe(true);
    expect(antigravityVersionSatisfies('agy 1.6.0')).toBe(true);
    expect(antigravityVersionSatisfies('2.0.0')).toBe(true);
  });

  it('rejects older or unreported versions', () => {
    expect(antigravityVersionSatisfies('1.5.14')).toBe(false);
    expect(antigravityVersionSatisfies('unknown')).toBe(false);
  });
});
