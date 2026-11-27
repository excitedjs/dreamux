import { describe, expect, it } from 'vitest';

import {
  defaultAntigravityConfig,
  readAntigravityConfig,
} from '../src/config.js';

const FILE = 'config.json';
const PREFIX = 'agents[0].config.';

describe('readAntigravityConfig', () => {
  it('defaults to the native tmux transport', () => {
    expect(defaultAntigravityConfig()).toMatchObject({
      transport: 'tmux',
      bin: 'agy',
    });
    expect(readAntigravityConfig({}, FILE, PREFIX).transport).toBe('tmux');
  });

  it('accepts resident ACP and arbitrary non-empty model and effort strings', () => {
    expect(
      readAntigravityConfig(
        {
          transport: 'acp',
          model: 'gemini-test',
          effort: 'ultra',
          extra_args: ['--flag'],
          extra_env: { TEST_VALUE: 'value' },
        },
        FILE,
        PREFIX,
      ),
    ).toEqual({
      transport: 'acp',
      bin: 'agy',
      model: 'gemini-test',
      effort: 'ultra',
      extra_args: ['--flag'],
      extra_env: { TEST_VALUE: 'value' },
    });
  });

  it('rejects unknown transports and blank model or effort values', () => {
    expect(() =>
      readAntigravityConfig({ transport: 'headless' }, FILE, PREFIX),
    ).toThrow(/transport must be tmux or acp/);
    expect(() => readAntigravityConfig({ model: '   ' }, FILE, PREFIX)).toThrow(
      /model must be a non-empty string/,
    );
    expect(() => readAntigravityConfig({ effort: '' }, FILE, PREFIX)).toThrow(
      /effort must be a non-empty string/,
    );
  });
});
