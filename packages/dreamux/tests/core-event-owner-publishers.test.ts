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
import {
  AgentTurnsStore,
  ASSISTANT_TEXT_MAX,
} from '../src/service/agent-entity/turns-store.js';
import { DispatcherCoreEventBus } from '../src/service/dispatcher-core-events/index.js';
import { TeamStore } from '../src/service/team-collection/store.js';

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
    mkdirSync(process.env['HOME'], { recursive: true });
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('publishes allowlisted Team, agent, and normalized turn payloads only', async () => {
    const log = noopLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const events: ChannelCoreEvent[] = [];
    for (const kind of [
      'team.state',
      'agent.state',
      'turn.submitted',
      'turn.settled',
    ] as const) {
      lease.source.on(kind, (event) => {
        events.push(event);
      });
    }

    const teamStore = new TeamStore(bus.publisher);
    let team = await teamStore.create({
      dispatcher_id: 'dispatcher-a',
      team_id: 'team-a',
      name: 'team-a',
      repo_cwd: root,
      source_repo: null,
      leader_name: 'leader-a',
      leader_agent_runtime: 'runtime-a',
      runtime_cwd: root,
      worktree: {
        mode: 'reuse-cwd',
        slug: null,
        path: root,
        branch: null,
        base_ref: null,
        cleanup: 'keep',
        cleanup_state: 'not-managed',
        cleanup_error: null,
      },
      status: 'starting',
      intent: 'public event test',
      closed_at: null,
      close_note: null,
    });
    team = await teamStore.update(team, { intent: 'non-public update' });
    await teamStore.update(team, { status: 'running' });

    const identities = new AgentIdentityStore(log, bus.publisher);
    const worktree = {
      mode: 'reuse-cwd' as const,
      slug: null,
      path: root,
      branch: null,
      base_ref: null,
      cleanup: 'keep' as const,
      cleanup_state: 'not-managed' as const,
      cleanup_error: null,
    };
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
      worktree,
      status: 'starting',
    });
    leader = await identities.update(leader, { lastSeenAt: 9 });
    await identities.update(leader, { status: 'running' });
    let member = await identities.create({
      dispatcherId: 'dispatcher-a',
      name: 'member-a',
      role: 'team_member',
      teamId: 'team-a',
      agentRuntime: 'runtime-a',
      sourceCwd: root,
      sourceRepo: null,
      cwd: root,
      runtimeCwd: root,
      worktree,
      status: 'starting',
    });
    member = await identities.update(member, { lastSeenAt: 10 });
    await identities.update(member, { status: 'degraded' });
    await identities.create({
      dispatcherId: 'dispatcher-a',
      name: 'standalone-a',
      role: 'teammate',
      teamId: null,
      agentRuntime: 'runtime-a',
      sourceCwd: root,
      sourceRepo: null,
      cwd: root,
      runtimeCwd: root,
      worktree,
      status: 'starting',
    });

    const turns = new AgentTurnsStore(log, bus.publisher);
    const leaderScope = {
      dispatcherId: 'dispatcher-a',
      name: 'leader-a',
      teamId: 'team-a',
      role: 'team_leader' as const,
    };
    await turns.appendSubmit(leaderScope, {
      turnId: null,
      turnOrigin: 'channel',
      prompt: 'not submitted',
      intent: null,
    });
    await turns.appendSubmit(leaderScope, {
      turnId: 'turn-a',
      turnOrigin: 'channel',
      prompt: 'private prompt',
      intent: 'private intent',
    });
    await turns.appendSettled(leaderScope, {
      turnId: 'turn-a',
      assistant: 'assistant result',
      assistantTruncated: true,
      settleStatus: 'completed',
    });

    expect(events).toEqual([
      {
        schema_version: 1,
        kind: 'team.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        leader_name: 'leader-a',
        status: 'starting',
      },
      {
        schema_version: 1,
        kind: 'team.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        leader_name: 'leader-a',
        status: 'running',
      },
      {
        schema_version: 1,
        kind: 'agent.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'leader-a',
        role: 'team_leader',
        status: 'starting',
      },
      {
        schema_version: 1,
        kind: 'agent.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'leader-a',
        role: 'team_leader',
        status: 'running',
      },
      {
        schema_version: 1,
        kind: 'agent.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'member-a',
        role: 'team_member',
        status: 'starting',
      },
      {
        schema_version: 1,
        kind: 'agent.state',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'member-a',
        role: 'team_member',
        status: 'degraded',
      },
      {
        schema_version: 1,
        kind: 'turn.submitted',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'leader-a',
        role: 'team_leader',
        turn_id: 'turn-a',
      },
      {
        schema_version: 1,
        kind: 'turn.settled',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'leader-a',
        role: 'team_leader',
        turn_id: 'turn-a',
        status: 'completed',
        assistant: 'assistant result',
        assistant_truncated: true,
      },
    ]);

    await turns.appendSettled(leaderScope, {
      turnId: 'turn-b',
      assistant: null,
      settleStatus: 'failed',
    });
    await turns.appendSettled(leaderScope, {
      turnId: 'turn-c',
      assistant: 'x'.repeat(ASSISTANT_TEXT_MAX + 1),
      settleStatus: 'stopped',
    });
    expect(events.at(-2)).toEqual({
      schema_version: 1,
      kind: 'turn.settled',
      occurred_at: expect.any(Number),
      team_name: 'team-a',
      agent_name: 'leader-a',
      role: 'team_leader',
      turn_id: 'turn-b',
      status: 'failed',
      assistant: null,
      assistant_truncated: false,
    });
    const capped = events.at(-1);
    expect(capped).toMatchObject({
      schema_version: 1,
      kind: 'turn.settled',
      occurred_at: expect.any(Number),
      team_name: 'team-a',
      agent_name: 'leader-a',
      role: 'team_leader',
      turn_id: 'turn-c',
      status: 'stopped',
      assistant_truncated: true,
    });
    if (capped?.kind !== 'turn.settled') {
      throw new Error('expected a settled event');
    }
    expect(capped.assistant).toHaveLength(ASSISTANT_TEXT_MAX);

    for (const event of events) {
      expect(event).not.toHaveProperty('dispatcher_id');
      expect(event).not.toHaveProperty('source_repo');
      expect(event).not.toHaveProperty('cwd');
      expect(event).not.toHaveProperty('prompt');
      expect(event).not.toHaveProperty('error');
    }
    lease.revoke();
  });

  it('publishes a runtime turn fact even when its archive append fails', async () => {
    const blockedHome = join(root, 'blocked-home');
    writeFileSync(blockedHome, 'not a directory');
    process.env['HOME'] = blockedHome;
    resetRuntimeConfig();

    const log = noopLogger();
    const bus = new DispatcherCoreEventBus({
      dispatcherId: 'dispatcher-a',
      log,
      maxSources: 1,
    });
    const lease = bus.createSource('channel-a');
    const events: ChannelCoreEvent[] = [];
    lease.source.on('turn.submitted', (event) => {
      events.push(event);
    });

    const turns = new AgentTurnsStore(log, bus.publisher);
    await turns.appendSubmit(
      {
        dispatcherId: 'dispatcher-a',
        name: 'member-a',
        teamId: 'team-a',
        role: 'team_member',
      },
      {
        turnId: 'turn-after-write-failure',
        turnOrigin: 'channel',
        prompt: 'private prompt',
        intent: null,
      },
    );

    expect(events).toEqual([
      {
        schema_version: 1,
        kind: 'turn.submitted',
        occurred_at: expect.any(Number),
        team_name: 'team-a',
        agent_name: 'member-a',
        role: 'team_member',
        turn_id: 'turn-after-write-failure',
      },
    ]);
    lease.revoke();
  });
});
