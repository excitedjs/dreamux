import { describe, expect, it } from 'vitest';
import { TeammateCollection } from '../src/service/agent/index.js';
import { WORKFLOW_AGENT_SYSTEM_PROMPT } from '../src/service/workflow-service/run.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import {
  createUnstartedCommandServer,
  HARNESS_DISPATCHER_ID,
} from './helpers/command-harness.js';

const INSTRUCTIONS = 'Use this runtime for careful review.';

describe('runtime developer instructions at the provider launch boundary', () => {
  it('appends once after plugin instructions in both Dispatcher prompt alternatives', async () => {
    const fixture = await dispatcherFixture();
    fixture.config.agents['controlled']!.developerInstructions = INSTRUCTIONS;
    fixture.host.hooks.launch.tapPromise('prompt', async (draft) => {
      draft.instructions.push('Plugin instruction');
    });
    await fixture.host.start();
    await fixture.host.dispatcherAgent.mustAgent().activate();
    const prompt = fixture.provider.runtimes[0]!.context.systemPrompt!;
    expect(
      prompt.replace?.endsWith(`Plugin instruction\n\n${INSTRUCTIONS}`),
    ).toBe(true);
    expect(prompt.append?.slice(-2)).toEqual([
      'Plugin instruction',
      INSTRUCTIONS,
    ]);
    expect(prompt.replace?.split(INSTRUCTIONS)).toHaveLength(2);
    expect(prompt.append?.filter((text) => text === INSTRUCTIONS)).toHaveLength(
      1,
    );
  });

  it('reads updated config on resume without changing a previous prompt or accumulating instructions', async () => {
    const fixture = await createUnstartedCommandServer();
    const entries = fixture.config.readAgents();
    await fixture.config.replaceAgents(
      entries.map((agent) => ({
        ...agent,
        developerInstructions: INSTRUCTIONS,
      })),
    );
    await fixture.host.start();
    const agent = fixture.host.dispatchers
      .get(HARNESS_DISPATCHER_ID)
      .dispatcherAgent.mustAgent();
    await agent.activate();
    const first = fixture.provider.runtimes[0]!;
    const before = structuredClone(first.context.systemPrompt);
    await first.context.state.publish({
      kind: 'session',
      sessionId: 'prior-session',
    });
    const updated = 'Use the updated review instructions.';
    await fixture.config.replaceAgents(
      entries.map((entry) => ({ ...entry, developerInstructions: updated })),
    );
    expect(first.context.systemPrompt).toEqual(before);
    await agent.stopForHost();
    await agent.activate();
    const resumed = fixture.provider.runtimes[1]!.context;
    expect(resumed.identity.sessionId).toBe('prior-session');
    expect(resumed.systemPrompt?.append?.at(-1)).toBe(updated);
    expect(resumed.systemPrompt?.replace?.endsWith(updated)).toBe(true);
    expect(JSON.stringify(resumed.systemPrompt)).not.toContain(INSTRUCTIONS);
    expect(first.context.systemPrompt).toEqual(before);
    await agent.stopForHost();
    await agent.activate();
    expect(fixture.provider.runtimes[2]!.context.systemPrompt).toEqual(
      resumed.systemPrompt,
    );
    await fixture.config.replaceAgents(entries);
    await agent.stopForHost();
    await agent.activate();
    expect(
      JSON.stringify(fixture.provider.runtimes[3]!.context.systemPrompt),
    ).not.toContain(updated);
  });

  it('keeps the composed prompt unchanged for absent and empty instructions', async () => {
    const fixture = await dispatcherFixture();
    await fixture.host.start();
    const agent = fixture.host.dispatcherAgent.mustAgent();
    await agent.activate();
    const initial = fixture.provider.runtimes[0]!.context.systemPrompt;
    fixture.config.agents['controlled']!.developerInstructions = '';
    await agent.stopForHost();
    await agent.activate();
    expect(fixture.provider.runtimes[1]!.context.systemPrompt).toEqual(initial);
  });

  it('appends after plugin and identity on an ordinary TeamMate without adding a replace alternative', async () => {
    const fixture = await dispatcherFixture();
    fixture.config.agents['controlled']!.developerInstructions = INSTRUCTIONS;
    fixture.host.hooks.teammateLaunch.tapPromise('prompt', async (draft) => {
      draft.instructions.push('Plugin instruction');
    });
    await fixture.host.start();
    await fixture.host.teammates.spawn({
      name: 'reviewer',
      prompt: 'Review',
      intent: 'Review',
      identity: 'You are a reviewer.',
    });
    const prompt = fixture.provider.runtimes[0]!.context.systemPrompt;
    expect(prompt?.append?.slice(-3)).toEqual([
      'Plugin instruction',
      'You are a reviewer.',
      INSTRUCTIONS,
    ]);
    expect(prompt).not.toHaveProperty('replace');
  });

  it('appends to a TeamLeader after the leader launch plugin', async () => {
    const fixture = await dispatcherFixture();
    fixture.config.agents['controlled']!.developerInstructions = INSTRUCTIONS;
    fixture.host.hooks.team.tap('leader-plugin', (team) => {
      team.hooks.leaderLaunch.tapPromise('prompt', async (draft) => {
        draft.instructions.push('Leader plugin instruction');
      });
    });
    await fixture.teams.createFromRequest(
      teamRequest('instructions', 'Start review'),
    );
    expect(
      fixture.provider.runtimes[0]!.context.systemPrompt?.append?.slice(-2),
    ).toEqual(['Leader plugin instruction', INSTRUCTIONS]);
  });

  it('appends to a Workflow agent after operation, plugin and identity instructions', async () => {
    const fixture = await dispatcherFixture();
    fixture.config.agents['controlled']!.developerInstructions = INSTRUCTIONS;
    fixture.host.hooks.teammateLaunch.tapPromise('prompt', async (draft) => {
      draft.instructions.push('Workflow plugin instruction');
    });
    const created = await fixture.teams.createFromRequest(
      teamRequest('workflow-instructions'),
    );
    const team = await fixture.teams.open(created.team_name);
    if (!(team.teammates instanceof TeammateCollection))
      throw new Error('expected real collection');
    const handle = await team.teammates.createLocked(
      {
        name: 'worker',
        prompt: 'Review',
        intent: 'Review',
        identity: 'Review the result.',
      },
      { systemPromptAppend: [WORKFLOW_AGENT_SYSTEM_PROMPT] },
    );
    try {
      await handle.submit({ prompt: 'Review', source: 'task' });
      expect(
        fixture.provider.runtimes[0]!.context.systemPrompt?.append?.slice(-4),
      ).toEqual([
        WORKFLOW_AGENT_SYSTEM_PROMPT,
        'Workflow plugin instruction',
        'Review the result.',
        INSTRUCTIONS,
      ]);
    } finally {
      handle.unlock();
    }
  });
});
