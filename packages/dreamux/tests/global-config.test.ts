import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILT_IN_DEFAULTS,
  DEFAULT_CONFIG_JSON,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadConfig,
  loadOrInitConfig,
  redactConfigForDisplay,
  stringifyConfig,
} from '../src/runtime/config.js';
import {
  adminSocketPath,
  resetRuntimeConfig,
  runtimeRoot,
  serverJsonPath,
  setRuntimeConfig,
  stateRoot,
} from '../src/runtime/paths.js';
import { codexArgsToCli, parseCodexArgs } from '../src/runtime/codex-args.js';

function writeConfigObjectAt(configDir: string, value: unknown): void {
  writeFileSync(globalConfigFile({ configDir }), JSON.stringify(value), {
    mode: 0o600,
  });
}

describe('global config (~/.dreamux/config.json)', () => {
  let configDir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-cfg-'));
    for (const k of [
      'CODEX_HOST_RUNTIME_DIR',
      'CODEX_HOST_ADMIN_SOCKET',
      'CODEX_HOST_CODEX_BIN',
      'DREAMUX_CONFIG_DIR',
    ]) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });

  function writeConfigObject(value: unknown): void {
    writeConfigObjectAt(configDir, value);
  }

  function writeConfigText(file: string, content: string, mode = 0o600): void {
    writeFileSync(file, content, { mode });
  }

  it('first boot creates the config dir and JSON file', () => {
    expect(existsSync(join(configDir, 'config.json'))).toBe(false);

    const { config, configFile, createdOnThisBoot } = loadOrInitConfig({
      configDir,
    });

    expect(createdOnThisBoot).toBe(true);
    expect(configFile).toBe(join(configDir, 'config.json'));
    expect(readFileSync(configFile, 'utf8')).toBe(DEFAULT_CONFIG_JSON);
    expect(config.codex.approval_policy).toBe(
      BUILT_IN_DEFAULTS.codex.approval_policy,
    );
    expect(config.dispatchers).toEqual([]);
  });

  it('second boot reads the existing JSON file and does not overwrite it', () => {
    const file = globalConfigFile({ configDir });
    const original = stringifyConfig({
      codex: {
        bin: '/opt/codex',
        approval_policy: 'auto',
        sandbox_mode: 'workspace-write',
        extra_args: ['--model', 'gpt-5'],
        initialize_timeout_ms: 7500,
      },
      dispatchers: [
        {
          id: 'flow',
          cwd: '/workspace/flow',
          enabled: true,
          feishu: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
          codex: {
            approval_policy: null,
            sandbox_mode: 'danger-full-access',
            extra_args: ['--profile', 'flow'],
            extra_env: {},
          },
        },
      ],
    });
    writeConfigText(file, original);

    const { config, createdOnThisBoot } = loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(false);
    expect(config.codex.bin).toBe('/opt/codex');
    expect(config.codex.extra_args).toEqual(['--model', 'gpt-5']);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      cwd: '/workspace/flow',
      enabled: true,
      feishu: {
        app_id: 'app-test',
        app_secret: 'secret-test',
      },
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('parse error fails fast with the config path', () => {
    const file = globalConfigFile({ configDir });
    writeConfigText(file, `{"dispatchers": [`);
    expect(() => loadOrInitConfig({ configDir })).toThrow(/config\.json/);
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /dreamux config parse error/,
    );
  });

  it('fails fast when only the legacy TOML config exists', () => {
    const jsonFile = globalConfigFile({ configDir });
    const tomlFile = join(configDir, 'config.toml');
    writeFileSync(tomlFile, 'dispatchers = []\n');

    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /legacy dreamux config/,
    );
    expect(() => loadConfig({ configDir })).toThrow(/dispatchers array/);
    expect(existsSync(jsonFile)).toBe(false);
  });

  it('loadConfig loudly fails when config.json is missing', () => {
    expect(() => loadConfig({ configDir })).toThrow(/dreamux config is missing/);
    expect(() => loadConfig({ configDir })).toThrow(/dreamux onboard/);
    expect(existsSync(globalConfigFile({ configDir }))).toBe(false);
  });

  it('redacts Feishu app secrets for display', () => {
    const raw = JSON.stringify({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
        },
        {
          id: 'docs',
          nested: {
            app_secret: 'secret-docs',
          },
        },
      ],
    });

    const displayed = redactConfigForDisplay(raw, globalConfigFile({ configDir }));
    expect(displayed).toContain('<redacted>');
    expect(displayed).not.toContain('secret-flow');
    expect(displayed).not.toContain('secret-docs');
    expect(JSON.parse(displayed)).toMatchObject({
      dispatchers: [
        { feishu: { app_id: 'app-flow', app_secret: '<redacted>' } },
        { nested: { app_secret: '<redacted>' } },
      ],
    });
  });

  it('rejects invalid config values', () => {
    writeConfigObject({ codex: { approval_policy: 'ask-every-time' } });
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /approval_policy='ask-every-time'/,
    );

    writeConfigObject({ state_path: '/tmp/custom-state' });
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /state_path is not supported/,
    );

    writeConfigObject({ codex: { initialize_timeout_ms: 0 } });
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /initialize_timeout_ms must be > 0/,
    );

    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          enabled: 'yes',
          feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
        },
      ],
    });
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /enabled must be a boolean/,
    );
  });

  it('accepts the MVP dispatcher array schema', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'dispatcher-a',
          cwd: '~/workspace-a',
          enabled: true,
          feishu: {
            app_id: 'app-a',
            app_secret: 'secret-a',
          },
          codex: {
            extra_args: ['--model', 'gpt-5'],
            extra_env: {
              EXAMPLE_FLAG: '1',
            },
          },
        },
        {
          id: 'dispatcher.b',
          feishu: {
            app_id: 'app-b',
            app_secret: 'secret-b',
          },
        },
      ],
    });

    const { config } = loadConfig({ configDir });
    expect(config.dispatchers[0]).toMatchObject({
      id: 'dispatcher-a',
      enabled: true,
      feishu: {
        app_id: 'app-a',
        app_secret: 'secret-a',
      },
      codex: {
        approval_policy: null,
        sandbox_mode: null,
        extra_args: ['--model', 'gpt-5'],
        extra_env: {
          EXAMPLE_FLAG: '1',
        },
      },
    });
    expect(config.dispatchers[0]?.cwd).not.toContain('~');
    expect(config.dispatchers[1]).toMatchObject({
      id: 'dispatcher.b',
      cwd: null,
      enabled: true,
      feishu: {
        app_id: 'app-b',
        app_secret: 'secret-b',
      },
    });
  });

  it('rejects unsupported dispatcher secret fields', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
            callback_secret: 'future-only',
          },
        },
      ],
    });

    expect(() => loadConfig({ configDir })).toThrow(
      /callback_secret is not supported/,
    );
  });

  it('keeps access out of config and validates extra_env fields', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
          access: {},
        },
      ],
    });
    expect(() => loadConfig({ configDir })).toThrow(
      /access is not supported/,
    );

    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
          codex: {
            extra_env: {
              EXAMPLE_FLAG: 1,
            },
          },
        },
      ],
    });
    expect(() => loadConfig({ configDir })).toThrow(
      /codex\.extra_env\.EXAMPLE_FLAG must be a string/,
    );
  });

  it('requires unique Feishu app_id values across all dispatchers', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          enabled: false,
          feishu: {
            app_id: 'app-shared',
            app_secret: 'secret-flow',
          },
        },
        {
          id: 'docs',
          feishu: {
            app_id: 'app-shared',
            app_secret: 'secret-docs',
          },
        },
      ],
    });

    expect(() => loadConfig({ configDir })).toThrow(
      /duplicates dispatcher 'flow'/,
    );
  });

  it('rejects dispatcher ids that would not be stable path segments', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'team/alpha beta',
          feishu: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
        },
      ],
    });

    expect(() => loadConfig({ configDir })).toThrow(/dispatchers\[0\]\.id/);
    expect(() => loadConfig({ configDir })).toThrow(/ASCII letters/);
  });

  it('requires non-empty Feishu app_id and app_secret values', () => {
    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: '',
            app_secret: 'secret-flow',
          },
        },
      ],
    });
    expect(() => loadConfig({ configDir })).toThrow(
      /app_id must be a non-empty string/,
    );

    writeConfigObject({
      dispatchers: [
        {
          id: 'flow',
          feishu: {
            app_id: 'app-flow',
            app_secret: '   ',
          },
        },
      ],
    });
    expect(() => loadConfig({ configDir })).toThrow(
      /app_secret must be a non-empty string/,
    );
  });

  it('expandHome expands ~/ and bare ~', () => {
    expect(expandHome('~/x')).toMatch(/[/\\]x$/);
    expect(expandHome('~/x').startsWith('/')).toBe(true);
    expect(expandHome('~')).not.toContain('~');
    expect(expandHome('/abs/path')).toBe('/abs/path');
  });

  it('DREAMUX_CONFIG_DIR overrides ~/.dreamux when no explicit override', () => {
    process.env['DREAMUX_CONFIG_DIR'] = configDir;
    expect(globalConfigDir()).toBe(configDir);
    expect(globalConfigFile()).toBe(join(configDir, 'config.json'));
  });

  it('first-boot file is mode 0600', () => {
    const { configFile, createdOnThisBoot } = loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(true);
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects existing config files that are not mode 0600', () => {
    if (process.platform === 'win32') return;
    const file = globalConfigFile({ configDir });
    writeConfigText(file, JSON.stringify(BUILT_IN_DEFAULTS), 0o644);

    expect(() => loadConfig({ configDir })).toThrow(/must be mode 0600/);
  });

  it('throws when the config dir cannot be written', () => {
    if (process.getuid?.() === 0) return;
    const lockedParent = mkdtempSync(join(tmpdir(), 'dreamux-locked-'));
    const lockedChild = join(lockedParent, 'cfg');
    chmodSync(lockedParent, 0o500);
    try {
      expect(() => loadOrInitConfig({ configDir: lockedChild })).toThrow(
        /EACCES|EPERM|permission/i,
      );
    } finally {
      chmodSync(lockedParent, 0o700);
      rmSync(lockedParent, { recursive: true, force: true });
    }
  });
});

