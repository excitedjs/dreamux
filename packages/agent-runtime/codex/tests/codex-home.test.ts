import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
} from '../src/codex-home.js';
import { resolveCodexHomeDir, codexSpawnEnv } from '../src/paths.js';
import { unixSocketPathFitsBudget } from '@excitedjs/dreamux-utils';

function validate(id: string, options: { env: Record<string, string> }) {
  const env = codexSpawnEnv(process.env, options.env);
  return validateDispatcherCodexHome(
    dispatcherCodexHomeDoctorContext(id, env),
    { env },
  );
}

describe('global Codex home doctor', () => {
  let runtimeDir: string;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(homedir(), '.dreamux-test-'));
    vi.stubEnv('HOME', join(runtimeDir, 'home'));
    vi.stubEnv('CODEX_HOME', undefined);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('CODEX_API_KEY', undefined);
    vi.stubEnv('CODEX_ACCESS_TOKEN', undefined);
  });

  afterEach(() => {
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('selects the shared Codex home independently of runtime identity', () => {
    const home = join(runtimeDir, 'home');
    const configuredHome = join(runtimeDir, 'configured-codex');
    for (const [env, expectedHome] of [
      [{ HOME: home }, join(home, '.codex')],
      [{ HOME: home, CODEX_HOME: configuredHome }, configuredHome],
    ] as const) {
      for (const runtimeId of ['flow-a', 'flow-b', '']) {
        expect(dispatcherCodexHomeDoctorContext(runtimeId, env)).toMatchObject({
          dispatcherId: runtimeId,
          codexHome: expectedHome,
          configPath: join(expectedHome, 'config.toml'),
        });
      }
    }
  });

  it('reports every missing Codex home requirement', async () => {
    const result = await validate('flow', { env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing Codex home directory'),
        expect.stringContaining('missing Codex auth state'),
      ]),
    );
    // The doctor no longer checks for an on-disk dispatcher skill — bundled
    // skills are injected at runtime by role (issue #209 slice 6).
    expect(result.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('dispatcher skill')]),
    );
  });

  it('accepts a minimal global Codex home prepared by onboard', async () => {
    writeCodexHome();

    const result = await validate('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not require a Codex config file in the global Codex home', async () => {
    writeCodexHome();

    const result = await validate('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports a host-supplied app-server socket path that exceeds the sun_path budget', async () => {
    // Socket allocation now belongs to the host (`allocateRuntimeSocketPath`),
    // not the doctor: the host passes a representative socket sample into the
    // doctor context. A path that blows the sun_path budget surfaces as a
    // fail-loud entry in `result.errors` — `validateDispatcherCodexHome` returns
    // the result and never rejects (only `assertDispatcherCodexHomeReady`
    // throws). The neutral allocator's own over-budget fail-loud is covered in
    // runtime-sockets.test.ts; here we assert the codex doctor's reporting.
    const longSocketPath = join(
      runtimeDir,
      'h'.repeat(120),
      'sockets',
      `${'x'.repeat(40)}.sock`,
    );
    expect(unixSocketPathFitsBudget(longSocketPath)).toBe(false);

    const context = dispatcherCodexHomeDoctorContext(
      'dispatcher-with-long-id',
      process.env,
      { socketPath: longSocketPath },
    );
    const result = await validateDispatcherCodexHome(context, { env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      /app-server socket path is too long for Unix sockets/,
    );
  });

  it('requires auth environment variables to be non-empty and accepts CODEX_ACCESS_TOKEN', async () => {
    writeCodexHome({ writeAuth: false });

    const emptyAuth = await validate('flow', {
      env: { OPENAI_API_KEY: '' },
    });
    expect(emptyAuth.ok).toBe(false);
    expect(emptyAuth.errors.join('\n')).toContain('missing Codex auth state');

    const accessToken = await validate('flow', {
      env: { CODEX_ACCESS_TOKEN: 'token-test' },
    });
    expect(accessToken.ok).toBe(true);
  });

  it('reports invalid caller-provided Codex config paths', async () => {
    writeCodexHome();
    const badConfigPath = join(runtimeDir, 'bad-config.toml');
    writeFileSync(badConfigPath, 'not toml =');
    const context = dispatcherCodexHomeDoctorContext('flow', process.env);

    const result = await validateDispatcherCodexHome(
      {
        ...context,
        configPath: badConfigPath,
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(badConfigPath);
  });

  it('does not require an on-disk workspace dispatcher skill', async () => {
    // Bundled skills are injected at runtime via `skills/extraRoots/set`
    // (issue #209 slice 6), so a ready Codex home needs no `.codex/skills`
    // symlink — the doctor passes without one.
    writeCodexHome();

    const result = await validate('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('dispatcher skill')]),
    );
  });
});

function writeCodexHome(options: { writeAuth?: boolean } = {}): void {
  const codexHome = resolveCodexHomeDir(process.env);
  mkdirSync(codexHome, { recursive: true });
  if (options.writeAuth !== false) {
    writeFileSync(join(codexHome, 'auth.json'), '{}', {
      mode: 0o600,
    });
  }
}
