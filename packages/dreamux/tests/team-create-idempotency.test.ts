import { readdir } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentRuntimeCreateContext,
  AgentRuntimeProvider,
  JsonValue,
  TeamCreateContext,
  TeamSummary,
} from '@excitedjs/dreamux-types';

import type { CoreCommandPort } from '../src/command/port.js';
import type { TeamCollection } from '../src/service/team-collection/index.js';
import { teamCreatePayloadHash } from '../src/service/team-collection/create-request.js';
import { IdempotencyConflictError } from '../src/service/team-collection/errors.js';

import { channelContext, createCommandHarness } from './helpers/command-harness.js';
import {
  buildRestartedTeamCollection,
  buildTeamCollectionHarness,
  minimalTeamRecordInput,
  mockLeaderSubmissionRejected,
  type TeamCollectionHarness,
} from './helpers/team-harness.js';
import { controllableRuntimeSubmission } from './helpers/runtime-submission.js';
import { createCapturingPublisher } from './helpers/event-harness.js';

/**
 * `team.create` idempotency (technical-design/final.md §1-4): the Team record
 * is the whole protocol. Its exclusive publication is simultaneously the
 * single acceptance point, the concrete-name ownership point, and the durable
 * record of which request produced it — there is no second persisted
 * authority (no `team-create-requests.json`, no `name-claim.json`, no
 * tombstone).
 */

let harness: TeamCollectionHarness | null = null;
let submission: { restore(): void } | null = null;

afterEach(async () => {
  submission?.restore();
  submission = null;
  await harness?.cleanup();
  harness = null;
});

function hashOf(payload: unknown): string {
  return teamCreatePayloadHash(payload);
}

/**
 * One provider's opaque creation context; Core never reads inside `payload`.
 *
 * `satisfies` rather than an annotation: this fixture is also sent as a raw
 * Command payload, and a declared interface type carries no index signature to
 * make it a `JsonValue`. Checking it against the contract while keeping its
 * literal type is what lets the same fixture stand on both sides.
 */
