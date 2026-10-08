import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelCoreEvent } from '@excitedjs/dreamux-types';
import * as nameAllocation from '../src/service/name-allocator.js';
import { TeamService } from '../src/service/team/service.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());

describe('Team creation persistence and lazy start through real owners', () => {
  it('publishes accepted request identity in the Team record without a separate ledger file', async () => {
    const f = await dispatcherFixture();
    const request = teamRequest('durable-request');
    const result = await f.teams.createFromRequest(request);
    const record = JSON.parse(
      await readFile(join(f.teamRoot, result.team_name, 'record.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      create_request_id: request.requestId,
      create_payload_hash: request.payloadHash,
    });
    expect(await readdir(f.teamRoot)).toEqual([result.team_name]);
    const entries = await readdir(join(f.teamRoot, result.team_name), {
      recursive: true,
    });
    expect(entries).toEqual(
      expect.arrayContaining(['identity.json', 'record.json']),
    );
    expect(entries.some((entry) => /ledger|idempotency/.test(entry))).toBe(
      false,
    );
  });

  it('returns one held-live leader status from create, summary, list and replay without resubmission', async () => {
    const f = await dispatcherFixture();
    const create = f.provider.createRuntime.bind(f.provider);
    vi.spyOn(f.provider, 'createRuntime').mockImplementation(
      async (context) => {
        const runtime = await create(context),
          start = runtime.start.bind(runtime);
        vi.spyOn(runtime, 'start').mockImplementation(async () => {
          const result = await start();
          await context.state.publish({ kind: 'status', status: 'ready' });
          return result;
        });
        return runtime;
      },
    );
    const request = teamRequest('active-replay', 'Start work');
    const created = await f.teams.createFromRequest(request);
    expect(await f.teams.summary(created.team_name)).toEqual(created);
    expect(await f.teams.createFromRequest(request)).toEqual(created);
    expect(await f.teams.list()).toEqual([
      expect.objectContaining({
        team_name: created.team_name,
        status: created.status,
        leader_state: created.leader_state,
      }),
    ]);
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs).toEqual(['<task>Start work</task>']);
    expect(created.leader_state).toBe('running');
    expect(created.leader_runtime_status).toBe('ready');
  });

  it('starts the prompted leader only after announcing its input and before admitting its initial turn', async () => {
    const f = await dispatcherFixture({ channel: true });
    await f.host.channels.build();
    await f.host.channels.initialize(f.host.fence);
    const order: string[] = [];
    const subscription = f.channel.sessions
      .get('fixture-channel')!
      .port!.events.subscribe((event) => {
        if (event.kind === 'teammate.input') order.push('input');
      });
    const original = f.provider.createRuntime.bind(f.provider);
    vi.spyOn(f.provider, 'createRuntime').mockImplementation(
      async (context) => {
        order.push('createRuntime');
        const runtime = await original(context);
        const start = runtime.start.bind(runtime);
        vi.spyOn(runtime, 'start').mockImplementation(async () => {
          order.push('start');
          return start();
        });
        const submit = runtime.submit.bind(runtime);
        vi.spyOn(runtime, 'submit').mockImplementation(async (input) => {
          order.push('submit');
          return submit(input);
        });
        return runtime;
      },
    );
    const created = await f.teams.createFromRequest(
      teamRequest('initial-turn', 'Do the work'),
    );
    expect(order).toEqual(['input', 'createRuntime', 'start', 'submit']);
    expect(created.status).toBe('running');
    expect(f.provider.runtimes[0]!.inputs).toEqual([
      '<task>Do the work</task>',
    ]);
    subscription.unsubscribe();
  });

  it('closes a failed prompted creation and replays its durable acceptance without another launch', async () => {
    const f = await dispatcherFixture({ channel: true });
    await f.host.channels.build();
    await f.host.channels.initialize(f.host.fence);
    const events: ChannelCoreEvent[] = [];
    const subscription = f.channel.sessions
      .get('fixture-channel')!
      .port!.events.subscribe((event) => {
        events.push(event);
      });
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
    const request = teamRequest('failed-start', 'Start this work');
    await expect(f.teams.createFromRequest(request)).rejects.toThrow(
      'provider start failed',
    );
    const rows = await f.teams.list();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('closed');
    const identity = JSON.parse(
      await readFile(join(f.teamRoot, row.team_name, 'identity.json'), 'utf8'),
    );
    expect(identity.status).toBe('closed');
    const record = JSON.parse(
      await readFile(join(f.teamRoot, row.team_name, 'record.json'), 'utf8'),
    );
    expect(record).toMatchObject({
      status: 'closed',
      create_request_id: request.requestId,
      create_payload_hash: request.payloadHash,
    });
    expect(await f.teams.createFromRequest(request)).toMatchObject(row);
    await f.host.close();
    expect(await f.build().teams.createFromRequest(request)).toMatchObject(row);
    expect(f.provider.runtimes).toHaveLength(1);
    expect(f.provider.runtimes[0]!.inputs).toEqual([]);
    const input = events.findIndex((event) => event.kind === 'teammate.input');
    const ended = events.findIndex(
      (event) =>
        event.kind === 'teammate.activity' &&
        event.activity.kind === 'turn.ended',
    );
    expect(input).toBeGreaterThanOrEqual(0);
    expect(ended).toBeGreaterThan(input);
    expect(JSON.stringify(events[ended])).toContain('provider start failed');
    subscription.unsubscribe();
  });

  it('skips an occupied candidate without touching its record or building a discarded leader', async () => {
    const f = await dispatcherFixture();
    const occupant = await f.teams.createFromRequest(teamRequest('occupant'));
    const prepare = vi.spyOn(
      WorktreeManager.prototype,
      'prepareDefaultWorkspace',
    );
    const before = await readFile(
      join(f.teamRoot, occupant.team_name, 'record.json'),
      'utf8',
    );
    const allocate = nameAllocation.allocateConcreteNameAsync;
    let offered = false;
    vi.spyOn(nameAllocation, 'allocateConcreteNameAsync').mockImplementation(
      async (input) => {
        if (input.kind === 'team' && !offered) {
          offered = true;
          expect(await input.accept(occupant.team_name)).toBe(false);
        }
        return allocate(input);
      },
    );
    const launches: string[] = [];
    f.host.hooks.team.tap('observe-candidate', (team) => {
      team.hooks.leaderLaunch.tapPromise('observe-launch', async () => {
        launches.push(team.id);
      });
    });
    const result = await f.teams.createFromRequest(
      teamRequest('fresh-request'),
    );
    expect(result.team_name).not.toBe(occupant.team_name);
    expect(
      await readFile(
        join(f.teamRoot, occupant.team_name, 'record.json'),
        'utf8',
      ),
    ).toBe(before);
    expect(launches).toEqual([result.team_name]);
    expect(prepare.mock.calls.map(([input]) => input.slug)).toEqual([
      result.team_name,
    ]);
    expect(f.provider.runtimes).toHaveLength(0);
    expect(await f.teams.list()).toHaveLength(2);
  });

  it('retries a candidate lost at record publication without constructing its leader', async () => {
    const f = await dispatcherFixture();
    const handoffs: string[] = [];
    const launches: string[] = [];
    f.host.hooks.team.tap('observe-publication', (team, event) => {
      expect(event.origin).toBe('create');
      handoffs.push(team.id);
      team.hooks.leaderLaunch.tapPromise('observe-launch', async () => {
        launches.push(team.id);
      });
    });
    let competingBytes = '';
    const createNew = TeamService.createNew;
    vi.spyOn(TeamService, 'createNew').mockImplementationOnce(
      async (deps, input) => {
        expect(deps.record.current).toBeNull();
        const create = deps.record.create.bind(deps.record);
        vi.spyOn(deps.record, 'create').mockImplementationOnce(
          async (record) => {
            // A second publication uses the same captured serialized owner
            // after the candidate probe, before this service can publish.
            expect(
              await create({
                ...record,
                create_request_id: 'competing-request',
              }),
            ).not.toBeNull();
            competingBytes = await readFile(
              join(f.teamRoot, input.teamId, 'record.json'),
              'utf8',
            );
            const result = await create(record);
            expect(result).toBeNull();
            return result;
          },
        );
        return createNew(deps, input);
      },
    );
    const result = await f.teams.createFromRequest(
      teamRequest('publication-race'),
    );
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]).not.toBe(result.team_name);
    expect(handoffs[1]).toBe(result.team_name);
    expect(launches).toEqual([result.team_name]);
    expect(f.provider.runtimes).toHaveLength(0);
    const discardedRoot = join(f.teamRoot, handoffs[0]!);
    expect(await readFile(join(discardedRoot, 'record.json'), 'utf8')).toBe(
      competingBytes,
    );
    expect(JSON.parse(competingBytes).create_request_id).toBe(
      'competing-request',
    );
    expect(await readdir(discardedRoot)).toEqual(['record.json']);
    expect(await readdir(join(f.teamRoot, result.team_name))).toEqual(
      expect.arrayContaining(['identity.json', 'record.json']),
    );
  });

  it('rebuilds one leader for concurrent ordinary uses and submits only through that materialized owner', async () => {
    const f = await dispatcherFixture();
    const created = await f.teams.createFromRequest(teamRequest('cold-owner'));
    await f.host.close();
    const next = f.build();
    const rebuild = vi.spyOn(TeamService, 'rebuild');
    const [left, right] = await Promise.all([
      next.teams.open(created.team_name),
      next.teams.open(created.team_name),
    ]);
    expect(left).toBe(right);
    expect(rebuild).toHaveBeenCalledTimes(1);
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
    expect(f.provider.runtimes[0]!.inputs).toEqual(['<task>Continue</task>']);
    await next.teams.dissolve(created.team_name, { note: 'Done', force: true });
    await left.closed;
    expect((await next.teams.summary(created.team_name)).status).toBe('closed');
  });
});
