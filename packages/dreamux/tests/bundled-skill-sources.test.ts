/**
 * Role-gated bundled skill roots (issue #209).
 *
 * Proves the package ships disjoint role-specific skill roots. Dispatcher and
 * TeamLeader services pass these roots directly to runtime providers; runtime
 * packages own native layout translation from those roots.
 */
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import {
  BUNDLED_SKILL_NAMES,
  bundledDispatcherSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../src/platform/paths.js';

const EXPECTED_SKILLS_BY_ROOT = {
  [bundledDispatcherSkillRoot()]: ['dispatcher-workflow', 'dreamux-maintenance'],
  [bundledTeamLeaderSkillRoot()]: ['team-workflow'],
} satisfies Record<string, string[]>;

describe('bundled Dreamux skill roots', () => {
  it('declares the shipped bundled skill names', () => {
    expect([...BUNDLED_SKILL_NAMES]).toEqual([
      'dispatcher-workflow',
      'dreamux-maintenance',
      'team-workflow',
    ]);
  });

  for (const [root, expectedSkills] of Object.entries(EXPECTED_SKILLS_BY_ROOT)) {
    it(`ships only the expected skills in ${root}`, () => {
      expect(existsSync(root)).toBe(true);
      const skillNames = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(skillNames).toEqual([...expectedSkills].sort());
      for (const skillName of skillNames) {
        expect(existsSync(join(root, skillName, 'SKILL.md'))).toBe(true);
      }
    });
  }

  it('keeps Dispatcher and TeamLeader skill roots disjoint for root-scanning runtimes', () => {
    expect(bundledDispatcherSkillRoot()).not.toBe(bundledTeamLeaderSkillRoot());
    expect(bundledDispatcherSkillRoot()).not.toContain('/team-leader');
    expect(bundledTeamLeaderSkillRoot()).not.toContain('/dispatcher');
  });
});
