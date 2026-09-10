/**
 * `FeishuChannelSession` integration coverage (COVERAGE CELL F): the exact
 * fallback/typed-rejection contract from `requirement.md`'s "Channel-owned
 * external routing" section and TeamLeader failure ledger items 12 and 22 —
 * a typed pre-admission `TEAM_NOT_FOUND`/`TEAM_CLOSED` removes the stale
 * binding and delivers exactly once to the Dispatcher Agent; an ambiguous or
 * unknown post-submit outcome must never double-deliver — plus the
 * shutdown/close ordering contract: a Channel-owned asynchronous mutation
 * tail (the routing-document write) settles before `close()` returns, and no
 * presentation callback fires after the session's own fence is aborted.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
  TeamCreatedEvent,
  TeamStateEvent,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import { bindingBoundCard } from '../src/feishu-binding-notification-card.js';
import { FeishuCotSessionSeam } from '../src/feishu-cot-session.js';
import { FeishuBindingOperations } from '../src/feishu-session-bindings.js';
import { routingDocumentFilename } from '../src/routing/store.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { cotTexts, createFakeCotClient } from './helpers/fake-feishu-cot.js';
import { teamSummary } from './helpers/team-status.js';

let dir: string;
let attachDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-session-state-'));
  attachDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-session-attach-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(attachDir, { recursive: true, force: true });
});

const silentLog: DreamuxLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

interface FakePort {
  port: ChannelCorePort;
  emit(event: ChannelCoreEvent): void;
  calls: Array<{ command: string; payload: JsonValue }>;
}

function fakePort(
  invoke: (command: string, payload: JsonValue) => Promise<JsonValue>,
): FakePort {
  const listeners: Array<(event: ChannelCoreEvent) => void | Promise<void>> = [];
  const calls: FakePort['calls'] = [];
  return {
    calls,
    port: {
      invoke: {
        invoke: async (command, payload) => {
          calls.push({ command, payload });
          return invoke(command, payload);
        },
      },
      events: {
        subscribe(listener): ChannelEventSubscription {
          listeners.push(listener);
          return { unsubscribe: () => undefined };
        },
      },
    },
    emit(event) {
      for (const listener of listeners) void listener(event);
    },
  };
}

async function newSession(
  bot: FakeFeishuBot,
  channelId = 'chan-session',
  log: DreamuxLogger = silentLog,
): Promise<FeishuChannelSession> {
  return new FeishuChannelSession({
    dispatcherId: 'disp-1',
    channelId,
    appId: 'app-1',
    appSecret: '',
    stateDir: dir,
    attachmentCacheDir: attachDir,
    log,
    botFactory: () => bot,
  });
}

function teamClosedError(): Error & { code: string } {
  const err = new Error('team is closed') as Error & { code: string };
  err.code = 'TEAM_CLOSED';
  return err;
}

function teamNotFoundError(): Error & { code: string } {
  const err = new Error('no such team') as Error & { code: string };
  err.code = 'TEAM_NOT_FOUND';
  return err;
}

/**
 * Poll until `predicate` is true or the timeout elapses. The store's own
 * commit is real (bounded) filesystem I/O, so a plain microtask flush is not
 * always enough; a short bounded poll is deterministic without depending on
 * wall-clock timing of the production code itself.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function readBindings(channelId: string): Array<Record<string, unknown>> {
  const filename = routingDocumentFilename(channelId);
  const onDisk = JSON.parse(readFileSync(join(dir, filename), 'utf8')) as {
    bindings: Array<Record<string, unknown>>;
  };
  return onDisk.bindings;
}

/** One TeamLeader turn, as Core reports it: what Core admitted, then what ran. */
function emitTeamConversation(
  port: FakePort,
  teamName: string,
  content: string,
): void {
  const scope = {
    schema_version: 1 as const,
    teammate_name: `${teamName}-leader`,
    role: 'team_leader' as const,
    team_name: teamName,
    occurred_at: 1_700_000_000_000,
  };
  port.emit({
    ...scope,
    kind: 'teammate.input',
    notice: null,
    source: 'task',
    source_id: `source-${content}`,
    content: `${content} input`,
    redacted: false,
  });
  port.emit({
    ...scope,
    kind: 'teammate.activity',
    activity: {
      kind: 'assistant.message',
      event_id: `event-${content}`,
      content: `${content} activity`,
      redacted: false,
    },
  });
}

