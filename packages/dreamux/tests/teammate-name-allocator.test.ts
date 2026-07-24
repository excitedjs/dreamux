import { describe, it, expect } from 'vitest';

import {
  CONCRETE_NAME_MAX,
  NAME_SUFFIX_MAX_LENGTH,
  NAME_SUFFIX_MIN_LENGTH,
  allocateConcreteName,
  buildConcreteName,
  generateNameSuffix,
  slugifyName,
} from '../src/service/name-allocator.js';
import {
  assertNotReservedAgentName,
  TEAMMATE_NAME_PATTERN,
} from '../src/service/agent-entity/types.js';

/**
 * Unit coverage for the concrete-name allocator (issue #188): role prefixes,
 * suffix length, 64-char truncation, collision retry, and loud exhaustion.
 */
describe('Team and TeamMate concrete-name allocation (#188)', () => {
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

  it('generates a 4-8 char lowercase base36 suffix', () => {
    for (let sample = 0; sample < 32; sample += 1) {
      const suffix = generateNameSuffix();
      expect(suffix.length).toBeGreaterThanOrEqual(
        NAME_SUFFIX_MIN_LENGTH,
      );
      expect(suffix.length).toBeLessThanOrEqual(
        NAME_SUFFIX_MAX_LENGTH,
      );
      expect(suffix).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('uses both 4- and 8-char endpoints for every generated name kind', () => {
    for (const kind of [
      'team',
      'teammate',
      'team_member',
      'team_leader',
    ] as const) {
      for (const suffix of ['a1b2', 'abcd1234']) {
        const name = allocateConcreteName({
          kind,
          base: 'reviewer',
          teamSlug: 'alpha',
          exists: never,
          generateSuffix: () => suffix,
        });
        expect(name).toMatch(new RegExp(`-${suffix}$`));
        expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
      }
    }
  });

  it('applies the role prefix and the requested-vs-team slug source', () => {
    expect(
      buildConcreteName({ kind: 'teammate', base: 'reviewer', suffix: 'abcd' }),
    ).toBe('reviewer-abcd');
    expect(
      buildConcreteName({ kind: 'team', base: 'reviewers', suffix: 'abcde' }),
    ).toBe('reviewers-abcde');
    expect(
      buildConcreteName({ kind: 'team_member', base: 'builder', suffix: 'abcd1234' }),
    ).toBe('tm-builder-abcd1234');
    // A TeamLeader names from the team slug, not the base.
    expect(
      buildConcreteName({
        kind: 'team_leader',
        base: 'ignored',
        teamSlug: 'alpha',
        suffix: 'abcd1234',
      }),
    ).toBe('tl-alpha-abcd1234');
  });

  it('truncates the slug at both suffix endpoints to the 64-char limit', () => {
    const longBase = 'x'.repeat(200);
    for (const suffix of ['a1b2', 'abcd1234']) {
      const name = buildConcreteName({
        kind: 'team_member',
        base: longBase,
        suffix,
      });
      expect(name).toHaveLength(CONCRETE_NAME_MAX);
      expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
      expect(name.startsWith('tm-')).toBe(true);
      expect(name.endsWith(`-${suffix}`)).toBe(true);
    }
  });

  it('every produced name matches the TeamMate name pattern', () => {
    for (
      const kind of ['team', 'teammate', 'team_member', 'team_leader'] as const
    ) {
      const name = allocateConcreteName({
        kind,
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
      kind: 'teammate',
      base: 'reviewer',
      exists: (candidate) => taken.has(candidate),
      generateSuffix: () => suffixes[i++]!,
    });
    expect(name).toBe('reviewer-cccccccc');
  });

  it('fails loudly when the attempt budget is exhausted (never reuses a name)', () => {
    expect(() =>
      allocateConcreteName({
        kind: 'teammate',
        base: 'reviewer',
        exists: () => true, // every candidate already taken
        generateSuffix: () => 'aaaaaaaa',
        maxAttempts: 4,
      }),
    ).toThrow(/could not allocate a unique teammate name after 4 attempts/);
  });

  it('reserves dispatcher as an ordinary agent or team name', () => {
    expect(() => assertNotReservedAgentName('dispatcher')).toThrow(/reserved/);
    expect(() => assertNotReservedAgentName('Dispatcher')).toThrow(/reserved/);
  });
});
