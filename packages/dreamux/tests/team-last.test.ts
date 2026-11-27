import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeProvider } from '@excitedjs/dreamux-types';
import { TeamNotFoundError } from '../src/service/team/errors.js';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { TeamService } from '../src/service/team/service.js';
import { ServerShuttingDownError } from '../src/platform/errors.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

type Fixture = Awaited<ReturnType<typeof dispatcherFixture>>;

const DONE = {
  kind: 'assistant_message',
  text: 'Checked the diff',
} as const;
const CURRENT = {
  kind: 'assistant_message',
  text: 'Running the tests',
} as const;
const OLDER = { kind: 'assistant_message', text: 'Read the files' } as const;
const TOOL = { kind: 'tool', name: 'Read', status: 'completed' } as const;
const DONE_RECORD = { ...DONE, occurred_at: null };
const CURRENT_RECORD = { ...CURRENT, occurred_at: null };
const OLDER_RECORD = { ...OLDER, occurred_at: null };
const TOOL_RECORD = { ...TOOL, occurred_at: null };

/** Every activity read the fake provider answers. */
function answerActivity(provider: AgentRuntimeProvider<unknown>) {
  return vi
    .spyOn(provider, 'readRecentActivity')
    .mockImplementation(async (query) => ({
      records: query.includeTools ? [DONE, TOOL] : [DONE],
      truncated: false,
    }));
}

/** The leader's first turn is submitted and its session is published. */
async function startLeaderTurn(fixture: Fixture): Promise<void> {
  await fixture.provider.runtimes[0]!.submitStarted.promise;
  await fixture.provider.runtimes[0]!.context.state.publish({
    kind: 'session',
    sessionId: 'native-session',
  });
}

