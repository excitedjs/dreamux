import { describe, expect, it } from 'vitest';

import type { ChannelRouteOwner } from '../src/service/channel-service/index.js';
import { TeamChannelCoordinator } from '../src/service/dispatcher-service/team-channel-coordinator.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';

const OWNER: ChannelRouteOwner = {
  kind: 'team',
  teamName: 'alpha',
  leaderName: 'leader-alpha',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function harness(routeError?: Error) {
  const events: string[] = [];
  const team = {
    dissolve: async () => {
      events.push('team.dissolve');
      return 'dissolved';
    },
  };
  const teams = {
    requireOpenTeamRouteOwner: async () => OWNER,
    requireRoutableTeamOwner: async () => {
      if (routeError !== undefined) throw routeError;
      return OWNER;
    },
    withTeamRouteClosing: async (
      _name: string,
      task: (owner: ChannelRouteOwner) => Promise<unknown>,
    ) => task(OWNER),
    get: async () => team,
  };
  const channels = {
    resolveChannelId: () => 'primary',
    resolveTarget: async () => ({
      target_type: 'group',
      target_key: 'chat-alpha',
      bindable: true,
      meta: { chat_id: 'chat-alpha' },
    }),
    bindResolvedTarget: async () => {
      events.push('channel.bind');
      return 'bound';
    },
    transferResolvedTargetBack: async () => {
      events.push('channel.transfer_back');
      return 'transferred';
    },
    transferAllForOwner: async () => {
      events.push('channel.transfer_all');
      return [];
    },
  };
  const collaborationSpaces = {
    bindTargetRoute: async () => {
      events.push('channel.bind');
      events.push('collaboration.detach_target');
      return 'bound';
    },
    bindLeasedTargetRoute: async (input: Record<string, unknown>) => {
      events.push('channel.bind.scoped');
      return input;
    },
    dissolveTeam: async () => {
      events.push('collaboration.detach_owner');
      events.push('channel.transfer_all');
      return team.dissolve();
    },
    mutateTargetRoute: async (_input: unknown, mutation: () => Promise<unknown>) => {
      events.push('collaboration.detach_target');
      return mutation();
    },
    mutateLeasedTargetRoute: async (
      _input: unknown,
      mutation: () => Promise<unknown>,
    ) => {
      events.push('collaboration.leased_target');
      return mutation();
    },
    detachTargetsForOwner: async () => {
      events.push('collaboration.detach_owner');
      return 0;
    },
  };
  const coordinator = new TeamChannelCoordinator({
    teams: teams as never,
    channels: channels as never,
    collaborationSpaces: collaborationSpaces as never,
  });
  return { coordinator, events };
}

describe('TeamChannelCoordinator collaboration ownership', () => {
  it('binds the explicit Team route before detaching collaboration intent', async () => {
    const { coordinator, events } = harness();

    await expect(
      coordinator.bind({ teamId: 'alpha', meta: { chat_id: 'chat-alpha' } }),
    ).resolves.toBe('bound');
    expect(events).toEqual(['channel.bind', 'collaboration.detach_target']);
  });

  it('does not detach or bind when the requested Team is not routable', async () => {
    const { coordinator, events } = harness(new Error('leader identity missing'));

    await expect(
      coordinator.bind({ teamId: 'alpha', meta: { chat_id: 'chat-alpha' } }),
    ).rejects.toThrow(/leader identity missing/);
    expect(events).toEqual([]);
  });

  it('forwards descriptor scope through the non-replacing TeamLeader bind path', async () => {
    const { coordinator, events } = harness();
    const lease = { teamId: 'alpha', leaderName: 'leader-alpha' };

    await expect(coordinator.bindForTeamLeader({
      lease,
      meta: { target: 'target-alpha' },
    })).resolves.toMatchObject({
      lease,
      channelId: 'primary',
      target: { target_key: 'chat-alpha' },
    });
    expect(events).toEqual(['channel.bind.scoped']);
  });

  it('detaches collaboration intent before transfer back', async () => {
    const { coordinator, events } = harness();

    await expect(
      coordinator.transferBack({
        expectedOwner: OWNER,
        meta: { chat_id: 'chat-alpha' },
      }),
    ).resolves.toBe('transferred');
    expect(events).toEqual([
      'collaboration.detach_target',
      'channel.transfer_back',
    ]);
  });

  it('keeps TeamLeader transfer generation validation inside target mutation', async () => {
    const { coordinator, events } = harness();

    await expect(coordinator.transferBackForTeamLeader({
      lease: { teamId: 'alpha', leaderName: 'leader-alpha' },
      meta: { chat_id: 'chat-alpha' },
    })).resolves.toBe('transferred');
    expect(events).toEqual([
      'collaboration.leased_target',
      'channel.transfer_back',
    ]);
  });

  it('takes the target lock before the scoped Team lease during close races', async () => {
    const events: string[] = [];
    const teamLocks = new KeyedAsyncQueue();
    const targetLocks = new KeyedAsyncQueue();
    const teamHeld = deferred<void>();
    const releaseTeam = deferred<void>();
    const transferTargetHeld = deferred<void>();
    const held = teamLocks.run('alpha', async () => {
      teamHeld.resolve();
      await releaseTeam.promise;
    });
    await teamHeld.promise;
    const teams = {
      withTeamLeaderLease<T>(
        _lease: unknown,
        task: () => Promise<T>,
      ): Promise<T> {
        events.push('team.request');
        return teamLocks.run('alpha', async () => {
          events.push('team.acquired');
          return task();
        });
      },
    };
    const channels = {
      resolveChannelId: () => 'primary',
      resolveTarget: () => ({
        target_type: 'group',
        target_key: 'chat-alpha',
        bindable: true,
      }),
      async transferResolvedTargetBack() {
        events.push('channel.transfer_back');
        return 'transferred';
      },
    };
    const collaborationSpaces = {
      mutateLeasedTargetRoute<T>(
        _input: unknown,
        mutation: () => Promise<T>,
      ): Promise<T> {
        return targetLocks.run('chat-alpha', async () => {
          events.push('transfer.target');
          transferTargetHeld.resolve();
          return teams.withTeamLeaderLease({}, mutation);
        });
      },
      mutateTargetRoute<T>(
        _input: unknown,
        mutation: () => Promise<T>,
      ): Promise<T> {
        return targetLocks.run('chat-alpha', mutation);
      },
    };
    const coordinator = new TeamChannelCoordinator({
      teams: teams as never,
      channels: channels as never,
      collaborationSpaces: collaborationSpaces as never,
    });

    const transfer = coordinator.transferBackForTeamLeader({
      lease: { teamId: 'alpha', leaderName: 'leader-alpha' },
      meta: { chat_id: 'chat-alpha' },
    });
    await transferTargetHeld.promise;
    expect(events).toEqual(['transfer.target', 'team.request']);
    const close = targetLocks.run('chat-alpha', async () => {
      events.push('close.target');
      await teamLocks.run('alpha', async () => {
        events.push('close.team');
      });
    });

    releaseTeam.resolve();
    await Promise.all([held, transfer, close]);
    expect(events).toEqual([
      'transfer.target',
      'team.request',
      'team.acquired',
      'channel.transfer_back',
      'close.target',
      'close.team',
    ]);
  });

  it('detaches every collaboration target before Team route release and close', async () => {
    const { coordinator, events } = harness();

    await expect(
      coordinator.dissolve({ teamId: 'alpha', note: 'done' }),
    ).resolves.toBe('dissolved');
    expect(events).toEqual([
      'collaboration.detach_owner',
      'channel.transfer_all',
      'team.dissolve',
    ]);
  });

  it('rejects a bind waiting on the route lock once Team dissolve starts', async () => {
    const events: string[] = [];
    const routeLocked = deferred<void>();
    const continueBind = deferred<void>();
    const routeReleased = deferred<void>();
    const closingAnnounced = deferred<void>();
    let routeHeld = false;
    let closing = false;
    const team = {
      async dissolve() {
        events.push('team.dissolve');
        return 'dissolved';
      },
    };
    const coordinator = new TeamChannelCoordinator({
      teams: {
        async requireRoutableTeamOwner() {
          return OWNER;
        },
        async withTeamRouteClosing<T>(
          _name: string,
          task: (owner: ChannelRouteOwner) => Promise<T>,
        ) {
          closing = true;
          closingAnnounced.resolve();
          try {
            return await task(OWNER);
          } finally {
            closing = false;
          }
        },
        async get() {
          return team;
        },
      } as never,
      channels: {
        resolveChannelId: () => 'primary',
        resolveTarget: async () => ({
          target_type: 'group',
          target_key: 'chat-alpha',
          bindable: true,
        }),
        async bindResolvedTarget() {
          events.push('channel.bind');
          return 'bound';
        },
        async transferAllForOwner() {
          events.push('channel.transfer_all');
          return [];
        },
      } as never,
      collaborationSpaces: {
        async bindTargetRoute() {
          routeHeld = true;
          routeLocked.resolve();
          await continueBind.promise;
          try {
            if (closing) throw new Error('Team "alpha" is closing');
            events.push('channel.bind');
            events.push('collaboration.detach_target');
            return 'bound';
          } finally {
            routeHeld = false;
            routeReleased.resolve();
          }
        },
        async dissolveTeam() {
          closing = true;
          closingAnnounced.resolve();
          if (routeHeld) await routeReleased.promise;
          events.push('collaboration.detach_owner');
          events.push('channel.transfer_all');
          try {
            return await team.dissolve();
          } finally {
            closing = false;
          }
        },
      } as never,
    });

    const bind = coordinator.bind({
      teamId: 'alpha',
      meta: { chat_id: 'chat-alpha' },
    });
    await routeLocked.promise;
    const dissolve = coordinator.dissolve({ teamId: 'alpha', note: 'done' });
    await closingAnnounced.promise;
    continueBind.resolve();

    await expect(bind).rejects.toThrow(/closing/);
    await expect(dissolve).resolves.toBe('dissolved');
    expect(events).toEqual([
      'collaboration.detach_owner',
      'channel.transfer_all',
      'team.dissolve',
    ]);
  });
});
