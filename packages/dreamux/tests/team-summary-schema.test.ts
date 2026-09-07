import { describe, expect, it } from 'vitest';

import { teamCommands } from '../src/service/team-collection/commands.js';
import { createTeamMcpDelegate } from '../src/service/team-collection/mcp-delegate.js';
import { createCommandHarness } from './helpers/command-harness.js';

describe('canonical TeamSummary schemas', () => {
  it('advertises one identical closed Team item for create, list, and status on both surfaces', () => {
    const definitions = teamCommands(createCommandHarness().host);
    const command = (name: string) => {
      const found = definitions.find((definition) => definition.name === name);
      if (found === undefined) throw new Error(`missing ${name}`);
      return found.output as Record<string, unknown>;
    };
    const commandCreate = command('team.create');
    const commandList = command('team.list');
    const commandStatus = command('team.status');
    const commandListItem = (((commandList['properties'] as Record<string, unknown>)[
      'teams'
    ] as Record<string, unknown>)['items']);

    const tools = createTeamMcpDelegate({
      dispatcher: {} as never,
      caller: { kind: 'dispatcher' },
    }).describe().tools as Array<{
      name: string;
      outputSchema: Record<string, unknown>;
    }>;
    const tool = (name: string) => {
      const found = tools.find((descriptor) => descriptor.name === name);
      if (found === undefined) throw new Error(`missing ${name}`);
      return found.outputSchema;
    };
    const toolCreate = tool('create');
    const toolList = tool('list');
    const toolStatus = tool('status');
    const toolListItem = (((toolList['properties'] as Record<string, unknown>)[
      'teams'
    ] as Record<string, unknown>)['items']);

    expect(commandCreate['additionalProperties']).toBe(false);
    expect(commandCreate).toEqual(commandStatus);
    expect(commandCreate).toEqual(commandListItem);
    expect(commandCreate).toEqual(toolCreate);
    expect(commandCreate).toEqual(toolStatus);
    expect(commandCreate).toEqual(toolListItem);
    expect(Object.keys(commandCreate['properties'] as Record<string, unknown>)).not.toContain(
      'worktree_branch',
    );
    expect(Object.keys(commandCreate['properties'] as Record<string, unknown>)).not.toContain(
      'worktree_base_ref',
    );
  });
});
