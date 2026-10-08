import { describe, expect, it } from 'vitest';
import { codexVersionSatisfies, parseCodexVersion } from '../src/version.js';

describe('Codex provider version boundary', () => {
  it('parses numeric components from actual CLI version output', () => {
    expect(parseCodexVersion('codex-cli 0.135.0')).toEqual([0, 135, 0]);
    expect(parseCodexVersion('codex-cli 0.136.0')).toEqual([0, 136, 0]);
    expect(parseCodexVersion('codex-cli 0.137.0')).toEqual([0, 137, 0]);
    expect(parseCodexVersion('codex-cli 0.159.12')).toEqual([0, 159, 12]);
    expect(parseCodexVersion('codex-cli 1.0.0')).toEqual([1, 0, 0]);
  });

  it('rejects malformed and incomplete version output', () => {
    for (const output of ['', 'not a version string', 'codex-cli 0.137']) {
      expect(parseCodexVersion(output)).toBeNull();
      expect(codexVersionSatisfies(output)).toBe(false);
    }
  });

  it('enforces the supported floor with numeric component comparisons', () => {
    expect(codexVersionSatisfies('codex-cli 0.136.99')).toBe(false);
    expect(codexVersionSatisfies('codex-cli 0.137.0')).toBe(true);
    expect(codexVersionSatisfies('codex-cli 0.137.1')).toBe(true);
    expect(codexVersionSatisfies('codex-cli 0.138.0')).toBe(true);
    expect(codexVersionSatisfies('codex-cli 1.0.0')).toBe(true);
    expect(codexVersionSatisfies('codex-cli 0.99.0')).toBe(false);
  });
});
