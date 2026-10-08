import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LegacyStateError } from '../src/platform/errors.js';
import { teamCreatePayloadHash } from '../src/service/team/create-request.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';

async function plantLeader(
  transform: (identity: Record<string, unknown>) => string,
) {
  const fixture = await dispatcherFixture();
  const created = await fixture.teams.createFromRequest(
    teamRequest('projection-request'),
  );
  await fixture.host.close();
  const path = join(fixture.teamRoot, created.team_name, 'identity.json');
  const identity = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(path, transform({ ...identity, status: 'running' }));
  return { ...fixture, teams: fixture.build().teams, name: created.team_name };
}

describe('Team leader identity persistence and read projections', () => {
  it('stores the whole composed string in the Team record and the leader identity', async () => {
    const fixture = await dispatcherFixture();
    const identity = [
      'You are the release captain for this Team.',
      '',
      'Reply in this Feishu conversation with the channel reply tool:',
      '- chat_id: oc_example',
      '- message_id: om_initial_message (the message that initially triggered Team creation)',
      'Never omit message_id.',
    ].join('\n');
    const request = teamRequest('req-composed-identity');
    const command = {
      ...request.command,
      leader: { ...request.command.leader, identity },
    };
    const created = await fixture.teams.createFromRequest({
      ...request,
      command,
      payloadHash: teamCreatePayloadHash(command),
    });
    const root = join(fixture.teamRoot, created.team_name);
    const record = JSON.parse(
      await readFile(join(root, 'record.json'), 'utf8'),
    ) as Record<string, unknown>;
    const leader = JSON.parse(
      await readFile(join(root, 'identity.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['leader_identity_prompt']).toBe(identity);
    expect(leader['identity_prompt']).toBe(identity);
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('raises a legacy leader record through list, history, and status', async () => {
    const fixture = await plantLeader((identity) =>
      JSON.stringify({
        version: 1,
        name: identity['name'],
        dispatcher_id: identity['dispatcher_id'],
        provider_ref: 'builtin:codex',
      }),
    );
    await expect(fixture.teams.list()).rejects.toBeInstanceOf(LegacyStateError);
    await expect(fixture.teams.history({})).rejects.toBeInstanceOf(
      LegacyStateError,
    );
    await expect(fixture.teams.summary(fixture.name)).rejects.toBeInstanceOf(
      LegacyStateError,
    );
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('projects a leader carrying a leftover role field normally', async () => {
    const fixture = await plantLeader((identity) =>
      JSON.stringify({ ...identity, role: 'team_member' }),
    );
    const [row] = await fixture.teams.list();
    expect(row?.leader_agent_runtime).toBe('controlled');
    expect(row?.leader_state).toBe('running');
    expect((await fixture.teams.summary(fixture.name)).leader_state).toBe(
      'running',
    );
    expect((await fixture.teams.history({})).items[0]?.leader_state).toBe(
      'running',
    );
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('still reports an ordinary unreadable leader as no leader state', async () => {
    const fixture = await plantLeader(() => '{ not json');
    expect((await fixture.teams.summary(fixture.name)).leader_state).toBeNull();
    expect((await fixture.teams.list())[0]?.leader_state).toBeNull();
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('keeps the response shape of a valid leader record', async () => {
    const fixture = await plantLeader((identity) => JSON.stringify(identity));
    expect(await fixture.teams.summary(fixture.name)).toMatchObject({
      team_name: fixture.name,
      status: 'running',
      leader_state: 'running',
      leader_agent_runtime: 'controlled',
      leader_runtime_status: null,
      leader_session_id: null,
      member_count: 0,
    });
    expect(fixture.provider.runtimes).toHaveLength(0);
  });
});
