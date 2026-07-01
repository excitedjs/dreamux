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

import { bundledSkillSourcesForRole } from '../src/agent-runtime/bundled-skill-sources.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillContainerDir,
  bundledSkillDir,
  type BundledSkillName,
} from '../src/platform/paths.js';

type TestRole = 'dispatcher' | 'team_leader' | 'teammate' | 'team_member';

const SKILLED_ROLES: TestRole[] = ['dispatcher', 'team_leader'];
const UNSKILLED_ROLES: TestRole[] = ['teammate', 'team_member'];

describe('bundledSkillSourcesForRole', () => {
  for (const role of SKILLED_ROLES) {
    it(`gives the ${role} role every bundled skill as a direct skill directory`, () => {
      const sources = bundledSkillSourcesForRole(role);
      expect(sources.map((s) => s.name)).toEqual([...BUNDLED_SKILL_NAMES]);
      for (const source of sources) {
        expect(source.source).toBe('dreamux-core');
        expect(source.path).toBe(bundledSkillDir(source.name as BundledSkillName));
        expect(existsSync(join(source.path, 'SKILL.md'))).toBe(true);
      }
      const parents = new Set(sources.map((s) => dirname(s.path)));
      expect([...parents]).toEqual([bundledSkillContainerDir()]);
    });

    it(`does not emit runtime-specific layout markers for ${role}`, () => {
      expect(
        bundledSkillSourcesForRole(role).map((source) => Object.keys(source).sort()),
      ).toEqual(
        BUNDLED_SKILL_NAMES.map(() => ['name', 'path', 'source']),
      );
    });
  }

  for (const role of UNSKILLED_ROLES) {
    it(`gives the ${role} role no bundled skills`, () => {
      expect(bundledSkillSourcesForRole(role)).toEqual([]);
    });
  }
});
