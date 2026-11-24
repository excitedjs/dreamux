import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveAntigravityNativeRoots } from '../src/paths.js';

describe('resolveAntigravityNativeRoots', () => {
  it('uses the host home when HOME is empty', () => {
    expect(resolveAntigravityNativeRoots({ HOME: '' }).geminiHome).toBe(
      join(homedir(), '.gemini'),
    );
  });

  it('honors an explicit native home', () => {
    expect(
      resolveAntigravityNativeRoots({ HOME: '/native-home' }).geminiHome,
    ).toBe(join('/native-home', '.gemini'));
  });
});
