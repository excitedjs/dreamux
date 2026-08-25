import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { ChannelCoreEvent, DreamuxLogger } from '@excitedjs/dreamux-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetRuntimeConfig } from '../src/platform/paths.js';
import { AgentIdentityStore } from '../src/service/agent-entity/identity-store.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import { EntityTurn } from '../src/service/teammate-service/turn-recording.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

function noopLogger(): DreamuxLogger {
  const log = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as DreamuxLogger;
}

describe('core event owner publishers', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join('/tmp', 'dx-core-events-')));
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

  it('publishes only allowlisted Team and agent state payloads', async () => {
    const log = noopLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const events: ChannelCoreEvent[] = [];
    lease.source.on('team.state', (event) => { events.push(event); });
    lease.source.on('agent.state', (event) => { events.push(event); });

    const teamStore = new TeamStore(bus.publisher);
    await teamStore.claimName('dispatcher-a', 'team-a', 'event-test');
    let team = await teamStore.create({
      dispatcher_id: 'dispatcher-a',
      team_id: 'team-a',
      name: 'team-a',
      repo_cwd: root,
      source_repo: null,
      leader_name: 'leader-a',
      leader_agent_runtime: 'runtime-a',
      runtime_cwd: root,
      worktree: worktree(root),
      status: 'starting',
      intent: 'public event test',
      closed_at: null,
      close_note: null,
    }, 'event-test');
    team = await teamStore.update(team, { intent: 'non-public update' });
    await teamStore.update(team, { status: 'running' });

    const identities = new AgentIdentityStore(log, bus.publisher);
    let leader = await identities.create({
      dispatcherId: 'dispatcher-a',
      name: 'leader-a',
      role: 'team_leader',
      teamId: 'team-a',
      agentRuntime: 'runtime-a',
      sourceCwd: root,
      sourceRepo: null,
      cwd: root,
      runtimeCwd: root,
      worktree: worktree(root),
      status: 'starting',
    });
    leader = await identities.update(leader, { intent: 'updated leader intent' });
    await identities.update(leader, { status: 'running' });

    expect(events).toEqual([
      expect.objectContaining({ kind: 'team.state', status: 'starting' }),
      expect.objectContaining({ kind: 'team.state', status: 'running' }),
      expect.objectContaining({ kind: 'agent.state', status: 'starting' }),
      expect.objectContaining({ kind: 'agent.state', status: 'running' }),
    ]);
    for (const event of events) {
      expect(event).not.toHaveProperty('dispatcher_id');
      expect(event).not.toHaveProperty('source_repo');
      expect(event).not.toHaveProperty('cwd');
      expect(event).not.toHaveProperty('prompt');
      expect(event).not.toHaveProperty('error');
    }
    lease.revoke();
  });

  it('settles an entity Turn without publishing Channel Turn events', async () => {
    const log = noopLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const events: ChannelCoreEvent[] = [];
    lease.source.on('team.state', (event) => { events.push(event); });
    lease.source.on('agent.state', (event) => { events.push(event); });
    lease.source.on('binding.route', (event) => { events.push(event); });
    lease.source.on('binding.collaboration_space', (event) => { events.push(event); });

    const runtime = controllableRuntimeSubmission();
    const turn = new EntityTurn(
      runtime.submission,
      'channel',
      'private prompt',
      null,
      1,
      'member-a',
      null,
    );
    runtime.complete('private assistant');

    await expect(turn.settled).resolves.toMatchObject({ status: 'completed' });
    expect(events).toEqual([]);
    lease.revoke();
  });

  it('settles without consulting an unusable Dreamux home', async () => {
    const blockedHome = join(root, 'blocked-home');
    writeFileSync(blockedHome, 'not a directory');
    process.env['HOME'] = blockedHome;
    process.env['DREAMUX_ROOT'] = blockedHome;
    resetRuntimeConfig();

    const runtime = controllableRuntimeSubmission();
    const turn = new EntityTurn(
      runtime.submission,
      'channel',
      'private prompt',
      null,
      1,
      'member-a',
      null,
    );
    runtime.failCompletion(new Error('provider failed'));

    await expect(turn.settled).resolves.toMatchObject({
      status: 'failed',
      error: expect.objectContaining({ message: 'provider failed' }),
    });
  });
});

function worktree(path: string) {
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
