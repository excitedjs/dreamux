/**
 * Role-gated bundled skill selection (issue #209).
 *
 * Proves Dreamux core hands neutral direct bundled skill directories ONLY to the
 * Dispatcher and TeamLeader roles. Runtime packages own native layout
 * translation from those direct directories.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import {
  bundledSkillNamesForRole,
  bundledSkillSourcesForRole,
} from '../src/agent-runtime/bundled-skill-sources.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillContainerDir,
  bundledSkillDir,
  type BundledSkillName,
} from '../src/platform/paths.js';

type TestRole = 'dispatcher' | 'team_leader' | 'teammate' | 'team_member';

const EXPECTED_SKILLS_BY_ROLE = {
  dispatcher: ['dispatcher-workflow', 'dreamux-maintenance'],
  team_leader: ['team-workflow'],
  teammate: [],
  team_member: [],
} satisfies Record<TestRole, BundledSkillName[]>;

describe('bundledSkillSourcesForRole', () => {
  it('declares the shipped bundled skill names', () => {
    expect([...BUNDLED_SKILL_NAMES]).toEqual([
      'dispatcher-workflow',
      'dreamux-maintenance',
      'team-workflow',
    ]);
  });

  for (const role of Object.keys(EXPECTED_SKILLS_BY_ROLE) as TestRole[]) {
    it(`gives the ${role} role only its role-specific bundled skills`, () => {
      const sources = bundledSkillSourcesForRole(role);
      expect(sources.map((s) => s.name)).toEqual(EXPECTED_SKILLS_BY_ROLE[role]);
      expect([...bundledSkillNamesForRole(role)]).toEqual(
        EXPECTED_SKILLS_BY_ROLE[role],
      );
      for (const source of sources) {
        expect(source.source).toBe('dreamux-core');
        expect(source.path).toBe(bundledSkillDir(source.name as BundledSkillName));
        expect(existsSync(join(source.path, 'SKILL.md'))).toBe(true);
      }
      const parents = new Set(sources.map((s) => dirname(s.path)));
      expect([...parents]).toEqual(
        sources.length === 0 ? [] : [bundledSkillContainerDir()],
      );
    });

    it(`does not emit runtime-specific layout markers for ${role}`, () => {
      expect(
        bundledSkillSourcesForRole(role).map((source) => Object.keys(source).sort()),
      ).toEqual(
        EXPECTED_SKILLS_BY_ROLE[role].map(() => ['name', 'path', 'source']),
      );
    });
  }
});
