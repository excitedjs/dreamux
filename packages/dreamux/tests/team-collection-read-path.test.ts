import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdmission } from '@excitedjs/dreamux-types';
import {
  TeamNotFoundError,
  TeamClosedError,
} from '../src/service/team/errors.js';
import { TeamStore } from '../src/service/team/store.js';
import type { TeamRecord } from '../src/service/team/types.js';
import { AgentEntityCollectionStore } from '../src/service/agent/store.js';
import { createLogger } from '../src/platform/logger.js';
import { teamMateCollectionDir } from '../src/platform/paths.js';
import { reuseCwdWorktree } from '../src/service/worktree/manager.js';
import { dispatcherFixture, teamRequest } from './helpers/real-dispatcher.js';
import { deferred } from './helpers/controlled-runtime-provider.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';

type Fixture = Awaited<ReturnType<typeof dispatcherFixture>>;
async function writeRawRecord(fixture: Fixture, name: string, raw: string) {
  await mkdir(join(fixture.teamRoot, name), { recursive: true });
  await writeFile(join(fixture.teamRoot, name, 'record.json'), raw);
}

describe('TeamCollection durable read paths', () => {
  it('starts a real Dispatcher with inert Team inventory and preserves valid history and residue', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(
      teamRequest('retained-history'),
    );
    await fixture.teams.dissolve(created.team_name, {
      note: 'Finished',
      force: true,
    });
    await fixture.host.close();
    for (const name of ['ledger', '.tmp', 'backup old'])
      await writeRawRecord(fixture, name, 'inert bytes');
    const next = fixture.build();
    await next.host.start();
    await next.host.dispatcherAgent.mustAgent().activate();
    expect(fixture.provider.runtimes).toHaveLength(1);
    expect((await next.teams.list()).map((row) => row.team_name)).toEqual([
      created.team_name,
    ]);
    expect(await next.teams.summary(created.team_name)).toMatchObject({
      status: 'closed',
    });
    for (const name of ['ledger', '.tmp', 'backup old']) {
      expect(await readdir(join(fixture.teamRoot, name))).toEqual([
        'record.json',
      ]);
      expect(
        await readFile(join(fixture.teamRoot, name, 'record.json'), 'utf8'),
      ).toBe('inert bytes');
    }
  });

  it('reports TEAM_NOT_FOUND for lookup and routing when no record exists', async () => {
    const fixture = await dispatcherFixture();
    await expect(fixture.teams.open('nope')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    await expect(fixture.teams.summary('nope')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('treats malformed records as missing and permits a valid record to claim the same name', async () => {
    const fixture = await dispatcherFixture();
    await writeRawRecord(fixture, 'ghost', '{ invalid JSON');
    await expect(fixture.teams.open('ghost')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    expect(await fixture.teams.list()).toEqual([]);
    const store = new TeamStore({
      root: fixture.teamRoot,
      dispatcherId: 'test',
    });
    const handle = await store.acquire('ghost');
    expect(
      await handle.create(
        validRawRecord('test', 'ghost') as unknown as TeamRecord,
      ),
    ).not.toBeNull();
    await handle.release();
    expect(await fixture.teams.summary('ghost')).toMatchObject({
      team_name: 'ghost',
      status: 'running',
    });
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it.each([
    [
      'leader_name missing',
      (r: Record<string, unknown>) => {
        delete r['leader_name'];
      },
    ],
    [
      'status outside the vocabulary',
      (r: Record<string, unknown>) => {
        r['status'] = 'active';
      },
    ],
    [
      'leader_agent_runtime missing',
      (r: Record<string, unknown>) => {
        delete r['leader_agent_runtime'];
      },
    ],
    [
      'repo_cwd missing',
      (r: Record<string, unknown>) => {
        delete r['repo_cwd'];
      },
    ],
    [
      'runtime_cwd missing',
      (r: Record<string, unknown>) => {
        delete r['runtime_cwd'];
      },
    ],
    [
      'worktree missing',
      (r: Record<string, unknown>) => {
        delete r['worktree'];
      },
    ],
    [
      'worktree.mode outside the vocabulary',
      (r: Record<string, unknown>) => {
        (r['worktree'] as Record<string, unknown>)['mode'] = 'symlink';
      },
    ],
    [
      'team_id disagrees with the directory it was found in',
      (r: Record<string, unknown>) => {
        r['team_id'] = 'someone-else';
      },
    ],
    [
      'dispatcher_id disagrees with the owning dispatcher',
      (r: Record<string, unknown>) => {
        r['dispatcher_id'] = 'someone-elses-dispatcher';
      },
    ],
    [
      'leader_identity_prompt has the wrong type',
      (r: Record<string, unknown>) => {
        r['leader_identity_prompt'] = 42;
      },
    ],
  ])(
    'a record with %s is TEAM_NOT_FOUND, not a crash',
    async (_label, corrupt) => {
      const fixture = await dispatcherFixture();
      const valid = validRawRecord('test', 'broken');
      corrupt(valid);
      await writeRawRecord(fixture, 'broken', JSON.stringify(valid));
      await expect(fixture.teams.open('broken')).rejects.toBeInstanceOf(
        TeamNotFoundError,
      );
      expect(await fixture.teams.list()).toEqual([]);
      expect(fixture.provider.runtimes).toHaveLength(0);
    },
  );

  it('does not expand validation beyond the Team record existence boundary', async () => {
    const fixture = await dispatcherFixture();
    const valid = validRawRecord('test', 'loose');
    valid['intent'] = 12345;
    delete valid['created_at'];
    delete valid['close_note'];
    await writeRawRecord(fixture, 'loose', JSON.stringify(valid));
    expect(await fixture.teams.summary('loose')).toMatchObject({
      team_name: 'loose',
      status: 'running',
    });
  });

  it('reads missing additive leader creation inputs as empty without backfilling the file', async () => {
    const fixture = await dispatcherFixture();
    const valid = validRawRecord('test', 'preexisting');
    delete valid['leader_identity_prompt'];
    delete valid['leader_skill_sources'];
    const raw = JSON.stringify(valid);
    await writeRawRecord(fixture, 'preexisting', raw);
    const store = new TeamStore({
      root: fixture.teamRoot,
      dispatcherId: 'test',
    });
    expect(await store.get('preexisting')).toMatchObject({
      leader_identity_prompt: null,
      leader_skill_sources: [],
    });
    expect(
      await readFile(
        join(fixture.teamRoot, 'preexisting', 'record.json'),
        'utf8',
      ),
    ).toBe(raw);
  });

  it('lists, searches, and summarizes closed Teams with no leader identity or TeamService', async () => {
    const fixture = await dispatcherFixture();
    await writeRawRecord(
      fixture,
      'retired',
      JSON.stringify({
        ...validRawRecord('test', 'retired'),
        status: 'closed',
      }),
    );
    expect(await fixture.teams.list()).toEqual([
      expect.objectContaining({
        team_name: 'retired',
        status: 'closed',
        leader_state: null,
      }),
    ]);
    expect((await fixture.teams.history({})).items).toEqual([
      expect.objectContaining({ team_name: 'retired', status: 'closed' }),
    ]);
    expect(await fixture.teams.summary('retired')).toMatchObject({
      status: 'closed',
      leader_state: null,
    });
    await expect(fixture.teams.open('retired')).rejects.toBeInstanceOf(
      TeamClosedError,
    );
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('counts occupied member directories identically in live and cold projections', async () => {
    const fixture = await dispatcherFixture();
    const created = await fixture.teams.createFromRequest(
      teamRequest('member-occupancy'),
    );
    const root = teamMateCollectionDir(
      join(fixture.teamRoot, created.team_name),
    );
    const store = new AgentEntityCollectionStore({
      root,
      dispatcherId: 'test',
      log: createLogger({ destination: { write() {} } }),
    });
    await store.entity('closed-member').create({
      name: 'closed-member',
      teamId: created.team_name,
      agentRuntime: 'controlled',
      sourceCwd: created.runtime_cwd,
      sourceRepo: created.source_repo,
      cwd: created.runtime_cwd,
      runtimeCwd: created.runtime_cwd,
      worktree: reuseCwdWorktree(created.runtime_cwd),
      status: 'closed',
    });
    await mkdir(join(root, 'missing-identity'));
    await mkdir(join(root, 'malformed-identity'));
    await writeFile(
      join(root, 'malformed-identity', 'identity.json'),
      '{ invalid JSON',
    );
    const live = await fixture.teams.summary(created.team_name);
    expect(live.member_count).toBe(3);
    expect((await fixture.teams.list())[0]).toMatchObject({
      member_count: 3,
      leader_state: live.leader_state,
    });
    await fixture.host.close();
    const cold = fixture.build();
    const status = await cold.teams.summary(created.team_name);
    expect(status).toMatchObject({
      member_count: 3,
      leader_name: created.leader_name,
    });
    expect((await cold.teams.list())[0]).toMatchObject({
      member_count: 3,
      leader_state: status.leader_state,
    });
    expect(fixture.provider.runtimes).toHaveLength(0);
  });

  it('joins concurrent open to the same in-flight create until initial admission settles', async () => {
    const fixture = await dispatcherFixture();
    const admission = deferred<RuntimeAdmission>();
    const pending = controllableRuntimeSubmission();
    fixture.releases.push(() => {
      admission.resolve({ status: 'stopped' });
      pending.stop();
    });
    fixture.provider.planNext({ delayedAdmission: admission.promise });
    const creating = fixture.teams.createFromRequest(
      teamRequest('joined-create', 'First task'),
    );
    await vi.waitFor(() => expect(fixture.provider.runtimes).toHaveLength(1));
    await fixture.provider.runtimes[0]!.submitStarted.promise;
    const [name] = await readdir(fixture.teamRoot);
    if (name === undefined) throw new Error('expected durable Team');
    let opened = false;
    const opening = fixture.teams.open(name).then((service) => {
      opened = true;
      return service;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(false);
    admission.resolve({ status: 'submitted', submission: pending.submission });
    const [created, service] = await Promise.all([creating, opening]);
    expect(created).toMatchObject({ team_name: name, status: 'running' });
    expect(await fixture.teams.open(name)).toBe(service);
    expect(fixture.provider.runtimes).toHaveLength(1);
    expect(fixture.provider.runtimes[0]!.inputs).toHaveLength(1);
    pending.stop();
  });
});

function validRawRecord(
  dispatcherId: string,
  teamId: string,
): Record<string, unknown> {
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    team_id: teamId,
    name: teamId,
    repo_cwd: '/tmp/unused-cwd',
    source_repo: null,
    leader_name: `tl-${teamId}-seed`,
    leader_agent_runtime: 'controlled',
    leader_identity_prompt: null,
    leader_skill_sources: [],
    runtime_cwd: '/tmp/unused-cwd',
    worktree: {
      mode: 'reuse-cwd',
      slug: null,
      path: '/tmp/unused-cwd',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    },
    status: 'running',
    intent: 'ok',
    created_at: 1,
    updated_at: 1,
    closed_at: null,
    close_note: null,
    create_request_id: null,
    create_payload_hash: null,
    worktree_cleanup_force: false,
  };
}
