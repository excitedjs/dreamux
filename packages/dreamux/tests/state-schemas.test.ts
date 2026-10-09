import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultWorkspaceEnabled } from '../src/config/config.js';
import { loadConfig } from '../src/config/load.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
} from '../src/registry/index.js';
import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../src/service/agent/store.js';
import type { AgentEntityIdentity } from '../src/service/agent/identity.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import { TeamStore } from '../src/service/team/store.js';
import type { TeamRecord } from '../src/service/team/types.js';
import {
  agentIdentityPath,
  collectionEntityDir,
  dispatcherDir,
  dispatcherTeamDir,
  dispatcherTeamMateDir,
  dispatcherTeamRecordPath,
  dispatcherTeamScopeDir,
  dispatcherTeamTeamMateDir,
} from '../src/platform/paths.js';

const log = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
} as unknown as DreamuxLogger;

/**
 * Coverage cell G: CURRENT schemas (Identity, TeamRecord, cron store) and the
 * current config shape, exercised at the owning boundary rather than by
 * grepping source text. Positive round-trips prove the shape a fresh install
 * actually persists and reads back; the accompanying reject cases in
 * `legacy-state-fail-loud.test.ts` prove the removed shapes never come back
 * silently.
 */

describe('config parser accepts the current shape and rejects a dangling agent ref', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'dreamux-config-'));
    vi.stubEnv('DREAMUX_ROOT', configDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(configDir, { recursive: true, force: true });
  });

  async function writeConfig(body: unknown): Promise<void> {
    await writeFile(join(configDir, 'config.json'), JSON.stringify(body), {
      mode: 0o600,
    });
  }

  it('accepts top-level agents[] + dispatchers[].agentRuntime + channels[]', async () => {
    await writeConfig({
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
      dispatchers: [
        {
          id: 'flow',
          cwd: '/srv/flow',
          agentRuntime: 'flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    const { config } = await loadConfig();
    expect(Object.keys(config.agents)).toEqual(['flow']);
    expect(config.agents['flow']?.provider).toBe(BUILTIN_CODEX_PROVIDER_REF);
    expect(config.dispatchers).toHaveLength(1);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      cwd: '/srv/flow',
      agentRuntime: 'flow',
    });
    expect(config.dispatchers[0]!.channels).toHaveLength(1);
    expect(config.dispatchers[0]!.channels[0]!.provider).toBe(
      BUILTIN_FEISHU_PROVIDER_REF,
    );
  });

  it('rejects a dispatcher whose agentRuntime does not match any agents[].id', async () => {
    await writeConfig({
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
      dispatchers: [
        {
          id: 'flow',
          cwd: '/srv/flow',
          agentRuntime: 'does-not-exist',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    await expect(loadConfig()).rejects.toThrow(
      /agentRuntime='does-not-exist' does not match any agents\[\]\.id/,
    );
  });

  it('rejects a dispatcher without a cwd, enabled or not, naming its id', async () => {
    await writeConfig({
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
      dispatchers: [
        {
          id: 'flow',
          enabled: false,
          agentRuntime: 'flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    await expect(loadConfig()).rejects.toThrow(
      /dispatchers\[0\]\.cwd is required for dispatcher 'flow'/,
    );
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a non-string value', 42],
  ])(
    'rejects a dispatcher whose cwd is %s, like a missing one',
    async (_label, cwd) => {
      await writeConfig({
        agents: [
          { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
        ],
        dispatchers: [
          {
            id: 'flow',
            cwd,
            agentRuntime: 'flow',
            channels: [
              {
                id: 'primary',
                provider: BUILTIN_FEISHU_PROVIDER_REF,
                config: { app_id: 'app-flow', app_secret: 'secret-flow' },
              },
            ],
          },
        ],
      });
      await expect(loadConfig()).rejects.toThrow(
        /dispatchers\[0\]\.cwd is required for dispatcher 'flow'/,
      );
    },
  );

  it('rejects a dispatcher with no agentRuntime at all', async () => {
    await writeConfig({
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
      dispatchers: [
        {
          id: 'flow',
          cwd: '/srv/flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    await expect(loadConfig()).rejects.toThrow(/agentRuntime is required/);
  });

  /**
   * Workspace isolation policy, read through the real loader: an omitted
   * `workspace` block and an empty one both mean the default, and an explicit
   * boolean means itself. `defaultWorkspaceEnabled()` is the lookup every
   * workspace allocation goes through, so it is asserted beside the parsed
   * value.
   */
  for (const workspaceCase of [
    {
      label: 'an omitted workspace block',
      workspace: undefined,
      enabled: false,
    },
    { label: 'an empty workspace block', workspace: {}, enabled: false },
    { label: 'an explicit true', workspace: { enabled: true }, enabled: true },
    {
      label: 'an explicit false',
      workspace: { enabled: false },
      enabled: false,
    },
  ]) {
    it(`resolves ${workspaceCase.label} to workspace.enabled=${workspaceCase.enabled}`, async () => {
      await writeConfig({
        agents: [
          { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
        ],
        dispatchers: [
          {
            id: 'flow',
            cwd: '/srv/flow',
            agentRuntime: 'flow',
            ...(workspaceCase.workspace === undefined
              ? {}
              : { workspace: workspaceCase.workspace }),
            channels: [
              {
                id: 'primary',
                provider: BUILTIN_FEISHU_PROVIDER_REF,
                config: { app_id: 'app-flow', app_secret: 'secret-flow' },
              },
            ],
          },
        ],
      });
      const { config } = await loadConfig();
      expect(config.dispatchers[0]!.workspace).toEqual({
        enabled: workspaceCase.enabled,
      });
      expect(defaultWorkspaceEnabled(config, 'flow')).toBe(
        workspaceCase.enabled,
      );
    });
  }

  // The default loader imports real plugins without starting providers.
  it('accepts a builtin:feishu channel through the real default provider registry', async () => {
    await writeConfig({
      agents: [
        { id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
      ],
      dispatchers: [
        {
          id: 'flow',
          cwd: '/srv/flow',
          agentRuntime: 'flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    await expect(loadConfig()).resolves.toBeDefined();
  });
});

describe('AgentEntityIdentity: round-trip through the current schema', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dreamux-identity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseWorktree: AgentEntityIdentity['worktree'] = {
    mode: 'reuse-cwd',
    slug: null,
    path: '/tmp/run',
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };

  it('creates, reads back, and updates an identity with exactly the current fields', async () => {
    const store = new AgentIdentityStore({
      dir,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
    const created = await store.create({
      name: 'reviewer',
      agentRuntime: 'codex',
      sourceCwd: '/tmp/src',
      sourceRepo: null,
      cwd: '/tmp/run',
      runtimeCwd: '/tmp/run',
      worktree: baseWorktree,
    });
    expect(created.status).toBe('starting');
    expect(created.team_id).toBeNull();

    const read = await store.read();
    expect(read).toEqual(created);

    const updated = await store.update({ status: 'running' });
    expect(updated.status).toBe('running');
    expect(updated.updated_at).toBeGreaterThanOrEqual(created.updated_at);

    const readAfterUpdate = await store.read();
    expect(readAfterUpdate).toEqual(updated);
  });

  it('refuses to create a second identity at an occupied name (no silent overwrite)', async () => {
    const store = new AgentIdentityStore({
      dir,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
    await store.create({
      name: 'reviewer',
      agentRuntime: 'codex',
      sourceCwd: '/tmp/src',
      sourceRepo: null,
      cwd: '/tmp/run',
      runtimeCwd: '/tmp/run',
      worktree: baseWorktree,
    });
    await expect(
      store.create({
        name: 'reviewer',
        agentRuntime: 'claude',
        sourceCwd: '/tmp/src2',
        sourceRepo: null,
        cwd: '/tmp/run2',
        runtimeCwd: '/tmp/run2',
        worktree: baseWorktree,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('a collection lists occupied names by directory presence, even with an unreadable identity file', async () => {
    const root = join(dir, 'teammate');
    const collection = new AgentEntityCollectionStore({
      root,
      dispatcherId: 'flow',
      log,
    });
    await collection.entity('reviewer').create({
      name: 'reviewer',
      agentRuntime: 'codex',
      sourceCwd: '/tmp/src',
      sourceRepo: null,
      cwd: '/tmp/run',
      runtimeCwd: '/tmp/run',
      worktree: baseWorktree,
    });
    // Plant a second entity directory whose identity.json is garbage: the
    // directory itself is still the occupancy fact, so the name stays taken
    // even though `list()` cannot read a real identity out of it.
    await mkdir(collectionEntityDir(root, 'broken'), { recursive: true });
    await writeFile(
      agentIdentityPath(collectionEntityDir(root, 'broken')),
      'not json',
    );

    expect((await collection.names()).sort()).toEqual(['broken', 'reviewer']);
    const listed = await collection.list();
    expect(listed.map((identity) => identity.name)).toEqual(['reviewer']);
  });
});

describe('TeamRecord: round-trip through the current schema', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dreamux-team-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function baseTeamInput(
    teamId: string,
  ): Omit<
    TeamRecord,
    'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'
  > {
    return {
      dispatcher_id: 'flow',
      team_id: teamId,
      name: teamId,
      repo_cwd: '/tmp/repo',
      source_repo: null,
      leader_name: `tl-${teamId}-abcd`,
      leader_agent_runtime: 'codex',
      leader_identity_prompt: null,
      leader_skill_sources: [],
      runtime_cwd: '/tmp/repo',
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: '/tmp/repo',
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
      status: 'starting',
      intent: 'ship the feature',
      closed_at: null,
      close_note: null,
      create_request_id: null,
      create_payload_hash: null,
    };
  }

  it('creates, reads back, and updates a Team record with exactly the current fields', async () => {
    const store = new TeamStore({ root, dispatcherId: 'flow' });
    const handle = await store.acquire('team-alpha');
    const created = await handle.create(baseTeamInput('team-alpha'));
    expect(created).not.toBeNull();
    expect(created!.version).toBe(1);
    expect(created!.worktree_cleanup_force).toBe(false);

    const read = await store.get('team-alpha');
    expect(read).toEqual(created);

    const updated = await handle.update({ status: 'running' });
    expect(updated.status).toBe('running');
    const readAfterUpdate = await store.get('team-alpha');
    expect(readAfterUpdate).toEqual(updated);
    await handle.release();
  });

  it('create() returns null (not an overwrite) when a VALID record already owns the name', async () => {
    const store = new TeamStore({ root, dispatcherId: 'flow' });
    const handle = await store.acquire('team-alpha');
    await handle.create(baseTeamInput('team-alpha'));
    const second = await handle.create(baseTeamInput('team-alpha'));
    expect(second).toBeNull();
    // The original record is untouched by the losing attempt.
    const read = await store.get('team-alpha');
    expect(read!.leader_name).toBe('tl-team-alpha-abcd');
    await handle.release();
  });

  it('a concrete Team name is owned only while a VALID record exists there: a malformed record holds no claim', async () => {
    const store = new TeamStore({ root, dispatcherId: 'flow' });
    const handle = await store.acquire('team-beta');
    // Plant an unreadable/malformed record.json directly, bypassing create() —
    // `teamRoot()` is the store's own resolution of the entity directory, so
    // this test never re-derives the path itself.
    const teamDir = store.teamRoot('team-beta');
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, 'record.json'), 'not json at all');

    // get() reports no Team: a malformed record proves nothing.
    expect(await store.get('team-beta')).toBeNull();

    // create() at the same name succeeds — the malformed leftover holds no
    // claim on the name and is atomically replaced by the new, valid record.
    const created = await handle.create(baseTeamInput('team-beta'));
    expect(created).not.toBeNull();
    const read = await store.get('team-beta');
    expect(read!.team_id).toBe('team-beta');
    await handle.release();
  });
});

describe('cron job store: round-trip through the current schema', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dreamux-cron-'));
    path = join(dir, 'cron-jobs.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates, lists, updates, marks fired, and deletes a prompt-agent job', async () => {
    const store = new CronJobStore(path);
    const created = await store.create({
      cron: '0 9 * * *',
      tz: 'UTC',
      recurring: true,
      action: { kind: 'prompt-agent', prompt: 'daily stand-up' },
      nextRunAt: 1_700_000_000_000,
    });
    expect(created.enabled).toBe(true);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);

    const updated = await store.update(created.id, () => ({
      title: 'Stand-up',
    }));
    expect(updated.title).toBe('Stand-up');

    const fired = await store.setFired(
      {
        id: created.id,
        firedAt: 1_700_000_100_000,
      },
      () => ({ nextRunAt: 1_700_086_400_000, enabled: true }),
    );
    expect(fired!.last_fired_at).toBe(1_700_000_100_000);

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});

describe('path contracts: exact directory shape for state (platform/paths.ts)', () => {
  it('builds the documented {DREAMUX_HOME}/state/{dispatcher_id}/... shape', () => {
    const flowDir = dispatcherDir('flow');
    expect(flowDir.endsWith(join('state', 'flow'))).toBe(true);
    expect(agentIdentityPath(flowDir)).toBe(join(flowDir, 'identity.json'));

    const teammateDir = dispatcherTeamMateDir('flow');
    expect(teammateDir).toBe(join(flowDir, 'teammate'));
    expect(
      agentIdentityPath(collectionEntityDir(teammateDir, 'reviewer')),
    ).toBe(join(teammateDir, 'reviewer', 'identity.json'));

    const teamDir = dispatcherTeamDir('flow');
    expect(teamDir).toBe(join(flowDir, 'team'));
    const teamScope = dispatcherTeamScopeDir('flow', 'team-alpha');
    expect(teamScope).toBe(join(teamDir, 'team-alpha'));
    expect(dispatcherTeamRecordPath('flow', 'team-alpha')).toBe(
      join(teamScope, 'record.json'),
    );
    expect(agentIdentityPath(teamScope)).toBe(join(teamScope, 'identity.json'));
    expect(dispatcherTeamTeamMateDir('flow', 'team-alpha')).toBe(
      join(teamScope, 'teammate'),
    );
    expect(
      agentIdentityPath(
        collectionEntityDir(
          dispatcherTeamTeamMateDir('flow', 'team-alpha'),
          'builder',
        ),
      ),
    ).toBe(join(teamScope, 'teammate', 'builder', 'identity.json'));
  });

  it('two dispatcher ids never share a state directory (constructor-bound isolation)', () => {
    expect(dispatcherDir('flow-a')).not.toBe(dispatcherDir('flow-b'));
    expect(dispatcherTeamMateDir('flow-a')).not.toBe(
      dispatcherTeamMateDir('flow-b'),
    );
  });
});

describe('AgentIdentityStore: persistence root is constructor-bound, never record-selected', () => {
  let dirA: string;
  let dirB: string;

  const baseWorktree: AgentEntityIdentity['worktree'] = {
    mode: 'reuse-cwd',
    slug: null,
    path: '/tmp/run',
    branch: null,
    base_ref: null,
    cleanup: 'keep',
    cleanup_state: 'not-managed',
    cleanup_error: null,
  };

  beforeEach(async () => {
    dirA = await mkdtemp(join(tmpdir(), 'dreamux-store-a-'));
    dirB = await mkdtemp(join(tmpdir(), 'dreamux-store-b-'));
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('a store bound to dirA never reads or writes dirB, even for the same entity name', async () => {
    const storeA = new AgentIdentityStore({
      dir: dirA,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
    const storeB = new AgentIdentityStore({
      dir: dirB,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
    await storeA.create({
      name: 'reviewer',
      agentRuntime: 'codex',
      sourceCwd: '/tmp/src-a',
      sourceRepo: null,
      cwd: '/tmp/run-a',
      runtimeCwd: '/tmp/run-a',
      worktree: baseWorktree,
    });
    // storeB is bound to a completely different directory: it must report no
    // identity, never storeA's record, even though both share dispatcher/name.
    expect(await storeB.read()).toBeNull();
  });

  it("a record whose `name` disagrees with the store's expected (path-encoded) name is rejected", async () => {
    const store = new AgentIdentityStore({
      dir: dirA,
      dispatcherId: 'flow',
      expectedName: 'reviewer',
      log,
    });
    await writeFile(
      agentIdentityPath(dirA),
      JSON.stringify({
        version: 1,
        dispatcher_id: 'flow',
        name: 'someone-else', // disagrees with expectedName='reviewer'
        team_id: null,
        agent_runtime: 'codex',
        session_id: null,
        source_cwd: '/tmp/src',
        source_repo: null,
        cwd: '/tmp/run',
        runtime_cwd: '/tmp/run',
        worktree: baseWorktree,
        intent: null,
        identity_prompt: null,
        skill_sources: [],
        created_at: 1,
        updated_at: 1,
        status: 'running',
        last_error: null,
        closed_at: null,
        close_note: null,
      }),
    );
    // The mismatch is treated as an unreadable identity (logged and skipped),
    // not a promotion of the record's own `name` field to authority over the
    // directory the caller resolved.
    expect(await store.read()).toBeNull();
  });
});