/**
 * Binding the group a Team's own `team.create` context named.
 *
 * The caller already owns the conversation and already got its Team back, so
 * everything here is what the session does on its own afterwards: install the
 * route, hand COT ownership over, and say so in the chat — and, when the
 * context is malformed or someone else's, do none of it.
 */
describe('FeishuChannelSession — team.create context', () => {
  const payload = { chat_id: 'oc_created', title: 'Bound On Create' };
  const created: TeamCreatedEvent = {
    schema_version: 1,
    kind: 'team.created',
    occurred_at: 1_700_000_000_000,
    summary: {
      ...teamSummary('team-created'),
      leader_agent_runtime: 'test-runtime',
      metadata: { provider: 'builtin:feishu', payload },
    },
  };
  const target = chatTarget(payload.chat_id, 'group');
  /** Any Core call at all would mean the event was not enough on its own. */
  const noCoreCommands = (): FakePort =>
    fakePort(async (command) => {
      throw new Error(`unexpected Core command ${command}`);
    });

  it('binds the named group and sends its binding card without asking Core anything', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-created');
    const port = noCoreCommands();
    await session.initialize(port.port);
    await session.start();

    try {
      port.emit(created);
      await waitFor(() => bot.sentCards.length === 1);
      expect(session.routing.bindingFor(target)).toMatchObject({
        team_name: created.summary.team_name,
        display: payload.title,
        origin: 'manual',
        space_id: null,
      });
      expect(readBindings('chan-created')).toHaveLength(1);
      expect(bot.sentCards[0]).toMatchObject({
        target: { chatId: payload.chat_id },
        card: bindingBoundCard({
          target,
          display: payload.title,
          teamName: created.summary.team_name,
          leaderName: created.summary.leader_name,
          agentRuntime: created.summary.leader_agent_runtime,
          runtimeCwd: created.summary.runtime_cwd,
        }),
      });
      expect(bot.sentMessages).toEqual([]);
      expect(port.calls).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('anchors the new TeamLeader COT card on the binding card it just sent', async () => {
    const bot = createFakeFeishuBot();
    const cot = createFakeCotClient();
    bot.setCot(cot);
    const session = await newSession(bot, 'chan-created');
    const port = noCoreCommands();
    await session.initialize(port.port);
    await session.start();

    try {
      port.emit(created);
      await waitFor(
        () =>
          bot.sentCards.length === 1 &&
          session.handle.targetRouter.targetForMessage(
            bot.sentCards[0]!.messageIds[0]!,
          ) !== undefined,
      );
      emitTeamConversation(port, created.summary.team_name, 'after binding');
      await waitFor(
        () => cot.cards.length === 1 && cotTexts(cot.cards[0]!).length === 2,
      );
      expect(cot.cards[0]).toMatchObject({
        chatId: payload.chat_id,
        originMessageId: bot.sentCards[0]!.messageIds[0],
      });
      expect(cotTexts(cot.cards[0]!)).toEqual([
        'after binding input',
        'after binding activity',
      ]);
    } finally {
      await session.close();
    }
  });

  it('releases the Team it displaces before claiming the route for the new one', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-created');
    const port = fakePort(async () => null);
    await session.initialize(port.port);
    await session.start();
    port.emit({
      ...created,
      summary: { ...created.summary, team_name: 'previous-team' },
    });
    await waitFor(() => bot.sentCards.length === 1);
    const release = vi.spyOn(FeishuCotSessionSeam.prototype, 'onRouteReleased');
    const claim = vi.spyOn(FeishuCotSessionSeam.prototype, 'onRouteClaimed');

    try {
      port.emit(created);
      await waitFor(() => bot.sentCards.length === 2);
      expect(release.mock.calls).toEqual([
        [{ teamName: 'previous-team', target }],
      ]);
      expect(claim.mock.calls).toEqual([
        [{ teamName: created.summary.team_name, target }],
      ]);
      expect(release.mock.invocationCallOrder[0]!).toBeLessThan(
        claim.mock.invocationCallOrder[0]!,
      );

      // Re-announcing the same Team displaces nobody, so nothing is released.
      release.mockClear();
      claim.mockClear();
      port.emit(created);
      await waitFor(() => bot.sentCards.length === 3);
      expect(release).not.toHaveBeenCalled();
      expect(claim.mock.calls).toEqual([
        [{ teamName: created.summary.team_name, target }],
      ]);
    } finally {
      release.mockRestore();
      claim.mockRestore();
      await session.close();
    }
  });

  it('keeps the committed binding when the notification card cannot be sent', async () => {
    const bot = createFakeFeishuBot();
    const sendCard = vi
      .spyOn(bot, 'sendCard')
      .mockRejectedValue(new Error('notification unavailable'));
    const warn = vi.fn();
    const session = await newSession(bot, 'chan-created', { ...silentLog, warn });
    const port = fakePort(async () => null);
    await session.initialize(port.port);
    await session.start();

    try {
      port.emit(created);
      await waitFor(() => sendCard.mock.calls.length === 2);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 2 }),
        'Feishu binding notification failed after retry',
      );
      // The route committed before the card was attempted, and a card this
      // conversation never saw is not a reason to un-route the Team.
      expect(session.routing.bindingFor(target)?.team_name).toBe(
        created.summary.team_name,
      );
      expect(readBindings('chan-created')).toHaveLength(1);
    } finally {
      sendCard.mockRestore();
      await session.close();
    }
  });

  it.each(['chat_id', 'title'])(
    'warns and routes nothing when %s is not a non-empty string',
    async (field) => {
      const bot = createFakeFeishuBot();
      const warn = vi.fn();
      const session = await newSession(bot, 'chan-created', {
        ...silentLog,
        warn,
      });
      const port = fakePort(async () => null);
      await session.initialize(port.port);

      try {
        const rejected: JsonValue[] = [null, '', '  ', 1, [], {}];
        for (const value of [...rejected, undefined]) {
          const invalid: Record<string, JsonValue> = { ...payload };
          if (value === undefined) delete invalid[field];
          else invalid[field] = value;
          port.emit({
            ...created,
            summary: {
              ...created.summary,
              metadata: { provider: 'builtin:feishu', payload: invalid },
            },
          });
        }
        await waitFor(() => warn.mock.calls.length === rejected.length + 1);
        expect(warn).toHaveBeenLastCalledWith(
          expect.objectContaining({
            event_kind: 'team.created',
            err: { message: expect.stringContaining(`non-empty ${field}`) },
          }),
          'Feishu core-event listener failed',
        );
        expect(session.routing.bindingFor(target)).toBeUndefined();
        expect(bot.sentCards).toEqual([]);
      } finally {
        await session.close();
      }
    },
  );

  it('refuses a payload carrying a key this Channel does not support', async () => {
    const bot = createFakeFeishuBot();
    const warn = vi.fn();
    const session = await newSession(bot, 'chan-created', { ...silentLog, warn });
    const port = fakePort(async () => null);
    await session.initialize(port.port);

    try {
      port.emit({
        ...created,
        summary: {
          ...created.summary,
          metadata: {
            provider: 'builtin:feishu',
            payload: { ...payload, member_emails: 'someone@example.com' },
          },
        },
      });
      await waitFor(() => warn.mock.calls.length === 1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event_kind: 'team.created',
          err: {
            message: expect.stringContaining('unknown key(s): member_emails'),
          },
        }),
        'Feishu core-event listener failed',
      );
      expect(session.routing.bindingFor(target)).toBeUndefined();
      expect(bot.sentCards).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('ignores a creation whose context belongs to another provider', async () => {
    const bot = createFakeFeishuBot();
    const warn = vi.fn();
    const session = await newSession(bot, 'chan-created', { ...silentLog, warn });
    const port = fakePort(async () => null);
    await session.initialize(port.port);

    try {
      port.emit({
        ...created,
        summary: {
          ...created.summary,
          metadata: { provider: 'npm:other-channel', payload },
        },
      });
      port.emit({
        ...created,
        summary: { ...teamSummary('team-plain') },
      });
      await waitFor(() => true);
      expect(session.routing.bindingFor(target)).toBeUndefined();
      expect(bot.sentCards).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('does not finish close() while the binding it started is still running', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-created');
    const port = noCoreCommands();
    await session.initialize(port.port);
    await session.start();
    // A binding that has not answered yet, held open on purpose: the session
    // registers this handler like any other background task, so shutdown has
    // to wait for it instead of walking away mid-bind.
    let finishBinding!: () => void;
    const binding = vi
      .spyOn(FeishuBindingOperations.prototype, 'bindCreatedTeam')
      .mockReturnValue(new Promise<void>((resolve) => { finishBinding = resolve; }));

    try {
      port.emit(created);
      expect(binding).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = session.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(closed).toBe(false);
      finishBinding();
      await closing;
      expect(closed).toBe(true);
    } finally {
      finishBinding();
      binding.mockRestore();
    }
  });
});

describe('FeishuChannelSession.deliver — typed pre-admission rejection fallback', () => {
  it('TEAM_CLOSED during a refused dissolve: removes the route neutrally and falls back once', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-closed';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async (command, payload) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      submitCalls += 1;
      const p = payload as Record<string, unknown>;
      if (p['team_name'] !== undefined) throw teamClosedError();
      return { status: 'submitted', turn_id: 'turn-fallback-1' };
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_closed', 'group'),
      teamName: 'closing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_closed', 'group'),
      containerChatId: null,
      submission: {
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-1',
        anchor: { chatId: 'oc_closed', messageId: 'm1', target: chatTarget('oc_closed', 'group') },
      },
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-fallback-1' });
    expect(submitCalls).toBe(2);
    expect(session.routing.bindingFor(chatTarget('oc_closed', 'group'))).toBeUndefined();
    expect(bot.sentCards).toHaveLength(1);
    expect(JSON.stringify(bot.sentCards[0]!.card)).toContain('Dreamux route ended');
    expect(JSON.stringify(bot.sentCards[0]!.card)).not.toMatch(/dissolved|remains active|Team closed/);

    // The pending non-force dissolve is refused; Core still reports an open Team.
    port.emit({
      schema_version: 1, kind: 'team.state', occurred_at: Date.now(),
      team_name: 'closing-team', leader_name: 'leader-1', status: 'running', teammates: [],
    });
    expect(bot.sentCards).toHaveLength(1);
    expect(readBindings(channelId)).toEqual([]);
    expect(port.calls.map((call) => call.command)).toEqual(['team.submit', 'team.submit']);

    await session.close();
  });

  it('TEAM_NOT_FOUND: removes the stale binding silently (no card) and delivers once to the Dispatcher Agent', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-notfound';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async (_command, payload) => {
      submitCalls += 1;
      const p = payload as Record<string, unknown>;
      if (p['team_name'] !== undefined) throw teamNotFoundError();
      return { status: 'submitted', turn_id: 'turn-fallback-2' };
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_stale', 'group'),
      teamName: 'gone-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_stale', 'group'),
      containerChatId: null,
      submission: {
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-2',
        anchor: { chatId: 'oc_stale', messageId: 'm2', target: chatTarget('oc_stale', 'group') },
      },
    });

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-fallback-2' });
    expect(submitCalls).toBe(2);
    expect(session.routing.bindingFor(chatTarget('oc_stale', 'group'))).toBeUndefined();
    // TEAM_NOT_FOUND is this Channel correcting its own stale document: silent.
    expect(bot.sentCards).toHaveLength(0);

    await session.close();
  });

  it('an ambiguous/unknown post-submit outcome is never retried and never falls back (no double delivery)', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-ambiguous';
    const session = await newSession(bot, channelId);
    let submitCalls = 0;
    const port = fakePort(async () => {
      submitCalls += 1;
      // An unknown boundary failure: no `.code`, so commandErrorCode() is
      // null and submit() must classify this as 'error', never 'rejected'.
      throw new Error('unknown transport failure');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_ambiguous', 'group'),
      teamName: 'ambiguous-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_ambiguous', 'group'),
      containerChatId: null,
      submission: {
        attrs: {},
        text: 'hi',
        reminder: '',
        sourceId: 'msg-3',
        anchor: { chatId: 'oc_ambiguous', messageId: 'm3', target: chatTarget('oc_ambiguous', 'group') },
      },
    });

    expect(outcome.status).toBe('error');
    // Exactly one attempt: no fallback submit, and the binding this Channel
    // could not prove stale is left exactly as it was.
    expect(submitCalls).toBe(1);
    expect(session.routing.bindingFor(chatTarget('oc_ambiguous', 'group'))?.team_name).toBe(
      'ambiguous-team',
    );

    await session.close();
  });
});

