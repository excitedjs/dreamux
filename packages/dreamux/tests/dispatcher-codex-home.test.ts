import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES,
  formatDispatcherCodexHomeErrors,
  dispatcherCodexHomeDoctorContext,
  validateDispatcherCodexHome,
  dispatcherCodexHome,
} from '@excitedjs/agent-runtime-codex';
import { unixSocketPathFitsBudget } from '@excitedjs/dreamux-utils';
import { BUILT_IN_DEFAULTS } from '../src/config/config.js';
import {
  resetRuntimeConfig,
  runRoot,
  setRuntimeConfig,
  stateRoot,
} from '../src/platform/paths.js';
import { allocateRuntimeSocketPath } from '../src/platform/runtime-sockets.js';

describe('global Codex home doctor', () => {
  let runtimeDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(homedir(), '.dreamux-test-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(runtimeDir, 'home');
    process.env['DREAMUX_ROOT'] = join(runtimeDir, 'dreamux');
    setRuntimeConfig(BUILT_IN_DEFAULTS);
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('allocates app-server sockets under a private runtime root, never state or /tmp', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    delete process.env['XDG_RUNTIME_DIR'];
    try {
      const socket = allocateRuntimeSocketPath('codex app-server socket');
      expect(socket.startsWith(join(runRoot(), 'sockets'))).toBe(true);
      expect(socket.endsWith('.sock')).toBe(true);
      expect(socket.startsWith(stateRoot())).toBe(false);
      expect(socket).not.toMatch(/^\/tmp(?:\/|$)/);
      expect(
        Buffer.byteLength(allocateRuntimeSocketPath('codex app-server socket'), 'utf8'),
      ).toBeLessThanOrEqual(DISPATCHER_APP_SERVER_SOCKET_PATH_MAX_BYTES);
      // Random rendezvous endpoint: a fresh start never reuses a path.
      expect(allocateRuntimeSocketPath('codex app-server socket')).not.toBe(socket);
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previousXdg;
    }
  });

  it('is a truly global home: two dispatcher ids resolve the identical Codex home path (no dispatcher-private CODEX_HOME)', () => {
    // Dreamux 0.x does not create a per-dispatcher CODEX_HOME (project
    // CLAUDE.md "Always-Binding Rules" / `packages/agent-runtime/codex/src/
    // paths.ts` doc comment). `dispatcherCodexHome(id)` accepts an id only for
    // call-site symmetry and ignores it entirely — this locks that fact down
    // so a future change cannot silently make it per-dispatcher without a
    // failing test surfacing the shift.
    expect(dispatcherCodexHome('flow-a')).toBe(dispatcherCodexHome('flow-b'));
    expect(dispatcherCodexHome('flow-a')).toBe(dispatcherCodexHome(''));
  });

  it('reports every missing Codex home requirement', async () => {
    const result = await validateDispatcherCodexHome('flow', { env: {} });

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

    const context = dispatcherCodexHomeDoctorContext('dispatcher-with-long-id', {
      socketPath: longSocketPath,
    });
    const result = await validateDispatcherCodexHome(context, { env: {} });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      /app-server socket path is too long for Unix sockets/,
    );
  });

  it('uses the private OS temp dir for deep home dirs when XDG is absent (#182 macOS gate)', async () => {
    const previousXdg = process.env['XDG_RUNTIME_DIR'];
    const previousTmpdir = process.env['TMPDIR'];
    // The macOS CI shape: long DREAMUX_ROOT, no $XDG_RUNTIME_DIR, but a short
    // PRIVATE $TMPDIR keeps the Codex socket within budget instead of failing loudly.
    process.env['DREAMUX_ROOT'] = join(runtimeDir, 'h'.repeat(120));
    delete process.env['XDG_RUNTIME_DIR'];
    process.env['TMPDIR'] = join(runtimeDir, 't');

    try {
      const socket = allocateRuntimeSocketPath('codex app-server socket');
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
    process.env['DREAMUX_ROOT'] = join(runtimeDir, 'h'.repeat(120));
    process.env['XDG_RUNTIME_DIR'] = join(runtimeDir, 'xdg');

    try {
      const socket = allocateRuntimeSocketPath('codex app-server socket');
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

  it('does not require an on-disk workspace dispatcher skill', async () => {
    // Bundled skills are injected at runtime via `skills/extraRoots/set`
    // (issue #209 slice 6), so a ready Codex home needs no `.codex/skills`
    // symlink — the doctor passes without one.
    writeDispatcherHome('flow');

    const result = await validateDispatcherCodexHome('flow', { env: {} });

    expect(result.ok).toBe(true);
    expect(result.errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('dispatcher skill')]),
    );
  });
});

function writeDispatcherHome(
  dispatcherId: string,
  options: { writeAuth?: boolean } = {},
): void {
  mkdirSync(dispatcherCodexHome(dispatcherId), { recursive: true });
  if (options.writeAuth !== false) {
    writeFileSync(join(dispatcherCodexHome(dispatcherId), 'auth.json'), '{}', {
      mode: 0o600,
    });
  }
}
