import { describe, expect, it } from 'vitest';
import { CoreCommandPort } from '../src/command/port.js';
import { createCoreCommandRegistry } from '../src/server/command-catalog.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import {
  adminContext,
  createUnstartedCommandServer,
  HARNESS_DISPATCHER_ID,
} from './helpers/command-harness.js';

describe('configured runtime selection metadata', () => {
  it('projects only id, optional description and nonempty tags without resolving providers', async () => {
    const fixture = await dispatcherFixture();
    fixture.config.agents = {
      described: {
        provider: 'builtin:unresolved',
        config: { private: 'not exposed' },
        description: 'Careful review',
        tags: ['review', 'reasoning'],
        developerInstructions: 'Private instructions',
      },
      plain: { provider: 'builtin:unresolved', config: {} },
      empty: {
        provider: 'builtin:unresolved',
        config: {},
        description: '',
        tags: [],
      },
    };
    expect(await fixture.host.teammates.getCapabilities()).toEqual({
      agent_runtimes: [
        {
          id: 'described',
          description: 'Careful review',
          tags: ['review', 'reasoning'],
        },
        { id: 'plain' },
        { id: 'empty', description: '' },
      ],
    });
  });

  it('reflects current config for both Dispatcher and Team collections', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(teamRequest('caps'));
    const team = await fixture.teams.open(created.team_name);
    expect(await team.teammates.getCapabilities()).toEqual({
      agent_runtimes: [{ id: 'controlled' }],
    });
    fixture.config.agents['controlled'] = {
      ...fixture.config.agents['controlled']!,
      description: 'Updated',
      tags: ['updated'],
    };
    const expected = {
      agent_runtimes: [
        { id: 'controlled', description: 'Updated', tags: ['updated'] },
      ],
    };
    expect(await fixture.host.teammates.getCapabilities()).toEqual(expected);
    expect(await team.teammates.getCapabilities()).toEqual(expected);
  });

  it('returns the same metadata through the validated Command output contract', async () => {
    const fixture = await createUnstartedCommandServer();
    await fixture.config.replaceAgents(
      fixture.config.readAgents().map((agent) => ({
        ...agent,
        description: 'Command runtime',
        tags: ['command'],
        developerInstructions: 'Not in capabilities',
      })),
    );
    await fixture.host.start();
    const port = new CoreCommandPort(createCoreCommandRegistry(fixture.host));
    await expect(
      port.invoke(
        adminContext(HARNESS_DISPATCHER_ID),
        'teammate.capabilities',
        {},
      ),
    ).resolves.toEqual({
      agent_runtimes: [
        { id: 'controlled', description: 'Command runtime', tags: ['command'] },
      ],
    });
  });
});