describe('runtime path precedence', () => {
  let configDir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-prec-'));
    for (const k of [
      'CODEX_HOST_RUNTIME_DIR',
      'CODEX_HOST_ADMIN_SOCKET',
      'CODEX_HOST_CODEX_BIN',
    ]) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });

  it('runtimeRoot aliases stateRoot and ignores legacy env overrides', () => {
    writeConfigObjectAt(configDir, {});
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_RUNTIME_DIR'] = '/tmp/from-env';
    expect(runtimeRoot()).toBe(stateRoot());
  });

  it('adminSocketPath is fixed under stateRoot', () => {
    writeConfigObjectAt(configDir, {});
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_ADMIN_SOCKET'] = '/tmp/env-admin.sock';
    expect(adminSocketPath()).toBe(join(stateRoot(), 'admin.sock'));
    expect(serverJsonPath()).toBe(join(stateRoot(), 'server.json'));
  });

  it('parseCodexArgs: per-dispatcher overrides config defaults', () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ approvalPolicy: 'on-failure' }),
      { approvalPolicy: 'never', extraArgs: ['--model', 'gpt-5'] },
    );
    expect(parsed.approvalPolicy).toBe('on-failure');
    expect(parsed.extraArgs).toEqual(['--model', 'gpt-5']);
  });

  it('parseCodexArgs: per-dispatcher extraArgs append after config defaults', () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ extraArgs: ['--model', 'override'] }),
      { approvalPolicy: 'never', extraArgs: ['--model', 'default'] },
    );
    expect(parsed.extraArgs).toEqual([
      '--model',
      'default',
      '--model',
      'override',
    ]);
  });

  it('parseCodexArgs hard-fails on invalid policy or sandbox mode', () => {
    expect(() =>
      parseCodexArgs(JSON.stringify({ approvalPolicy: 'untrusted-policy' })),
    ).toThrow(/refused/);
    expect(() =>
      parseCodexArgs(JSON.stringify({ sandboxMode: 'invalid-mode' })),
    ).toThrow(/sandboxMode='invalid-mode'/);
  });
});

