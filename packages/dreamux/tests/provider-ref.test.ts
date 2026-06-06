import { describe, expect, it } from 'vitest';

import {
  InvalidProviderRefError,
  formatProviderRef,
  isBuiltinRef,
  parseProviderRef,
  type ProviderRef,
} from '../src/registry/provider-ref.js';

describe('parseProviderRef — builtin', () => {
  it('parses a builtin id', () => {
    const ref = parseProviderRef('builtin:feishu');
    expect(ref).toEqual({ source: 'builtin', id: 'feishu', raw: 'builtin:feishu' });
  });

  it('parses a kebab-case builtin id', () => {
    const ref = parseProviderRef('builtin:claude-code');
    expect(ref).toMatchObject({ source: 'builtin', id: 'claude-code' });
  });

  it('rejects a builtin ref with an export', () => {
    expect(() => parseProviderRef('builtin:feishu#x')).toThrow(InvalidProviderRefError);
  });

  it('rejects an empty builtin id', () => {
    expect(() => parseProviderRef('builtin:')).toThrow(InvalidProviderRefError);
  });

  it('rejects an uppercase / invalid builtin id', () => {
    expect(() => parseProviderRef('builtin:Feishu')).toThrow(InvalidProviderRefError);
    expect(() => parseProviderRef('builtin:-bad')).toThrow(InvalidProviderRefError);
  });
});

describe('parseProviderRef — npm (reserved syntax)', () => {
  it('parses an unscoped package', () => {
    const ref = parseProviderRef('npm:some-provider');
    expect(ref).toEqual({
      source: 'npm',
      package: 'some-provider',
      export: null,
      raw: 'npm:some-provider',
    });
  });

  it('parses a scoped package', () => {
    const ref = parseProviderRef('npm:@example/dreamux-provider');
    expect(ref).toMatchObject({
      source: 'npm',
      package: '@example/dreamux-provider',
      export: null,
    });
  });

  it('parses a scoped package with a named export', () => {
    const ref = parseProviderRef('npm:@example/dreamux-provider#feishuLikeChannel');
    expect(ref).toEqual({
      source: 'npm',
      package: '@example/dreamux-provider',
      export: 'feishuLikeChannel',
      raw: 'npm:@example/dreamux-provider#feishuLikeChannel',
    });
  });

  it('rejects an empty package', () => {
    expect(() => parseProviderRef('npm:')).toThrow(InvalidProviderRefError);
    expect(() => parseProviderRef('npm:#export')).toThrow(InvalidProviderRefError);
  });

  it('rejects a malformed scope', () => {
    expect(() => parseProviderRef('npm:@/name')).toThrow(InvalidProviderRefError);
  });

  it('rejects a non-identifier export', () => {
    expect(() => parseProviderRef('npm:pkg#not-an-identifier')).toThrow(
      InvalidProviderRefError,
    );
  });
});

describe('parseProviderRef — malformed', () => {
  it('rejects an empty string', () => {
    expect(() => parseProviderRef('')).toThrow(InvalidProviderRefError);
  });

  it('rejects a missing scheme separator', () => {
    expect(() => parseProviderRef('feishu')).toThrow(InvalidProviderRefError);
  });

  it('rejects a leading separator', () => {
    expect(() => parseProviderRef(':feishu')).toThrow(InvalidProviderRefError);
  });

  it('rejects an unknown source', () => {
    expect(() => parseProviderRef('file:./local')).toThrow(InvalidProviderRefError);
  });

  it('carries the offending ref on the error', () => {
    try {
      parseProviderRef('bogus');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProviderRefError);
      expect((err as InvalidProviderRefError).ref).toBe('bogus');
    }
  });
});

describe('formatProviderRef / isBuiltinRef', () => {
  it('round-trips canonical strings', () => {
    for (const raw of [
      'builtin:codex',
      'npm:some-provider',
      'npm:@example/dreamux-provider#named',
    ]) {
      expect(formatProviderRef(parseProviderRef(raw))).toBe(raw);
    }
  });

  it('distinguishes builtin from external refs', () => {
    const builtin: ProviderRef = parseProviderRef('builtin:feishu');
    const external: ProviderRef = parseProviderRef('npm:pkg');
    expect(isBuiltinRef(builtin)).toBe(true);
    expect(isBuiltinRef(external)).toBe(false);
  });
});
