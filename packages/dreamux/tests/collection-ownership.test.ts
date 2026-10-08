import { describe, expect, it, vi } from 'vitest';
import { TeammateCollection } from '../src/service/agent/index.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

describe('Collections own entity retention and eviction', () => {
  it('observes the Team close fact, removes that owner and serves only its terminal durable record', async () => {
    const f = await dispatcherFixture();
    const created = await f.teams.createFromRequest(teamRequest());
    const service = await f.teams.open(created.team_name);
    expect(await f.teams.open(created.team_name)).toBe(service);
    const fact = vi.fn();
    void service.closed.then(fact);
    await service.dissolve({ note: 'Done', force: true });
    const closed = await service.closed;
    expect(fact).toHaveBeenCalledOnce();
    expect(closed).toMatchObject({
      kind: 'team.closed',
      team_id: created.team_name,
    });
    await expect(f.teams.open(created.team_name)).rejects.toMatchObject({
      code: 'TEAM_CLOSED',
    });
    expect((await f.teams.summary(created.team_name)).status).toBe('closed');
    expect(f.provider.runtimes).toHaveLength(0);
  });

  it('observes the Agent close fact and deduplicates its successor without letting an old close evict it', async () => {
    const f = await dispatcherFixture();
    await f.host.start();
    const members = f.host.teammates;
    if (!(members instanceof TeammateCollection))
      throw new Error('expected real member owner');
    const first = await members.spawn({
      name: 'reviewer',
      prompt: 'First work',
      intent: 'Test ownership',
    });
    const original = members.materializedEntities()[0]!;
    expect(original).toBeDefined();
    const observed = vi.fn();
    void original.closed.then(observed);
    await members.close({ name: first.teammate.name, note: 'First close' });
    expect(await original.closed).toMatchObject({
      kind: 'teammate.closed',
      name: first.teammate.name,
    });
    expect(observed).toHaveBeenCalledOnce();
    expect(members.materializedEntities()).toEqual([]);
    const [left, right] = await Promise.all([
      members.send({ name: first.teammate.name, prompt: 'Second work' }),
      members.send({ name: first.teammate.name, prompt: 'Third work' }),
    ]);
    expect(left.status).toBe('submitted');
    expect(right.status).toBe('submitted');
    const successor = members.materializedEntities()[0]!;
    expect(successor).not.toBe(original);
    expect(members.materializedEntities()).toHaveLength(1);
    expect(f.provider.runtimes).toHaveLength(2);
    await original.close({ note: 'Repeated old close' });
    expect(members.materializedEntities()).toEqual([successor]);
    expect(f.provider.runtimes[1]!.inputs).toEqual([
      '<task>Second work</task>',
      '<task>Third work</task>',
    ]);
  });
});
