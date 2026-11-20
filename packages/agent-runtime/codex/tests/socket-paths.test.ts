/**
 * The two sides of this package's socket-path policy: a real app-server start
 * allocates a fresh random name every time, while the sample the doctor only
 * REPORTS is the same path on every call — the doctor renders it into its own
 * diagnostics, so two `doctor` runs over identical configuration must print
 * identical text.
 */
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allocateCodexSocketPath,
  defaultVolatileSocketPath,
  representativeCodexSocketPath,
} from '../src/internal/socket.js';

const XDG_ROOT = '/run/user/424242';
const CANDIDATES = [join(XDG_ROOT, 'dreamux', 'sockets')];

describe('Codex socket paths', () => {
  beforeEach(() => {
    vi.stubEnv('XDG_RUNTIME_DIR', XDG_ROOT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allocates a fresh random name per call in the first fitting candidate', () => {
    const first = allocateCodexSocketPath(CANDIDATES, 'flow');
    const second = allocateCodexSocketPath(CANDIDATES, 'flow');
    expect(dirname(first)).toBe(CANDIDATES[0]);
    expect(first).not.toBe(second);
  });

  it('reports the same sample twice, at a real allocation length', () => {
    const sample = representativeCodexSocketPath(CANDIDATES, 'flow');
    expect(representativeCodexSocketPath(CANDIDATES, 'flow')).toBe(sample);
    expect(dirname(sample)).toBe(CANDIDATES[0]);
    // The doctor's placement and budget verdicts are functions of the whole
    // path, so the sample must stand in at the real path's exact length.
    expect(sample.length).toBe(
      allocateCodexSocketPath(CANDIDATES, 'flow').length,
    );
  });

  it('reports the same sample from the fallback root when no candidate is supplied', () => {
    const sample = representativeCodexSocketPath([], 'flow');
    expect(representativeCodexSocketPath([], 'flow')).toBe(sample);
    expect(dirname(sample)).toBe(XDG_ROOT);
    expect(sample.length).toBe(defaultVolatileSocketPath('flow').length);
    expect(defaultVolatileSocketPath('flow')).not.toBe(
      defaultVolatileSocketPath('flow'),
    );
  });

  it('reports the last candidate without throwing when no candidate fits the budget', () => {
    const overBudget = `/${'x'.repeat(120)}`;
    const sample = representativeCodexSocketPath([overBudget], 'flow');
    expect(dirname(sample)).toBe(overBudget);
    expect(representativeCodexSocketPath([overBudget], 'flow')).toBe(sample);
  });
});
