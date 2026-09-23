/**
 * When the Team-level plugin hooks fire, against a real file-backed
 * `TeamCollection`: `dispatcher.hooks.team` (through `announceTeam`) on create
 * and rebuild, `beforeTeamLeaderLaunch` at every TeamLeader construction, and
 * `created` exactly once per newly created Team.
 */
import type { Team } from '@excitedjs/dreamux-types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { teamCreatePayloadHash } from '../src/service/team-collection/create-request.js';
import { TeamStore } from '../src/service/team-collection/store.js';
import type { TeamCollectionOptions } from '../src/service/team-collection/types.js';

import {
  buildRestartedTeamCollection,
  buildTeamCollectionHarness,
  mockLeaderSubmissionRejected,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';

let harness: TeamCollectionHarness | null = null;
let submission: { restore(): void } | null = null;

afterEach(async () => {
  submission?.restore();
  submission = null;
  await harness?.cleanup();
  harness = null;
});

interface Recorder {
  readonly events: string[];
  readonly announce: TeamCollectionOptions['announceTeam'];
}

/**
 * Taps every announced Team the way a plugin's `team` tap would, recording
 * each hook as `<event>:<team name>`.
 */
function recorder(onCreated?: (team: Team) => Promise<void>): Recorder {
  const events: string[] = [];
  return {
    events,
    announce(team, { origin }) {
      events.push(`team:${origin}:${team.name}`);
      team.hooks.beforeTeamLeaderLaunch.tapPromise('alpha', async () => {
        events.push(`beforeTeamLeaderLaunch:${team.name}`);
      });
      team.hooks.created.tapPromise('alpha', async ({ requestId }) => {
        events.push(`created:${team.name}:${requestId}`);
        await onCreated?.(team);
      });
    },
  };
}

function request(requestId: string, intent: string) {
  return {
    requestId,
    payloadHash: teamCreatePayloadHash({ intent }),
    options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent },
  };
}

describe('Team plugin hooks', () => {
  it('announces a created Team, builds its leader, then fires created once with the request id after it is running', async () => {
    let statusSeenByCreated: string | undefined;
    const hooks = recorder(async (team) => {
      statusSeenByCreated = (await harness!.seedStore.get(team.name))?.status;
    });
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });

    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));

    const name = created.team_name;
    expect(hooks.events).toEqual([
      `team:create:${name}`,
      `beforeTeamLeaderLaunch:${name}`,
      `created:${name}:req-1`,
    ]);
    expect(statusSeenByCreated).toBe('running');
  });

  it('never fires the leader or created hooks of an object discarded for a taken name', async () => {
    let calls = 0;
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({
      announceTeam: hooks.announce,
      nameSuffixGenerator: () => (calls++ === 0 ? 'lost' : 'won'),
    });
    // Another writer publishes at the first candidate between the probe and
    // this Team's own publication: the exclusive create answers null.
    const publish = vi.spyOn(TeamStore.prototype, 'create').mockResolvedValueOnce(null);
    submission = { restore: () => publish.mockRestore() };

    await harness.collection.createFromRequest(request('req-retry', 'needs a free name'));

    expect(hooks.events).toEqual([
      'team:create:alpha-lost',
      'team:create:alpha-won',
      'beforeTeamLeaderLaunch:alpha-won',
      'created:alpha-won:req-retry',
    ]);
  });

  it('fires nothing again for a replayed request, in process or after a restart', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    await harness.collection.createFromRequest(request('req-replay', 'ship it'));
    const afterCreate = [...hooks.events];

    await harness.collection.createFromRequest(request('req-replay', 'ship it'));
    await buildRestartedTeamCollection(harness, hooks.announce)
      .createFromRequest(request('req-replay', 'ship it'));

    expect(hooks.events).toEqual(afterCreate);
  });

  it('announces a rebuilt Team with origin rebuild and never fires created for it', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));
    hooks.events.length = 0;

    await buildRestartedTeamCollection(harness, hooks.announce).open(created.team_name);

    expect(hooks.events).toEqual([
      `team:rebuild:${created.team_name}`,
      `beforeTeamLeaderLaunch:${created.team_name}`,
    ]);
  });

  it('does not fire created when creation fails', async () => {
    const hooks = recorder();
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });
    submission = mockLeaderSubmissionRejected(new Error('runtime boom'));

    await expect(
      harness.collection.createFromRequest({
        ...request('req-fail', 'fails on the first prompt'),
        options: {
          namePrefix: 'alpha',
          leaderAgentRuntime: 'fake',
          intent: 'fails on the first prompt',
          prompt: 'first task',
        },
      }),
    ).rejects.toThrow(/runtime boom/);

    expect(hooks.events.some((event) => event.startsWith('created:'))).toBe(false);
  });

  it('keeps a created Team when a created tap rejects', async () => {
    const hooks = recorder(async () => {
      throw new Error('external action failed');
    });
    harness = await buildTeamCollectionHarness({ announceTeam: hooks.announce });

    const created = await harness.collection.createFromRequest(request('req-1', 'ship it'));

    expect(created.status).toBe('running');
    expect(hooks.events.at(-1)).toBe(`created:${created.team_name}:req-1`);
  });
});
