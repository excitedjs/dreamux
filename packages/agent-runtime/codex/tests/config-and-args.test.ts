import { describe, expect, it } from 'vitest';
import { RuleViolation } from '@excitedjs/dreamux-utils';
import { codexCliArgs } from '../src/args.js';
import {
  DEFAULT_CODEX_BIN,
  defaultDispatcherCodexConfig,
  readDispatcherCodexConfig,
} from '../src/config.js';

const FILE = 'config.json';
const PREFIX = 'agents[0].config.';

describe('readDispatcherCodexConfig', () => {
  it('returns aligned defaults when config is empty', () => {
    expect(defaultDispatcherCodexConfig()).toEqual({
      bin: DEFAULT_CODEX_BIN,
      model: null,
      effort: null,
      extra_args: [],
      extra_env: {},
    });
    expect(readDispatcherCodexConfig({}, FILE, PREFIX)).toEqual(
      defaultDispatcherCodexConfig(),
    );
  });

  it('reads model, effort, extra_args, and extra_env without effort allowlist', () => {
    expect(
      readDispatcherCodexConfig(
        {
          bin: '/opt/codex',
          model: 'gpt-test-model',
          effort: 'ultra',
          extra_args: ['-c', 'sandbox_mode=danger-full-access'],
          extra_env: { CODEX_HOME: '/custom/codex' },
        },
        FILE,
        PREFIX,
      ),
    ).toEqual({
      bin: '/opt/codex',
      model: 'gpt-test-model',
      effort: 'ultra',
      extra_args: ['-c', 'sandbox_mode=danger-full-access'],
      extra_env: { CODEX_HOME: '/custom/codex' },
    });
  });

  it('tolerates and ignores retired fields under R21', () => {
    expect(
      readDispatcherCodexConfig(
        {
          approval_policy: 'on-request',
          sandbox_mode: 'danger-full-access',
          initialize_timeout_ms: 25_000,
          turn_timeout_ms: 600_000,
          unknown_future_key: true,
        },
        FILE,
        PREFIX,
      ),
    ).toEqual(defaultDispatcherCodexConfig());
  });

  it('rejects blank or non-string bin, model, and effort values', () => {
    for (const bad of ['', '   ']) {
      expect(() =>
        readDispatcherCodexConfig({ bin: bad }, FILE, PREFIX),
      ).toThrow(RuleViolation);
      expect(() =>
        readDispatcherCodexConfig({ model: bad }, FILE, PREFIX),
      ).toThrow(/model must be a non-empty string/);
      expect(() =>
        readDispatcherCodexConfig({ effort: bad }, FILE, PREFIX),
      ).toThrow(/effort must be a non-empty string/);
    }
    expect(() =>
      readDispatcherCodexConfig({ model: 123 }, FILE, PREFIX),
    ).toThrow(RuleViolation);
    expect(() =>
      readDispatcherCodexConfig({ effort: true }, FILE, PREFIX),
    ).toThrow(RuleViolation);
  });
});

describe('codexCliArgs', () => {
  it('emits approval_policy=never and sandbox_mode=danger-full-access when model, effort, and extra_args are unset', () => {
    const args = codexCliArgs(defaultDispatcherCodexConfig());
    expect(args).toEqual([
      '-c',
      'approval_policy=never',
      '-c',
      'sandbox_mode=danger-full-access',
    ]);
  });

  it('emits TOML-quoted model and effort overrides ahead of extra_args so extra_args can override sandbox_mode', () => {
    const args = codexCliArgs({
      model: 'gpt-6.2/test "quoted"',
      effort: 'xhigh',
      extra_args: ['-c', 'sandbox_mode=read-only'],
    });
    expect(args).toEqual([
      '-c',
      'approval_policy=never',
      '-c',
      'sandbox_mode=danger-full-access',
      '-c',
      'model="gpt-6.2/test \\"quoted\\""',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-c',
      'sandbox_mode=read-only',
    ]);
  });
});
