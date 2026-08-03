import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CollaborationSpaceService } from '../src/service/collaboration-space/index.js';
import { CollaborationSpaceStore } from '../src/service/collaboration-space/store.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { AgentTurnsStore } from '../src/service/agent-entity/turns-store.js';
import { CompletionRouter } from '../src/service/completion-router/index.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { fakeChannels, log } from './helpers/collaboration-space.js';
import { FAKE_RUNTIME_REF, fakeRuntimeCatalog } from './helpers/fake-runtime.js';

const execFileAsync = promisify(execFile);

const CONTAINER = {
  container_type: 'topic_group',
  container_key: 'container-1',
} as const;

const TARGET = {
  target_type: 'topic',
  target_key: 'topic-1',
  bindable: true,
  display: 'Fix Login',
} as const;

/**
 * Prove the per-target `repo` creates a real managed worktree and that the
 * OWNER target-close path removes it — not space dissolve or harness teardown.
 * This drives a REAL `TeamCollection` + `WorktreeManager` against a REAL source
 * Git repo so the managed worktree is a genuine `git worktree`. `closeTarget`
 * (owner path) must dissolve the Team, remove the managed worktree directory,
 * and de-register it from `git worktree list`.
 */
describe('collaboration target per-target repo close cleanup', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-repo-close-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('dissolves the Team and removes the managed worktree on owner target-close', async () => {
    // A real source repo so the managed worktree is a real `git worktree`.
    const sourceRepoPath = join(root, 'source');
    mkdirSync(sourceRepoPath, { recursive: true });
    const sourceRepo = realpathSync(sourceRepoPath);
    const git = async (args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync('git', args, { cwd: sourceRepo });
      return stdout;
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
    writeFileSync(join(sourceRepo, 'README.md'), '# source\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    const listWorktrees = async (): Promise<string[]> =>
      (await git(['worktree', 'list', '--porcelain']))
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));

    // A real, operator-owned dispatcher workspace so managed worktrees resolve.
    const workspace = join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const config = testDreamuxConfig([
      testDispatcherConfig({
        id: 'flow',
        cwd: workspace,
        agentRuntime: 'agent-a',
        runtimeProvider: FAKE_RUNTIME_REF,
      }),
    ]);

    const teams = new TeamCollection({
      dispatcherId: 'flow',
      config,
      agentRuntimeProviders: fakeRuntimeCatalog(),
      worktrees: new WorktreeManager(),
      identities: new AgentIdentityStore(log as never),
      turnsStore: new AgentTurnsStore(log as never),
      router: new CompletionRouter({ dispatcherId: 'flow', log: log as never }),
      initiatorFor: async () => null,
      isShuttingDown: () => false,
      adminSocketPath: join(root, 'admin.sock'),
      leaderChannelDescriptors: () => [],
      log: log as never,
    });
    const channels = fakeChannels();
    const store = new CollaborationSpaceStore();
    const service = new CollaborationSpaceService({
      dispatcherId: 'flow',
      config,
      teams,
      channels: channels.service,
      store,
      log: log as never,
      isShuttingDown: () => false,
    });

    // Bind the space repo-less: the only managed repo comes from the target's
    // own per-target `repo`, exercising the per-target seam.
    await service.bind({
      spaceName: 'space-close',
      container: CONTAINER,
      leaderAgentRuntime: 'agent-a',
    });

    const provisioned = await service.provisionTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: CONTAINER,
      target: TARGET,
      repo: {
        path: sourceRepo,
        base_ref: 'HEAD',
      },
    });
    expect(provisioned).toMatchObject({ lifecycle_status: 'active' });
    const teamName = provisioned!.team_name;

    // The managed worktree is a real, additional `git worktree` of the source.
    const worktreesWhileActive = await listWorktrees();
    expect(worktreesWhileActive).toHaveLength(2);
    const managedPath = worktreesWhileActive.find((path) => path !== sourceRepo)!;
    expect(managedPath).toBeDefined();
    expect(existsSync(managedPath)).toBe(true);
    expect(await teams.isOpenTeam(teamName)).toBe(true);

    // The OWNER close path: dissolve the Team and delete its worktree.
    const closed = await service.closeTarget({
      channelId: 'primary',
      provider: 'builtin:test',
      container: CONTAINER,
      target: TARGET,
    });
    expect(closed.closed).toBe(true);
    expect(closed.target?.lifecycle_status).toBe('closed');

    // Team dissolved.
    expect(await teams.isOpenTeam(teamName)).toBe(false);
    await waitFor(() => !existsSync(managedPath));
    // Managed worktree directory gone from disk.
    expect(existsSync(managedPath)).toBe(false);
    // git worktree registration gone: only the source repo remains.
    const worktreesAfterClose = await listWorktrees();
    expect(worktreesAfterClose).toEqual([sourceRepo]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}
