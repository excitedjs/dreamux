import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES,
  formatDispatcherCodexHomeErrors,
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
} from '../src/runtime/dispatcher-codex-home.js';
import { BUILT_IN_DEFAULTS } from '../src/runtime/config.js';
import {
  dispatcherAppServerControlDir,
  dispatcherCodexConfigPath,
  dispatcherCodexHome,
  dispatcherCodexPluginsDir,
  dispatcherSocketPath,
  resetRuntimeConfig,
  setRuntimeConfig,
} from '../src/runtime/paths.js';

const VALID_CONFIG = `[marketplaces.dreamux]
source = "public"

	[plugins.codexmux]
	enabled = true
	`;

describe('operator Codex home doctor', () => {
  let runtimeDir: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(homedir(), '.dreamux-test-'));
    previousCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = join(runtimeDir, 'codex-home');
    setRuntimeConfig({ ...BUILT_IN_DEFAULTS, runtime_dir: runtimeDir });
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
    resetRuntimeConfig();
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('places app-server sockets under the dreamux dispatcher runtime directory', () => {
    expect(dispatcherSocketPath('flow')).toBe(
      join(dispatcherAppServerControlDir('flow'), 'as.sock'),
    );
    expect(dispatcherSocketPath('flow')).toContain(
      join('dispatchers', 'flow', 'app-server-control'),
    );
    expect(dispatcherSocketPath('flow')).not.toMatch(/^\/tmp(?:\/|$)/);
    expect(Buffer.byteLength(dispatcherSocketPath('frontend-service'), 'utf8'))
      .toBeLessThanOrEqual(DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES);
  });

  it('reports every missing Codex home requirement', () => {
    const result = validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing Codex config'),
        expect.stringContaining('missing Codex home directory'),
        expect.stringContaining('missing codexmux plugin'),
        expect.stringContaining('missing Codex auth state'),
      ]),
    );
  });

  it('accepts a minimal operator Codex home prepared by onboard', () => {
    writeDispatcherHome('flow', VALID_CONFIG);

    const result = validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not require dispatcher-specific network config in the operator Codex home', () => {
    writeDispatcherHome(
      'flow',
      `[marketplaces.dreamux]
source = "public"
`,
    );

    const result = validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('ignores runtime CLI overrides when checking static Codex home readiness', () => {
    writeDispatcherHome('flow', VALID_CONFIG);

    const result = validateDispatcherCodexHome('flow', {
      codexCliArgs: [
        '-c',
        'sandbox_mode=workspace-write',
        '-c',
        'sandbox_workspace_write.network_access=false',
      ],
      env: {},
    });

    expect(result.ok).toBe(true);
  });

  it('rejects too-long app-server socket paths before bind', () => {
    setRuntimeConfig({
      ...BUILT_IN_DEFAULTS,
      runtime_dir: join(runtimeDir, 'runtime-root-with-a-long-custom-name'),
    });
    writeDispatcherHome('dispatcher-with-long-id', VALID_CONFIG);

    const result = validateDispatcherCodexHome('dispatcher-with-long-id', {
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(result)).toContain(
      'socket path is too long',
    );
  });

  it('requires auth environment variables to be non-empty and accepts CODEX_ACCESS_TOKEN', () => {
    writeDispatcherHome('flow', VALID_CONFIG, { writeAuth: false });

    const emptyAuth = validateDispatcherCodexHome('flow', {
      env: { OPENAI_API_KEY: '' },
    });
    expect(emptyAuth.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(emptyAuth)).toContain(
      'missing Codex auth state',
    );

    const accessToken = validateDispatcherCodexHome('flow', {
      env: { CODEX_ACCESS_TOKEN: 'token-test' },
    });
    expect(accessToken.ok).toBe(true);
  });

  it('honors caller-provided doctor context paths', () => {
    writeDispatcherHome('flow', VALID_CONFIG);
    const context = dispatcherCodexHomeDoctorContext('flow', {
      codexCliArgs: ['-c', 'sandbox_mode=danger-full-access'],
    });

    const result = validateDispatcherCodexHome({
      ...context,
      configPath: join(runtimeDir, 'missing-config.toml'),
    }, { env: {} });

    expect(result.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(result)).toContain(
      join(runtimeDir, 'missing-config.toml'),
    );
  });

  it('rejects dispatcher homes without codexmux installed', () => {
    writeDispatcherHome('flow', VALID_CONFIG, { installCodexmux: false });

    const result = validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(result)).toContain(
      'missing codexmux plugin',
    );
  });
});

function writeDispatcherHome(
  dispatcherId: string,
  config: string,
  options: { installCodexmux?: boolean; writeAuth?: boolean } = {},
): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  writeFileSync(dispatcherCodexConfigPath(dispatcherId), config, { mode: 0o600 });
  if (options.writeAuth !== false) {
    writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
      mode: 0o600,
    });
  }

  if (options.installCodexmux === false) return;
  mkdirSync(
    join(
      dispatcherCodexPluginsDir(dispatcherId),
      'cache',
      'dreamux',
      'codexmux',
    ),
    { recursive: true },
  );
}
