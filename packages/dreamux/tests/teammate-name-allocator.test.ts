import { describe, it, expect } from 'vitest';

import {
  TEAMMATE_NAME_MAX,
  NAME_SUFFIX_LENGTH,
  allocateConcreteName,
  buildConcreteName,
  generateNameSuffix,
  slugifyName,
} from '../src/dispatcher-service/teammate/name-allocator.js';
import { TEAMMATE_NAME_PATTERN } from '../src/dispatcher-service/teammate/types.js';

/**
 * Unit coverage for the concrete-name allocator (issue #188): role prefixes,
 * suffix length, 64-char truncation, collision retry, and loud exhaustion.
 */
describe('TeamMate concrete-name allocation (#188)', () => {
  const never = (): boolean => false;

  it('slugifies an agent-supplied base into the name charset', () => {
    expect(slugifyName('Review The Auth Change')).toBe('review-the-auth-change');
    expect(slugifyName('  weird@@name!! ')).toBe('weird-name');
    // Junk/empty bases fall back to a non-empty slug rather than producing ''.
    expect(slugifyName('')).toBe('tm');
    expect(slugifyName('***')).toBe('tm');
    // Must start with an alphanumeric and carry no trailing separators.
    expect(slugifyName('---lead---')).toBe('lead');
  });

  it('generates an 8-char lowercase base36 suffix', () => {
    const suffix = generateNameSuffix();
    expect(suffix).toHaveLength(NAME_SUFFIX_LENGTH);
    expect(suffix).toMatch(/^[a-z0-9]{8}$/);
  });

  it('applies the role prefix and the requested-vs-team slug source', () => {
    expect(
      buildConcreteName({ role: 'teammate', base: 'reviewer', suffix: 'abcd1234' }),
    ).toBe('reviewer-abcd1234');
    expect(
      buildConcreteName({ role: 'team_member', base: 'builder', suffix: 'abcd1234' }),
    ).toBe('tm-builder-abcd1234');
    // A TeamLeader names from the team slug, not the base.
    expect(
      buildConcreteName({
        role: 'team_leader',
        base: 'ignored',
        teamSlug: 'alpha',
        suffix: 'abcd1234',
      }),
    ).toBe('tl-alpha-abcd1234');
  });

  it('truncates the slug so the whole name stays within the 64-char limit', () => {
    const longBase = 'x'.repeat(200);
    const name = buildConcreteName({
      role: 'team_member',
      base: longBase,
      suffix: 'abcd1234',
    });
    expect(name.length).toBeLessThanOrEqual(TEAMMATE_NAME_MAX);
    expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
    expect(name.startsWith('tm-')).toBe(true);
    expect(name.endsWith('-abcd1234')).toBe(true);
  });

  it('every produced name matches the TeamMate name pattern', () => {
    for (const role of ['teammate', 'team_member', 'team_leader'] as const) {
      const name = allocateConcreteName({
        role,
        base: 'My Review.Task',
        teamSlug: 'alpha',
        exists: never,
      });
      expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it('regenerates the suffix on collision and returns the first free name', () => {
    const suffixes = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'];
    let i = 0;
    const taken = new Set(['reviewer-aaaaaaaa', 'reviewer-bbbbbbbb']);
    const name = allocateConcreteName({
      role: 'teammate',
      base: 'reviewer',
      exists: (candidate) => taken.has(candidate),
      generateSuffix: () => suffixes[i++]!,
    });
    expect(name).toBe('reviewer-cccccccc');
  });

  it('fails loudly when the attempt budget is exhausted (never reuses a name)', () => {
    expect(() =>
      allocateConcreteName({
        role: 'teammate',
        base: 'reviewer',
        exists: () => true, // every candidate already taken
        generateSuffix: () => 'aaaaaaaa',
        maxAttempts: 4,
      }),
    ).toThrow(/could not allocate a unique TeamMate name after 4 attempts/);
  });
});
