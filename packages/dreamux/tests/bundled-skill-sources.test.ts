/**
 * Role-gated bundled skill selection (issue #209).
 *
 * Proves Dreamux core hands the bundled Dreamux skills ONLY to the Dispatcher
 * and TeamLeader roles, and that the selection carries BOTH engine views of the
 * same on-disk skills: per-skill `skill-dir` sources for Codex AND a single
 * `claude-skills-parent` source for Claude Code, so Claude Code emits a real
 * `--add-dir` instead of filtering the bundled skills to zero. Ordinary
 * teammate / team-member roles receive none.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import {
  DREAMUX_BUNDLED_CLAUDE_PARENT_NAME,
  DREAMUX_CLAUDE_SKILLS_PARENT_LAYOUT,
  DREAMUX_SKILL_DIR_LAYOUT,
  bundledSkillSourcesForRole,
} from '../src/agent-runtime/bundled-skill-sources.js';
import type { AgentRuntimeRole } from '../src/agent-runtime/types.js';
import {
  BUNDLED_SKILL_NAMES,
  bundledSkillContainerDir,
  bundledSkillDir,
  bundledSkillsDir,
} from '../src/platform/paths.js';
import {
  CLAUDE_SKILLS_PARENT_LAYOUT,
  claudeCodeSkillAddDirArgs,
} from '@excitedjs/agent-runtime-claude-code';

const SKILLED_ROLES: AgentRuntimeRole[] = ['dispatcher', 'team_leader'];
const UNSKILLED_ROLES: AgentRuntimeRole[] = ['teammate', 'team_member'];

describe('bundledSkillSourcesForRole', () => {
  it('keeps the core claude-parent layout literal in sync with the claude-code package', () => {
    expect(DREAMUX_CLAUDE_SKILLS_PARENT_LAYOUT).toBe(CLAUDE_SKILLS_PARENT_LAYOUT);
  });

  for (const role of SKILLED_ROLES) {
    it(`gives the ${role} role every bundled skill as a codex skill-dir source`, () => {
      const codex = bundledSkillSourcesForRole(role).filter(
        (s) => s.layout === DREAMUX_SKILL_DIR_LAYOUT,
      );
      expect(codex.map((s) => s.name)).toEqual([...BUNDLED_SKILL_NAMES]);
      for (const source of codex) {
        expect(source.source).toBe('dreamux-core');
        expect(source.path).toBe(bundledSkillDir(source.name));
      }
      // The bundled skills share one parent dir — the single codex extra root —
      // which is the `.claude/skills` container.
      const parents = new Set(codex.map((s) => dirname(s.path)));
      expect([...parents]).toEqual([bundledSkillContainerDir()]);
    });

    it(`gives the ${role} role a single claude add-dir parent that yields a real --add-dir`, () => {
      const sources = bundledSkillSourcesForRole(role);
      const claudeParents = sources.filter(
        (s) => s.layout === DREAMUX_CLAUDE_SKILLS_PARENT_LAYOUT,
      );
      expect(claudeParents).toHaveLength(1);
      const parent = claudeParents[0]!;
      expect(parent.name).toBe(DREAMUX_BUNDLED_CLAUDE_PARENT_NAME);
      expect(parent.source).toBe('dreamux-core');
      expect(parent.path).toBe(bundledSkillsDir());

      // The claude-code package translates it into a real --add-dir flag (no
      // filtering to zero).
      expect(claudeCodeSkillAddDirArgs(sources)).toEqual([
        '--add-dir',
        bundledSkillsDir(),
      ]);

      // And the on-disk add-dir parent genuinely contains the discoverable
      // `.claude/skills/<name>/SKILL.md` tree the flag points Claude Code at,
      // from the SHIPPED package layout (guards against packaging drift).
      for (const name of BUNDLED_SKILL_NAMES) {
        expect(
          existsSync(join(parent.path, '.claude', 'skills', name, 'SKILL.md')),
        ).toBe(true);
      }
    });
  }

  for (const role of UNSKILLED_ROLES) {
    it(`gives the ${role} role no bundled skills`, () => {
      expect(bundledSkillSourcesForRole(role)).toEqual([]);
    });
  }
});
