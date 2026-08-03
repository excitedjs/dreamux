/**
 * Role-gated bundled skill roots (issue #209).
 *
 * Proves the package ships disjoint role-specific skill roots. Dispatcher and
 * TeamLeader services pass these roots directly to runtime providers; runtime
 * packages own native layout translation from those roots.
 */
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  BUNDLED_SKILL_NAMES,
  bundledDispatcherSkillRoot,
  bundledSharedSkillRoot,
  bundledTeamLeaderSkillRoot,
} from '../src/platform/paths.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const EXPECTED_SKILLS_BY_ROOT = {
  [bundledDispatcherSkillRoot()]: ['dispatcher-workflow', 'dreamux-maintenance'],
  [bundledTeamLeaderSkillRoot()]: ['team-workflow'],
  [bundledSharedSkillRoot()]: ['workflow'],
} satisfies Record<string, string[]>;

describe('bundled Dreamux skill roots', () => {
  it('declares the shipped bundled skill names', () => {
    expect([...BUNDLED_SKILL_NAMES]).toEqual([
      'dispatcher-workflow',
      'dreamux-maintenance',
      'team-workflow',
      'workflow',
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
    expect(bundledSharedSkillRoot()).not.toBe(bundledDispatcherSkillRoot());
    expect(bundledSharedSkillRoot()).not.toBe(bundledTeamLeaderSkillRoot());
    expect(bundledDispatcherSkillRoot()).not.toContain('/team-leader');
    expect(bundledTeamLeaderSkillRoot()).not.toContain('/dispatcher');
  });

  it('documents role-specific plus shared workflow injection and name protection', () => {
    const documents = [
      readFileSync(join(REPO_ROOT, 'packages/dreamux/README.md'), 'utf8'),
      readFileSync(join(REPO_ROOT, '.agents/reference/dispatcher-skill.md'), 'utf8'),
    ];

    for (const document of documents) {
      for (const roleSkill of [
        'dispatcher-workflow',
        'dreamux-maintenance',
        'team-workflow',
      ]) {
        expect(document).toContain(roleSkill);
      }
      expect(document).toMatch(
        /both[\s\S]{0,100}(?:shared )?`workflow`|shared `workflow`[\s\S]{0,100}both/,
      );
      expect(document).toMatch(
        /required-source[\s\S]{0,180}`workflow`[\s\S]{0,100}(?:shadow|custom)/,
      );
    }
  });
});
