import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
afterEach(() => vi.restoreAllMocks());

async function teamFixture() {
  const f = await dispatcherFixture();
  const created = await f.teams.createFromRequest(teamRequest());
  const team = await f.teams.open(created.team_name);
  const delegate = createTeamMateMcpDelegate({ kind: 'team_leader', team });
  return { ...f, created, team, delegate };
}

describe('Leader tools admit owner access before invoking children', () => {
  it.each(['workflow_run', 'workflow_stop'] as const)(
    'finishes the owner access span before %s starts or reenters Team admission',
    async (name) => {
      const f = await teamFixture();
      let active = 0;
      const access = f.team.admitLeaderTools.bind(f.team);
      vi.spyOn(f.team, 'admitLeaderTools').mockImplementation(
        async <T>(operation: () => Promise<T>): Promise<T> => {
          active += 1;
          try {
            return await access(operation);
          } finally {
            active -= 1;
          }
        },
      );
      if (name === 'workflow_run') {
        vi.spyOn(f.team.workflows, 'run').mockImplementationOnce(async () => {
          expect(active).toBe(0);
          return f.team.admitLeaderTools(async () => ({
            run_id: 'nested-run',
          }));
        });
      } else {
        vi.spyOn(f.team.workflows, 'stop').mockImplementationOnce(async () => {
          expect(active).toBe(0);
          return f.team.admitLeaderTools(async () => ({
            run_id: 'nested-run',
            status: 'stopped' as const,
          }));
        });
      }
      expect(
        await f.delegate.call({
          name,
          arguments:
            name === 'workflow_run'
              ? { script: 'return null;' }
              : { run_id: 'nested-run' },
        }),
      ).toMatchObject({ ok: true, structured: { run_id: 'nested-run' } });
      expect(active).toBe(0);
    },
  );

  it('routes spawn, send and list through actual Team-owned collections and rejects stale leader access after closed', async () => {
    const f = await teamFixture();
    const stopping = deferred<void>();
    f.releases.push(() => stopping.resolve());
    f.provider.planNext({ stopBarrier: stopping.promise });
    const admission = vi.spyOn(f.team, 'admit');
    const spawned = await f.delegate.call({
      name: 'spawn',
      arguments: { name_prefix: 'member', intent: 'Work', prompt: 'First' },
    });
    expect(spawned).toMatchObject({
      ok: true,
      structured: { status: 'submitted' },
    });
    expect(admission).toHaveBeenCalled();
    const member = (await f.team.teammates.list())[0]!;
    expect(
      await f.delegate.call({
        name: 'send',
        arguments: { name: member.name, prompt: 'Second' },
      }),
    ).toMatchObject({ ok: true, structured: { status: 'submitted' } });
    expect(
      await f.delegate.call({ name: 'list', arguments: {} }),
    ).toMatchObject({
      ok: true,
      structured: {
        teammates: [expect.objectContaining({ name: member.name })],
      },
    });
    await f.team.dissolve({ note: 'Done', force: true });
    await f.provider.runtimes[0]!.stopStarted.promise;
    expect((await f.teams.summary(f.created.team_name)).status).toBe('closed');
    for (const call of [
      {
        name: 'spawn',
        arguments: { name_prefix: 'late', intent: 'Late', prompt: 'Late' },
      },
      { name: 'send', arguments: { name: member.name, prompt: 'Late' } },
      { name: 'list', arguments: {} },
      { name: 'workflow_run', arguments: { script: 'return null;' } },
    ])
      await expect(f.delegate.call(call)).rejects.toMatchObject({
        code: 'TEAM_CLOSED',
      });
    expect(f.provider.runtimes).toHaveLength(1);
    stopping.resolve();
    await f.team.closed;
  });
});
