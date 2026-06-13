/**
 * Role-gated skill `--add-dir` mapping (issue #209 slice 6).
 *
 * Pure args-translation tests: claude-code turns add-dir-compatible skill
 * sources into `--add-dir <path>` flags and ignores incompatible layouts (e.g.
 * the bundled Dreamux `skill-dir` sources, which feed codex only). No live
 * `claude` binary and no filesystem access.
 */
import { describe, it, expect } from 'vitest';

import {
  CLAUDE_SKILLS_PARENT_LAYOUT,
  claudeCodeResidentArgs,
  claudeCodeSkillAddDirArgs,
} from '../src/args.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';
import type { AgentRuntimeSkillSource } from '@excitedjs/dreamux-types';

function compatible(path: string): AgentRuntimeSkillSource {
  return { name: path.split('/').pop()!, path, layout: CLAUDE_SKILLS_PARENT_LAYOUT, source: 'ext' };
}
function skillDir(path: string): AgentRuntimeSkillSource {
  return { name: path.split('/').pop()!, path, layout: 'skill-dir', source: 'dreamux-core' };
}

describe('claudeCodeSkillAddDirArgs', () => {
  it('emits one --add-dir per compatible source, deduped in order', () => {
    expect(
      claudeCodeSkillAddDirArgs([
        compatible('/ext/a'),
        compatible('/ext/b'),
        compatible('/ext/a'),
      ]),
    ).toEqual(['--add-dir', '/ext/a', '--add-dir', '/ext/b']);
  });

  it('ignores bundled skill-dir sources (claude-incompatible layout)', () => {
    expect(
      claudeCodeSkillAddDirArgs([
        skillDir('/pkg/skills/dispatcher'),
        skillDir('/pkg/skills/dreamux-maintenance'),
      ]),
    ).toEqual([]);
  });

  it('treats undefined/empty as no flags', () => {
    expect(claudeCodeSkillAddDirArgs(undefined)).toEqual([]);
    expect(claudeCodeSkillAddDirArgs([])).toEqual([]);
  });
});

describe('claudeCodeResidentArgs --add-dir', () => {
  it('threads compatible skill add-dirs into the resident argv', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/tmp/mcp.json',
      skillSources: [compatible('/ext/team-skills')],
    });
    const i = args.indexOf('--add-dir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/ext/team-skills');
  });

  it('emits no --add-dir for the bundled skill-dir sources', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/tmp/mcp.json',
      skillSources: [skillDir('/pkg/skills/dispatcher')],
    });
    expect(args).not.toContain('--add-dir');
  });
});
