import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TeamNotFoundError, TeamClosedError } from '../src/service/team-collection/errors.js';
import { resolveSpawnWorkspace } from '../src/service/worktree/workspaces.js';
import type { SpawnTeamMateRequest } from '../src/service/teammate-collection/types.js';
import type { DreamuxConfig } from '../src/config/config.js';

import {
  buildTeamCollectionHarness,
  minimalTeamRecordInput,
  mockLeaderSubmission,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';

let harness: TeamCollectionHarness | null = null;
let submission: { restore(): void } | null = null;

afterEach(async () => {
  submission?.restore();
  submission = null;
  await harness?.cleanup();
  harness = null;
});

describe('TeamCollection: missing/malformed records', () => {
  it('reports TEAM_NOT_FOUND for lookup and routing when no record exists at all', async () => {
    harness = await buildTeamCollectionHarness();
    await expect(harness.collection.open('nope')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    await expect(harness.collection.summary('nope')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
  });

  it('treats a malformed record identically to a missing one: not found, not listed, and its name is not reserved', async () => {
    harness = await buildTeamCollectionHarness();
    await writeRawRecord(harness, 'ghost', '{ this is not JSON');

    await expect(harness.collection.open('ghost')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    expect(await harness.collection.list()).toEqual([]);

    // A name a malformed record sits at is free, not reserved: publishing a
    // fresh, valid record at the EXACT same name succeeds — the malformed
    // file held no claim on it, so exclusive publication (which fails fast
    // on a real collision) falls through to replacing it.
    const republished = await harness.seedStore.create(
      minimalTeamRecordInput({ dispatcherId: harness.dispatcherId, teamId: 'ghost' }),
    );
    expect(republished).not.toBeNull();
    expect((await harness.seedStore.get('ghost'))?.status).toBe('running');
  });

  it.each([
    ['leader_name missing', (r: Record<string, unknown>) => { delete r['leader_name']; }],
    ['status outside the vocabulary', (r: Record<string, unknown>) => { r['status'] = 'active'; }],
    ['leader_agent_runtime missing', (r: Record<string, unknown>) => { delete r['leader_agent_runtime']; }],
    ['repo_cwd missing', (r: Record<string, unknown>) => { delete r['repo_cwd']; }],
    ['runtime_cwd missing', (r: Record<string, unknown>) => { delete r['runtime_cwd']; }],
    ['worktree missing', (r: Record<string, unknown>) => { delete r['worktree']; }],
    ['worktree.mode outside the vocabulary', (r: Record<string, unknown>) => {
      (r['worktree'] as Record<string, unknown>)['mode'] = 'symlink';
    }],
    ['team_id disagrees with the directory it was found in', (r: Record<string, unknown>) => {
      r['team_id'] = 'someone-else';
    }],
    ['dispatcher_id disagrees with the owning dispatcher', (r: Record<string, unknown>) => {
      r['dispatcher_id'] = 'someone-elses-dispatcher';
    }],
    ['leader_identity_prompt has the wrong type', (r: Record<string, unknown>) => {
      r['leader_identity_prompt'] = 42;
    }],
  ])('a record with %s is TEAM_NOT_FOUND, not a crash', async (_label, corrupt) => {
    harness = await buildTeamCollectionHarness();
    const valid = validRawRecord(harness.dispatcherId, 'broken');
    corrupt(valid);
    await writeRawRecord(harness, 'broken', JSON.stringify(valid));

    await expect(harness.collection.open('broken')).rejects.toBeInstanceOf(
      TeamNotFoundError,
    );
    expect(await harness.collection.list()).toEqual([]);
  });

  it('does NOT validate fields outside the record-validity boundary — their absence is the contract', async () => {
    harness = await buildTeamCollectionHarness();
    const valid = validRawRecord(harness.dispatcherId, 'loose');
    // Wrong type, and entirely absent — neither is part of what a Team record
    // is checked for; both must still read back as a found, live Team.
    valid['intent'] = 12345;
    delete valid['created_at'];
    delete valid['close_note'];
    await writeRawRecord(harness, 'loose', JSON.stringify(valid));

    await expect(harness.collection.summary('loose')).resolves.toMatchObject({
      team: { team_name: 'loose', status: 'running' },
    });
  });

  it('reads a record written before leader_identity_prompt/leader_skill_sources existed as empty, never backfilled', async () => {
    harness = await buildTeamCollectionHarness();
    const valid = validRawRecord(harness.dispatcherId, 'preexisting');
    delete valid['leader_identity_prompt'];
    delete valid['leader_skill_sources'];
    await writeRawRecord(harness, 'preexisting', JSON.stringify(valid));

    const record = await harness.seedStore.get('preexisting');
    expect(record?.leader_identity_prompt).toBeNull();
    expect(record?.leader_skill_sources).toEqual([]);
  });

  it("a stale in-memory record snapshot cannot resurrect a Team whose disk record has since become invalid", async () => {
    harness = await buildTeamCollectionHarness();
    const input = minimalTeamRecordInput({
      dispatcherId: harness.dispatcherId,
      teamId: 'vanishing',
    });
    const staleSnapshot = await harness.seedStore.create(input);
    expect(staleSnapshot).not.toBeNull();

    // The record an operator or a failed write left behind is now unreadable —
    // simulating a Team whose durable proof of existence disappeared out from
    // under an in-memory copy still held somewhere.
    await writeRawRecord(harness, 'vanishing', '{ corrupted, not valid json');

    await expect(
      harness.seedStore.update(staleSnapshot!, {
        status: 'closed',
        closedAt: Date.now(),
        closeNote: 'attempted close of a vanished Team',
      }),
    ).rejects.toBeInstanceOf(TeamNotFoundError);

    // Nothing was written back from the stale snapshot: the file on disk is
    // exactly the corrupted content this test planted, not a resurrected,
    // merged "closed" record built from stale memory.
    const raw = await readFile(recordPath(harness, 'vanishing'), 'utf8');
    expect(raw).toBe('{ corrupted, not valid json');
  });
});

describe('TeamCollection: closed Teams are record-only reads', () => {
  it('lists, searches, and summarizes a closed Team from its record alone, without materializing a TeamService', async () => {
    harness = await buildTeamCollectionHarness();
    // Seeded directly: there is no leader identity file at all for this Team,
    // so any code path that tried to materialize a TeamService would either
    // throw (rebuild refuses a closed record outright) or need a real leader
    // identity it does not have. `list`/`history`/`summary` succeeding proves
    // neither path was taken.
    await harness.seedStore.create(minimalTeamRecordInput({
      dispatcherId: harness.dispatcherId,
      teamId: 'retired',
      status: 'closed',
    }));

    const rows = await harness.collection.list();
    expect(rows).toEqual([
      expect.objectContaining({ team_name: 'retired', status: 'closed', leader_state: null }),
    ]);

    const history = await harness.collection.history({});
    expect(history.items).toEqual([
      expect.objectContaining({ team_name: 'retired', status: 'closed' }),
    ]);

    const summary = await harness.collection.summary('retired');
    expect(summary.team.status).toBe('closed');
    expect(summary.leader).toBeNull();

    // The one operation that DOES require a live Team refuses instead of
    // building one — a closed Team is never materialized again.
    await expect(harness.collection.open('retired')).rejects.toBeInstanceOf(
      TeamClosedError,
    );
  });
});

describe('TeamCollection: shared create/open construction', () => {
  it('joins a concurrent open() to the exact same in-flight creation, and only delivers work after the leader is usable', async () => {
    const gate = mockLeaderSubmission();
    submission = gate;
    harness = await buildTeamCollectionHarness();

    // A prompt is what makes the leader's first submission happen at all — a
    // promptless creation would reach no runtime, and there would be nothing
    // here to hold open.
    const creating = harness.collection.create({
      name: 'joined',
      leaderAgentRuntime: 'fake',
      intent: 'first caller',
      prompt: 'first task',
    });

    // Wait for the record to actually be durable (the record is published
    // BEFORE the leader's first `submitInput()` call) so the concurrent
    // `admit` below has a real, findable Team to join rather than racing
    // record publication.
    await waitFor(async () => (await harness!.seedStore.get('joined')) !== null);

    let delivered = false;
    let seenService: unknown;
    const admitting = harness.collection.admit('joined', async (service) => {
      delivered = true;
      seenService = service;
      return service.view();
    });

    // The leader's first `submitInput()` is still held open, so nothing has
    // been delivered to the joined caller yet — construction is shared, not
    // bypassed by a second, independent build.
    await settledOrPending(admitting);
    expect(delivered).toBe(false);

    gate.release();
    const [createResult, admitResult] = await Promise.all([creating, admitting]);

    expect(delivered).toBe(true);
    expect(createResult.team.status).toBe('running');
    expect(admitResult.status).toBe('running');
    // Exactly one leader submission for both callers together.
    expect(gate.callCount()).toBe(1);

    // The exact same TeamService instance both callers ended up sharing is
    // also what a later, ordinary open() reads back from the cache.
    const reopened = await harness.collection.open('joined');
    expect(reopened).toBe(seenService);
  });
});

describe('Team-scoped TeamMate workspace borrowing', () => {
  it('borrows the Team runtime directory as reuse-cwd/keep, never copying the Team worktree\'s own identity', async () => {
    const teamManagedWorktree = {
      mode: 'managed' as const,
      slug: 'team-slug',
      path: '/team/managed/checkout',
      branch: 'dreamux/team-branch',
      base_ref: 'main',
      cleanup: 'delete-on-close' as const,
      cleanup_state: 'managed-active' as const,
      cleanup_error: null,
    };
    const request: SpawnTeamMateRequest = {
      name: 'member-1',
      prompt: 'hi',
      intent: 'work',
      sharedWorkspace: {
        sourceCwd: '/team/managed/checkout',
        sourceRepo: 'git@example.com:org/repo.git',
        runtimeCwd: '/team/managed/checkout',
      },
    };
    const config: DreamuxConfig = { agents: {}, dispatchers: [] };
    const untouchedWorktrees = {
      prepare: () => { throw new Error('must not be called for a shared-workspace spawn'); },
      prepareDefaultWorkspace: () => {
        throw new Error('must not be called for a shared-workspace spawn');
      },
    } as unknown as import('../src/service/worktree/manager.js').WorktreeManager;

    const workspace = await resolveSpawnWorkspace({
      config,
      worktrees: untouchedWorktrees,
      dispatcherId: 'd1',
      name: 'member-1',
      request,
    });

    expect(workspace.createdCheckout).toBe(false);
    expect(workspace.worktree).toEqual({
      mode: 'reuse-cwd',
      slug: null,
      path: '/team/managed/checkout',
      branch: null,
      base_ref: null,
      cleanup: 'keep',
      cleanup_state: 'not-managed',
      cleanup_error: null,
    });
    // None of the Team's own managed-worktree facts (slug, branch, base_ref,
    // delete-on-close, active cleanup state) made it into the member's
    // workspace — the loan type carries no worktree identity at all, so
    // there is nothing for a member's own close to mistakenly clean up.
    expect(workspace.worktree).not.toMatchObject({
      slug: teamManagedWorktree.slug,
      cleanup: 'delete-on-close',
    });
  });

  it('lets a dispatcher-scoped TeamMate (no sharedWorkspace) take its own managed, delete-on-close worktree', async () => {
    // `resolveSpawnWorkspace` resolves the dispatcher's own workspace cwd for
    // real in managed mode (it is only the checkout placement that is faked
    // below), so this needs one genuine, writable dispatcher cwd.
    const dispatcherCwd = await mkdtemp(join(tmpdir(), 'dreamux-dispatcher-cwd-'));
    let prepareCalls = 0;
    const worktrees = {
      prepare: async () => {
        prepareCalls += 1;
        return {
          sourceCwd: '/repo',
          sourceRepo: '/repo',
          runtimeCwd: '/repo/.workspace/worktree/repo/member-1',
          worktree: {
            mode: 'managed' as const,
            slug: 'member-1',
            path: '/repo/.workspace/worktree/repo/member-1',
            branch: 'dreamux/member-1',
            base_ref: null,
            cleanup: 'delete-on-close' as const,
            cleanup_state: 'managed-active' as const,
            cleanup_error: null,
          },
          createdCheckout: true,
        };
      },
      prepareDefaultWorkspace: () => {
        throw new Error('must not be called when the caller supplied an explicit cwd/worktree');
      },
    } as unknown as import('../src/service/worktree/manager.js').WorktreeManager;

    try {
      const config: DreamuxConfig = {
        agents: {},
        dispatchers: [{
          id: 'd1',
          cwd: dispatcherCwd,
          enabled: true,
          workspace: { enabled: false },
          channels: [],
          agentRuntime: 'unused',
          runtime: { provider: 'unused', config: {} },
        }],
      };
      const workspace = await resolveSpawnWorkspace({
        config,
        worktrees,
        dispatcherId: 'd1',
        name: 'member-1',
        request: {
          name: 'member-1',
          prompt: 'hi',
          intent: 'work',
          cwd: '/repo',
          worktree: { mode: 'managed', cleanup: 'delete-on-close' },
        },
      });

      expect(prepareCalls).toBe(1);
      expect(workspace.createdCheckout).toBe(true);
      expect(workspace.worktree.mode).toBe('managed');
      expect(workspace.worktree.cleanup).toBe('delete-on-close');
    } finally {
      await rm(dispatcherCwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// helpers

function recordPath(harness: TeamCollectionHarness, teamId: string): string {
  return join(harness.teamCollectionRoot, teamId, 'record.json');
}

async function writeRawRecord(
  harness: TeamCollectionHarness,
  teamId: string,
  raw: string,
): Promise<void> {
  await mkdir(join(harness.teamCollectionRoot, teamId), { recursive: true });
  await writeFile(recordPath(harness, teamId), raw);
}

function validRawRecord(dispatcherId: string, teamId: string): Record<string, unknown> {
  return {
    version: 1,
    dispatcher_id: dispatcherId,
    team_id: teamId,
    name: teamId,
    repo_cwd: '/tmp/unused-cwd',
    source_repo: null,
    leader_name: `tl-${teamId}-seed`,
    leader_agent_runtime: 'fake',
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

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Give a promise a short window to settle, without ever timing out the test. */
async function settledOrPending(promise: Promise<unknown>): Promise<void> {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 30)),
  ]);
}
