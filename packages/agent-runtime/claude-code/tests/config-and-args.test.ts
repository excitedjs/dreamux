import { describe, expect, it } from 'vitest';
import { RuleViolation } from '@excitedjs/dreamux-utils';
import { claudeCodeResidentArgs } from '../src/args.js';
import {
  DEFAULT_CLAUDE_CODE_BIN,
  defaultDispatcherClaudeCodeConfig,
  readDispatcherClaudeCodeConfig,
} from '../src/config.js';

const FILE = 'config.json';
const PREFIX = 'agents[0].config.';

describe('readDispatcherClaudeCodeConfig', () => {
  it('returns aligned defaults when config is empty', () => {
    expect(defaultDispatcherClaudeCodeConfig()).toEqual({
      bin: DEFAULT_CLAUDE_CODE_BIN,
      model: null,
      effort: null,
      remote_control: false,
      extra_args: [],
      extra_env: {},
    });
    expect(readDispatcherClaudeCodeConfig({}, FILE, PREFIX)).toEqual(
      defaultDispatcherClaudeCodeConfig(),
    );
  });

  it('reads model, effort, remote_control, extra_args, and extra_env without effort allowlist', () => {
    expect(
      readDispatcherClaudeCodeConfig(
        {
          bin: '/opt/claude',
          model: 'opus',
          effort: 'ultra',
          remote_control: true,
          extra_args: ['--fallback-model', 'sonnet'],
          extra_env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
        },
        FILE,
        PREFIX,
      ),
    ).toEqual({
      bin: '/opt/claude',
      model: 'opus',
      effort: 'ultra',
      remote_control: true,
      extra_args: ['--fallback-model', 'sonnet'],
      extra_env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    });
  });

  it('tolerates and ignores retired fields under R21', () => {
    expect(
      readDispatcherClaudeCodeConfig(
        {
          permission_mode: 'plan',
          turn_timeout_ms: 120_000,
          unknown_future_key: 'keep-ignoring',
        },
        FILE,
        PREFIX,
      ),
    ).toEqual(defaultDispatcherClaudeCodeConfig());
  });

  it('rejects blank or non-string bin, model, and effort values', () => {
    for (const bad of ['', '   ']) {
      expect(() =>
        readDispatcherClaudeCodeConfig({ bin: bad }, FILE, PREFIX),
      ).toThrow(RuleViolation);
      expect(() =>
        readDispatcherClaudeCodeConfig({ model: bad }, FILE, PREFIX),
      ).toThrow(/model must be a non-empty string/);
      expect(() =>
        readDispatcherClaudeCodeConfig({ effort: bad }, FILE, PREFIX),
      ).toThrow(/effort must be a non-empty string/);
    }
    expect(() =>
      readDispatcherClaudeCodeConfig({ model: 42 }, FILE, PREFIX),
    ).toThrow(RuleViolation);
    expect(() =>
      readDispatcherClaudeCodeConfig({ effort: false }, FILE, PREFIX),
    ).toThrow(RuleViolation);
  });
});

describe('claudeCodeResidentArgs config flags', () => {
  it('always emits --dangerously-skip-permissions and never emits --permission-mode', () => {
    const args = claudeCodeResidentArgs({
      config: defaultDispatcherClaudeCodeConfig(),
      mcpConfigJson: '{}',
    });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('emits --model and --effort ahead of extra_args', () => {
    const args = claudeCodeResidentArgs({
      config: {
        ...defaultDispatcherClaudeCodeConfig(),
        model: 'opus',
        effort: 'high',
        extra_args: ['--effort', 'max'],
      },
      mcpConfigJson: '{}',
    });
    const modelIndex = args.indexOf('--model');
    const effortIndex = args.indexOf('--effort');
    const extraEffortIndex = args.lastIndexOf('--effort');
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe('opus');
    expect(effortIndex).toBeGreaterThan(modelIndex);
    expect(args[effortIndex + 1]).toBe('high');
    expect(extraEffortIndex).toBeGreaterThan(effortIndex);
    expect(args[extraEffortIndex + 1]).toBe('max');
  });
});
