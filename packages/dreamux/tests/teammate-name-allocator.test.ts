import { describe, it, expect } from 'vitest';

import {
  CONCRETE_NAME_MAX,
  NAME_SUFFIX_MAX_LENGTH,
  NAME_SUFFIX_MIN_LENGTH,
  allocateConcreteName,
  buildConcreteName,
  generateNameSuffix,
  slugifyName,
  type ConcreteNameKind,
} from '../src/service/name-allocator.js';
import {
  assertNotReservedAgentName,
  TEAMMATE_NAME_PATTERN,
} from '../src/service/agent-entity/types.js';

/**
 * Unit coverage for the concrete-name allocator (issue #188, revised by the
 * minimize-provider-boundaries refactor): role prefixes, suffix length, 64-char
 * truncation, collision retry, and loud exhaustion.
 *
 * `ConcreteNameKind` is now `'team' | 'team-leader' | 'team-teammate' |
 * 'dispatcher-teammate'` (src/service/name-allocator.ts). The old
 * `'team_member'` / `'team_leader'` (underscore) kinds and the `tm-` prefix on
 * a bare `'teammate'` kind belonged to the retired `role`/`team_member`
 * vocabulary the minimize-provider-boundaries refactor deleted — see
 * `.agents/tasks/architecture/minimize-provider-boundaries/README.md` (failure-ledger vocabulary item)
 * ("`team_member` is deleted from persisted types, internal vocabulary, and
 * public surfaces"). This suite asserts the CURRENT kind set and prefix rules
 * only; it must never reintroduce the deleted vocabulary.
 */
describe('Team and TeamMate concrete-name allocation', () => {
  const never = (): boolean => false;
  const ALL_KINDS: readonly ConcreteNameKind[] = [
    'team',
    'team-leader',
    'team-teammate',
    'dispatcher-teammate',
  ];

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
      expect(suffix.length).toBeGreaterThanOrEqual(NAME_SUFFIX_MIN_LENGTH);
      expect(suffix.length).toBeLessThanOrEqual(NAME_SUFFIX_MAX_LENGTH);
      expect(suffix).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('uses both 4- and 8-char suffix endpoints for every current name kind', () => {
    for (const kind of ALL_KINDS) {
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

  it('applies the current role prefix: none for team/dispatcher-teammate, tm-/tl- for the rest', () => {
    // A dispatcher-scoped TeamMate carries no prefix at all.
    expect(
      buildConcreteName({ kind: 'dispatcher-teammate', base: 'reviewer', suffix: 'abcd' }),
    ).toBe('reviewer-abcd');
    // A Team's own name carries no prefix either.
    expect(
      buildConcreteName({ kind: 'team', base: 'reviewers', suffix: 'abcde' }),
    ).toBe('reviewers-abcde');
    // A Team-scoped TeamMate is durably tagged `tm-` (the durable address, not
    // a description of the retired `team_member` role vocabulary).
    expect(
      buildConcreteName({ kind: 'team-teammate', base: 'builder', suffix: 'abcd1234' }),
    ).toBe('tm-builder-abcd1234');
    // A TeamLeader names from the team slug (with `tl-`), not the base.
    expect(
      buildConcreteName({
        kind: 'team-leader',
        base: 'ignored',
        teamSlug: 'alpha',
        suffix: 'abcd1234',
      }),
    ).toBe('tl-alpha-abcd1234');
  });

  it('a team-leader falls back to the base when no teamSlug is supplied', () => {
    expect(
      buildConcreteName({ kind: 'team-leader', base: 'fallback-base', suffix: 'abcd' }),
    ).toBe('tl-fallback-base-abcd');
  });

  it('truncates the slug at both suffix endpoints to the 64-char limit', () => {
    const longBase = 'x'.repeat(200);
    for (const suffix of ['a1b2', 'abcd1234']) {
      const name = buildConcreteName({
        kind: 'team-teammate',
        base: longBase,
        suffix,
      });
      expect(name).toHaveLength(CONCRETE_NAME_MAX);
      expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
      expect(name.startsWith('tm-')).toBe(true);
      expect(name.endsWith(`-${suffix}`)).toBe(true);
    }
  });

  it('truncates a prefix-free kind (team) at both suffix endpoints too', () => {
    const longBase = 'y'.repeat(200);
    for (const suffix of ['a1b2', 'abcd1234']) {
      const name = buildConcreteName({ kind: 'team', base: longBase, suffix });
      expect(name).toHaveLength(CONCRETE_NAME_MAX);
      expect(TEAMMATE_NAME_PATTERN.test(name)).toBe(true);
      expect(name.endsWith(`-${suffix}`)).toBe(true);
    }
  });

  it('every produced name matches the TeamMate name pattern', () => {
    for (const kind of ALL_KINDS) {
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
      kind: 'dispatcher-teammate',
      base: 'reviewer',
      exists: (candidate) => taken.has(candidate),
      generateSuffix: () => suffixes[i++]!,
    });
    expect(name).toBe('reviewer-cccccccc');
  });

  it('fails loudly when the attempt budget is exhausted (never reuses a name)', () => {
    expect(() =>
      allocateConcreteName({
        kind: 'dispatcher-teammate',
        base: 'reviewer',
        exists: () => true, // every candidate already taken
        generateSuffix: () => 'aaaaaaaa',
        maxAttempts: 4,
      }),
    ).toThrow(/could not allocate a unique dispatcher-teammate name after 4 attempts/);
  });

  it('reserves dispatcher as an ordinary agent or team name', () => {
    expect(() => assertNotReservedAgentName('dispatcher')).toThrow(/reserved/);
    expect(() => assertNotReservedAgentName('Dispatcher')).toThrow(/reserved/);
  });

  it('never produces the retired tm- prefix for a bare "teammate" or "team_member" kind', () => {
    // The allocator's ConcreteNameKind type no longer has a member spelled
    // 'teammate' or 'team_member' at all -- this is a runtime companion to
    // that compile-time fact: an arbitrary unknown-kind string (as could arrive
    // through an `as` cast at a call site) is not silently accepted as a valid
    // Team-scoped-TeamMate/dispatcher-TeamMate/TeamLeader alias, it falls
    // through to the neutral (no-prefix) branch instead of resurrecting `tm-`
    // for a spelling that isn't `team-teammate`.
    const name = buildConcreteName({
      kind: 'team_member' as unknown as ConcreteNameKind,
      base: 'builder',
      suffix: 'abcd',
    });
    expect(name.startsWith('tm-')).toBe(false);
    expect(name).toBe('builder-abcd');
  });
});
