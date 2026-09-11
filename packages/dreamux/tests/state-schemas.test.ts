import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DreamuxLogger } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/config.js';
import {
  BUILTIN_CODEX_PROVIDER_REF,
  BUILTIN_FEISHU_PROVIDER_REF,
  createBuiltinProviderRegistry,
  type ProviderRegistry,
} from '../src/registry/index.js';
import {
  AgentEntityCollectionStore,
  AgentIdentityStore,
} from '../src/service/agent-entity/identity-store.js';
import type { AgentEntityIdentity } from '../src/service/agent-entity/types.js';
import { CronJobStore } from '../src/service/scheduler/store.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamRecord } from '../src/service/team-collection/types.js';
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

/**
 * A registry pre-seeded with a FAKE runnable implementation for each builtin
 * provider id, so `loadConfig()` never dynamically imports the real
 * `@excitedjs/feishu-channel` / `@excitedjs/agent-runtime-codex` packages.
 *
 * This isolates what THIS test file is responsible for — `config.ts`'s own
 * parse/validate/merge logic (coverage cell G) — from the separate provider
 * package loader (`src/registry/provider-loader.ts`), which is a different
 * module's contract. Because `loadProviderPackages` skips any ref whose
 * IMPLEMENTATION is already registered (see `isImplementationLoaded`),
 * pre-registering these fakes here never touches that loading path at all.
 * The last test in the config describe block below deliberately drops this
 * override so the real default path is covered end to end.
 */
function fakeProviderRegistry(): ProviderRegistry {
  const registry = createBuiltinProviderRegistry();
  registry.registerImplementation('feishu', {
    createSession: () => {
      throw new Error('fake channel provider: createSession not implemented');
    },
  });
  registry.registerImplementation('codex', {
    getCapabilities: () => ({ verbs: [], agent_runtimes: [] }),
    readRecentActivity: async () => [],
    createRuntime: () => {
      throw new Error('fake agent runtime provider: createRuntime not implemented');
    },
  });
  return registry;
}

