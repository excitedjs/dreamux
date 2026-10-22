import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DREAMUX_MCP_LEASE_ENV } from '../src/mcp/launch.js';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { WorktreeManager } from '../src/service/worktree/manager.js';
import {
  deferred,
  type ControlledRuntime,
} from './helpers/controlled-runtime-provider.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

function leaderToken(
  runtime: ControlledRuntime,
  name: 'team' | 'teammate' = 'team',
): string {
  const token = runtime.context.mcpServers.find(
    (server) => server.name === name,
  )?.env?.[DREAMUX_MCP_LEASE_ENV];
  if (token === undefined)
    throw new Error(`missing actual leader ${name} lease`);
  return token;
}

describe('TeamLeader bound status through its runtime MCP lease', () => {
  it('reads the same full summary as Dispatcher status, only for its own Team, without changing records', async () => {
    const fixture = await dispatcherFixture();
    const dispatcher = createTeamMcpDelegate({ teams: fixture.teams });
    const first = await fixture.teams.createFromRequest(
      teamRequest('first-status', 'First Team work'),
    );
    const second = await fixture.teams.createFromRequest(
      teamRequest('second-status', 'Second Team work'),
    );
    const teams = [first, second];
    for (const [index, created] of teams.entries()) {
      const runtime = fixture.provider.runtimes[index]!;
      const sessionId = `leader-session-${index}`;
      await runtime.context.state.publish({ kind: 'session', sessionId });
      const token = leaderToken(runtime);
      const catalog = fixture.mcpLeases.catalog(token);
      expect(catalog.tools.map((tool) => tool.name).sort()).toEqual([
        'dissolve',
        'status',
      ]);
      expect(
        catalog.tools.find((tool) => tool.name === 'status'),
      ).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false },
      });
      const files = ['record.json', 'identity.json'].map((file) =>
        join(fixture.teamRoot, created.team_name, file),
      );
      const before = await Promise.all(
        files.map((file) => readFile(file, 'utf8')),
      );
      const expected = await dispatcher.call({
        name: 'status',
        arguments: { team_name: created.team_name },
      });
      expect(expected).toMatchObject({
        ok: true,
        structured: {
          team_name: created.team_name,
          intent: 'Review the implementation',
          leader_session_id: sessionId,
          runtime_cwd: created.runtime_cwd,
          member_count: 0,
        },
      });
      expect(
        await fixture.mcpLeases.invoke(token, {
          name: 'status',
          arguments: {},
        }),
      ).toEqual(expected);
      // Even a direct admin-socket caller cannot address another Team with this lease.
      expect(
        await fixture.mcpLeases.invoke(token, {
          name: 'status',
          arguments: { team_name: teams[1 - index]!.team_name },
        }),
      ).toEqual(expected);
      for (const name of ['list', 'history']) {
        expect(
          await fixture.mcpLeases.invoke(token, { name, arguments: {} }),
        ).toMatchObject({ ok: false });
      }
      expect(
        await Promise.all(files.map((file) => readFile(file, 'utf8'))),
      ).toEqual(before);
      expect(expected.ok && expected.structured).not.toHaveProperty('members');
    }

    await fixture.host.close();
    const restored = fixture.build();
    await restored.teams.submitToLeader(first.team_name, {
      source: 'task',
      text: 'Recover collaboration from the leader session',
      deliverCompletionToDispatcher: false,
    });
    const resumed = fixture.provider.runtimes.at(-1)!;
    expect(resumed.context.identity.sessionId).toBe('leader-session-0');
    expect(
      await fixture.mcpLeases.invoke(leaderToken(resumed), {
        name: 'status',
        arguments: {},
      }),
    ).toEqual({
      ok: true,
      structured: await restored.teams.summary(first.team_name),
    });
  });

  it('rejects leader status, member list and send after dissolve admission while the second worktree assessment delays the closed write', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(
      teamRequest('dissolve-assessment-status', 'Lead the work'),
    );
    const team = await fixture.teams.open(created.team_name);
    const leader = fixture.provider.runtimes[0]!;
    const token = leaderToken(leader);
    const membersToken = leaderToken(leader, 'teammate');
    await team.teammates.spawn({
      name: 'member',
      intent: 'Work',
      prompt: 'Start',
    });
    const member = (await team.teammates.list())[0]!;
    const memberRuntime = fixture.provider.runtimes[1]!;
    const inputs = [...memberRuntime.inputs];
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.releases.push(() => release.resolve());
    const assess = WorktreeManager.prototype.assessCleanup;
    let assessments = 0;
    const assessment = vi
      .spyOn(WorktreeManager.prototype, 'assessCleanup')
      .mockImplementation(async function (this: WorktreeManager, input) {
        if (++assessments === 2) {
          entered.resolve();
          await release.promise;
        }
        return assess.call(this, input);
      });
    const dispatcher = createTeamMcpDelegate({ teams: fixture.teams });
    const readStatus = () =>
      dispatcher.call({
        name: 'status',
        arguments: { team_name: created.team_name },
      });
    try {
      const dissolve = {
        name: 'dissolve',
        arguments: { note: 'Work complete' },
      };
      const receipt = { ok: true, structured: { status: 'submitted' } };
      expect(await fixture.mcpLeases.invoke(token, dissolve)).toEqual(receipt);
      await entered.promise;
      expect(
        JSON.parse(
          await readFile(
            join(fixture.teamRoot, created.team_name, 'record.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ status: 'running', closed_at: null });
      expect(await readStatus()).toMatchObject({
        ok: true,
        structured: { team_name: created.team_name, status: 'running' },
      });
      // A repeated dissolve still joins the admitted operation before its closed write.
      expect(await fixture.mcpLeases.invoke(token, dissolve)).toEqual(receipt);
      expect(assessment).toHaveBeenCalledTimes(2);
      for (const [lease, call] of [
        [membersToken, { name: 'list', arguments: {} }],
        [
          membersToken,
          {
            name: 'send',
            arguments: { name: member.name, prompt: 'Too late' },
          },
        ],
        [token, { name: 'status', arguments: {} }],
      ] as const) {
        expect(await fixture.mcpLeases.invoke(lease, call)).toMatchObject({
          ok: false,
          message: expect.stringContaining('TEAM_CLOSED'),
        });
      }
      expect(memberRuntime.inputs).toEqual(inputs);
    } finally {
      release.resolve();
      await team.closed;
      assessment.mockRestore();
    }
    expect(await readStatus()).toMatchObject({
      ok: true,
      structured: {
        team_name: created.team_name,
        status: 'closed',
        close_note: 'Work complete',
        closed_at: expect.any(Number),
      },
    });
  });

  it('returns the dissolve receipt before member stop, then refuses status and dissolve on the still-live leader lease', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(
      teamRequest('closing-status', 'Lead the work'),
    );
    const team = await fixture.teams.open(created.team_name);
    const token = leaderToken(fixture.provider.runtimes[0]!);
    const stopping = deferred<void>();
    fixture.releases.push(() => stopping.resolve());
    fixture.provider.planNext({ stopBarrier: stopping.promise });
    await team.teammates.spawn({
      name: 'member',
      intent: 'Work',
      prompt: 'Start',
    });

    expect(
      await fixture.mcpLeases.invoke(token, {
        name: 'dissolve',
        arguments: { note: 'Work complete' },
      }),
    ).toEqual({ ok: true, structured: { status: 'submitted' } });
    await fixture.provider.runtimes[1]!.stopStarted.promise;
    expect(() => fixture.mcpLeases.catalog(token)).not.toThrow();
    for (const name of ['status', 'dissolve']) {
      expect(
        await fixture.mcpLeases.invoke(token, {
          name,
          arguments: name === 'status' ? {} : { note: 'Too late' },
        }),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining('TEAM_CLOSED'),
      });
    }
    stopping.resolve();
    await team.closed;
    expect(
      await fixture.mcpLeases.invoke(token, { name: 'status', arguments: {} }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('MCP_LEASE_REVOKED'),
    });
  });

  it('keeps both bound tools behind Dispatcher admission', async () => {
    const fixture = await dispatcherFixture();
    await fixture.teams.createFromRequest(teamRequest('host-fence', 'Start'));
    const token = leaderToken(fixture.provider.runtimes[0]!);
    fixture.host.fence.close();
    for (const name of ['status', 'dissolve']) {
      expect(
        await fixture.mcpLeases.invoke(token, {
          name,
          arguments: name === 'status' ? {} : { note: 'After shutdown' },
        }),
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining('SERVER_SHUTTING_DOWN'),
      });
    }
  });
});
