import { describe, expect, it } from 'vitest';

import { adminMethods } from '../src/admin/methods.js';
import { AdminError } from '../src/admin/protocol.js';
import type { Server } from '../src/server.js';

/**
 * Issue #182 PR-3: the admin layer (mustNonEmptyString) is the last of three
 * enforcement layers for required intent/note. These tests drive the admin
 * handlers directly with a minimal stub server so a regression from
 * mustNonEmptyString back to mustString/optionalString is caught — the shim
 * reject tests (teammate-mcp/team-mcp) never reach this layer.
 *
 * The handlers read+reject intent/note before touching `dispatcherService`, so
 * the stub only needs a dispatcher row for `mustExistingDispatcher`.
 */
const stubServer = {
  repos: { dispatchers: { get: () => ({ dispatcher_id: 'flow' }) } },
  // Lifecycle calls reject on the intent/note guard before the service is ever
  // reached; the stub service methods just assert they are not invoked.
  dispatcherService: {
    createTeam: () => {
      throw new Error('createTeam must not be reached on a rejected request');
    },
  },
} as unknown as Server;

async function expectBadRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const handler = adminMethods[method];
  if (handler === undefined) throw new Error(`no admin method ${method}`);
  await expect(
    Promise.resolve(handler(stubServer, params)),
  ).rejects.toMatchObject({ name: 'AdminError', code: 'BAD_REQUEST' });
}

describe('admin layer enforces required non-empty intent/note (#182 PR-3)', () => {
  it('AdminError exposes a BAD_REQUEST code (sanity)', () => {
    expect(new AdminError('BAD_REQUEST', 'x').code).toBe('BAD_REQUEST');
  });

  it('rejects teammate.spawn with missing or empty intent', async () => {
    // #199 Slice 1/2: spawn takes name_prefix and no required cwd. intent is
    // validated before any work-directory resolution, so the stub server here
    // never needs a dispatcherWorkspace.
    const base = { dispatcher_id: 'flow', name_prefix: 'a', prompt: 'go' };
    await expectBadRequest('mcp.teammate.spawn', base);
    await expectBadRequest('mcp.teammate.spawn', { ...base, intent: '' });
  });

  it('rejects teammate.close with missing or empty note', async () => {
    const base = { dispatcher_id: 'flow', name: 'a' };
    await expectBadRequest('mcp.teammate.close', base);
    await expectBadRequest('mcp.teammate.close', { ...base, note: '' });
  });

  it('rejects team.create with missing or empty intent', async () => {
    // #199 Slice 1/2: create takes team_name and an optional repo (no repo_cwd).
    const base = {
      dispatcher_id: 'flow',
      team_name: 'alpha',
      leader_agent_runtime: 'codex',
    };
    await expectBadRequest('mcp.team.create', base);
    await expectBadRequest('mcp.team.create', { ...base, intent: '' });
  });

  it('rejects team.dissolve with missing or empty note', async () => {
    // #199 Slice 1: Team lifecycle is addressed by `team_name`.
    const base = { dispatcher_id: 'flow', team_name: 'alpha' };
    await expectBadRequest('mcp.team.dissolve', base);
    await expectBadRequest('mcp.team.dissolve', { ...base, note: '' });
  });
});
