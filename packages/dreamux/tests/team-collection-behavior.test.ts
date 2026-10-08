import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TeamCreateParams } from '@excitedjs/dreamux-types';
import { deferred } from './helpers/controlled-runtime-provider.js';
import {
  dispatcherFixture as fixture,
  teamRequest as request,
} from './helpers/real-dispatcher.js';

describe('Team collection through real owners', () => {
  it('creates a durable Team without starting its leader until the first submission', async () => {
    const f = await fixture();
    const created = await f.teams.createFromRequest(request());
    expect(created).toMatchObject({
      status: 'running',
      leader_name: expect.any(String),
    });
    expect(f.provider.runtimes).toHaveLength(0);
    expect(await f.teams.summary(created.team_name)).toEqual(created);
    expect(await f.teams.list()).toHaveLength(1);
    expect(f.provider.runtimes).toHaveLength(0);
    expect(
      JSON.parse(
        await readFile(
          join(f.teamRoot, created.team_name, 'record.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'running', create_request_id: 'request-one' });
    const input = {
      source: 'channel',
      text: 'Start review',
      sourceId: 'message-one',
      deliverCompletionToDispatcher: false,
    };
    expect(
      (await f.teams.submitToLeader(created.team_name, input)).status,
    ).toBe('submitted');
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs).toEqual([
      '<channel>Start review</channel>',
    ]);
    expect(
      (await f.teams.submitToLeader(created.team_name, input)).status,
    ).toBe('duplicate');
    expect(f.provider.runtimes[0]!.inputs).toHaveLength(1);
  });
  it('serializes same-request creation and replays before rerunning the create hook', async () => {
    const f = await fixture();
    const hook = vi.fn(async (input: TeamCreateParams) => input);
    f.host.hooks.createTeam.tapPromise('observe-create', hook);
    const [first, second] = await Promise.all([
      f.teams.createFromRequest(request()),
      f.teams.createFromRequest(request()),
    ]);
    expect(second).toEqual(first);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await f.teams.list()).toHaveLength(1);
    await expect(
      f.teams.createFromRequest({ ...request(), payloadHash: 'different' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.provider.runtimes).toHaveLength(0);
  });
  it('replays from disk after host release and deduplicates concurrent lazy materialization', async () => {
    const f = await fixture();
    const created = await f.teams.createFromRequest(request());
    await f.host.close();
    const next = f.build();
    const hook = vi.fn(async (input: TeamCreateParams) => input);
    next.host.hooks.createTeam.tapPromise('must-not-recreate', hook);
    expect(await next.teams.createFromRequest(request())).toEqual(created);
    expect(hook).not.toHaveBeenCalled();
    const [left, right] = await Promise.all([
      next.teams.open(created.team_name),
      next.teams.open(created.team_name),
    ]);
    expect(left).toBe(right);
    expect(f.provider.runtimes).toHaveLength(0);
    expect(
      (
        await next.teams.submitToLeader(created.team_name, {
          source: 'task',
          text: 'Continue',
          deliverCompletionToDispatcher: false,
        })
      ).status,
    ).toBe('submitted');
    expect(f.provider.runtimes).toHaveLength(1);
  });
  it('returns dissolve acceptance before runtime stop and keeps closed Teams readable', async () => {
    const f = await fixture();
    const stop = deferred<void>();
    f.releases.push(() => stop.resolve());
    f.provider.planNext({ stopBarrier: stop.promise });
    const created = await f.teams.createFromRequest(
      request('close-request', 'Start'),
    );
    const service = await f.teams.open(created.team_name);
    const receipt = await f.teams.dissolve(created.team_name, {
      note: 'Done',
      force: true,
    });
    expect(receipt).toEqual({
      accepted: true,
      team_name: created.team_name,
      status: 'submitted',
    });
    await f.provider.runtimes[0]!.stopStarted.promise;
    expect(await f.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
    });
    expect(await service.dissolve({ note: 'Repeated', force: true })).toEqual(
      receipt,
    );
    await expect(
      f.teams.submitToLeader(created.team_name, {
        source: 'task',
        text: 'Too late',
        deliverCompletionToDispatcher: false,
      }),
    ).rejects.toMatchObject({ code: 'TEAM_CLOSED' });
    stop.resolve();
    await expect(service.closed).resolves.toMatchObject({
      kind: 'team.closed',
      team_id: created.team_name,
    });
    expect(await f.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
    });
    expect(
      (await f.teams.createFromRequest(request('close-request', 'Start')))
        .status,
    ).toBe('closed');
    expect(f.provider.runtimes).toHaveLength(1);
  });
  it('rejects new collection work after dispatcher close before creating a Team', async () => {
    const f = await fixture();
    await f.host.close();
    await expect(f.teams.createFromRequest(request())).rejects.toMatchObject({
      code: 'SERVER_SHUTTING_DOWN',
    });
    await expect(f.teams.list()).rejects.toMatchObject({
      code: 'SERVER_SHUTTING_DOWN',
    });
    await expect(f.teams.summary('missing')).rejects.toMatchObject({
      code: 'SERVER_SHUTTING_DOWN',
    });
    expect(f.provider.runtimes).toHaveLength(0);
    await expect(readdir(f.teamRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a create admitted before host close cannot start its leader after the fence rises', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const resume = deferred<void>();
    f.releases.push(() => resume.resolve());
    f.host.hooks.createTeam.tapPromise('hold-create', async (input) => {
      entered.resolve();
      await resume.promise;
      return input;
    });
    const rejected = expect(
      f.teams.createFromRequest(request('racing-request', 'Must not start')),
    ).rejects.toMatchObject({ code: 'SERVER_SHUTTING_DOWN' });
    await entered.promise;
    const closing = f.host.close();
    expect(f.host.fence.isClosing()).toBe(true);
    resume.resolve();
    await rejected;
    await closing;
    expect(f.provider.runtimes).toHaveLength(0);
  });
});
