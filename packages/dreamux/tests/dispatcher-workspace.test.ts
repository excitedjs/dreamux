import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configuredDispatcherCwd,
  diagnoseDispatcherWorkspace,
  ensureDispatcherWorkspace,
} from '../src/dispatcher-service/dispatcher-workspace.js';
import {
  managedWorkspaceGitignorePath,
  managedWorktreePath,
  managedWorktreeRoot,
  repoDisambiguatedSlug,
} from '../src/dispatcher-service/teammate/worktree-paths.js';
import {
  dreamuxRoot,
  isRealPathUnderDreamuxRoot,
  isUnderDreamuxRoot,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { Server } from '../src/server.js';
import type { DreamuxLogger } from '../src/platform/logger.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const NO_CWD_MESSAGE = /no configured `cwd`/;

function noopLog(): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => log,
  };
  return log as unknown as DreamuxLogger;
}

describe('dispatcher workspace cwd contract (issue #182 PR-4)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-workspace-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a configured cwd to an absolute path and null when unset', () => {
    const configured = testDreamuxConfig([
      testDispatcherConfig({ id: 'flow', cwd: join(root, 'ws') }),
    ]);
    expect(configuredDispatcherCwd(configured, 'flow')).toBe(join(root, 'ws'));

    const unset = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd: null })]);
    expect(configuredDispatcherCwd(unset, 'flow')).toBeNull();

    const blank = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd: '   ' })]);
    expect(configuredDispatcherCwd(blank, 'flow')).toBeNull();
  });

  it('fails loud when a dispatcher declares no cwd — no state-dir fallback', async () => {
    const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd: null })]);
    await expect(ensureDispatcherWorkspace(config, 'flow')).rejects.toThrow(
      NO_CWD_MESSAGE,
    );
  });

  it('creates a missing configured cwd with mkdir -p semantics', async () => {
    const cwd = join(root, 'nested', 'workspace');
    const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
    const resolved = await ensureDispatcherWorkspace(config, 'flow');
    expect(resolved).toBe(cwd);
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it('rejects a configured cwd that is not a directory', async () => {
    const cwd = join(root, 'a-file');
    writeFileSync(cwd, 'not a dir');
    const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
    await expect(ensureDispatcherWorkspace(config, 'flow')).rejects.toThrow(
      /could not be created|not a directory/,
    );
  });

  it('rejects a configured cwd whose parent is unusable (mkdir fails)', async () => {
    const parentFile = join(root, 'blocker');
    writeFileSync(parentFile, 'i am a file, not a parent dir');
    const cwd = join(parentFile, 'workspace');
    const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
    await expect(ensureDispatcherWorkspace(config, 'flow')).rejects.toThrow(
      /could not be created|not (a )?directory|accessible/,
    );
  });

  describe('diagnoseDispatcherWorkspace (doctor, non-throwing)', () => {
    it('reports a missing cwd as a failure', async () => {
      const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd: null })]);
      const diagnosis = await diagnoseDispatcherWorkspace(config, 'flow');
      expect(diagnosis.ok).toBe(false);
      expect(diagnosis.detail).toMatch(/no configured `cwd`/);
    });

    it('reports an existing directory as ok', async () => {
      const cwd = join(root, 'ws');
      await mkdir(cwd, { recursive: true });
      const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
      const diagnosis = await diagnoseDispatcherWorkspace(config, 'flow');
      expect(diagnosis.ok).toBe(true);
      expect(diagnosis.detail).toBe(cwd);
    });

    it('reports a missing-but-configured dir as ok (created at startup)', async () => {
      const cwd = join(root, 'not-yet');
      const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
      const diagnosis = await diagnoseDispatcherWorkspace(config, 'flow');
      expect(diagnosis.ok).toBe(true);
      expect(diagnosis.detail).toMatch(/created at server startup/);
    });

    it('reports a non-directory cwd as a failure', async () => {
      const cwd = join(root, 'a-file');
      writeFileSync(cwd, 'file');
      const config = testDreamuxConfig([testDispatcherConfig({ id: 'flow', cwd })]);
      const diagnosis = await diagnoseDispatcherWorkspace(config, 'flow');
      expect(diagnosis.ok).toBe(false);
      expect(diagnosis.detail).toMatch(/not a directory/);
    });
  });

  describe('Server.start() pre-flight', () => {
    it('fails loud when an enabled dispatcher lacks an explicit cwd', async () => {
      const config = testDreamuxConfig([
        testDispatcherConfig({ id: 'flow', cwd: null, enabled: true }),
      ]);
      const server = new Server({
        config,
        adminSocketPath: join(root, 'admin.sock'),
        logger: noopLog(),
        channelLoggerFactory: () => noopLog(),
      });
      await expect(server.start()).rejects.toThrow(
        /dispatcher workspace cwd contract failed[\s\S]*flow[\s\S]*no configured `cwd`/,
      );
      await server.shutdown();
    });

    it('aggregates failures across multiple misconfigured dispatchers', async () => {
      const config = testDreamuxConfig([
        testDispatcherConfig({ id: 'flow', cwd: null, enabled: true }),
        testDispatcherConfig({
          id: 'docs',
          cwd: null,
          enabled: true,
          channelId: 'docs-primary',
          feishu: { app_id: 'app-docs', app_secret: 'secret-docs' },
        }),
      ]);
      const server = new Server({
        config,
        adminSocketPath: join(root, 'admin.sock'),
        logger: noopLog(),
        channelLoggerFactory: () => noopLog(),
      });
      const error = await server.start().then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      expect(error).not.toBeNull();
      expect(error).toMatch(/flow/);
      expect(error).toMatch(/docs/);
      await server.shutdown();
    });
  });

  describe('isUnderDreamuxRoot', () => {
    it('is true for the dreamux root itself and paths inside it', () => {
      expect(isUnderDreamuxRoot(dreamuxRoot())).toBe(true);
      expect(isUnderDreamuxRoot(join(dreamuxRoot(), 'state', 'flow', 'cwd'))).toBe(
        true,
      );
    });

    it('is false for sibling paths, including prefix-similar siblings', () => {
      expect(isUnderDreamuxRoot(join(root, 'home', 'projects'))).toBe(false);
      // `~/.dreamux-foo` shares a textual prefix but is NOT under `~/.dreamux`.
      expect(isUnderDreamuxRoot(`${dreamuxRoot()}-foo`)).toBe(false);
    });
  });

  describe('isRealPathUnderDreamuxRoot (symlink-safe)', () => {
    it('catches a path outside ~/.dreamux that symlinks into it', async () => {
      const target = join(dreamuxRoot(), 'state', 'sneaky');
      await mkdir(target, { recursive: true });
      const outsideLink = join(root, 'outside-link');
      await symlink(target, outsideLink);

      // Lexically outside (the pure check misses it)...
      expect(isUnderDreamuxRoot(outsideLink)).toBe(false);
      // ...but the symlink-safe check follows the link and rejects it.
      expect(await isRealPathUnderDreamuxRoot(outsideLink)).toBe(true);
    });

    it('is false for a genuine project dir outside ~/.dreamux', async () => {
      const project = join(root, 'home', 'projects', 'app');
      await mkdir(project, { recursive: true });
      expect(await isRealPathUnderDreamuxRoot(project)).toBe(false);
    });
  });
});

