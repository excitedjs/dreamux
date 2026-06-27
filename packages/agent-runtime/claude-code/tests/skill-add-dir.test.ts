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

describe('claudeCodeResidentArgs disableFeatures', () => {
  function argsFor(disableFeatures?: readonly string[]): string[] {
    return claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/tmp/mcp.json',
      ...(disableFeatures !== undefined ? { disableFeatures } : {}),
    });
  }

  it('maps cron to Claude Code native cron tools and ignores unknown features', () => {
    const args = argsFor(['cron', 'unknown-a', 'unknown-b']);
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('CronCreate,CronDelete,CronList');
    expect(args.filter((arg) => arg === '--disallowedTools')).toHaveLength(1);
  });

  it('maps userInterrupt to the AskUserQuestion tool', () => {
    const args = argsFor(['userInterrupt']);
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('AskUserQuestion');
  });

  it('merges every feature into a single --disallowedTools flag', () => {
    const args = argsFor(['userInterrupt', 'cron', 'unknown']);
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('AskUserQuestion,CronCreate,CronDelete,CronList');
    expect(args.filter((arg) => arg === '--disallowedTools')).toHaveLength(1);
  });

  it('does not emit disallowed tools when no known feature is requested', () => {
    expect(argsFor(undefined)).not.toContain('--disallowedTools');
    expect(argsFor([])).not.toContain('--disallowedTools');
    expect(argsFor(['unknown'])).not.toContain('--disallowedTools');
  });
});