describe('FeishuChannelSession — team.state closed invalidates every binding to that Team', () => {
  it('removes every binding to a closed Team and cards each removed target', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-team-state';
    const session = await newSession(bot, channelId);
    const port = fakePort(async () => {
      throw new Error('no Command expected in this test');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_x', 'group'),
      teamName: 'dying-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await session.routing.bind({
      target: topicTarget('oc_x', 'thread_1'),
      teamName: 'dying-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });
    await session.routing.bind({
      target: chatTarget('oc_y', 'group'),
      teamName: 'surviving-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const closed: TeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: Date.now(),
      team_name: 'dying-team',
      leader_name: 'leader-1',
      status: 'closed',
      teammates: [],
    };
    port.emit(closed);

    // Let the fire-and-forget forgetTeamRoutes() chain actually finish —
    // both its store commit and its (still-live, not-yet-closed) card
    // notification — before this test closes the session. The immediate,
    // no-wait variant of this same sequence is the next test below.
    await waitFor(
      () => session.routing.bindingFor(chatTarget('oc_x', 'group')) === undefined,
    );
    await waitFor(() => bot.sentCards.length >= 2);
    for (const { card } of bot.sentCards) {
      expect(JSON.stringify(card)).toContain('Dreamux team dissolved');
      expect(JSON.stringify(card)).toContain('all of its routes were removed automatically.');
      expect(JSON.stringify(card)).not.toContain('remains active');
    }

    await session.close();

    expect(readBindings(channelId).map((b) => b['team_name'])).toEqual([
      'surviving-team',
    ]);
    expect(bot.sentCards.length).toBeGreaterThanOrEqual(1);
  });

  it('closing the session immediately after the event still drains the routing-document write, but drops the now-post-close card', async () => {
    const bot = createFakeFeishuBot();
    const channelId = 'chan-team-state-race';
    const session = await newSession(bot, channelId);
    const port = fakePort(async () => {
      throw new Error('no Command expected in this test');
    });
    await session.initialize(port.port);
    await session.routing.bind({
      target: chatTarget('oc_race', 'group'),
      teamName: 'racing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const closed: TeamStateEvent = {
      schema_version: 1,
      kind: 'team.state',
      occurred_at: Date.now(),
      team_name: 'racing-team',
      leader_name: 'leader-1',
      status: 'closed',
      teammates: [],
    };
    // Emit, then close in the very same synchronous turn — before the
    // fire-and-forget forgetTeamRoutes() chain has had a chance to run any
    // of its own awaits.
    port.emit(closed);
    await session.close();

    // The mutation tail (the routing document write) still settled: close()
    // awaits the store's own commit queue regardless of who queued it.
    expect(readBindings(channelId)).toEqual([]);

    // But no card exists — announceRoutesRemoved's notify() only reaches the
    // network after the write resolves, by which point close() has already
    // aborted this session's fence, and notify() refuses to run past that
    // point. No presentation callback fires after final close.
    expect(bot.sentCards).toHaveLength(0);
  });
});

describe('FeishuChannelSession.submit — session liveness fence', () => {
  it('refuses to submit once the session is not live, without reaching Core at all', async () => {
    const bot = createFakeFeishuBot();
    const session = await newSession(bot, 'chan-not-live');
    const port = fakePort(async () => {
      throw new Error('must not be called: session was never initialized');
    });
    void port;

    const outcome = await session.submit(null, {
      attrs: {},
      text: 'hi',
      reminder: '',
      sourceId: 'msg-never',
      anchor: { chatId: 'oc_z', messageId: 'm', target: chatTarget('oc_z', 'group') },
    });
    expect(outcome).toEqual({ status: 'error', message: 'Feishu session is not live' });
  });
});
