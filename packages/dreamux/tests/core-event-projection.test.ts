import { capturingLogger } from './helpers/command-harness.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversationProjection,
  type ProjectedAgent,
} from '../src/service/dispatcher-core-events/conversation-projection.js';
import { COMPLETION_SOURCE } from '../src/service/submission-sources.js';
import {
  createCapturingPublisher,
  makeIdentity,
} from './helpers/event-harness.js';
import { dispatcherFixture } from './helpers/real-dispatcher.js';
afterEach(() => vi.restoreAllMocks());
function realProjection(
  publisher: ReturnType<typeof createCapturingPublisher>,
) {
  return createConversationProjection({
    coreEvents: publisher,
    log: capturingLogger([]),
    homePathPrefixes: [],
  });
}
describe('display fact correlation', () => {
  it('passes reasoning append fragments unchanged while ordinary text stays redacted', () => {
    const publisher = createCapturingPublisher();
    const projection = realProjection(publisher);
    const agent: ProjectedAgent = {
      identity: makeIdentity({ team_id: 'alpha', name: 'scout' }),
      role: 'teammate',
    };
    const fragments = [
      { partIndex: 0, text: 'token=', status: 'streaming' as const },
      { partIndex: 0, text: 'synthetic-value', status: 'streaming' as const },
      { partIndex: 0, text: '', status: 'completed' as const },
      {
        partIndex: 1,
        text: 'token=synthetic-value',
        status: 'completed' as const,
      },
    ].map((fragment) => ({
      kind: 'assistant.reasoning' as const,
      id: 'native-reasoning-item',
      occurredAt: 10,
      ...fragment,
    }));
    for (const fragment of fragments)
      projection.projectActivity(agent, fragment);
    projection.projectActivity(agent, {
      kind: 'assistant.message',
      id: 'native-answer',
      occurredAt: 11,
      text: 'token=synthetic-value',
    });
    expect(
      publisher.published.map(({ event }) =>
        event.kind === 'teammate.activity' ? event.activity : null,
      ),
    ).toEqual([
      ...fragments,
      {
        kind: 'assistant.message',
        id: 'native-answer',
        occurredAt: 11,
        text: 'token=<redacted>',
      },
    ]);
  });

  it('the input fact returns sourceId and source, and no event carries a turn_id', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: capturingLogger([]),
      homePathPrefixes: [],
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    projection.projectInput(agent, {
      source: 'feishu:chat-1',
      sourceId: 'message-fixture',
      text: 'investigate',
      notice: null,
      occurredAt: Date.now(),
    });
    projection.projectActivity(agent, {
      kind: 'assistant.message',
      occurredAt: Date.now(),
      id: 'evt-1',
      text: 'done',
    });

    const kinds = publisher.published.map((entry) => entry.event.kind);
    expect(kinds).toEqual(['teammate.input', 'teammate.activity']);

    // One input fact carries the provenance and the body together: there is no
    // second event to correlate to it, and so no correlation key at all.
    expect(publisher.published[0]?.event).toMatchObject({
      kind: 'teammate.input',
      source: 'feishu:chat-1',
      sourceId: 'message-fixture',
      content: 'investigate',
    });

    for (const entry of publisher.published) {
      expect('turn_id' in entry.event).toBe(false);
    }
  });

  it('never carries a ChannelOrigin, turnOrigin, or presentation-correlation field on any display fact', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: capturingLogger([]),
      homePathPrefixes: [],
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    projection.projectInput(agent, {
      source: 'feishu:chat-1',
      sourceId: null,
      text: 'do it',
      notice: null,
      occurredAt: Date.now(),
    });
    projection.projectActivity(agent, {
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: 'completed',
      reason: null,
    });

    const forbidden =
      /channelorigin|turnorigin|presentation.?correlation|correlation.?token/i;
    for (const entry of publisher.published) {
      for (const key of Object.keys(entry.event)) {
        expect(
          forbidden.test(key),
          `unexpected field '${key}' on ${entry.event.kind}`,
        ).toBe(false);
      }
    }
  });

  it('projects nothing for a dispatcher-scoped TeamMate (neither a Dispatcher stream nor a Team one)', () => {
    const publisher = createCapturingPublisher();
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: capturingLogger([]),
      homePathPrefixes: [],
    });
    const identity = makeIdentity({ team_id: null, name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    projection.projectInput(agent, {
      source: 'dispatcher:cli',
      sourceId: null,
      text: 'go',
      notice: null,
      occurredAt: Date.now(),
    });

    expect(publisher.published).toHaveLength(0);
  });

  it('publishes nothing at all when hasSources() reports no live listener', () => {
    const publisher = createCapturingPublisher(false);
    const projection = createConversationProjection({
      coreEvents: publisher,
      log: capturingLogger([]),
      homePathPrefixes: [],
    });
    const identity = makeIdentity({ team_id: 'alpha', name: 'scout' });
    const agent: ProjectedAgent = { identity, role: 'teammate' };
    projection.projectInput(agent, {
      source: 'feishu',
      sourceId: null,
      text: 'go',
      notice: null,
      occurredAt: Date.now(),
    });

    expect(publisher.published).toHaveLength(0);
  });
});

