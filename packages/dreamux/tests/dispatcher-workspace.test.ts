import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configuredDispatcherCwd,
  diagnoseDispatcherWorkspace,
  ensureDispatcherWorkspace,
} from '../src/service/dispatcher-workspace.js';
import {
  defaultWorkspaceWorkPath,
  directWorkspaceWorkPath,
  managedWorkspaceGitignorePath,
  managedWorkspaceDir,
  managedWorktreePath,
  managedWorktreeRoot,
  repoDisambiguatedSlug,
} from '../src/service/worktree/paths.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import {
  dreamuxRoot,
  dispatcherAgentTurnsPath,
  dispatcherChannelBindingsPath,
  dispatcherCollaborationSpacesPath,
  isRealPathUnderDreamuxRoot,
  isUnderDreamuxRoot,
  resetRuntimeConfig,
} from '../src/platform/paths.js';
import { Server } from '../src/server.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { codexAgentRuntimeCatalog } from './helpers/fake-agent-runtime.js';

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

describe('dispatcher workspace cwd contract (issue #182 PR-4)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-workspace-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
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
        // Q2: provider implementations live in the catalog, not Server seams.
        agentRuntimeProviderCatalog: codexAgentRuntimeCatalog(),
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
        // Q2: provider implementations live in the catalog, not Server seams.
        agentRuntimeProviderCatalog: codexAgentRuntimeCatalog(),
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

    it('fails loud on ambiguous v2 bindings for disabled dispatchers', async () => {
      const config = testDreamuxConfig([
        testDispatcherConfig({
          id: 'flow',
          cwd: join(root, 'disabled-workspace'),
          enabled: false,
        }),
      ]);
      await writeJson(dispatcherChannelBindingsPath('flow'), {
        version: 2,
        bindings: [
          {
            channel_id: 'primary',
            provider: 'builtin:feishu',
            target_type: 'group',
            target_key: 'chat-x',
            display: null,
            canonical_url: null,
            meta: { chat_id: 'chat-x', chat_type: 'group' },
            team_name: 'gamma',
            leader_name: 'lead-1',
            active: true,
            created_at: 1,
            updated_at: 1,
            deactivated_at: null,
          },
        ],
      });
      await writeJson(dispatcherCollaborationSpacesPath('flow'), {
        version: 1,
        spaces: [],
        targets: [
          {
            version: 1,
            dispatcher_id: 'flow',
            space_name: 'space-a',
            channel_id: 'primary',
            provider: 'builtin:feishu',
            container_key: 'container-a',
            binding_generation: 1,
            target_key: 'chat-x',
            target_type: 'group',
            target_display: null,
            team_name: 'gamma',
            leader_name: 'lead-1',
            worktree_slug: 'space-a-chat-x',
            lifecycle_status: 'active',
            phase: 'bound',
            claim_event_id: null,
            close_event_id: null,
            last_error: null,
            created_at: 1,
            updated_at: 1,
            closed_at: null,
            detached_at: null,
          },
        ],
      });
      const server = new Server({
        config,
        adminSocketPath: join(root, 'admin.sock'),
        logger: noopLog(),
        channelLoggerFactory: () => noopLog(),
        agentRuntimeProviderCatalog: codexAgentRuntimeCatalog(),
      });

      await expect(server.start()).rejects.toThrow(
        /incompatible local state[\s\S]*version 2[\s\S]*open collaboration target route/,
      );
      await server.shutdown();
    });

    it('rejects a legacy Turn archive before starting a disabled dispatcher runtime', async () => {
      const config = testDreamuxConfig([
        testDispatcherConfig({
          id: 'flow',
          cwd: join(root, 'disabled-workspace'),
          enabled: false,
        }),
      ]);
      const archive = dispatcherAgentTurnsPath({
        dispatcherId: 'flow',
        name: 'reviewer',
        teamId: null,
        role: 'teammate',
      });
      await mkdir(dirname(archive), { recursive: true });
      writeFileSync(
        archive,
        `${JSON.stringify({ version: 1, type: 'settled', turn_id: 'old' })}\n`,
        { mode: 0o600 },
      );
      const server = new Server({
        config,
        adminSocketPath: join(root, 'admin.sock'),
        logger: noopLog(),
        channelLoggerFactory: () => noopLog(),
        agentRuntimeProviderCatalog: codexAgentRuntimeCatalog(),
      });

      await expect(server.start()).rejects.toThrow(
        /incompatible local state[\s\S]*legacy v1 Turn archive[\s\S]*Rebuild:/,
      );
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

  it('maps default work dirs under the workspace boundary or dispatcher dir', () => {
    expect(defaultWorkspaceWorkPath({ dispatcherWorkspace: workspace, slug: 'alpha' }))
      .toBe('/work/space/.workspace/work/alpha');
    expect(directWorkspaceWorkPath({ dispatcherWorkspace: workspace, slug: 'alpha' }))
      .toBe('/work/space');
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

describe('default workspace preparation (issue #199)', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'dreamux-default-workspace-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the self-ignored workspace boundary when workspace isolation is enabled', async () => {
    const manager = new WorktreeManager();
    const workspace = await manager.prepareDefaultWorkspace({
      dispatcherWorkspace: root,
      slug: 'alpha',
      workspaceEnabled: true,
    });

    expect(workspace.runtimeCwd).toBe(join(root, '.workspace', 'work', 'alpha'));
    expect((await stat(workspace.runtimeCwd)).isDirectory()).toBe(true);
    expect(readFileSync(managedWorkspaceGitignorePath(root), 'utf8')).toContain('*');
  });

  it('uses the dispatcher cwd directly when workspace isolation is disabled', async () => {
    const manager = new WorktreeManager();
    const workspace = await manager.prepareDefaultWorkspace({
      dispatcherWorkspace: root,
      slug: 'alpha',
      workspaceEnabled: false,
    });

    expect(workspace.runtimeCwd).toBe(root);
    expect(workspace.sourceCwd).toBe(root);
    await expect(stat(managedWorkspaceDir(root))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
