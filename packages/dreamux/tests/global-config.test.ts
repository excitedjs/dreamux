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
  setRuntimeConfig,
} from '../src/runtime/paths.js';
import { codexArgsToCli, parseCodexArgs } from '../src/runtime/codex-args.js';

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
    expect(config.feishu.bots).toEqual({});
  });

  it('second boot reads the existing JSON file and does not overwrite it', () => {
    const file = globalConfigFile({ configDir });
    const original = stringifyConfig({
      ...BUILT_IN_DEFAULTS,
      runtime_dir: '/tmp/custom-runtime',
      codex: {
        ...BUILT_IN_DEFAULTS.codex,
        bin: '/opt/codex',
        approval_policy: 'auto',
        extra_args: ['--model', 'gpt-5'],
        initialize_timeout_ms: 7500,
      },
      outbound: {
        retries: 5,
        retry_delay_ms: 2000,
      },
      feishu: {
        bots: {
          flow: {
            app_id: 'app-test',
            app_secret: 'secret-test',
          },
        },
      },
    });
    writeFileSync(file, original);

    const { config, createdOnThisBoot } = loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(false);
    expect(config.runtime_dir).toBe('/tmp/custom-runtime');
    expect(config.codex.bin).toBe('/opt/codex');
    expect(config.codex.extra_args).toEqual(['--model', 'gpt-5']);
    expect(config.feishu.bots.flow).toEqual({
      app_id: 'app-test',
      app_secret: 'secret-test',
    });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('parse error fails fast with the config path', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `{"runtime_dir": "/ok"`);
    expect(() => loadOrInitConfig({ configDir })).toThrow(/config\.json/);
    expect(() => loadOrInitConfig({ configDir })).toThrow(/dreamux config parse error/);
  });

  it('fails fast when only the legacy TOML config exists', () => {
    const jsonFile = globalConfigFile({ configDir });
    const tomlFile = join(configDir, 'config.toml');
    writeFileSync(tomlFile, 'runtime_dir = "/tmp/old-runtime"\n');

    expect(() => loadOrInitConfig({ configDir })).toThrow(/legacy dreamux config/);
    expect(() => loadConfig({ configDir })).toThrow(/Create .*config\.json/);
    expect(existsSync(jsonFile)).toBe(false);
  });

  it('redacts Feishu app secrets for display', () => {
    const raw = JSON.stringify({
      runtime_dir: '/tmp/runtime',
      feishu: {
        bots: {
          flow: {
            app_id: 'app-flow',
            app_secret: 'secret-flow',
          },
          docs: {
            app_id: 'app-docs',
            app_secret: 'secret-docs',
          },
        },
      },
    });

    const displayed = redactConfigForDisplay(raw, globalConfigFile({ configDir }));
    expect(displayed).toContain('<redacted>');
    expect(displayed).not.toContain('secret-flow');
    expect(displayed).not.toContain('secret-docs');
    expect(JSON.parse(displayed)).toMatchObject({
      feishu: {
        bots: {
          flow: { app_id: 'app-flow', app_secret: '<redacted>' },
          docs: { app_id: 'app-docs', app_secret: '<redacted>' },
        },
      },
    });
  });

  it('rejects invalid config values', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, JSON.stringify({ codex: { approval_policy: 'ask-every-time' } }));
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /approval_policy='ask-every-time'/,
    );

    writeFileSync(file, JSON.stringify({ runtime_dir: 42 }));
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /runtime_dir must be a string/,
    );

    writeFileSync(file, JSON.stringify({ codex: { initialize_timeout_ms: 0 } }));
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /initialize_timeout_ms must be > 0/,
    );

    writeFileSync(file, JSON.stringify({ outbound: { retries: -1 } }));
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /retries must be >= 0/,
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

describe('precedence: env > per-dispatcher > config > built-in', () => {
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

  it('paths.runtimeRoot reflects config when no env override', () => {
    writeFileSync(globalConfigFile({ configDir }), JSON.stringify({
      runtime_dir: '/tmp/from-config',
    }));
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    expect(runtimeRoot()).toBe('/tmp/from-config');
  });

  it('CODEX_HOST_RUNTIME_DIR env beats config.runtime_dir', () => {
    writeFileSync(globalConfigFile({ configDir }), JSON.stringify({
      runtime_dir: '/tmp/from-config',
    }));
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_RUNTIME_DIR'] = '/tmp/from-env';
    expect(runtimeRoot()).toBe('/tmp/from-env');
  });

  it('adminSocketPath: env > config.admin_socket > <runtime_dir>/admin.sock', () => {
    writeFileSync(globalConfigFile({ configDir }), JSON.stringify({
      runtime_dir: '/tmp/rt',
      admin_socket: '/tmp/cfg-admin.sock',
    }));
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    expect(adminSocketPath()).toBe('/tmp/cfg-admin.sock');

    process.env['CODEX_HOST_ADMIN_SOCKET'] = '/tmp/env-admin.sock';
    expect(adminSocketPath()).toBe('/tmp/env-admin.sock');
  });

  it('admin_socket derives from runtime_dir when not set in config', () => {
    writeFileSync(globalConfigFile({ configDir }), JSON.stringify({
      runtime_dir: '/tmp/rt',
    }));
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    expect(adminSocketPath()).toBe('/tmp/rt/admin.sock');
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
    writeFileSync(
      globalConfigFile({ configDir }),
      JSON.stringify({ codex: { sandbox_mode: 'danger-full-access' } }),
    );
    const { config } = loadOrInitConfig({ configDir });
    expect(config.codex.sandbox_mode).toBe('danger-full-access');
  });

  it('config rejects an invalid sandbox_mode at load time', () => {
    writeFileSync(
      globalConfigFile({ configDir }),
      JSON.stringify({ codex: { sandbox_mode: 'not-a-mode' } }),
    );
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