const feishuContext = {
  provider: 'builtin:feishu',
  payload: { chat_id: 'oc_team_create', title: 'Team Create Contract' },
} satisfies TeamCreateContext;

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
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'ship the thing' });

    const created = await harness.collection.createFromRequest({
      requestId: 'req-only-record',
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(created.status).toBe('running');

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
    harness = await buildTeamCollectionHarness();
    const hash = hashOf({ intent: 'ship the thing' });
    const requestId = 'req-replay';

    const first = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(first.status).toBe('running');

    const secondSameProcess = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(secondSameProcess).toEqual(first);

    // A fresh `TeamCollection` bound to the exact same `team/` root has no
    // in-memory cache at all — the replay answer has to come from scanning
    // durable records, which is what a restart actually has available.
    const restarted = buildRestartedTeamCollection(harness);
    const afterRestart = await restarted.createFromRequest({
      requestId,
      payloadHash: hash,
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'ship the thing' },
    });
    expect(afterRestart).toEqual({
      ...first,
      leader_runtime_status: null,
    });
  });

  it('returns one current held-live runtime status from create, status, and same-process replay, and the matching list row, without resubmitting', async () => {
    let submissions = 0;
    const provider = {
      getCapabilities: () => ({ tags: [] }),
      readRecentActivity: async () => ({ records: [], truncated: false }),
      async createRuntime(context: AgentRuntimeCreateContext<unknown>) {
        return {
          async start() {
            await context.state.publish({ kind: 'status', status: 'ready' });
            return { continuity: 'fresh' as const };
          },
          async submit() {
            submissions += 1;
            const pending = controllableRuntimeSubmission();
            pending.complete(null);
            return { status: 'submitted' as const, submission: pending.submission };
          },
          async interrupt() { return { status: 'idle' as const }; },
          async stop() {},
        };
      },
    } as AgentRuntimeProvider<unknown>;
    harness = await buildTeamCollectionHarness({
      agentRuntime: { id: 'live-runtime', provider },
    });
    const requestId = 'req-held-live-runtime';
    const hash = hashOf({ intent: 'observe the live owner', prompt: 'start now' });
    const request = {
      requestId,
      payloadHash: hash,
      options: {
        namePrefix: 'alpha',
        leaderAgentRuntime: 'live-runtime',
        intent: 'observe the live owner',
        prompt: 'start now',
      },
    };

    const created = await harness.collection.createFromRequest(request);
    expect(created.leader_runtime_status).toBe('ready');
    expect(submissions).toBe(1);

    const status = await harness.collection.summary(created.team_name);
    const listed = (await harness.collection.list()).find(
      (team) => team.team_name === created.team_name,
    );
    const replayed = await harness.collection.createFromRequest(request);

    expect(status).toEqual(created);
    expect(replayed).toEqual(created);
    // The list row is the record's compact view: same names and meanings as
    // the summary, no runtime status.
    expect(listed).toEqual({
      team_name: created.team_name,
      status: created.status,
      intent: created.intent,
      source_repo: created.source_repo,
      leader_name: created.leader_name,
      leader_agent_runtime: created.leader_agent_runtime,
      leader_state: created.leader_state,
      member_count: created.member_count,
      created_at: created.created_at,
      updated_at: created.updated_at,
      closed_at: created.closed_at,
      worktree_cleanup: created.worktree_cleanup,
    });
    expect(submissions).toBe(1);
  });

  it('raises IdempotencyConflictError for the same request id replayed with a different payload, and creates no second Team', async () => {
    harness = await buildTeamCollectionHarness();
    const requestId = 'req-conflict';

    const created = await harness.collection.createFromRequest({
      requestId,
      payloadHash: hashOf({ intent: 'version A' }),
      options: { namePrefix: 'alpha', leaderAgentRuntime: 'fake', intent: 'version A' },
    });
    expect(created.status).toBe('running');

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
    expect(replay).toMatchObject({
      status: 'closed',
      team_name: created.team_name,
      leader_name: created.leader_name,
      leader_agent_runtime: created.leader_agent_runtime,
      runtime_cwd: created.runtime_cwd,
    });
  });

  it('leaves a candidate name free after a failed attempt, so a fresh request can take it', async () => {
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
    const publisher = createCapturingPublisher();
    harness = await buildTeamCollectionHarness({ coreEvents: publisher });
    submission = mockLeaderSubmissionRejected(new Error('runtime boom'));
    // A prompt is what makes the leader's first submission happen at all — a
    // promptless creation reaches no runtime, so it could never fail here.
    const hash = hashOf({
      intent: "will fail on the leader's first submission",
      prompt: 'first task',
    });
    const requestId = 'req-after-publish-failure';

    await expect(
      harness.collection.createFromRequest({
        requestId,
        payloadHash: hash,
        options: {
          namePrefix: 'alpha',
          leaderAgentRuntime: 'fake',
          intent: "will fail on the leader's first submission",
          prompt: 'first task',
        },
      }),
    ).rejects.toThrow(/runtime boom/);
    // Creation never completed, so no Channel is told to act on it.
    expect(
      publisher.published.filter(({ event }) => event.kind === 'team.created'),
    ).toEqual([]);

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
        intent: "will fail on the leader's first submission",
        prompt: 'first task',
      },
    });
    expect(replay.status).toBe('closed');
    expect(replay.team_name).toBe(all[0]?.team_id);
    expect(
      publisher.published.filter(({ event }) => event.kind === 'team.created'),
    ).toEqual([]);
  });

  it('serializes two concurrent createFromRequest calls under the same request id into one created Team', async () => {
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

    // Exactly one caller publishes the Team; the other joins the same
    // request-id lifecycle queue and receives the same canonical projection,
    // with no operation-outcome discriminator.
    expect(second).toEqual(first);
    expect(first.status).toBe('running');

    const all = await harness.seedStore.list();
    expect(all).toHaveLength(1);
  });
});

/**
 * The same creation context, at the surface that actually carries it.
 *
 * The Command owns the declared payload schema, the parse into a
 * `TeamCreateContext`, and the canonical hash — so a test that calls
 * `createFromRequest` with a hash it computed itself proves nothing about
 * whether `team.create` reads, hashes, or forwards `context` at all. These go
 * through the real registry instead, standing the real `TeamCollection` where
 * production stands it: `DispatcherService.createTeam` is a one-line forward
 * to `createFromRequest`, and there is nothing else between the two.
 */
