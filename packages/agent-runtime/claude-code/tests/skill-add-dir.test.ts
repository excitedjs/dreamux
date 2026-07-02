/**
 * Runtime-owned skill `--add-dir` mapping (issue #209 slice 6).
 *
 * Pure args-translation tests: claude-code turns runtime-owned add-dir roots
 * into `--add-dir <path>` flags. Materializing those roots from neutral skill
 * sources belongs to the runtime lifecycle tests.
 */
import { describe, it, expect } from 'vitest';

import {
  claudeCodeResidentArgs,
  claudeCodeSkillAddDirArgs,
} from '../src/args.js';
import { defaultDispatcherClaudeCodeConfig } from '../src/config.js';

describe('claudeCodeSkillAddDirArgs', () => {
  it('emits one --add-dir per runtime-owned root, deduped in order', () => {
    expect(
      claudeCodeSkillAddDirArgs([
        '/runtime/claude-skills-a',
        '/runtime/claude-skills-b',
        '/runtime/claude-skills-a',
      ]),
    ).toEqual([
      '--add-dir',
      '/runtime/claude-skills-a',
      '--add-dir',
      '/runtime/claude-skills-b',
    ]);
  });

  it('treats undefined/empty as no flags', () => {
    expect(claudeCodeSkillAddDirArgs(undefined)).toEqual([]);
    expect(claudeCodeSkillAddDirArgs([])).toEqual([]);
  });
});

describe('claudeCodeResidentArgs --add-dir', () => {
  it('threads runtime-owned skill add-dirs into the resident argv', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/tmp/mcp.json',
      skillAddDirs: ['/runtime/team-skills'],
    });
    const i = args.indexOf('--add-dir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/runtime/team-skills');
  });

  it('emits no --add-dir when no runtime-owned skill add-dir exists', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigPath: '/tmp/mcp.json',
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
