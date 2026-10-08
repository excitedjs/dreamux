import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TEAM_DISPATCH_SUCCESS_REMINDER,
  TEAMMATE_DISPATCH_SUCCESS_REMINDER,
  WORKFLOW_RUN_SUCCESS_REMINDER,
} from '../src/service/mcp/dispatch-reminders.js';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { createTeamMateMcpDelegate } from '../src/service/agent/mcp.js';
import type { TurnAdmission } from '../src/service/agent/turn.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());

describe('Team dispatch reminders', () => {
  it('attaches the Team reminder when a prompt was handed down', async () => {
    const f = await dispatcherFixture();
    await f.host.start();
    const result = await createTeamMcpDelegate({ teams: f.teams }).call({
      name: 'create',
      arguments: {
        name_prefix: 'blue',
        intent: 'Ship the refactor',
        leader_agent_runtime: 'controlled',
        prompt: 'Start design',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      text: TEAM_DISPATCH_SUCCESS_REMINDER,
    });
    expect(result).toMatchObject({
      text: expect.stringMatching(/do not poll.*completion/i),
    });
  });
  it('says nothing when no prompt was given', async () => {
    const f = await dispatcherFixture();
    const result = await createTeamMcpDelegate({ teams: f.teams }).call({
      name: 'create',
      arguments: {
        name_prefix: 'blue',
        intent: 'Ship the refactor',
        leader_agent_runtime: 'controlled',
      },
    });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('text');
    expect(f.provider.runtimes).toHaveLength(0);
  });
  it('preserves the admission receipt and tells the caller to wait for the push', async () => {
    const f = await dispatcherFixture();
    const receipt: TurnAdmission = {
      status: 'submitted',
      turn: {
        id: 'accepted-turn',
        settled: Promise.resolve({ status: 'completed', resultText: null }),
      },
    };
    vi.spyOn(f.teams, 'submitToLeader').mockResolvedValueOnce(receipt);
    const result = await createTeamMcpDelegate({ teams: f.teams }).call({
      name: 'send',
      arguments: { team_name: 'accepted-team', prompt: 'Continue' },
    });
    expect(result).toEqual({
      ok: true,
      structured: { status: 'submitted', turn_id: 'accepted-turn' },
      text: TEAM_DISPATCH_SUCCESS_REMINDER,
    });
    expect(result).toMatchObject({
      text: expect.stringMatching(/automatically push.*Do not poll/),
    });
  });
  it.each(['duplicate', 'stopped', 'skipped', 'failed', 'ambiguous'] as const)(
    'adds no reminder when admission is %s',
    async (status) => {
      const f = await dispatcherFixture();
      const admission: TurnAdmission =
        status === 'failed' || status === 'ambiguous'
          ? { status, error: new Error('not admitted') }
          : { status };
      vi.spyOn(f.teams, 'submitToLeader').mockResolvedValueOnce(admission);
      const result = await createTeamMcpDelegate({ teams: f.teams }).call({
        name: 'send',
        arguments: { team_name: 'accepted-team', prompt: 'Continue' },
      });
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('text');
    },
  );
});

async function scoped(kind: 'dispatcher' | 'team_leader') {
  const f = await dispatcherFixture();
  await f.host.start();
  if (kind === 'dispatcher')
    return {
      ...f,
      owner: f.host,
      delegate: createTeamMateMcpDelegate({ kind, dispatcher: f.host }),
    };
  const created = await f.teams.createFromRequest(teamRequest('reminder-team'));
  const team = await f.teams.open(created.team_name);
  return {
    ...f,
    owner: team,
    delegate: createTeamMateMcpDelegate({ kind, team }),
  };
}
describe.each(['dispatcher', 'team_leader'] as const)(
  '%s TeamMate dispatch reminders',
  (kind) => {
    describe.each(['spawn', 'send'] as const)('%s', (name) => {
      it.each([
        'submitted',
        'duplicate',
        'stopped',
        'failed',
        'ambiguous',
      ] as const)(
        'preserves the %s receipt and guides only submitted work',
        async (status) => {
          const f = await scoped(kind);
          const actual = await f.owner.teammates.spawn({
            name: 'fixture-member',
            prompt: 'Work',
            intent: 'Build a real status row',
          });
          const receipt = { teammate: actual.teammate, status };
          vi.spyOn(f.owner.teammates, 'spawn').mockResolvedValue(receipt);
          vi.spyOn(f.owner.teammates, 'send').mockResolvedValue(receipt);
          const result = await f.delegate.call({
            name,
            arguments:
              name === 'spawn'
                ? {
                    name_prefix: 'reviewer',
                    intent: 'Review',
                    prompt: 'Review',
                  }
                : { name: actual.teammate.name, prompt: 'Continue' },
          });
          expect(result).toMatchObject({ ok: true, structured: receipt });
          if (status === 'submitted') {
            expect(result).toMatchObject({
              text: TEAMMATE_DISPATCH_SUCCESS_REMINDER,
            });
            expect(result).toMatchObject({
              text: expect.stringMatching(/automatically push.*Do not poll/),
            });
          } else expect(result).not.toHaveProperty('text');
        },
      );
    });
    it('keeps the workflow run id and requires waiting for system completion', async () => {
      const f = await scoped(kind);
      vi.spyOn(f.owner.workflows, 'run').mockResolvedValueOnce({
        run_id: 'accepted-run',
      });
      const result = await f.delegate.call({
        name: 'workflow_run',
        arguments: { script: 'return null;' },
      });
      expect(result).toEqual({
        ok: true,
        structured: { run_id: 'accepted-run' },
        text: WORKFLOW_RUN_SUCCESS_REMINDER,
      });
      expect(result).toMatchObject({
        text: expect.stringMatching(
          /do not call or poll.*wait for the system push/,
        ),
      });
    });
    it('does not attach dispatch guidance to a read', async () => {
      const f = await scoped(kind);
      expect(await f.delegate.call({ name: 'list', arguments: {} })).toEqual({
        ok: true,
        structured: { teammates: [] },
      });
    });
  },
);
