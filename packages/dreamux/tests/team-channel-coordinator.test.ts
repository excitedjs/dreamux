import { describe, expect, it } from 'vitest';

import type { ChannelRouteOwner } from '../src/service/channel-service/index.js';
import { TeamChannelCoordinator } from '../src/service/dispatcher-service/team-channel-coordinator.js';

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
    withRoutableTeamOwner: async (
      _name: string,
      task: (owner: ChannelRouteOwner) => Promise<unknown>,
    ) => {
      if (routeError !== undefined) throw routeError;
      return task(OWNER);
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
    dissolveTeam: async () => {
      events.push('collaboration.detach_owner');
      events.push('channel.transfer_all');
      return team.dissolve();
    },
    mutateTargetRoute: async (_input: unknown, mutation: () => Promise<unknown>) => {
      events.push('collaboration.detach_target');
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
        async withRoutableTeamOwner<T>(
          _name: string,
          task: (owner: ChannelRouteOwner) => Promise<T>,
        ) {
          if (closing) throw new Error('Team "alpha" is closing');
          return task(OWNER);
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