describe('managed worktree path builders (issue #182 PR-4)', () => {
  const workspace = '/work/space';

  it('roots managed worktrees under <workspace>/.workspace/worktree', () => {
    expect(managedWorktreeRoot(workspace)).toBe('/work/space/.workspace/worktree');
    expect(managedWorkspaceGitignorePath(workspace)).toBe(
      '/work/space/.workspace/.gitignore',
    );
  });

  it('maps the same repo to a stable repo-disambiguated slug', () => {
    const repo = '/home/dev/project';
    expect(repoDisambiguatedSlug(repo)).toBe(repoDisambiguatedSlug(repo));
    expect(repoDisambiguatedSlug(repo)).toMatch(/^project-[0-9a-f]{12}$/);
  });

  it('disambiguates different repos that share a basename', () => {
    const a = repoDisambiguatedSlug('/home/dev/project');
    const b = repoDisambiguatedSlug('/srv/other/project');
    expect(a).not.toBe(b);
    // Same human-readable prefix, different hash suffix.
    expect(a.startsWith('project-')).toBe(true);
    expect(b.startsWith('project-')).toBe(true);
  });

  it('sanitizes unsafe basenames into the slug', () => {
    const slug = repoDisambiguatedSlug('/home/dev/weird name@v2');
    expect(slug).toMatch(/^weird_name_v2-[0-9a-f]{12}$/);
  });

  it('places a worktree at <root>/<repo-slug>/<inner-slug> and sanitizes the inner slug', () => {
    const path = managedWorktreePath({
      dispatcherWorkspace: workspace,
      canonicalRepoRoot: '/home/dev/project',
      slug: 'team-alpha',
    });
    expect(path).toBe(
      `${managedWorktreeRoot(workspace)}/${repoDisambiguatedSlug('/home/dev/project')}/team-alpha`,
    );

    const sanitized = managedWorktreePath({
      dispatcherWorkspace: workspace,
      canonicalRepoRoot: '/home/dev/project',
      slug: 'has spaces/and@symbols',
    });
    expect(sanitized.endsWith('/has_spaces_and_symbols')).toBe(true);
  });
});