describe('team.create context, through the Command a Channel invokes', () => {
  function commandPortOver(collection: () => TeamCollection): CoreCommandPort {
    return createCommandHarness({
      dispatcherOverrides: {
        createTeam: (input) =>
          collection().createFromRequest(
            input as Parameters<TeamCollection['createFromRequest']>[0],
          ),
      },
    }).port;
  }

  /** One valid `team.create` payload, as a Channel sends it. */
  function createPayload(extra: Record<string, JsonValue> = {}): JsonValue {
    return {
      request_id: 'req-created-event',
      name_prefix: 'alpha',
      intent: 'bind the external conversation',
      leader: { agent_runtime: 'fake' },
      ...extra,
    };
  }

  it('projects create context onto the fresh answer and publishes team.created once, never on replay', async () => {
    const publisher = createCapturingPublisher();
    harness = await buildTeamCollectionHarness({ coreEvents: publisher });
    let target: TeamCollection = harness.collection;
    const port = commandPortOver(() => target);
    const request = createPayload({ context: feishuContext });
    const createdEvents = (): unknown[] =>
      publisher.published.filter(({ event }) => event.kind === 'team.created');

    const created = (await port.invoke(
      channelContext(),
      'team.create',
      request,
    )) as unknown as TeamSummary;
    expect(created.metadata).toEqual(feishuContext);
    // The context lives on this answer and this event only: it is never
    // written to the Team record, so the ordinary read has nothing to return.
    expect(await target.summary(created.team_name)).not.toHaveProperty('metadata');
    expect(createdEvents()).toHaveLength(1);
    expect(createdEvents()[0]).toMatchObject({
      dispatcherId: harness.dispatcherId,
      event: { schema_version: 1, kind: 'team.created', summary: created },
    });

    // A replay answers from the accepted record and projects the same context,
    // but nothing was created, so nothing is announced a second time.
    expect(await port.invoke(channelContext(), 'team.create', request)).toEqual(created);
    expect(createdEvents()).toHaveLength(1);

    target = buildRestartedTeamCollection(harness, { coreEvents: publisher });
    expect(await port.invoke(channelContext(), 'team.create', request)).toEqual({
      ...created,
      leader_runtime_status: null,
    });
    expect(createdEvents()).toHaveLength(1);
  });

  it('creates without metadata when the caller sends no context, and conflicts when a replay adds one', async () => {
    const publisher = createCapturingPublisher();
    harness = await buildTeamCollectionHarness({ coreEvents: publisher });
    const target = harness.collection;
    const port = commandPortOver(() => target);

    const created = (await port.invoke(
      channelContext(),
      'team.create',
      createPayload(),
    )) as unknown as TeamSummary;
    expect(created).not.toHaveProperty('metadata');
    expect(
      publisher.published.filter(({ event }) => event.kind === 'team.created'),
    ).toHaveLength(1);

    // Context is part of the canonical payload the Command hashes, so adding
    // one to a replayed id is a different request, not the same one described
    // differently — and the Team that request already made is the only one.
    await expect(
      port.invoke(
        channelContext(),
        'team.create',
        createPayload({ context: feishuContext }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await target.list()).toHaveLength(1);
  });

  it('conflicts when a replay changes only what is inside the provider payload', async () => {
    harness = await buildTeamCollectionHarness();
    const target = harness.collection;
    const port = commandPortOver(() => target);
    await port.invoke(channelContext(), 'team.create', createPayload({ context: feishuContext }));

    // Core reads nothing inside `payload`, but it hashes all of it: a context
    // naming a different group is a different creation request.
    await expect(
      port.invoke(
        channelContext(),
        'team.create',
        createPayload({
          context: {
            ...feishuContext,
            payload: { ...feishuContext.payload, title: 'Renamed Group' },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await target.list()).toHaveLength(1);
  });

  it.each<[string, JsonValue]>([
    ['a context that is not an object at all', 'builtin:feishu'],
    ['a context naming no provider', { payload: { chat_id: 'oc_x' } }],
    ['a context with an empty provider', { provider: '', payload: { chat_id: 'oc_x' } }],
    ['a context carrying no payload', { provider: 'builtin:feishu' }],
    ['a context whose payload is not an object', { provider: 'builtin:feishu', payload: 'oc_x' }],
  ])('refuses %s as the caller’s mistake, creating nothing', async (_case, context) => {
    harness = await buildTeamCollectionHarness();
    const target = harness.collection;
    const port = commandPortOver(() => target);

    await expect(
      port.invoke(channelContext(), 'team.create', createPayload({ context })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // Refused at the surface, so no Team, no record, and nothing to replay.
    expect(await target.list()).toEqual([]);
  });
});
