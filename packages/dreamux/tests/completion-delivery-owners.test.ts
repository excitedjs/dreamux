import { describe, expect, it, vi } from 'vitest';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import {
  createCommandHarness,
  createHarnessChannelInvoker,
  startHarnessAdminSocket,
  HARNESS_CHANNEL_ID,
} from './helpers/command-harness.js';

describe('completion ownership at actual Command and MCP callers', () => {
  it.each(['create', 'send'] as const)(
    '%s states the waiting owner: both Command adapters omit pushback and MCP delivers it',
    async (operation) => {
      const harness = await createCommandHarness();
      const ready = await harness.dispatcher.submitToAgent({
        source: 'channel',
        text: 'be ready for results',
      });
      if (ready.status !== 'submitted')
        throw new Error('recipient was not admitted');
      const recipient = harness.provider.runtimes[0]!;
      recipient.submissions[0]!.complete('ready');
      await ready.turn.settled;
      const admin = await startHarnessAdminSocket(harness);
      const channel = createHarnessChannelInvoker(harness);
      const delegate = createTeamMcpDelegate({
        teams: harness.dispatcher.teams,
      });
      const request = (name: string, prompt?: string) => ({
        request_id: `ownership-${name}`,
        name_prefix: name,
        intent: 'exercise caller-owned completion',
        leader: {
          agent_runtime: 'controlled',
          ...(prompt === undefined ? {} : { prompt }),
        },
      });
      try {
        for (const route of ['admin', 'channel', 'mcp'] as const) {
          const text = `${route}-work`;
          const before = harness.provider.runtimes.length;
          let teamName: string | undefined;
          if (operation === 'send') {
            const result = await channel.port.invoke.invoke(
              'team.create',
              request(`${route}-team`),
            );
            teamName = (result as { team_name: string }).team_name;
          }
          if (route === 'admin') {
            const response = await admin.send(
              operation === 'create' ? 'team.create' : 'team.submit',
              {
                dispatcher_id: 'harness-d1',
                ...(operation === 'create'
                  ? request('admin-team', text)
                  : { team_name: teamName, text }),
              },
            );
            expect(response.ok).toBe(true);
          } else if (route === 'channel') {
            const response = await channel.port.invoke.invoke(
              operation === 'create' ? 'team.create' : 'team.submit',
              operation === 'create'
                ? request('channel-team', text)
                : { team_name: teamName!, text },
            );
            expect(response).toMatchObject(
              operation === 'create'
                ? { status: 'running' }
                : { status: 'submitted' },
            );
          } else {
            const response = await delegate.call({
              name: operation,
              arguments:
                operation === 'create'
                  ? {
                      name_prefix: 'mcp-team',
                      leader_agent_runtime: 'controlled',
                      intent: 'exercise MCP ownership',
                      prompt: text,
                    }
                  : { team_name: teamName!, prompt: text },
            });
            expect(response.ok).toBe(true);
          }
          expect(harness.provider.runtimes).toHaveLength(before + 1);
          const leader = harness.provider.runtimes[before]!;
          expect(leader.inputs[0]).toContain(text);
          leader.submissions[0]!.complete(`${route}-answer`);
        }
        const notices = () =>
          recipient.inputs.filter((text) =>
            text.startsWith('<task-notification>'),
          );
        await vi.waitFor(() => expect(notices()).toHaveLength(1));
        expect(notices()[0]).toContain('mcp-answer');
        expect(notices()[0]).not.toContain('admin-answer');
        expect(notices()[0]).not.toContain('channel-answer');
      } finally {
        await admin.close();
      }
    },
  );
});

it('real completion delivery uses the ordinary dispatcher input projection and task-notification envelope', async () => {
  const harness = await createCommandHarness();
  const admission = await harness.dispatcher.submitToAgent({
    source: 'channel',
    text: 'ready',
  });
  if (admission.status !== 'submitted')
    throw new Error('recipient was not admitted');
  const runtime = harness.provider.runtimes[0]!;
  runtime.submissions[0]!.complete('ready');
  await admission.turn.settled;
  const owner = harness.dispatcher.dispatcherAgent.current;
  if (owner === null) throw new Error('missing Dispatcher Agent');
  const delivery = await owner.prepareCompletion({
    kind: 'teammate',
    role: 'teammate',
    source: 'worker',
    status: 'completed',
    result: 'finished-work',
  });
  await expect(delivery.submit()).resolves.toEqual({ status: 'accepted' });
  expect(runtime.inputs.at(-1)).toMatch(
    /^<task-notification>[\s\S]*finished-work[\s\S]*<\/task-notification>$/,
  );
  const session = harness.fake.sessions.get(HARNESS_CHANNEL_ID)!;
  await vi.waitFor(() =>
    expect(session.receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'teammate.input',
          role: 'dispatcher',
          source: 'task-notification',
          notice: { kind: 'teammate_completion', producer: 'worker' },
        }),
      ]),
    ),
  );
  expect(harness.provider.runtimes).toHaveLength(1);
});

it('a real dormant completion recipient returns unsupported without waking a runtime', async () => {
  const harness = await createCommandHarness();
  const owner = harness.dispatcher.dispatcherAgent.current;
  if (owner === null) throw new Error('missing Dispatcher Agent');
  expect(harness.provider.runtimes).toHaveLength(0);
  const delivery = await owner.prepareCompletion({
    kind: 'teammate',
    role: 'teammate',
    source: 'worker',
    status: 'completed',
    result: 'finished-work',
  });
  await expect(delivery.submit()).resolves.toMatchObject({
    status: 'unsupported',
    reason: 'teammate runtime not running',
  });
  expect(harness.provider.runtimes).toHaveLength(0);
  expect(
    harness.fake.sessions
      .get(HARNESS_CHANNEL_ID)!
      .receivedEvents.filter((event) => event.kind === 'teammate.input'),
  ).toEqual([]);
});