describe('config parser accepts the current shape and rejects a dangling agent ref', () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'dreamux-config-'));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  async function writeConfig(body: unknown): Promise<void> {
    await writeFile(join(configDir, 'config.json'), JSON.stringify(body), {
      mode: 0o600,
    });
  }

  it('accepts top-level agents[] + dispatchers[].agentRuntime + channels[]', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
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
    const { config } = await loadConfig({ configDir, providerRegistry: fakeProviderRegistry() });
    expect(Object.keys(config.agents)).toEqual(['flow']);
    expect(config.dispatchers).toHaveLength(1);
    expect(config.dispatchers[0]).toMatchObject({
      id: 'flow',
      agentRuntime: 'flow',
      runtime: { provider: BUILTIN_CODEX_PROVIDER_REF },
    });
    expect(config.dispatchers[0]!.channels).toHaveLength(1);
    expect(config.dispatchers[0]!.channels[0]!.provider).toBe(
      BUILTIN_FEISHU_PROVIDER_REF,
    );
  });

  it('rejects a dispatcher whose agentRuntime does not match any agents[].id', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
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
    await expect(loadConfig({ configDir, providerRegistry: fakeProviderRegistry() })).rejects.toThrow(
      /agentRuntime='does-not-exist' does not match any agents\[\]\.id/,
    );
  });

  it('rejects a dispatcher with no agentRuntime at all', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
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
    await expect(loadConfig({ configDir, providerRegistry: fakeProviderRegistry() })).rejects.toThrow(/agentRuntime is required/);
  });

  it('rejects the removed Core Collaboration Space policy block as a named incompatible-configuration error', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
          agentRuntime: 'flow',
          channels: [
            {
              id: 'primary',
              provider: BUILTIN_FEISHU_PROVIDER_REF,
              collaborationSpace: { defaultBinding: { enabled: false } },
              config: { app_id: 'app-flow', app_secret: 'secret-flow' },
            },
          ],
        },
      ],
    });
    await expect(loadConfig({ configDir, providerRegistry: fakeProviderRegistry() })).rejects.toThrow(
      /collaborationSpace was removed\. Core no longer owns Collaboration Space policy/,
    );
  });

  it('rejects a top-level `codex` block (runtime config moved to a named agents[] entry)', async () => {
    await writeConfig({
      agents: [],
      dispatchers: [],
      codex: { bin: 'codex' },
    });
    await expect(loadConfig({ configDir, providerRegistry: fakeProviderRegistry() })).rejects.toThrow(
      /a top-level "codex" block is no longer supported/,
    );
  });

  it('rejects a dispatcher-level `runtime` block (moved to agents\\[\\])', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
          agentRuntime: 'flow',
          runtime: { provider: BUILTIN_CODEX_PROVIDER_REF, config: {} },
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
    await expect(loadConfig({ configDir, providerRegistry: fakeProviderRegistry() })).rejects.toThrow(
      /dispatchers\[0\]\.runtime is no longer supported/,
    );
  });

  /**
   * The REAL default path, with no fake registry: `loadConfig()` over
   * `createBuiltinProviderRegistry()` is the exact call `dreamux onboard` and
   * server startup make, so this dynamically imports and loads the real
   * `@excitedjs/feishu-channel` package.
   *
   * That provider exposes no `ref` and no `descriptor` member, and it does
   * not need to: registration identity is Core's, parsed from the configured
   * ref and held beside the implementation it registered. The channel loader
   * therefore accepts a provider on its capability shape alone
   * (`assertChannelProvider` in `src/channel/external-channel-provider.ts`),
   * exactly as the sibling `assertExternalAgentRuntimeProvider` does.
   * Substituting `fakeProviderRegistry()` here would defeat the entire point
   * of this test.
   */
  it('accepts a builtin:feishu channel through the real default provider registry', async () => {
    await writeConfig({
      agents: [{ id: 'flow', provider: BUILTIN_CODEX_PROVIDER_REF, config: {} }],
      dispatchers: [
        {
          id: 'flow',
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
    // No providerRegistry override: this is the exact call `loadOrInitConfig`
    // (and therefore `dreamux onboard` / server startup) makes.
    await expect(loadConfig({ configDir })).resolves.toBeDefined();
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

    const updated = await store.update(created, { status: 'running' });
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
    await writeFile(agentIdentityPath(collectionEntityDir(root, 'broken')), 'not json');

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
  ): Omit<TeamRecord, 'version' | 'created_at' | 'updated_at' | 'worktree_cleanup_force'> {
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
    const created = await store.create(baseTeamInput('team-alpha'));
    expect(created).not.toBeNull();
    expect(created!.version).toBe(1);
    expect(created!.worktree_cleanup_force).toBe(false);

    const read = await store.get('team-alpha');
    expect(read).toEqual(created);

    const updated = await store.update(created!, { status: 'running' });
    expect(updated.status).toBe('running');
    const readAfterUpdate = await store.get('team-alpha');
    expect(readAfterUpdate).toEqual(updated);
  });

  it('create() returns null (not an overwrite) when a VALID record already owns the name', async () => {
    const store = new TeamStore({ root, dispatcherId: 'flow' });
    await store.create(baseTeamInput('team-alpha'));
    const second = await store.create(baseTeamInput('team-alpha'));
    expect(second).toBeNull();
    // The original record is untouched by the losing attempt.
    const read = await store.get('team-alpha');
    expect(read!.leader_name).toBe('tl-team-alpha-abcd');
  });

  it('a concrete Team name is owned only while a VALID record exists there: a malformed record holds no claim', async () => {
    const store = new TeamStore({ root, dispatcherId: 'flow' });
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
    const created = await store.create(baseTeamInput('team-beta'));
    expect(created).not.toBeNull();
    const read = await store.get('team-beta');
    expect(read!.team_id).toBe('team-beta');
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
    const store = new CronJobStore({ cronJobsPath: path, dispatcherId: 'flow' });
    const created = await store.create(
      {
        cron: '0 9 * * *',
        tz: 'UTC',
        recurring: true,
        action: { kind: 'prompt-agent', prompt: 'daily stand-up' },
        nextRunAt: 1_700_000_000_000,
      },
      10,
    );
    expect(created.enabled).toBe(true);
    expect(created.dispatcher_id).toBe('flow');

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);

    const updated = await store.update({ id: created.id, title: 'Stand-up' });
    expect(updated.title).toBe('Stand-up');

    const fired = await store.setFired({
      id: created.id,
      firedAt: 1_700_000_100_000,
      nextRunAt: 1_700_086_400_000,
      enabled: true,
    });
    expect(fired!.last_fired_at).toBe(1_700_000_100_000);

    expect(await store.delete(created.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it('enforces the per-owner max job count', async () => {
    const store = new CronJobStore({ cronJobsPath: path, dispatcherId: 'flow' });
    await store.create(
      {
        cron: '0 9 * * *',
        tz: 'UTC',
        recurring: true,
        action: { kind: 'prompt-agent', prompt: 'x' },
        nextRunAt: null,
      },
      1,
    );
    await expect(
      store.create(
        {
          cron: '0 10 * * *',
          tz: 'UTC',
          recurring: true,
          action: { kind: 'prompt-agent', prompt: 'y' },
          nextRunAt: null,
        },
        1,
      ),
    ).rejects.toThrow(/already has the maximum 1 cron jobs/);
  });
});

describe('path contracts: exact directory shape for state (platform/paths.ts)', () => {
  it('builds the documented {DREAMUX_HOME}/state/{dispatcher_id}/... shape', () => {
    const flowDir = dispatcherDir('flow');
    expect(flowDir.endsWith(join('state', 'flow'))).toBe(true);
    expect(agentIdentityPath(flowDir)).toBe(join(flowDir, 'identity.json'));

    const teammateDir = dispatcherTeamMateDir('flow');
    expect(teammateDir).toBe(join(flowDir, 'teammate'));
    expect(agentIdentityPath(collectionEntityDir(teammateDir, 'reviewer'))).toBe(
      join(teammateDir, 'reviewer', 'identity.json'),
    );

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
        collectionEntityDir(dispatcherTeamTeamMateDir('flow', 'team-alpha'), 'builder'),
      ),
    ).toBe(join(teamScope, 'teammate', 'builder', 'identity.json'));
  });

  it('two dispatcher ids never share a state directory (constructor-bound isolation)', () => {
    expect(dispatcherDir('flow-a')).not.toBe(dispatcherDir('flow-b'));
    expect(dispatcherTeamMateDir('flow-a')).not.toBe(dispatcherTeamMateDir('flow-b'));
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

  it('a record whose `name` disagrees with the store\'s expected (path-encoded) name is rejected', async () => {
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
