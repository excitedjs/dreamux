import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());

async function startingTeam() {
  const f = await dispatcherFixture({ channel: true });
  const created = await f.teams.createFromRequest(
    teamRequest('recover-starting'),
  );
  await f.host.close();
  const path = join(f.teamRoot, created.team_name, 'record.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...record, status: 'starting' }));
  const next = f.build();
  await next.host.channels.build();
  await next.host.channels.initialize(next.host.fence);
  const events: ChannelCoreEvent[] = [];
  const subscription = f.channel.sessions
    .get('fixture-channel')!
    .port!.events.subscribe((event) => {
      events.push(event);
    });
  const service = await next.teams.open(created.team_name);
  return { ...f, ...next, created, service, events, subscription };
}

describe('TeamLeader ordinary submission from durable recovery', () => {
  it('reports idle without creating or starting a dormant leader runtime', async () => {
    const f = await dispatcherFixture();
    const created = await f.teams.createFromRequest(teamRequest());
    expect(await f.teams.interruptLeader(created.team_name)).toEqual({
      status: 'idle',
    });
    expect(f.provider.runtimes).toHaveLength(0);
  });

  it("announces the input, then ends it with the provider's start error", async () => {
    const f = await startingTeam();
    const original = f.provider.createRuntime.bind(f.provider);
    vi.spyOn(f.provider, 'createRuntime').mockImplementationOnce(
      async (context) => {
        const runtime = await original(context);
        vi.spyOn(runtime, 'start').mockRejectedValueOnce(
          new Error('provider start failed'),
        );
        return runtime;
      },
    );
    await expect(
      f.service.submitInput({ source: 'task', text: 'First work' }),
    ).rejects.toThrow('provider start failed');
    const display = f.events.filter(
      (event) =>
        event.kind === 'teammate.input' || event.kind === 'teammate.activity',
    );
    expect(display).toEqual([
      expect.objectContaining({ kind: 'teammate.input' }),
      expect.objectContaining({
        kind: 'teammate.activity',
        activity: {
          kind: 'turn.ended',
          occurredAt: expect.any(Number),
          status: 'failed',
          reason: 'provider start failed',
        },
      }),
    ]);
    expect((await f.service.status()).status).toBe('starting');
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs).toEqual([]);
    f.subscription.unsubscribe();
  });

  it('marks a starting Team running once its leader has taken a turn', async () => {
    const f = await startingTeam();
    expect((await f.service.status()).status).toBe('starting');
    expect(
      (await f.service.submitInput({ source: 'task', text: 'First work' }))
        .status,
    ).toBe('submitted');
    expect((await f.service.status()).status).toBe('running');
    expect(
      f.events.filter((event) => event.kind === 'teammate.input'),
    ).toHaveLength(1);
    expect(
      f.events.filter(
        (event) =>
          event.kind === 'teammate.activity' &&
          event.activity.kind === 'turn.ended',
      ),
    ).toEqual([]);
    expect(f.provider.runtimes[0]!.inputs).toEqual(['<task>First work</task>']);
    f.subscription.unsubscribe();
  });
});
