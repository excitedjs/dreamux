/**
 * Role-gated bundled skill selection (issue #209 slice 6).
 *
 * Proves Dreamux core hands the bundled Dreamux skills ONLY to the Dispatcher
 * and TeamLeader roles, and none to ordinary teammate / team-member roles.
 */
import { dirname } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  DREAMUX_SKILL_DIR_LAYOUT,
  bundledSkillSourcesForRole,
} from '../src/agent-runtime/bundled-skill-sources.js';
import type { AgentRuntimeRole } from '../src/agent-runtime/types.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillDir,
  bundledSkillsDir,
} from '../src/platform/paths.js';

const SKILLED_ROLES: AgentRuntimeRole[] = ['dispatcher', 'team_leader'];
const UNSKILLED_ROLES: AgentRuntimeRole[] = ['teammate', 'team_member'];

describe('bundledSkillSourcesForRole', () => {
  for (const role of SKILLED_ROLES) {
    it(`gives the ${role} role every bundled skill as a skill-dir source`, () => {
      const sources = bundledSkillSourcesForRole(role);
      expect(sources.map((s) => s.name)).toEqual([...BUNDLED_SKILL_NAMES]);
      for (const source of sources) {
        expect(source.layout).toBe(DREAMUX_SKILL_DIR_LAYOUT);
        expect(source.source).toBe('dreamux-core');
        // The source path is the skill's own directory under the bundled root,
        // so a runtime can derive its engine root (codex: the shared parent).
        expect(source.path).toBe(bundledSkillDir(source.name));
        expect(source.path.startsWith(bundledSkillsDir())).toBe(true);
      }
      // The bundled skills share one parent dir — the single codex extra root.
      const parents = new Set(sources.map((s) => dirname(s.path)));
      expect([...parents]).toEqual([bundledSkillsDir()]);
    });
  }

  for (const role of UNSKILLED_ROLES) {
    it(`gives the ${role} role no bundled skills`, () => {
      expect(bundledSkillSourcesForRole(role)).toEqual([]);
    });
  }
});