describe('sandbox_mode precedence', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-sandbox-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    resetRuntimeConfig();
  });

  it('default config has sandbox_mode = workspace-write', () => {
    expect(BUILT_IN_DEFAULTS.codex.sandbox_mode).toBe('workspace-write');
    const { config } = loadOrInitConfig({ configDir });
    expect(config.codex.sandbox_mode).toBe('workspace-write');
  });

  it('config file value is loaded and validated', () => {
    writeConfigObjectAt(configDir, {
      codex: { sandbox_mode: 'danger-full-access' },
    });
    const { config } = loadOrInitConfig({ configDir });
    expect(config.codex.sandbox_mode).toBe('danger-full-access');
  });

  it('config rejects an invalid sandbox_mode at load time', () => {
    writeConfigObjectAt(configDir, {
      codex: { sandbox_mode: 'not-a-mode' },
    });
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /sandbox_mode='not-a-mode'/,
    );
  });

  it('parseCodexArgs: per-dispatcher sandboxMode overrides config default', () => {
    const parsed = parseCodexArgs(
      JSON.stringify({ sandboxMode: 'read-only' }),
      { sandboxMode: 'danger-full-access' },
    );
    expect(parsed.sandboxMode).toBe('read-only');
  });

  it('codexArgsToCli emits `-c sandbox_mode=<value>` after approval_policy', () => {
    const parsed = parseCodexArgs(
      JSON.stringify({
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
      }),
    );
    const cli = codexArgsToCli(parsed);
    expect(cli).toContain('-c');
    expect(cli).toContain('approval_policy=never');
    expect(cli).toContain('sandbox_mode=workspace-write');
    expect(cli.indexOf('sandbox_mode=workspace-write')).toBeGreaterThan(
      cli.indexOf('approval_policy=never'),
    );
  });
});
