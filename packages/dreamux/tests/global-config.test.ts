/**
 * Tests for ~/.dreamux/config.toml (feat/global-config-dir).
 *
 * Covers:
 *   - first boot: dir + file auto-created with the default TOML
 *   - second boot: existing file is read, never overwritten
 *   - parse error: fails fast with a file:line pointer
 *   - field-level validation: type errors / out-of-range values
 *   - approval_policy allowlist enforced at config load (defense in depth
 *     before per-dispatcher parseCodexArgs gets a chance)
 *   - precedence: env > per-dispatcher > config > built-in default
 *   - paths.* reflect config-derived values when no env var is set
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
  DEFAULT_CONFIG_TOML,
  expandHome,
  globalConfigDir,
  globalConfigFile,
  loadOrInitConfig,
} from '../src/runtime/config.js';
import {
  adminSocketPath,
  resetRuntimeConfig,
  runtimeRoot,
  setRuntimeConfig,
} from '../src/runtime/paths.js';
import { codexArgsToCli, parseCodexArgs } from '../src/runtime/codex-args.js';

describe('global config (~/.dreamux/config.toml)', () => {
  let configDir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'dreamux-cfg-'));
    // Snapshot every env var the suite touches so each test starts clean.
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

  it('first boot creates the config dir and file with default TOML', () => {
    expect(existsSync(join(configDir, 'config.toml'))).toBe(false);

    const { config, configFile, createdOnThisBoot } = loadOrInitConfig({
      configDir,
    });

    expect(createdOnThisBoot).toBe(true);
    expect(configFile).toBe(join(configDir, 'config.toml'));
    expect(readFileSync(configFile, 'utf8')).toBe(DEFAULT_CONFIG_TOML);
    expect(config.codex.approval_policy).toBe(
      BUILT_IN_DEFAULTS.codex.approval_policy,
    );
    expect(config.codex.bin).toBe(BUILT_IN_DEFAULTS.codex.bin);
    expect(config.outbound.retries).toBe(BUILT_IN_DEFAULTS.outbound.retries);
  });

  it('second boot reads the existing file and does not overwrite it', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(
      file,
      `runtime_dir = "/tmp/custom-runtime"

[codex]
bin = "/opt/codex"
approval_policy = "auto"
extra_args = ["--model", "gpt-5"]
initialize_timeout_ms = 7500

[outbound]
retries = 5
retry_delay_ms = 2000
`,
    );

    const { config, createdOnThisBoot } = loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(false);
    expect(config.runtime_dir).toBe('/tmp/custom-runtime');
    expect(config.codex.bin).toBe('/opt/codex');
    expect(config.codex.approval_policy).toBe('auto');
    expect(config.codex.extra_args).toEqual(['--model', 'gpt-5']);
    expect(config.codex.initialize_timeout_ms).toBe(7500);
    expect(config.outbound.retries).toBe(5);
    expect(config.outbound.retry_delay_ms).toBe(2000);
    // File was not rewritten — the user's exact text is preserved.
    // (Dedicated test below asserts byte-for-byte preservation; here we
    // just check the file isn't replaced by DEFAULT_CONFIG_TOML.)
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('runtime_dir = "/tmp/custom-runtime"');
    expect(after).not.toContain('# dreamux global configuration');
  });

  it('preserves user comments / formatting (does not regenerate the file)', () => {
    const file = globalConfigFile({ configDir });
    const original = `# my custom header — must survive

runtime_dir = "/tmp/keep-me"
`;
    writeFileSync(file, original);
    loadOrInitConfig({ configDir });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('parse error fails fast with a file:line pointer', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(
      file,
      `runtime_dir = "/ok"
[codex
bin = "nope"
`,
    );
    expect(() => loadOrInitConfig({ configDir })).toThrow(/config\.toml/);
    expect(() => loadOrInitConfig({ configDir })).toThrow(/dreamux config parse error/);
  });

  it('rejects an unknown approval_policy at config load', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(
      file,
      `[codex]\napproval_policy = "ask-every-time"\n`,
    );
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /approval_policy='ask-every-time'/,
    );
  });

  it('rejects wrong types with the offending key', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `runtime_dir = 42\n`);
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /runtime_dir must be a string/,
    );
  });

  it('rejects non-positive initialize_timeout_ms', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `[codex]\ninitialize_timeout_ms = 0\n`);
    expect(() => loadOrInitConfig({ configDir })).toThrow(
      /initialize_timeout_ms must be > 0/,
    );
  });

  it('rejects negative outbound retries', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `[outbound]\nretries = -1\n`);
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
    expect(globalConfigFile()).toBe(join(configDir, 'config.toml'));
  });

  // PR #8 review #3 — auto-init boundary: mode of the created file.
  it('first-boot file is mode 0600 (no group / world bits)', () => {
    const { configFile, createdOnThisBoot } = loadOrInitConfig({ configDir });
    expect(createdOnThisBoot).toBe(true);
    const mode = statSync(configFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // PR #8 review #3 — auto-init boundary: parent dir is unwritable.
  it('throws when the config dir cannot be written', () => {
    // Build a parent dir, chmod it read-only-execute so mkdir / open fails
    // for the file underneath. We're the owner; bits still apply unless
    // we have CAP_DAC_OVERRIDE (i.e. root), which the test runner shouldn't.
    if (process.getuid?.() === 0) {
      // Root bypasses DAC permission checks; skip rather than mislead.
      return;
    }
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

  // PR #8 review #1 — atomic create-if-absent semantics.
  //
  // The implementation uses Node `wx` (POSIX O_CREAT|O_EXCL) so multiple
  // processes racing the same path see at most one EEXIST loser; the
  // winning process's write is never overwritten. We can't easily fork
  // here, but we can exercise the same code path twice in sequence:
  // second call must return createdOnThisBoot=false and the file's
  // contents must be the *first* call's, not a freshly-rewritten copy.
  it('second call does NOT overwrite the file written by the first call', () => {
    const first = loadOrInitConfig({ configDir });
    expect(first.createdOnThisBoot).toBe(true);
    // Mutate the file to simulate a user edit (or another process having
    // written the "winning" version of a race).
    const userEdit = `# user touched this between calls\nruntime_dir = "/tmp/keep-me"\n`;
    writeFileSync(first.configFile, userEdit, { mode: 0o600 });

    const second = loadOrInitConfig({ configDir });
    expect(second.createdOnThisBoot).toBe(false);
    expect(readFileSync(second.configFile, 'utf8')).toBe(userEdit);
    expect(second.config.runtime_dir).toBe('/tmp/keep-me');
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
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `runtime_dir = "/tmp/from-config"\n`);
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    expect(runtimeRoot()).toBe('/tmp/from-config');
  });

  it('CODEX_HOST_RUNTIME_DIR env beats config.runtime_dir', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `runtime_dir = "/tmp/from-config"\n`);
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    process.env['CODEX_HOST_RUNTIME_DIR'] = '/tmp/from-env';
    expect(runtimeRoot()).toBe('/tmp/from-env');
  });

  it('adminSocketPath: env > config.admin_socket > <runtime_dir>/admin.sock', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(
      file,
      `runtime_dir = "/tmp/rt"\nadmin_socket = "/tmp/cfg-admin.sock"\n`,
    );
    const { config } = loadOrInitConfig({ configDir });
    setRuntimeConfig(config);
    expect(adminSocketPath()).toBe('/tmp/cfg-admin.sock');

    process.env['CODEX_HOST_ADMIN_SOCKET'] = '/tmp/env-admin.sock';
    expect(adminSocketPath()).toBe('/tmp/env-admin.sock');
  });

  it('admin_socket derives from runtime_dir when not set in config', () => {
    const file = globalConfigFile({ configDir });
    writeFileSync(file, `runtime_dir = "/tmp/rt"\n`);
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
    // Per-dispatcher extra_args is empty → only the global default applies.
    expect(parsed.extraArgs).toEqual(['--model', 'gpt-5']);
  });

  it('parseCodexArgs: global default is used when per-dispatcher omits the field', () => {
    const parsed = parseCodexArgs('{}', {
      approvalPolicy: 'auto-approve',
      extraArgs: ['--reasoning', 'high'],
    });
    expect(parsed.approvalPolicy).toBe('auto-approve');
    expect(parsed.extraArgs).toEqual(['--reasoning', 'high']);
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
    // Per the codex CLI's "last write wins" semantics for repeated -c keys,
    // the per-dispatcher entry effectively overrides the global default.
  });

  it('parseCodexArgs still hard-fails on a non-trusted approvalPolicy', () => {
    expect(() =>
      parseCodexArgs(
        JSON.stringify({ approvalPolicy: 'untrusted-policy' }),
        { approvalPolicy: 'never' },
      ),
    ).toThrow(/refused/);
  });
});

// PR #8 review #2 — sandbox_mode is a first-class config + CLI key.
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
      `[codex]\nsandbox_mode = "danger-full-access"\n`,
    );
    const { config } = loadOrInitConfig({ configDir });
    expect(config.codex.sandbox_mode).toBe('danger-full-access');
  });

  it('config rejects an invalid sandbox_mode at load time', () => {
    writeFileSync(
      globalConfigFile({ configDir }),
      `[codex]\nsandbox_mode = "not-a-mode"\n`,
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

  it('parseCodexArgs: config default is used when per-dispatcher omits sandboxMode', () => {
    const parsed = parseCodexArgs('{}', { sandboxMode: 'danger-full-access' });
    expect(parsed.sandboxMode).toBe('danger-full-access');
  });

  it('parseCodexArgs hard-fails on an invalid sandboxMode', () => {
    expect(() =>
      parseCodexArgs(JSON.stringify({ sandboxMode: 'invalid-mode' })),
    ).toThrow(/sandboxMode='invalid-mode'/);
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
    // Verify ordering: approval_policy comes before sandbox_mode so that a
    // same-key override in extra_args (which is appended) wins via codex's
    // last-write-wins parse rule.
    const apIdx = cli.indexOf('approval_policy=never');
    const sbIdx = cli.indexOf('sandbox_mode=workspace-write');
    expect(apIdx).toBeGreaterThanOrEqual(0);
    expect(sbIdx).toBeGreaterThan(apIdx);
  });
});