describe('the real conversation projection presents a dispatcher completion delivery (failure-ledger #13)', () => {
  it('publishes the input fact for a dispatcher-role completion body, scoped to team_name: null', () => {
    const publisher = createCapturingPublisher();
    const identity = makeIdentity({ name: 'dispatcher', team_id: null });

    realProjection(publisher).projectInput(
      { identity, role: 'dispatcher' },
      {
        source: COMPLETION_SOURCE,
        sourceId: null,
        text: 'TeamMate worker completed a turn.',
        notice: { kind: 'teammate_completion', producer: 'worker' },
        occurredAt: Date.now(),
      },
    );

    expect(publisher.published.map((entry) => entry.event)).toMatchObject([
      {
        kind: 'teammate.input',
        teamName: null,
        teammateName: 'dispatcher',
        role: 'dispatcher',
        source: COMPLETION_SOURCE,
        sourceId: null,
      },
    ]);
  });

  it('publishes the runtime activity that answers it, still scoped to team_name: null', () => {
    const publisher = createCapturingPublisher();
    const identity = makeIdentity({ name: 'dispatcher', team_id: null });

    realProjection(publisher).projectActivity(
      { identity, role: 'dispatcher' },
      {
        kind: 'turn.ended',
        occurredAt: Date.now(),
        status: 'completed',
        reason: null,
      },
    );

    expect(publisher.published.map((entry) => entry.event)).toMatchObject([
      {
        kind: 'teammate.activity',
        teamName: null,
        role: 'dispatcher',
        activity: { kind: 'turn.ended', status: 'completed' },
      },
    ]);
  });

  it('negative control: a dispatcher-scoped TeamMate (role teammate, team_id null) is legitimately out of scope, not "erased"', () => {
    // This is the real, intended boundary actorScope draws: only a Team's own
    // conversation (`role !== 'dispatcher' && team_id !== null`) and the
    // dispatcher's own conversation (`role === 'dispatcher' && team_id ===
    // null`) exist. A `teammate`-role entity with no team is neither, so it
    // projects nothing — a scoping decision, not a role filter erasing
    // Dispatcher presentation. Pinning this distinguishes the two: the
    // dispatcher case above must publish, this one must not.
    const publisher = createCapturingPublisher();
    const identity = makeIdentity({ name: 'orphan', team_id: null });

    realProjection(publisher).projectInput(
      { identity, role: 'teammate' },
      {
        source: COMPLETION_SOURCE,
        sourceId: null,
        text: 'TeamMate worker completed a turn.',
        notice: { kind: 'teammate_completion', producer: 'worker' },
        occurredAt: Date.now(),
      },
    );

    expect(publisher.published).toHaveLength(0);
  });
});

it('forwards reasoning through the agent observer before its turn settles', async () => {
  const f = await dispatcherFixture({ channel: true });
  await f.host.start();
  const result = await f.host.submitInput({ source: 'task', text: 'work' });
  if (result.status !== 'submitted') throw new Error('turn was not admitted');
  const runtime = f.provider.runtimes[0]!;
  const fragment = {
    kind: 'assistant.reasoning' as const,
    id: 'native-message',
    partIndex: 2,
    occurredAt: 10,
    text: 'token=synthetic-value',
    status: 'streaming' as const,
  };
  runtime.context.events(fragment);
  expect(
    f.channel.sessions
      .get('fixture-channel')!
      .receivedEvents.filter((event) => event.kind === 'teammate.activity'),
  ).toEqual([
    expect.objectContaining({
      kind: 'teammate.activity',
      role: 'dispatcher',
      activity: fragment,
    }),
  ]);
  runtime.submissions[0]!.complete(null);
  await result.turn.settled;
});

it('a turn still projects submitted/settled facts to a well-behaved sibling listener even with a hostile listener attached', async () => {
  const f = await dispatcherFixture({ channel: true });
  await f.host.start();
  const handle = f.channel.sessions.get('fixture-channel')!;
  const badSync = handle.port!.events.subscribe(() => {
    throw new Error('hostile synchronous listener');
  });
  const badAsync = handle.port!.events.subscribe(async () => {
    throw new Error('hostile asynchronous listener');
  });
  try {
    const result = await f.host.submitInput({
      source: 'channel',
      text: 'visible work',
      sourceId: 'hostile-listener-test',
    });
    if (result.status !== 'submitted') throw new Error('turn was not admitted');
    const runtime = f.provider.runtimes[0]!;
    runtime.context.events({
      kind: 'turn.ended',
      occurredAt: Date.now(),
      status: 'completed',
      reason: null,
    });
    runtime.submissions[0]!.complete('done');
    await result.turn.settled;
    expect(handle.receivedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'teammate.input',
          sourceId: 'hostile-listener-test',
          content: 'visible work',
        }),
        expect.objectContaining({
          kind: 'teammate.activity',
          activity: expect.objectContaining({
            kind: 'turn.ended',
            status: 'completed',
          }),
        }),
      ]),
    );
  } finally {
    badSync.unsubscribe();
    badAsync.unsubscribe();
  }
});
