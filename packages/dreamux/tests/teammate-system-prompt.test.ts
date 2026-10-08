import { describe, expect, it, vi } from 'vitest';
import { TeammateCollection } from '../src/service/agent/index.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from '../src/service/workflow-service/run.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

const IDENTITY = 'You are the release reviewer.';

describe('TeamMate prompts at the provider launch boundary', () => {
  it('leads a Team-scoped TeamMate with its membership and completion recipient, then operator identity', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('member-prompt'),
    );
    const team = await fixture.teams.open(created.team_name);
    const spawned = await team.teammates.spawn({
      name: 'reviewer',
      prompt: 'Review',
      intent: 'Review',
      agentRuntime: 'controlled',
      identity: IDENTITY,
    });
    expect(fixture.provider.runtimes).toHaveLength(1);
    expect(fixture.provider.runtimes[0]!.context.systemPrompt?.append).toEqual([
      `You are TeamMate "${spawned.teammate.name}" of Dreamux Team "${created.team_name}". Your TeamLeader receives what you output when your turn ends.`,
      IDENTITY,
    ]);
  });

  it('tells a dispatcher-scoped TeamMate only the operator identity', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    await fixture.host.teammates.spawn({
      name: 'reviewer',
      prompt: 'Review',
      intent: 'Review',
      agentRuntime: 'controlled',
      identity: IDENTITY,
    });
    expect(fixture.provider.runtimes[0]!.context.systemPrompt?.append).toEqual([
      IDENTITY,
    ]);
  });

  it('gives a dispatcher-scoped TeamMate without an identity no system prompt', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    await fixture.host.teammates.spawn({
      name: 'plain',
      prompt: 'Review',
      intent: 'Review',
      agentRuntime: 'controlled',
    });
    expect(fixture.provider.runtimes[0]!.context.systemPrompt).toBeUndefined();
  });

  it('orders Workflow membership, operation contract, plugin instruction, and identity without a leader completion claim', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const created = await fixture.teams.createFromRequest(
      teamRequest('workflow-prompt'),
    );
    fixture.host.hooks.teammateLaunch.tapPromise(
      'workflow-plugin',
      async (draft, scope) => {
        expect(scope.teamId).toBe(created.team_name);
        draft.instructions.push('Plugin workflow instruction');
      },
    );
    const team = await fixture.teams.open(created.team_name);
    if (!(team.teammates instanceof TeammateCollection))
      throw new Error('expected real teammate collection');
    const handle = await team.teammates.createLocked(
      {
        name: 'agent',
        prompt: 'Return a value',
        intent: 'Workflow agent',
        agentRuntime: 'controlled',
        identity: IDENTITY,
      },
      {
        systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT],
      },
    );
    try {
      expect(
        (await handle.submit({ prompt: 'Return a value', source: 'task' }))
          .status,
      ).toBe('submitted');
      expect(
        fixture.provider.runtimes[0]!.context.systemPrompt?.append,
      ).toEqual([
        `You are TeamMate "${handle.name}" of Dreamux Team "${created.team_name}".`,
        WORKFLOW_AGENT_SYSTEM_PROMPT,
        'Plugin workflow instruction',
        IDENTITY,
      ]);
    } finally {
      handle.unlock();
    }
  });

  it('keeps successful plugin instructions in order before identity and discards a failing tap draft', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    fixture.host.hooks.teammateLaunch.tapPromise(
      'alpha',
      async (draft, scope) => {
        expect(scope.teamId).toBeNull();
        draft.instructions.push('from alpha');
      },
    );
    fixture.host.hooks.teammateLaunch.tapPromise('broken', async (draft) => {
      draft.instructions.push('half written');
      throw new Error('read failed');
    });
    fixture.host.hooks.teammateLaunch.tapPromise('omega', async (draft) => {
      draft.instructions.push('from omega');
    });
    await fixture.host.teammates.spawn({
      name: 'reviewer',
      prompt: 'Review',
      intent: 'Review',
      agentRuntime: 'controlled',
      identity: IDENTITY,
    });
    expect(fixture.provider.runtimes[0]!.context.systemPrompt?.append).toEqual([
      'from alpha',
      'from omega',
      IDENTITY,
    ]);
  });

  it('runs the launch hook for spawn and closed-agent reopen, but not another send to the same Agent', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const tap = vi.fn(async () => {});
    fixture.host.hooks.teammateLaunch.tapPromise('count-constructions', tap);
    const first = await fixture.host.teammates.spawn({
      name: 'reviewer',
      prompt: 'First',
      intent: 'Review',
      agentRuntime: 'controlled',
      identity: IDENTITY,
    });
    await fixture.host.teammates.send({
      name: first.teammate.name,
      prompt: 'Second',
    });
    expect(tap).toHaveBeenCalledTimes(1);
    expect(fixture.provider.runtimes).toHaveLength(1);
    await fixture.host.teammates.close({
      name: first.teammate.name,
      note: 'Pause review',
    });
    await fixture.host.teammates.send({
      name: first.teammate.name,
      prompt: 'Resume',
    });
    expect(tap).toHaveBeenCalledTimes(2);
    expect(fixture.provider.runtimes).toHaveLength(2);
    expect(fixture.provider.runtimes[1]!.context.systemPrompt?.append).toEqual([
      IDENTITY,
    ]);
  });
});
