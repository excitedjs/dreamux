import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DreamuxConfig } from '../src/config/config.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import { dispatcherDir, resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig } from './helpers/config.js';
import { TeamMateIdentityStore } from '../src/service/teammate-collection/identity-store.js';

function configWith(id = 'flow'): DreamuxConfig {
  return {
    agents: {},
    dispatchers: [
      testDispatcherConfig({
        id,
        feishu: { app_id: 'app-x', app_secret: 'secret' },
      }),
    ],
  };
}

describe('dispatcher config projection store', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-store-'));
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

  it('does not import retired status.json runtime checkpoints', () => {
    const path = join(dispatcherDir('flow'), 'status.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      version: 1,
      dispatcher_id: 'flow',
      thread_id: 'thread-x',
      status: 'ready',
      updated_at: 123,
      last_started_at: 100,
      last_ready_at: 110,
      last_error: null,
      last_lost_thread_id: null,
    }), { mode: 0o600 });
    const store = new DispatcherStore(configWith());

    const row = store.get('flow');
    expect(row?.status).toBe('declared');
    expect(row).not.toHaveProperty('thread_id');
  });

  it('projects declared rows from config only', () => {
    const store = new DispatcherStore(configWith());

    const row = store.get('flow');
    expect(row?.status).toBe('declared');
    expect(row).not.toHaveProperty('thread_id');
  });
});

describe('dispatcher root identity authority', () => {
  let root: string;
  let previousHome: string | undefined;
  type DispatcherIdentityChange = Partial<{
    agentRuntime: string;
    cwd: string;
    runtimeCwd: string;
    worktreePath: string;
  }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-dispatcher-identity-'));
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

  it('upsert preserves compatible runtime recovery fields and dispatcher role', async () => {
    const identities = new TeamMateIdentityStore({ warn: () => {} });
    const workspace = join(root, 'workspace');
    const first = await identities.ensureDispatcherIdentity({
      dispatcherId: 'flow',
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: reuseCwd(workspace),
    });
    await identities.update(first, {
      sessionId: 'session-a',
      status: 'running',
      lastError: 'provider detail',
      turnCount: 3,
      lastPromptPreview: 'last prompt',
    });

    const ensured = await identities.ensureDispatcherIdentity({
      dispatcherId: 'flow',
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: reuseCwd(workspace),
    });

    expect(ensured).toMatchObject({
      name: 'dispatcher',
      role: 'dispatcher',
      team_id: null,
      agent_runtime: 'agent-a',
      session_id: 'session-a',
      status: 'running',
      last_error: 'provider detail',
      turn_count: 3,
      last_prompt_preview: 'last prompt',
    });
    await expect(identities.dispatcherIdentity('flow')).resolves.toMatchObject({
      role: 'dispatcher',
      session_id: 'session-a',
    });
    await expect(identities.list('flow')).resolves.toEqual([]);
    await expect(identities.get('flow', 'dispatcher')).rejects.toThrow(
      'reserved',
    );
  });

  it.each<[string, DispatcherIdentityChange]>([
    ['agent_runtime', { agentRuntime: 'agent-b' }],
    ['cwd', { cwd: 'workspace-b' }],
    ['runtime_cwd', { runtimeCwd: 'runtime-workspace-b' }],
    ['worktree', { worktreePath: 'worktree-b' }],
  ])('clears checkpoint/status/error when %s changes', async (_field, change) => {
    const identities = new TeamMateIdentityStore({ warn: () => {} });
    const workspace = join(root, 'workspace-a');
    const first = await identities.ensureDispatcherIdentity({
      dispatcherId: 'flow',
      agentRuntime: 'agent-a',
      sourceCwd: workspace,
      cwd: workspace,
      runtimeCwd: workspace,
      worktree: reuseCwd(workspace),
    });
    await identities.update(first, {
      sessionId: 'session-a',
      status: 'running',
      lastError: 'provider detail',
    });

    const cwd = change.cwd === undefined ? workspace : join(root, change.cwd);
    const runtimeCwd =
      change.runtimeCwd === undefined ? workspace : join(root, change.runtimeCwd);
    const worktreePath =
      change.worktreePath === undefined ? runtimeCwd : join(root, change.worktreePath);
    const ensured = await identities.ensureDispatcherIdentity({
      dispatcherId: 'flow',
      agentRuntime: change.agentRuntime ?? 'agent-a',
      sourceCwd: cwd,
      cwd,
      runtimeCwd,
      worktree: reuseCwd(worktreePath),
    });

    expect(ensured).toMatchObject({
      agent_runtime: change.agentRuntime ?? 'agent-a',
      cwd,
      runtime_cwd: runtimeCwd,
      session_id: null,
      status: 'stopped',
      last_error: null,
    });
  });
});

describe('dispatcher store channel identity resolution (multi-channel config)', () => {
  it('populates channel_identity from the single channel\'s provider-reported identity', () => {
    const store = new DispatcherStore({
      agents: {},
      dispatchers: [
        testDispatcherConfig({
          id: 'flow',
          feishu: { app_id: 'app-flow', app_secret: 'secret-flow' },
        }),
      ],
    });
    expect(store.get('flow')?.channel_identity).toBe('app-flow');
  });

  it('seeds the PRIMARY (first) channel identity from a multi-channel config (rowDefaults takes the first)', () => {
    // The state row seeds the dispatcher's primary (first) channel's neutral,
    // provider-reported identity (issue #209 de-leak). Config load now rejects
    // more than one channel per provider ref (Decision #4, issue #209), but the
    // store seeds whatever config it is handed: a directly-constructed
    // multi-channel config still produces a row, and `rowDefaults`
    // deterministically takes the first channel's `identity`. Store seeding never
    // throws on the identity — there is no per-row uniqueness guard.
    let store: DispatcherStore | undefined;
    expect(() => {
      store = new DispatcherStore({
        agents: {},
        dispatchers: [
          testDispatcherConfig({
            id: 'flow',
            channels: [
              {
                id: 'primary',
                provider: 'builtin:feishu',
                config: { app_id: 'app-a', app_secret: 'secret-a' },
                identity: 'app-a',
              },
              {
                id: 'secondary',
                provider: 'builtin:feishu',
                config: { app_id: 'app-b', app_secret: 'secret-b' },
                identity: 'app-b',
              },
            ],
          }),
        ],
      });
    }).not.toThrow();
    expect(store?.get('flow')?.channel_identity).toBe('app-a');
  });
});

function reuseCwd(path: string) {
  return {
    mode: 'reuse-cwd' as const,
    slug: null,
    path,
    branch: null,
    base_ref: null,
    cleanup: 'keep' as const,
    cleanup_state: 'not-managed' as const,
    cleanup_error: null,
  };
}
