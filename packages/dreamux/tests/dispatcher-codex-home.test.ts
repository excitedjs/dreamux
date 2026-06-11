import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES,
  formatDispatcherCodexHomeErrors,
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
} from '../src/agent-runtime/builtin/codex/codex-home.js';
import { BUILT_IN_DEFAULTS } from '../src/config/config.js';
import {
  defaultDispatcherCwd,
  resetRuntimeConfig,
  runRoot,
  setRuntimeConfig,
  stateRoot,
  unixSocketPathFitsBudget,
} from '../src/platform/paths.js';
import {
  allocateCodexSocketPath,
  dispatcherCodexHome,
  dispatcherWorkspaceSkillPath,
} from '../src/agent-runtime/builtin/codex/paths.js';

describe('global Codex home doctor', () => {
  let runtimeDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(homedir(), '.dreamux-test-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(runtimeDir, 'home');
    setRuntimeConfig(BUILT_IN_DEFAULTS);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('allocates app-server sockets under a private runtime root, never state or /tmp', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    delete process.env['XDG_RUNTIME_DIR'];
    try {
      const socket = allocateCodexSocketPath('flow');
      expect(socket.startsWith(join(runRoot(), 'sockets'))).toBe(true);
      expect(socket.endsWith('.sock')).toBe(true);
      expect(socket.startsWith(stateRoot())).toBe(false);
      expect(socket).not.toMatch(/^\/tmp(?:\/|$)/);
      expect(
        Buffer.byteLength(allocateCodexSocketPath('frontend-service'), 'utf8'),
      ).toBeLessThanOrEqual(DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES);
      // Random rendezvous endpoint: a fresh start never reuses a path.
      expect(allocateCodexSocketPath('flow')).not.toBe(socket);
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previousXdg;
    }
  });

  it('reports every missing Codex home requirement', async () => {
    const result = await validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing Codex home directory'),
        expect.stringContaining('missing dispatcher skill'),
        expect.stringContaining('missing Codex auth state'),
      ]),
    );
  });

  it('accepts a minimal global Codex home prepared by onboard', async () => {
    writeDispatcherHome('flow');

    const result = await validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not require a Codex config file in the global Codex home', async () => {
    writeDispatcherHome('flow');

    const result = await validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('ignores runtime CLI overrides when checking static Codex home readiness', async () => {
    writeDispatcherHome('flow');

    const result = await validateDispatcherCodexHome('flow', {
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

  it('rejects too-long app-server socket paths when no private root fits the budget', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    const previousTmpdir = process.env['TMPDIR'];
    // A pathological $HOME blows the budget for the dreamux-owned fallback. To
    // assert the fail-loud path deterministically across platforms, also remove
    // the other private candidates: no XDG root, and a shared-tmp TMPDIR so the
    // private-OS-temp candidate is rejected too (on macOS the real $TMPDIR is a
    // short private root that would otherwise fit; issue #182 final gate).
    process.env['HOME'] = join(runtimeDir, 'h'.repeat(120));
    delete process.env['XDG_RUNTIME_DIR'];
    process.env['TMPDIR'] = '/tmp';

    try {
      await expect(
        validateDispatcherCodexHome('dispatcher-with-long-id', { env: {} }),
      ).rejects.toThrow(/Codex socket path is too long/);
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previousXdg;
      if (previousTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previousTmpdir;
    }
  });

  it('uses the private OS temp dir for deep home dirs when XDG is absent (#182 macOS gate)', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    const previousTmpdir = process.env['TMPDIR'];
    // The macOS CI shape: long $HOME, no $XDG_RUNTIME_DIR, but a short PRIVATE
    // $TMPDIR keeps the Codex socket within budget instead of failing loudly.
    process.env['HOME'] = join(runtimeDir, 'h'.repeat(120));
    delete process.env['XDG_RUNTIME_DIR'];
    process.env['TMPDIR'] = join(runtimeDir, 't');

    try {
      const socket = allocateCodexSocketPath('dispatcher-with-long-id');
      expect(socket.startsWith(join(runtimeDir, 't', 'dreamux', 'sockets'))).toBe(true);
      expect(unixSocketPathFitsBudget(socket)).toBe(true);
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previousXdg;
      if (previousTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previousTmpdir;
    }
  });

  it('uses the private XDG runtime root for deep home dirs instead of failing', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    process.env['HOME'] = join(runtimeDir, 'h'.repeat(120));
    process.env['XDG_RUNTIME_DIR'] = join(runtimeDir, 'xdg');

    try {
      const socket = allocateCodexSocketPath('dispatcher-with-long-id');
      expect(
        socket.startsWith(join(runtimeDir, 'xdg', 'dreamux', 'sockets')),
      ).toBe(true);
      expect(Buffer.byteLength(socket, 'utf8')).toBeLessThanOrEqual(
        DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES,
      );
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previousXdg;
    }
  });

  it('requires auth environment variables to be non-empty and accepts CODEX_ACCESS_TOKEN', async () => {
    writeDispatcherHome('flow', { writeAuth: false });

    const emptyAuth = await validateDispatcherCodexHome('flow', {
      env: { OPENAI_API_KEY: '' },
    });
    expect(emptyAuth.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(emptyAuth)).toContain(
      'missing Codex auth state',
    );

    const accessToken = await validateDispatcherCodexHome('flow', {
      env: { CODEX_ACCESS_TOKEN: 'token-test' },
    });
    expect(accessToken.ok).toBe(true);
  });

  it('reports invalid caller-provided Codex config paths', async () => {
    writeDispatcherHome('flow');
    const badConfigPath = join(runtimeDir, 'bad-config.toml');
    writeFileSync(badConfigPath, 'not toml =');
    const context = dispatcherCodexHomeDoctorContext('flow', {
      codexCliArgs: ['-c', 'sandbox_mode=danger-full-access'],
    });

    const result = await validateDispatcherCodexHome({
      ...context,
      configPath: badConfigPath,
    }, { env: {} });

    expect(result.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(result)).toContain(
      badConfigPath,
    );
  });

  it('rejects missing workspace-local dispatcher skills', async () => {
    writeDispatcherHome('flow', { installDispatcherSkill: false });

    const result = await validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(false);
    expect(formatDispatcherCodexHomeErrors(result)).toContain(
      'missing dispatcher skill',
    );
  });
});

function writeDispatcherHome(
  dispatcherId: string,
  options: { installDispatcherSkill?: boolean; writeAuth?: boolean } = {},
): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  if (options.writeAuth !== false) {
    writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
      mode: 0o600,
    });
  }

  if (options.installDispatcherSkill === false) return;
  const skillPath = dispatcherWorkspaceSkillPath(defaultDispatcherCwd(dispatcherId));
  mkdirSync(dirname(skillPath), {
    recursive: true,
  });
  writeFileSync(skillPath, '# test skill\n');
}
