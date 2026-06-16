import { describe, expect, it } from 'vitest';

import { adminMethods } from '../src/admin/methods.js';
import type { Server } from '../src/server.js';

function spawnStub(capture: (input: unknown) => void): Server {
  return {
    repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
    getDispatcher: () => ({
      spawnTeamMate: (input: unknown) => {
        capture(input);
        return { teammate: { name: 'solo' }, turn: {} };
      },
      workspace: () => {
        throw new Error(
          'workspace must not be resolved when cwd is given or repo omitted',
        );
      },
    }),
  } as unknown as Server;
}

describe('admin no-repo spawn/create → default work dir (#199)', () => {
  it('teammate.spawn without `repo` forwards neither cwd nor worktree', async () => {
    let captured: Record<string, unknown> = {};
    const server = spawnStub((input) => {
      captured = input as Record<string, unknown>;
    });
    await adminMethods['mcp.teammate.spawn']!(server, {
      dispatcher_id: 'flow',
      name_prefix: 'solo',
      prompt: 'go',
      intent: 'work',
    });
    expect(captured).not.toHaveProperty('cwd');
    expect(captured).not.toHaveProperty('worktree');
  });

  it('teammate.spawn with an explicit repo path forwards that cwd', async () => {
    let captured: Record<string, unknown> = {};
    const server = spawnStub((input) => {
      captured = input as Record<string, unknown>;
    });
    await adminMethods['mcp.teammate.spawn']!(server, {
      dispatcher_id: 'flow',
      name_prefix: 'solo',
      prompt: 'go',
      intent: 'work',
      repo: { mode: 'reuse-cwd', path: '/explicit' },
    });
    expect(captured['cwd']).toBe('/explicit');
    expect(captured['worktree']).toEqual({ mode: 'reuse-cwd' });
  });

  it('team.create without `repo` forwards neither repoCwd nor worktree', async () => {
    let captured: Record<string, unknown> = {};
    const server = {
      repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
      getDispatcher: () => ({
        createTeam: (input: unknown) => {
          captured = input as Record<string, unknown>;
          return {};
        },
        workspace: () => {
          throw new Error('workspace must not be resolved for a no-repo team');
        },
      }),
    } as unknown as Server;
    await adminMethods['mcp.team.create']!(server, {
      dispatcher_id: 'flow',
      team_name: 'plain',
      leader_agent_runtime: 'codex',
      intent: 'work',
    });
    expect(captured).not.toHaveProperty('repoCwd');
    expect(captured).not.toHaveProperty('worktree');
  });
});
