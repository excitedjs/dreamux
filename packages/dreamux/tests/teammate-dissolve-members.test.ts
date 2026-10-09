import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { TeammateCollection } from '../src/service/agent/index.js';
import { AgentIdentityStore } from '../src/service/agent/store.js';
import type { TeammateOps } from '../src/service/agent/types.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());

async function membersFixture() {
  const f = await dispatcherFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  const members = team.teammates;
  if (!(members instanceof TeammateCollection))
    throw new Error('expected real member owner');
  const identityPath = (name: string) =>
    join(f.teamRoot, created.team_name, 'teammate', name, 'identity.json');
  const read = async (name: string) =>
    JSON.parse(await readFile(identityPath(name), 'utf8'));
  async function seed(
    name: string,
    status: 'running' | 'degraded' | 'closed' = 'running',
  ) {
    const store = new AgentIdentityStore({
      dir: join(f.teamRoot, created.team_name, 'teammate', name),
      dispatcherId: 'test',
      expectedName: name,
      log: f.log,
    });
    await store.create({
      name,
      teamId: created.team_name,
      agentRuntime: 'controlled',
      sourceCwd: f.host.cwd,
      sourceRepo: null,
      cwd: f.host.cwd,
      runtimeCwd: f.host.cwd,
      worktree: reuseCwdWorktree(f.host.cwd),
      status,
    });
    if (status === 'closed')
      await store.update({
        status: 'closed',
        closedAt: 1234,
        closeNote: 'already closed',
      });
    return store;
  }
  return { ...f, team, members, identityPath, read, seed };
}

describe('Team member destruction through the current collection owner', () => {
  it('closes every held member through its own AgentService and stops the actual runtime', async () => {
    const f = await membersFixture();
    const spawned = await f.members.spawn({
      name: 'held',
      prompt: 'Work',
      intent: 'Test close ownership',
    });
    const held = f.members.materializedEntities();
    expect(held).toHaveLength(1);
    const close = vi.spyOn(held[0]!, 'close');
    const stop = vi.spyOn(f.provider.runtimes[0]!.runtime, 'stop');
    await f.members.destroy('Team dissolved');
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ note: 'Team dissolved' });
    expect(stop).toHaveBeenCalledOnce();
    expect((await f.read(spawned.teammate.name)).status).toBe('closed');
    expect(f.members.materializedEntities()).toEqual([]);
  });

  it('closes cold open member identities without constructing services, launching hooks or starting runtimes', async () => {
    const f = await membersFixture();
    await f.seed('cold-one');
    await f.seed('cold-two', 'degraded');
    const launch = vi.fn();
    f.host.hooks.teammateLaunch.tap('observe-unbuilt', launch);
    await f.members.destroy('Team dissolved');
    for (const name of ['cold-one', 'cold-two']) {
      expect(await f.read(name)).toMatchObject({
        status: 'closed',
        close_note: 'Team dissolved',
        closed_at: expect.any(Number),
      });
    }
    expect(f.members.materializedEntities()).toEqual([]);
    expect(f.provider.runtimes).toHaveLength(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it('leaves an already-closed member identity byte-for-byte unchanged', async () => {
    const f = await membersFixture();
    await f.seed('already-closed', 'closed');
    const before = await readFile(f.identityPath('already-closed'), 'utf8');
    await f.members.destroy('New note must not replace old note');
    expect(await readFile(f.identityPath('already-closed'), 'utf8')).toBe(
      before,
    );
    expect(f.provider.runtimes).toHaveLength(0);
  });

  it('never record-closes a held member whose runtime stop fails and still closes cold members', async () => {
    const f = await membersFixture();
    f.provider.planNext({ stopFailures: [new Error('runtime stop failed')] });
    const held = await f.members.spawn({
      name: 'held-fails',
      prompt: 'Work',
      intent: 'Stop failure ownership',
    });
    await f.seed('cold-survivor');
    await expect(f.members.destroy('Team dissolved')).rejects.toThrow(
      'runtime stop failed',
    );
    expect((await f.read(held.teammate.name)).status).not.toBe('closed');
    expect((await f.read('cold-survivor')).status).toBe('closed');
  });

  it('refuses bulk destruction of a dispatcher-scoped member collection', async () => {
    const f = await dispatcherFixture();
    const members = f.host.teammates;
    if (!(members instanceof TeammateCollection))
      throw new Error('expected concrete dispatcher members');
    await expect(members.destroy('Forbidden bulk close')).rejects.toThrow(
      'bulk member dissolve is a Team capability',
    );
    expect(f.provider.runtimes).toHaveLength(0);
  });

  it('exposes no bulk-dissolve verb through the dispatcher TeamMate operations contract', async () => {
    expectTypeOf<
      Extract<
        keyof TeammateOps,
        'destroy' | 'closeAllForDissolve' | 'stopAllForDissolve'
      >
    >().toEqualTypeOf<never>();
    const f = await dispatcherFixture();
    const capabilities = await f.host.teammates.getCapabilities();
    expect(capabilities.verbs).toEqual([
      'spawn',
      'send',
      'close',
      'history',
      'list',
      'status',
      'last',
      'get_capabilities',
    ]);
  });
});
