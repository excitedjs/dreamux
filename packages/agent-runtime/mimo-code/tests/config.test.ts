import { describe, expect, it } from 'vitest';

import {
  defaultMimoCodeConfig,
  readMimoCodeConfig,
} from '../src/config.js';
import {
  buildMimoNativeConfig,
  buildMimoProcessEnv,
} from '../src/supervisor.js';

describe('MiMo Code config parsing', () => {
  it('applies safe defaults', () => {
    expect(readMimoCodeConfig({}, 'config.json', 'agents[0].config.')).toMatchObject({
      bin: 'mimo',
      model: null,
      agent: null,
      extra_env: {},
      permission_mode: 'deny',
      startup_timeout_ms: 30_000,
      turn_timeout_ms: 600_000,
      keep_home: false,
    });
  });

  it('rejects unsupported ask permission mode', () => {
    expect(() =>
      readMimoCodeConfig(
        { permission_mode: 'ask' },
        'config.json',
        'agents[0].config.',
      ),
    ).toThrow(/ask.*not supported/i);
  });

  it('rejects unsupported auto approve permission mode', () => {
    expect(() =>
      readMimoCodeConfig(
        { permission_mode: 'auto-approve' },
        'config.json',
        'agents[0].config.',
      ),
    ).toThrow(/auto-approve.*not supported/i);
  });

  it('rejects mutually exclusive native config inputs', () => {
    expect(() =>
      readMimoCodeConfig(
        { config_content: '{}', config_path: '/tmp/mimo.json' },
        'config.json',
        'agents[0].config.',
      ),
    ).toThrow(/mutually exclusive/i);
  });
});

describe('MiMo Code env shaping', () => {
  it('isolates home, disables telemetry/default inheritance, and keeps provider auth authoritative', () => {
    const config = readMimoCodeConfig(
      {
        extra_env: {
          CUSTOM: 'provider',
          MIMOCODE_ENABLE_ANALYSIS: 'true',
          MIMOCODE_SERVER_PASSWORD: 'operator',
        },
      },
      'config.json',
      'agents[0].config.',
    );
    const env = buildMimoProcessEnv({
      config,
      homeDir: '/tmp/dreamux-mimo-home',
      username: 'mimocode',
      password: 'pw',
      configPath: '/tmp/dreamux-mimo-home/config.json',
      injectEnv: { CUSTOM: 'host' },
    });

    expect(env.MIMOCODE_HOME).toBe('/tmp/dreamux-mimo-home');
    expect(env.MIMOCODE_MIMO_ONLY).toBe('true');
    expect(env.MIMOCODE_DISABLE_EXTERNAL_SKILLS).toBe('true');
    expect(env.MIMOCODE_DISABLE_DEFAULT_PLUGINS).toBe('true');
    expect(env.MIMOCODE_DISABLE_MODELS_FETCH).toBe('true');
    expect(env.MIMOCODE_DISABLE_CLAUDE_CODE_MCP).toBe('true');
    expect(env.MIMOCODE_ENABLE_ANALYSIS).toBe('false');
    expect(env.MIMOCODE_SERVER_USERNAME).toBe('mimocode');
    expect(env.MIMOCODE_SERVER_PASSWORD).toBe('pw');
    expect(env.CUSTOM).toBe('provider');
  });
});

describe('MiMo Code native config shaping', () => {
  it('maps Dreamux MCP servers to MiMo native mcp config and keeps safety fields authoritative', () => {
    const nativeConfig = JSON.parse(
      buildMimoNativeConfig(
        {
          runtimeId: 'runtime-1',
          config: {
            ...defaultMimoCodeConfig(),
            model: 'mimo/model',
            agent: 'build',
          },
          cwd: '/workspace',
          paths: {
            dispatcherDir: (id) => `/tmp/dreamux/${id}`,
            logsDir: () => '/tmp/dreamux/logs',
            runtimeSocketDirs: () => ['/tmp'],
          },
          mcpServers: [{ name: 'tool', command: 'node', args: ['tool.mjs'] }],
          systemPrompt: 'system prompt',
        },
        {
          share: 'auto',
          model: 'operator/model',
          permission: 'allow',
        },
      ),
    ) as Record<string, unknown>;

    expect(nativeConfig).toMatchObject({
      share: 'disabled',
      model: 'mimo/model',
      permission: 'deny',
      mcp: {
        tool: {
          type: 'local',
          command: ['node', 'tool.mjs'],
        },
      },
    });
    expect(nativeConfig).not.toHaveProperty('agent');
    expect(nativeConfig).not.toHaveProperty('system');
  });
});
