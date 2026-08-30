import { readdir } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { teamCreatePayloadHash } from '../src/service/team-collection/create-request.js';
import { IdempotencyConflictError } from '../src/service/team-collection/errors.js';
import { TeamCollection } from '../src/service/team-collection/index.js';
import type { TeamCollectionOptions } from '../src/service/team-collection/types.js';

import {
  buildTeamCollectionHarness,
  minimalTeamRecordInput,
  mockLeaderActivationRejected,
  mockLeaderActivationResolved,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';

/**
 * `team.create` idempotency (technical-design/final.md §1-4): the Team record
 * is the whole protocol. Its exclusive publication is simultaneously the
 * single acceptance point, the concrete-name ownership point, and the durable
 * record of which request produced it — there is no second persisted
 * authority (no `team-create-requests.json`, no `name-claim.json`, no
 * tombstone).
 */

let harness: TeamCollectionHarness | null = null;
let activation: { restore(): void } | null = null;

afterEach(async () => {
  activation?.restore();
  activation = null;
  await harness?.cleanup();
  harness = null;
});

function hashOf(payload: unknown): string {
  return teamCreatePayloadHash(payload);
}

/** Every file this harness's whole `DREAMUX_ROOT` durably wrote, recursively. */
async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await allFiles(path)));
    else out.push(path);
  }
  return out;
}