describe('team.last', () => {
  it('reads a held leader mid-turn over pages, leaving the active turn alone', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('live-last', 'First task'),
    );
    await startLeaderTurn(fixture);
    const provider: AgentRuntimeProvider<unknown> = fixture.provider;
    const read = vi
      .spyOn(provider, 'readRecentActivity')
      .mockImplementation(async (query) => {
        const first = query.cursor === undefined;
        const messages = first ? [DONE, CURRENT] : [OLDER];
        return {
          records: query.includeTools ? [...messages, TOOL] : messages,
          ...(first ? { nextCursor: 'native-cursor' } : {}),
          truncated: false,
          transcriptPath: '/native/session.jsonl.zst',
        };
      });
    const tool = createTeamMcpDelegate({ teams: fixture.teams });
    const page = { team_name: created.team_name, limit: 5 };

    // The first page holds the last completed message and the one in progress;
    // include_tools defaults to assistant messages only.
    const first = await tool.call({ name: 'last', arguments: page });
    expect(read).toHaveBeenLastCalledWith(
      { sessionId: 'native-session', limit: 5, includeTools: false },
      expect.anything(),
    );
    expect(first).toEqual({
      ok: true,
      structured: {
        team_status: 'running',
        leader_name: created.leader_name,
        records: [DONE_RECORD, CURRENT_RECORD],
        next_cursor: 'native-cursor',
        truncated: false,
        transcript_path: '/native/session.jsonl.zst',
      },
    });

    // The cursor reaches the page before it, under the same filter.
    const older = await tool.call({
      name: 'last',
      arguments: { ...page, cursor: 'native-cursor' },
    });
    expect(read).toHaveBeenLastCalledWith(
      {
        sessionId: 'native-session',
        cursor: 'native-cursor',
        limit: 5,
        includeTools: false,
      },
      expect.anything(),
    );
    expect(older).toMatchObject({
      ok: true,
      structured: { records: [OLDER_RECORD], next_cursor: null },
    });

    const withTools = await tool.call({
      name: 'last',
      arguments: { ...page, include_tools: true },
    });
    expect(withTools).toMatchObject({
      ok: true,
      structured: { records: [DONE_RECORD, CURRENT_RECORD, TOOL_RECORD] },
    });

    // Nothing was submitted, settled, or started by the reads.
    const leader = fixture.provider.runtimes[0]!;
    expect(fixture.provider.runtimes).toHaveLength(1);
    expect(leader.inputs).toHaveLength(1);
    expect(leader.submissions[0]!.isSettled()).toBe(false);
    leader.submissions[0]!.stop();
  });

  it('answers an open Team this process does not hold from its persisted leader, building nothing', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('cold-last', 'First task'),
    );
    await startLeaderTurn(fixture);
    await fixture.host.close();
    // Built, not started: a start would hold every open Team itself.
    const next = fixture.build();
    const read = answerActivity(fixture.provider);
    const rebuild = vi.spyOn(TeamService, 'rebuild');

    const result = await next.teams.last(created.team_name, {
      includeTools: false,
    });

    expect(rebuild).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(
      { sessionId: 'native-session', limit: 20, includeTools: false },
      expect.anything(),
    );
    expect(result).toMatchObject({
      team_status: 'running',
      leader_name: created.leader_name,
      records: [DONE_RECORD],
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
  });

  it('reads a closed Team from its record, while it is still held and after it is gone', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const leaderStop = deferred<void>();
    fixture.releases.push(() => leaderStop.resolve());
    fixture.provider.planNext({ stopBarrier: leaderStop.promise });
    const created = await fixture.teams.createFromRequest(
      teamRequest('closed-last', 'First task'),
    );
    await startLeaderTurn(fixture);
    const service = await fixture.teams.open(created.team_name);
    const leaderForRead = vi.spyOn(service, 'leaderForRead');
    answerActivity(fixture.provider);
    const tool = createTeamMcpDelegate({ teams: fixture.teams });

    await fixture.teams.dissolve(created.team_name, {
      note: 'Finished',
      force: true,
    });
    // The record is closed and the leader's stop has begun but not ended, so
    // the Team is still held while it is being torn down.
    await fixture.provider.runtimes[0]!.stopStarted.promise;
    expect(await fixture.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
    });
    const during = await tool.call({
      name: 'last',
      arguments: { team_name: created.team_name },
    });
    expect(during).toMatchObject({
      ok: true,
      structured: {
        team_status: 'closed',
        leader_name: created.leader_name,
        records: [DONE_RECORD],
      },
    });
    expect(leaderForRead).not.toHaveBeenCalled();

    leaderStop.resolve();
    await service.closed;
    expect(
      await tool.call({
        name: 'last',
        arguments: { team_name: created.team_name },
      }),
    ).toMatchObject({
      ok: true,
      structured: { team_status: 'closed', records: [DONE_RECORD] },
    });
    expect(leaderForRead).not.toHaveBeenCalled();
    expect(fixture.provider.runtimes).toHaveLength(1);
  });

  it('says a held leader that has not run has no session, and starts nothing', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    // No prompt: the leader exists and has never run a turn.
    const created = await fixture.teams.createFromRequest(teamRequest('idle'));
    const runtimes = fixture.provider.runtimes.length;
    const read = vi.spyOn(fixture.provider, 'readRecentActivity');

    await expect(
      createTeamMcpDelegate({ teams: fixture.teams }).call({
        name: 'last',
        arguments: { team_name: created.team_name },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_SESSION_UNAVAILABLE' });

    expect(read).not.toHaveBeenCalled();
    expect(fixture.provider.runtimes).toHaveLength(runtimes);
  });

  it('says a Team whose leader left no identity has no session', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('no-leader'),
    );
    await fixture.teams.dissolve(created.team_name, {
      note: 'Finished',
      force: true,
    });
    await rm(join(fixture.teamRoot, created.team_name, 'identity.json'));
    const read = vi.spyOn(fixture.provider, 'readRecentActivity');

    await expect(
      createTeamMcpDelegate({ teams: fixture.teams }).call({
        name: 'last',
        arguments: { team_name: created.team_name },
      }),
    ).rejects.toMatchObject({ code: 'ACTIVITY_SESSION_UNAVAILABLE' });

    expect(read).not.toHaveBeenCalled();
  });

  it('answers a Team that does not exist, and a bad page is the caller’s mistake', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('bad-page'),
    );
    const tool = createTeamMcpDelegate({ teams: fixture.teams });
    await expect(
      tool.call({ name: 'last', arguments: { team_name: 'ghost' } }),
    ).rejects.toBeInstanceOf(TeamNotFoundError);
    await expect(
      tool.call({
        name: 'last',
        arguments: { team_name: created.team_name, limit: 0 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is refused like every other Team read once the dispatcher is closing', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    await fixture.host.close();
    await expect(fixture.teams.last('any-team', {})).rejects.toBeInstanceOf(
      ServerShuttingDownError,
    );
  });
});
