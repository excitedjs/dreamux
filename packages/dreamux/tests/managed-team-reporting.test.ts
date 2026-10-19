import type { RuntimeCompletion } from '@excitedjs/dreamux-types';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { createTeamMcpDelegate } from '../src/service/team/mcp.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { foldSubmissions } from './helpers/runtime-submission.js';

const result = (text: string): RuntimeCompletion =>
  Object.freeze({ status: 'completed', resultText: text });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it('keeps managed Teams request-only: member reports stop at leaders, explicit create/send answers fold once, and later equal-text results stay separate', async () => {
  console.error(
    'PR476_MANAGED_TEAM_DIAG ' +
      JSON.stringify({
        pid: process.pid,
        monotonicMs: performance.now(),
        stage: 'fixture.begin',
      }),
  );
  const f = await dispatcherFixture();
  const diagnostic = (stage: string, fields: Record<string, unknown> = {}) => {
    console.error(
      'PR476_MANAGED_TEAM_DIAG ' +
        JSON.stringify({
          pid: process.pid,
          monotonicMs: performance.now(),
          stage,
          runtimeCount: f.provider.runtimes.length,
          noticeCount: f.provider.runtimes[0]?.inputs.filter((text) =>
            text.startsWith('<task-notification>'),
          ).length,
          ...fields,
        }),
    );
  };
  diagnostic('fixture.end');
  diagnostic('host.start.begin');
  await f.host.start();
  diagnostic('host.start.end');
  diagnostic('ready.submit.begin');
  const ready = await f.host.submitInput({
    source: 'channel',
    text: 'dispatcher ready',
  });
  diagnostic('ready.submit.end');
  if (ready.status !== 'submitted') throw new Error('dispatcher not active');
  const dispatcher = f.provider.runtimes[0]!;
  diagnostic('ready.complete.trigger');
  dispatcher.submissions[0]!.complete(null);
  diagnostic('ready.settled.begin');
  await ready.turn.settled;
  diagnostic('ready.settled.end');
  const notices = () =>
    dispatcher.inputs.filter((text) => text.startsWith('<task-notification>'));
  const delegate = createTeamMcpDelegate({ teams: f.host.teams });
  diagnostic('bare.create.begin');
  const bare = await delegate.call({
    name: 'create',
    arguments: {
      name_prefix: 'bare',
      intent: 'no artificial request',
      leader_agent_runtime: 'controlled',
    },
  });
  diagnostic('bare.create.end');
  expect(bare.ok).toBe(true);
  expect(f.provider.runtimes).toHaveLength(1);
  expect(notices()).toEqual([]);
  for (let index = 0; index < 3; index++) {
    diagnostic('team.create.begin', { index });
    const created = await delegate.call({
      name: 'create',
      arguments: {
        name_prefix: `managed-${index}`,
        intent: 'managed request',
        leader_agent_runtime: 'controlled',
        prompt: `explicit create request ${index}`,
      },
    });
    diagnostic('team.create.end', { index });
    if (!created.ok) throw new Error('Team create request failed');
    const name = (created.structured as { team_name: string }).team_name;
    diagnostic('team.open.begin', { index });
    const team = await f.teams.open(name);
    diagnostic('team.open.end', { index });
    const leader = f.provider.runtimes.at(-1)!;
    diagnostic('leader.unbound.result.trigger', { index });
    leader.context.results!(
      result('unbound leader while a request is pending'),
    );
    diagnostic('leader.unbound.tick.begin', { index });
    await tick();
    diagnostic('leader.unbound.tick.end', { index });
    expect(notices()).toHaveLength(index * 3);
    const createAnswer = result(`create-answer-${index}`);
    diagnostic('create.result.trigger', { index });
    leader.context.results!(createAnswer);
    diagnostic('create.settle.trigger', { index });
    leader.submissions[0]!.settle({
      kind: 'completion',
      completion: createAnswer,
    });
    diagnostic('create.notice.wait.begin', { index });
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 1));
    diagnostic('create.notice.wait.end', { index });
    expect(notices().at(-1)).toContain(`create-answer-${index}`);
    diagnostic('member.spawn.begin', { index });
    await team.teammates.spawn({
      name: 'internal',
      prompt: 'member work',
      intent: 'Team internal activity',
    });
    diagnostic('member.spawn.end', { index });
    const member = f.provider.runtimes.at(-1)!;
    const memberAnswer = result(`internal-member-${index}`);
    diagnostic('member.result.trigger', { index });
    member.context.results!(memberAnswer);
    diagnostic('member.settle.trigger', { index });
    member.submissions[0]!.settle({
      kind: 'completion',
      completion: memberAnswer,
    });
    diagnostic('member.notice.wait.begin', { index });
    await vi.waitFor(() =>
      expect(
        leader.inputs.filter((text) => text.startsWith('<task-notification>')),
      ).toHaveLength(1),
    );
    diagnostic('member.notice.wait.end', { index });
    expect(leader.inputs.at(-1)).toContain(`internal-member-${index}`);
    diagnostic('leader.continuation.result.trigger', { index });
    leader.context.results!(
      result('leader continuation after internal activity'),
    );
    diagnostic('leader.continuation.tick.begin', { index });
    await tick();
    diagnostic('leader.continuation.tick.end', { index });
    expect(notices()).toHaveLength(index * 3 + 1);
    for (const prompt of ['request-one', 'request-two']) {
      diagnostic('folded.send.begin', { index, prompt });
      expect(
        await delegate.call({
          name: 'send',
          arguments: { team_name: name, prompt },
        }),
      ).toMatchObject({ ok: true, structured: { status: 'submitted' } });
      diagnostic('folded.send.end', { index, prompt });
    }
    const requestInputs = leader.submissions.slice(-2);
    diagnostic('folded.settle.trigger', { index });
    const folded = foldSubmissions(requestInputs, `equal-answer-${index}`);
    diagnostic('folded.result.trigger', { index });
    leader.context.results!(folded);
    diagnostic('folded.notice.wait.begin', { index });
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 2));
    diagnostic('folded.notice.wait.end', { index });
    expect(notices().at(-1)).toContain(`equal-answer-${index}`);
    diagnostic('distinct.send.begin', { index });
    expect(
      await delegate.call({
        name: 'send',
        arguments: { team_name: name, prompt: 'distinct request' },
      }),
    ).toMatchObject({ ok: true });
    diagnostic('distinct.send.end', { index });
    diagnostic('distinct.complete.trigger', { index });
    const separate = leader.submissions
      .at(-1)!
      .complete(`equal-answer-${index}`);
    diagnostic('distinct.result.trigger', { index });
    leader.context.results!(separate);
    diagnostic('distinct.notice.wait.begin', { index });
    await vi.waitFor(() => expect(notices()).toHaveLength(index * 3 + 3));
    diagnostic('distinct.notice.wait.end', { index });
    diagnostic('leader.failure.result.trigger', { index });
    leader.context.results!(
      Object.freeze({
        status: 'failed',
        error: new Error('unrelated leader background failure'),
      }),
    );
    diagnostic('leader.autonomous.result.trigger', { index });
    leader.context.results!(result('later autonomous leader turn'));
    diagnostic('leader.autonomous.tick.begin', { index });
    await tick();
    diagnostic('leader.autonomous.tick.end', { index });
    expect(notices()).toHaveLength(index * 3 + 3);
  }
  expect(notices()).toHaveLength(9);
  expect(notices().every((text) => !text.includes('internal-member'))).toBe(
    true,
  );
  diagnostic('body.complete');
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
