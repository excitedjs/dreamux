import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES,
  BUNDLED_SKILL_NAMES,
  adminSocketPath,
  dispatcherAccessPath,
  dispatcherDir,
  dispatcherFeishuAttachmentCacheDir,
  dispatcherTeamMateDir,
  dispatcherTeamMateHistoryPath,
  dispatcherTeamMateIdentitiesDir,
  dispatcherTeamMateIdentityPath,
  dispatcherTeamMateRuntimeDir,
  feishuChannelLogDir,
  feishuChannelLogPath,
  feishuMcpLogDir,
  feishuMcpLogPath,
  teammateMcpLogDir,
  teammateMcpLogPath,
  dispatcherStatusPath,
  dreamuxRoot,
  logsRoot,
  resetRuntimeConfig,
  serverJsonPath,
  serverLogPath,
  stateRoot,
  unixSocketPathFitsBudget,
} from '../src/platform/paths.js';
import {
  codexAppServerLogDir,
  codexSocketFallbackDir,
  codexSocketPathIn,
  dispatcherCodexAppServerErrorLogPath,
  dispatcherCodexAppServerLogPath,
  dispatcherSocketPath,
  dispatcherWorkspaceCodexSkillsDir,
  dispatcherWorkspaceSkillDirs,
  dispatcherWorkspaceSkillPath,
  teammateCodexAppServerErrorLogPath,
  teammateCodexAppServerLogPath,
} from '../src/agent-runtime/builtin/codex/paths.js';

