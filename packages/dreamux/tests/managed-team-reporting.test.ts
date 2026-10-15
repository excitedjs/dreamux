import type { RuntimeCompletion } from '@excitedjs/dreamux-types';
import { expect, it, vi } from 'vitest';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { foldSubmissions } from './helpers/runtime-submission.js';

const result = (text: string): RuntimeCompletion =>
  Object.freeze({ status: 'completed', resultText: text });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it('keeps managed Teams request-only: member reports stop at leaders, explicit create/send answers fold once, and later equal-text results stay separate', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  const ready = await f.host.submitInput({
    source: 'channel',
    text: 'dispatcher ready',
  });
  if (ready.status !== 'submitted') throw new Error('dispatcher not active');
  const dispatcher = f.provider.runtimes[0]!;
  dispatcher.submissions[0]!.complete(null);
  await ready.turn.settled;
  const notices = () =>
    dispatcher.inputs.filter((text) => text.startsWith('<task-notification>'));
  const delegate = createTeamMcpDelegate({ teams: f.host.teams });
  const bare = await delegate.call({
    name: 'create',
    arguments: {
      name_prefix: 'bare',
      intent: 'no artificial request',
      leader_agent_runtime: 'controlled',
    },
  });
  expect(bare.ok).toBe(true);
  expect(f.provider.runtimes).toHaveLength(1);
  expect(notices()).toEqual([]);
  for (let index = 0; index < 3; index++) {
    const created = await delegate.call({
      name: 'create',
      arguments: {
        name_prefix: `managed-${index}`,
        intent: 'managed request',
        leader_agent_runtime: 'controlled',
        prompt: `explicit create request ${index}`,
      },
    });
    if (!created.ok) throw new Error('Team create request failed');
    const name = (created.structured as { team_name: string }).team_name;
    const team = await f.teams.open(name);
    const leader = f.provider.runtimes.at(-1)!;
    leader.context.results!(
      result('unbound leader while a request is pending'),
    );
    await tick();
    expect(notices()).toHaveLength(index * 3);
    const createAnswer = result(`create-answer-${index}`);
    leader.context.results!(createAnswer);
    leader.submissions[0]!.settle({
      kind: 'completion',
      completion: createAnswer,
    });
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 1));
    expect(notices().at(-1)).toContain(`create-answer-${index}`);
    await team.teammates.spawn({
      name: 'internal',
      prompt: 'member work',
      intent: 'Team internal activity',
    });
    const member = f.provider.runtimes.at(-1)!;
    const memberAnswer = result(`internal-member-${index}`);
    member.context.results!(memberAnswer);
    member.submissions[0]!.settle({
      kind: 'completion',
      completion: memberAnswer,
    });
    await vi.waitFor(() =>
      expect(
        leader.inputs.filter((text) => text.startsWith('<task-notification>')),
      ).toHaveLength(1),
    );
    expect(leader.inputs.at(-1)).toContain(`internal-member-${index}`);
    leader.context.results!(
      result('leader continuation after internal activity'),
    );
    await tick();
    expect(notices()).toHaveLength(index * 3 + 1);
    for (const prompt of ['request-one', 'request-two']) {
      expect(
        await delegate.call({
          name: 'send',
          arguments: { team_name: name, prompt },
        }),
      ).toMatchObject({ ok: true, structured: { status: 'submitted' } });
    }
    const requestInputs = leader.submissions.slice(-2);
    const folded = foldSubmissions(requestInputs, `equal-answer-${index}`);
    leader.context.results!(folded);
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 2));
    expect(notices().at(-1)).toContain(`equal-answer-${index}`);
    expect(
      await delegate.call({
        name: 'send',
        arguments: { team_name: name, prompt: 'distinct request' },
      }),
    ).toMatchObject({ ok: true });
    const separate = leader.submissions
      .at(-1)!
      .complete(`equal-answer-${index}`);
    leader.context.results!(separate);
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 3));
    leader.context.results!(
      Object.freeze({
        status: 'failed',
        error: new Error('unrelated leader background failure'),
      }),
    );
    leader.context.results!(result('later autonomous leader turn'));
    await tick();
    expect(notices()).toHaveLength(index * 3 + 3);
  }
  expect(notices()).toHaveLength(9);
  expect(notices().every((text) => !text.includes('internal-member'))).toBe(
    true,
  );
});

it('a Channel-originated Team request retains its value without acquiring a Dispatcher reply recipient', async () => {
  const f = await dispatcherFixture();
  await f.host.start();
  const ready = await f.host.submitInput({ source: 'channel', text: 'ready' });
  if (ready.status !== 'submitted') throw new Error('dispatcher not active');
  const dispatcher = f.provider.runtimes[0]!;
  dispatcher.submissions[0]!.complete(null);
  const created = await f.teams.createFromRequest(teamRequest('channel-owned'));
  const team = await f.teams.open(created.team_name);
  const accepted = await team.submitInput({
    source: 'channel',
    text: 'Channel request',
  });
  if (accepted.status !== 'submitted')
    throw new Error('Channel request not admitted');
  const leader = f.provider.runtimes.at(-1)!;
  const answer = result('Channel answer');
  leader.context.results!(answer);
  leader.submissions[0]!.settle({ kind: 'completion', completion: answer });
  expect(await accepted.turn.settled).toEqual({
    status: 'completed',
    resultText: 'Channel answer',
  });
  await tick();
  expect(
    dispatcher.inputs.filter((text) => text.startsWith('<task-notification>')),
  ).toEqual([]);
});
