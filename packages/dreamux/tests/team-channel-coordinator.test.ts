import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRouteOwner } from '../src/service/channel-service/index.js';
import { TeamChannelCoordinator } from '../src/service/dispatcher-service/team-channel-coordinator.js';
import { KeyedAsyncQueue } from '../src/service/serial-queue.js';
import { TeamDissolveInterruptedError } from '../src/service/team-collection/errors.js';
import type {
  AcceptedTeamDissolve,
  TeamDissolveRecord,
  TeamSummary,
} from '../src/service/team-collection/types.js';

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

function dissolveRecord(
  phase: TeamDissolveRecord['phase'],
): TeamDissolveRecord {
  return {
    operation_id: 'operation-alpha',
    requester_kind: 'dispatcher',
    leader_name: null,
    target_handoff_ids: [],
    note: 'finish safely',
    accepted_at: 1,
    phase,
    last_error: null,
    cleanup_attempts: 0,
    next_retry_at: null,
  };
}

function acceptedHandle(
  record: TeamDissolveRecord,
  completed: Promise<TeamSummary> = new Promise<TeamSummary>(() => {}),
): AcceptedTeamDissolve {
  return {
    operationId: record.operation_id,
    teamId: 'alpha',
    receipt: { accepted: true, team_name: 'alpha', status: 'closing' },
    logicalClosed: new Promise<TeamSummary>(() => {}),
    completed,
    dissolveSnapshot: () => record,
  };
}

function completedSummary(): TeamSummary {
  return { completed: true } as unknown as TeamSummary;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      return acceptedHandle(
        dissolveRecord('complete'),
        team.dissolve() as Promise<never>,
      );
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
      coordinator.dissolve({ teamId: 'alpha', note: 'done' }, Date.now()),
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
            return acceptedHandle(
              dissolveRecord('complete'),
              team.dissolve() as Promise<never>,
            );
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
    const dissolve = coordinator.dissolve(
      { teamId: 'alpha', note: 'done' },
      Date.now(),
    );
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

describe('TeamChannelCoordinator caller policy', () => {
  it('derives the absolute 9s deadline and spends only the remaining projection budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const record = dissolveRecord('waiting_for_team_idle');
    const dissolveTeam = vi.fn(async () => acceptedHandle(record));
    const coordinator = new TeamChannelCoordinator({
      teams: {} as never,
      channels: {} as never,
      collaborationSpaces: { dissolveTeam } as never,
    });

    const result = coordinator.dissolve(
      { teamId: 'alpha', note: 'finish safely' },
      1_000,
    );
    await vi.advanceTimersByTimeAsync(7_999);
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      accepted: true,
      team_name: 'alpha',
      status: 'closing',
    });
    expect(dissolveTeam).toHaveBeenCalledWith({
      teamId: 'alpha',
      note: 'finish safely',
      decisionDeadlineAt: 10_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the completed summary and clears the losing timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const summary = completedSummary();
    const coordinator = new TeamChannelCoordinator({
      teams: {} as never,
      channels: {} as never,
      collaborationSpaces: {
        dissolveTeam: async () => acceptedHandle(
          dissolveRecord('complete'),
          Promise.resolve(summary),
        ),
      } as never,
    });

    await expect(coordinator.dissolve(
      { teamId: 'alpha', note: 'finish safely' },
      1_000,
    )).resolves.toBe(summary);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('projects cleanup-pending on timeout without cancelling accepted work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const record = dissolveRecord('worktree_cleanup_pending');
    const completed = deferred<TeamSummary>();
    let backgroundSettled = false;
    void completed.promise.then(() => {
      backgroundSettled = true;
    });
    const coordinator = new TeamChannelCoordinator({
      teams: {} as never,
      channels: {} as never,
      collaborationSpaces: {
        dissolveTeam: async () => acceptedHandle(record, completed.promise),
      } as never,
    });

    const result = coordinator.dissolve(
      { teamId: 'alpha', note: 'finish safely' },
      1_000,
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({
      accepted: true,
      team_name: 'alpha',
      status: 'closed',
      worktree_cleanup: 'pending',
      message: 'Managed worktree cleanup continues in the background.',
    });

    completed.resolve(completedSummary());
    await Promise.resolve();
    expect(backgroundSettled).toBe(true);
  });

  it('projects the current phase on shutdown interruption and clears its timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const record = dissolveRecord('worktree_cleanup_pending');
    const coordinator = new TeamChannelCoordinator({
      teams: {} as never,
      channels: {} as never,
      collaborationSpaces: {
        dissolveTeam: async () => acceptedHandle(
          record,
          Promise.reject(new TeamDissolveInterruptedError()),
        ),
      } as never,
    });

    await expect(coordinator.dissolve(
      { teamId: 'alpha', note: 'finish safely' },
      1_000,
    )).resolves.toEqual({
      accepted: true,
      team_name: 'alpha',
      status: 'closed',
      worktree_cleanup: 'pending',
      message: 'Managed worktree cleanup continues in the background.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns only the accepted receipt for TeamLeader self-dissolve', async () => {
    const handle = acceptedHandle(dissolveRecord('waiting_for_team_idle'));
    const dissolveTeamForLeader = vi.fn(async () => handle);
    const coordinator = new TeamChannelCoordinator({
      teams: {} as never,
      channels: {} as never,
      collaborationSpaces: { dissolveTeamForLeader } as never,
    });
    const input = {
      lease: { teamId: 'alpha', leaderName: 'leader-alpha' },
      note: 'finish safely',
    };

    await expect(coordinator.dissolveForTeamLeader(input)).resolves
      .toBe(handle.receipt);
    expect(dissolveTeamForLeader).toHaveBeenCalledWith(input);
  });

  it('keeps TeamLeader channel tools inside the exact generation lease', async () => {
    const events: string[] = [];
    const withTeamLeaderLease = vi.fn(async (
      _lease: unknown,
      task: () => Promise<unknown>,
    ) => {
      events.push('lease.enter');
      try {
        return await task();
      } finally {
        events.push('lease.exit');
      }
    });
    const coordinator = new TeamChannelCoordinator({
      teams: { withTeamLeaderLease } as never,
      channels: {
        authorizeTeamLeaderEgress: async () => {
          events.push('channel.authorize');
        },
        invokeTool: async () => {
          events.push('channel.invoke');
          return 'invoked';
        },
      } as never,
      collaborationSpaces: {} as never,
    });

    await expect(coordinator.invokeChannelTool({
      channelId: 'primary',
      name: 'reply',
      arguments: { text: 'done' },
      caller: {
        kind: 'team_leader',
        teamId: 'alpha',
        leaderName: 'leader-alpha',
      },
    })).resolves.toBe('invoked');
    expect(withTeamLeaderLease).toHaveBeenCalledWith(
      { teamId: 'alpha', leaderName: 'leader-alpha' },
      expect.any(Function),
    );
    expect(events).toEqual([
      'lease.enter',
      'channel.authorize',
      'channel.invoke',
      'lease.exit',
    ]);
  });

  it('does not acquire a Team lease for Dispatcher channel tools', async () => {
    const withTeamLeaderLease = vi.fn();
    const invokeTool = vi.fn(async () => 'invoked');
    const coordinator = new TeamChannelCoordinator({
      teams: { withTeamLeaderLease } as never,
      channels: { invokeTool } as never,
      collaborationSpaces: {} as never,
    });

    await expect(coordinator.invokeChannelTool({
      name: 'reply',
      arguments: { text: 'done' },
      caller: { kind: 'dispatcher' },
    })).resolves.toBe('invoked');
    expect(withTeamLeaderLease).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenCalledOnce();
  });
});