describe('team.create idempotency', () => {
  it('publishes the accepted request identity directly into the record, with no separate ledger file anywhere', async () => {
    activation = mockLeaderActivationResolved();
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'ship the thing' });

    const created = await harness.collection.createFromRequest({
      requestId: 'req-only-record',
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(created.status).toBe('created');

    const record = await harness.seedStore.get(created.team_name);
    expect(record?.create_request_id).toBe('req-only-record');
    expect(record?.create_payload_hash).toBe(hash);

    // The whole durable state tree this harness owns holds only the two files
    // every Team/leader pair always writes — no second ledger of any kind.
    const files = (await allFiles(harness.teamCollectionRoot)).map((f) =>
      f.split('/').pop(),
    );
    expect(new Set(files)).toEqual(new Set(['record.json', 'identity.json']));
    const suspicious = files.filter((f) =>
      /claim|request|tombstone|ledger|index/i.test(f ?? ''),
    );
    expect(suspicious).toEqual([]);
  });

  it('resolves a same-id, same-hash replay to the same Team, even from a fresh TeamCollection over the same store (a restart)', async () => {
    activation = mockLeaderActivationResolved();
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'ship the thing' });
    const requestId = 'req-replay';

    const first = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(first.status).toBe('created');

    const secondSameProcess = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(secondSameProcess).toEqual({
      status: 'existing',
      team_name: first.team_name,
      leader_name: first.leader_name,
    });

    // A fresh `TeamCollection` bound to the exact same `team/` root has no
    // in-memory cache at all — the replay answer has to come from scanning
    // durable records, which is what a restart actually has available.
    const restarted = new TeamCollection({
      ...collectionOptionsFor(harness),
    });
    const afterRestart = await restarted.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(afterRestart).toEqual({
      status: 'existing',
      team_name: first.team_name,
      leader_name: first.leader_name,
    });
  });

  it('raises IdempotencyConflictError for the same request id replayed with a different payload, and creates no second Team', async () => {
    activation = mockLeaderActivationResolved();
    harness = await buildTeamCollectionHarness();
    const requestId = 'req-conflict';

    const created = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hashOf({ intent: 'version A' }),
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'version A' },
    });
    expect(created.status).toBe('created');

    await expect(
      harness.collection.createFromRequest({
        requestId,
        payloadHash: hashOf({ intent: 'version B, not what was accepted' }),
        options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'version B' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    // Exactly the one Team the first call made — the conflicting replay must
    // not have produced a second record under this request id.
    const all = await harness.seedStore.list();
    expect(all.filter((t) => t.create_request_id === requestId)).toHaveLength(1);
  });

  it('answers a replay against a closed Team with status "closed", from the exact same request identity', async () => {
    activation = mockLeaderActivationResolved();
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'short-lived' });
    const requestId = 'req-closed-replay';

    const created = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'short-lived' },
    });
    const record = await harness.seedStore.get(created.team_name);
    expect(record).not.toBeNull();
    // Close it directly through the record — how it got closed is not this
    // contract's business; only the record's status is.
    await harness.seedStore.update(record!, {
      status: 'closed',
      closedAt: Date.now(),
      closeNote: 'done',
    });

    const replay = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'short-lived' },
    });
    expect(replay).toEqual({
      status: 'closed',
      team_name: created.team_name,
      leader_name: created.leader_name,
    });
  });

  it('leaves a candidate name free after a failed attempt, so a fresh request can take it', async () => {
    activation = mockLeaderActivationResolved();
    // Force the very first candidate to collide with an unrelated, already
    // published Team, so allocation must move on to a second candidate.
    let calls = 0;
    harness = await buildTeamCollectionHarness({
      nameSuffixGenerator: () => (calls++ === 0 ? 'taken' : 'free'),
    });
    const occupant = minimalTeamRecordInput({
      dispatcherId: harness.dispatcherId,
      teamId: 'alpha-taken',
      createRequestId: 'someone-elses-request',
      createPayloadHash: hashOf({ intent: 'not this test' }),
    });
    await harness.seedStore.create(occupant);

    const result = await harness.collection.createFromRequest({
      requestId: 'req-name-retry',
      payloadHash: hashOf({ intent: 'needs a free name' }),
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'needs a free name' },
    });

    // The occupied candidate was never this request's to reserve or touch.
    expect(result.team_name).toBe('alpha-free');
    const untouched = await harness.seedStore.get('alpha-taken');
    expect(untouched?.create_request_id).toBe('someone-elses-request');
  });

  it('leaves a durable, replayable acceptance even when creation fails AFTER the record is published', async () => {
    harness = await buildTeamCollectionHarness();
    activation = mockLeaderActivationRejected(new Error('runtime boom'));
    const hash = hashOf({ intent: 'will fail to activate' });
    const requestId = 'req-after-publish-failure';

    await expect(
      harness.collection.createFromRequest({
        requestId,
        payloadHash: hash,
        options: {
          namePrefix: 'alpha',
          leaderAgentRuntime: 'fake',
          intent: 'will fail to activate',
        },
      }),
    ).rejects.toThrow(/runtime boom/);

    // The record the failed attempt published is still there, still carrying
    // the request identity, and now durably closed — not silently discarded.
    const all = await harness.seedStore.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.create_request_id).toBe(requestId);
    expect(all[0]?.status).toBe('closed');

    const replay = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: {
        namePrefix: 'alpha',
        leaderAgentRuntime: 'fake',
        intent: 'will fail to activate',
      },
    });
    expect(replay.status).toBe('closed');
    expect(replay.team_name).toBe(all[0]?.team_id);
  });

  it('serializes two concurrent createFromRequest calls under the same request id into one created Team', async () => {
    activation = mockLeaderActivationResolved();
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'racing callers' });
    const requestId = 'req-concurrent';

    const [first, second] = await Promise.all([
      harness.collection.createFromRequest({
        requestId,
        payloadHash: hash,
        options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'racing callers' },
      }),
      harness.collection.createFromRequest({
        requestId,
        payloadHash: hash,
        options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'racing callers' },
      }),
    ]);

    // Exactly one of the two callers actually created the Team; the other
    // joined the same request-id lifecycle queue and read back the answer.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['created', 'existing']);
    expect(first.team_name).toBe(second.team_name);
    expect(first.leader_name).toBe(second.leader_name);

    const all = await harness.seedStore.list();
    expect(all).toHaveLength(1);
  });
});

function collectionOptionsFor(harness: TeamCollectionHarness): TeamCollectionOptions {
  // A second `TeamCollection` over the exact same durable root, standing in
  // for "a fresh process attached to the same state" — deliberately built
  // from scratch rather than reusing any in-memory object the first
  // collection constructed.
  return {
    dispatcherId: harness.dispatcherId,
    config: { agents: {}, dispatchers: [] },
    agentRuntimeProviders: {} as unknown as TeamCollectionOptions['agentRuntimeProviders'],
    worktrees: {} as unknown as TeamCollectionOptions['worktrees'],
    root: harness.teamCollectionRoot,
    names: {
      allocate: async () => `restarted-leader-${Math.random().toString(36).slice(2)}`,
    } as unknown as TeamCollectionOptions['names'],
    admissions: {} as unknown as TeamCollectionOptions['admissions'],
    completionDelivery: {} as unknown as TeamCollectionOptions['completionDelivery'],
    dispatcherCompletionInitiator: async () => null,
    leaderMcp: () => ({ leases: {}, delegates: [], adminSocketPath: '' }) as unknown as ReturnType<
      TeamCollectionOptions['leaderMcp']
    >,
    log: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    } as unknown as TeamCollectionOptions['log'],
    workflowLog: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    } as unknown as TeamCollectionOptions['log'],
  };
}