describe('runtime paths', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousXdgRuntimeDir: string | undefined;
  let previousTmpdir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join('/tmp', 'dreamux-paths-'));
    previousHome = process.env['HOME'];
    previousXdgRuntimeDir = process.env['XDG_RUNTIME_DIR'];
    previousTmpdir = process.env['TMPDIR'];
    process.env['HOME'] = join(root, 'home');
    delete process.env['CODEX_HOST_RUNTIME_DIR'];
    delete process.env['CODEX_HOST_ADMIN_SOCKET'];
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    if (previousXdgRuntimeDir === undefined) delete process.env['XDG_RUNTIME_DIR'];
    else process.env['XDG_RUNTIME_DIR'] = previousXdgRuntimeDir;
    if (previousTmpdir === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmpdir;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses ~/.dreamux/state and ~/.dreamux/logs as the effective layout', () => {
    expect(dreamuxRoot()).toBe(join(homedir(), '.dreamux'));
    expect(stateRoot()).toBe(join(dreamuxRoot(), 'state'));
    expect(logsRoot()).toBe(join(dreamuxRoot(), 'logs'));
    expect(serverJsonPath()).toBe(join(stateRoot(), 'server.json'));
    expect(adminSocketPath()).toBe(join(stateRoot(), 'admin.sock'));

    expect(dispatcherDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a'),
    );
    expect(dispatcherStatusPath('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'status.json'),
    );
    expect(dispatcherAccessPath('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'access.json'),
    );
    expect(dispatcherFeishuAttachmentCacheDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'feishu-attachments'),
    );
    expect(dispatcherSocketPath('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'codex.sock'),
    );
    expect(dispatcherTeamMateDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate'),
    );
    expect(dispatcherTeamMateIdentitiesDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate', 'identities'),
    );
    expect(dispatcherTeamMateIdentityPath('dispatcher-a', 'reviewer-1')).toBe(
      join(
        stateRoot(),
        'dispatcher-a',
        'teammate',
        'identities',
        'reviewer-1.json',
      ),
    );
    expect(dispatcherTeamMateHistoryPath('dispatcher-a', 'reviewer-1')).toBe(
      join(
        stateRoot(),
        'dispatcher-a',
        'teammate',
        'history',
        'reviewer-1.jsonl',
      ),
    );
    expect(dispatcherTeamMateRuntimeDir('dispatcher-a', 'reviewer-1')).toBe(
      join(stateRoot(), 'dispatcher-a', 'teammate', 'runtime', 'reviewer-1'),
    );
    expect(teammateCodexAppServerLogPath('dispatcher-a', 'reviewer-1')).toBe(
      join(
        logsRoot(),
        'codex-app-server',
        'teammate',
        'dispatcher-a',
        'reviewer-1.log',
      ),
    );
    expect(teammateCodexAppServerErrorLogPath('dispatcher-a', 'reviewer-1')).toBe(
      join(
        logsRoot(),
        'codex-app-server',
        'teammate',
        'dispatcher-a',
        'reviewer-1.stderr.log',
      ),
    );
    const workspace = join(root, 'workspace');
    expect(dispatcherWorkspaceCodexSkillsDir(workspace)).toBe(
      join(workspace, '.codex', 'skills'),
    );
    expect(dispatcherWorkspaceSkillPath(workspace)).toBe(
      join(workspace, '.codex', 'skills', 'dispatcher', 'SKILL.md'),
    );
    expect(dispatcherWorkspaceSkillDirs(workspace)).toEqual(
      BUNDLED_SKILL_NAMES.map((skillName) =>
        join(workspace, '.codex', 'skills', skillName),
      ),
    );
  });

  it('places logs under component log directories', () => {
    expect(serverLogPath()).toBe(join(logsRoot(), 'dreamux-server.log'));
    expect(codexAppServerLogDir()).toBe(
      join(logsRoot(), 'codex-app-server'),
    );
    expect(dispatcherCodexAppServerLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'codex-app-server', 'dispatcher-a.log'),
    );
    expect(dispatcherCodexAppServerErrorLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'codex-app-server', 'dispatcher-a.stderr.log'),
    );
    expect(feishuChannelLogDir()).toBe(join(logsRoot(), 'feishu-channel'));
    expect(feishuChannelLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'feishu-channel', 'dispatcher-a.log'),
    );
    expect(feishuMcpLogDir()).toBe(join(logsRoot(), 'feishu-mcp'));
    expect(feishuMcpLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'feishu-mcp', 'dispatcher-a.log'),
    );
    expect(teammateMcpLogDir()).toBe(join(logsRoot(), 'teammate-mcp'));
    expect(teammateMcpLogPath('dispatcher-a')).toBe(
      join(logsRoot(), 'teammate-mcp', 'dispatcher-a.log'),
    );
  });

  it('rejects dispatcher ids that are not valid path segments', () => {
    expect(dispatcherDir('dispatcher-a')).toBe(
      join(stateRoot(), 'dispatcher-a'),
    );
    expect(() => dispatcherDir('team/alpha beta')).toThrow(/dispatcher id/);
    expect(() => dispatcherDir('team_alpha_beta')).not.toThrow();
  });

  it('rejects Unix socket paths that exceed the safe sun_path budget', () => {
    expect(unixSocketPathFitsBudget('x'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES)))
      .toBe(true);
    expect(
      unixSocketPathFitsBudget('x'.repeat(DREAMUX_UNIX_SOCKET_PATH_MAX_BYTES + 1)),
    ).toBe(false);

    process.env['HOME'] = join(root, 'h'.repeat(90));
    expect(() => adminSocketPath()).toThrow(/too long for Unix sockets/);
  });

  it('falls back to a short deterministic Codex socket when the runtime root blows the budget', () => {
    // The descriptive in-tree socket survives short roots untouched.
    const shortDir = dispatcherTeamMateRuntimeDir('dispatcher-a', 'reviewer-1');
    expect(codexSocketPathIn(shortDir, 'dispatcher-a')).toBe(
      join(shortDir, 'codex.sock'),
    );

    // A deep teammate runtime root (the macOS CI shape: long tmp HOME +
    // state/<dispatcher>/teammate/runtime/<name>/) exceeds the budget; the
    // socket must move to the short private fallback root instead of failing.
    // Pure path derivation — the XDG dir does not need to exist.
    process.env['HOME'] = join(root, 'h'.repeat(90));
    process.env['XDG_RUNTIME_DIR'] = '/run/user/424242';
    const longDir = dispatcherTeamMateRuntimeDir('dispatcher-a', 'alpha-leader');
    expect(
      unixSocketPathFitsBudget(join(longDir, 'codex.sock')),
    ).toBe(false);
    const fallback = codexSocketPathIn(longDir, 'dispatcher-a');
    expect(unixSocketPathFitsBudget(fallback)).toBe(true);
    expect(fallback.startsWith('/run/user/424242/dreamux-codex-')).toBe(true);
    expect(fallback.endsWith('.sock')).toBe(true);

    // Deterministic across restart/resume, unique per runtime root.
    expect(codexSocketPathIn(longDir, 'dispatcher-a')).toBe(fallback);
    const otherDir = dispatcherTeamMateRuntimeDir('dispatcher-a', 'beta-leader');
    expect(codexSocketPathIn(otherDir, 'dispatcher-a')).not.toBe(fallback);
  });

  it('never places the Codex socket fallback in a shared tmp root', () => {
    // The global-bin decision record rejects /tmp app-server sockets: with no
    // private runtime root available, the budget assertion stays fail-loud.
    delete process.env['XDG_RUNTIME_DIR'];
    process.env['TMPDIR'] = '/tmp';
    expect(codexSocketFallbackDir()).toBe(null);

    process.env['HOME'] = join(root, 'h'.repeat(90));
    const longDir = dispatcherTeamMateRuntimeDir('dispatcher-a', 'alpha-leader');
    expect(() => codexSocketPathIn(longDir, 'dispatcher-a')).toThrow(
      /too long for Unix sockets/,
    );

    // XDG_RUNTIME_DIR is operator input: a shared-tmp value must not bypass
    // the guard, whether it is the root itself or a subdirectory.
    for (const sharedXdg of ['/tmp', '/tmp/xdg', '/private/tmp', '/var/tmp/xdg']) {
      process.env['XDG_RUNTIME_DIR'] = sharedXdg;
      expect(codexSocketFallbackDir()).toBe(null);
      expect(() => codexSocketPathIn(longDir, 'dispatcher-a')).toThrow(
        /too long for Unix sockets/,
      );
    }

    // A shared-tmp XDG still allows a private tmpdir to serve as the root.
    process.env['XDG_RUNTIME_DIR'] = '/tmp/xdg';
    process.env['TMPDIR'] = '/var/folders/zz/zyzzyva/T';
    expect(codexSocketFallbackDir()).toBe('/var/folders/zz/zyzzyva/T');

    // A private (non-shared-tmp) tmpdir — the macOS per-user $TMPDIR shape —
    // is an acceptable fallback root. Pure env/path resolution; no fs access.
    delete process.env['XDG_RUNTIME_DIR'];
    expect(codexSocketFallbackDir()).toBe('/var/folders/zz/zyzzyva/T');
  });
});
