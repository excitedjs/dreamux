import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatcherTeamMateDir } from '../src/platform/paths.js';
import type { AgentEntityIdentity } from '../src/service/agent/identity.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

afterEach(() => vi.restoreAllMocks());

describe('Agent status identity timestamps', () => {
  it.each(['dispatcher', 'team'] as const)(
    'reports record timestamps through the real %s collection for live and closed agents',
    async (scope) => {
      const fixture = await dispatcherFixture();
      await fixture.host.start();
      const created =
        scope === 'team'
          ? await fixture.teams.createFromRequest(teamRequest('timestamp'))
          : null;
      const collection =
        created === null
          ? fixture.host.teammates
          : (await fixture.teams.open(created.team_name)).teammates;
      const spawned = await collection.spawn({
        name: 'reader',
        prompt: 'Inspect status',
        intent: 'Check timestamps',
        identity: 'Private identity text',
      });
      const path =
        created === null
          ? join(
              dispatcherTeamMateDir('test'),
              spawned.teammate.name,
              'identity.json',
            )
          : join(
              fixture.teamRoot,
              created.team_name,
              'teammate',
              spawned.teammate.name,
              'identity.json',
            );
      const readIdentity = async () =>
        JSON.parse(await readFile(path, 'utf8')) as AgentEntityIdentity;
      const identity = await readIdentity();
      expect(spawned.teammate.created_at).toBe(identity.created_at);
      expect(spawned.teammate.updated_at).toBe(identity.updated_at);
      const updatedAt = identity.updated_at + 1000;
      vi.spyOn(Date, 'now').mockReturnValue(updatedAt);
      await fixture.provider.runtimes[0]!.context.state.publish({
        kind: 'session',
        sessionId: 'status-session',
      });
      const live = await collection.status(spawned.teammate.name);
      expect(live).toMatchObject({
        created_at: identity.created_at,
        updated_at: updatedAt,
        session_id: 'status-session',
      });
      expect(live.updated_at).toBe((await readIdentity()).updated_at);
      expect(live).not.toHaveProperty('last_activity_at');
      expect(live).not.toHaveProperty('identity_prompt');
      await collection.close({ name: spawned.teammate.name, note: 'Pause' });
      const closed = await collection.status(spawned.teammate.name);
      const closedIdentity = await readIdentity();
      expect(closed).toMatchObject({
        created_at: closedIdentity.created_at,
        updated_at: closedIdentity.updated_at,
        status: 'closed',
      });
      expect(closed.created_at).toBe(identity.created_at);
    },
  );
});
