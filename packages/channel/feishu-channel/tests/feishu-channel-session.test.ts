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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
  TeamStateEvent,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import { routingDocumentFilename } from '../src/routing/store.js';
import { chatTarget, topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';

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
): Promise<FeishuChannelSession> {
  return new FeishuChannelSession({
    dispatcherId: 'disp-1',
    channelId,
    appId: 'app-1',
    appSecret: '',
    stateDir: dir,
    attachmentCacheDir: attachDir,
    log: silentLog,
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

describe('FeishuChannelSession.deliver — typed pre-admission rejection fallback', () => {
  it('TEAM_CLOSED: removes the stale binding, announces it, and delivers once to the Dispatcher Agent', async () => {
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
    // TEAM_CLOSED is announced: the conversation is told its route ended.
    expect(bot.sentCards).toHaveLength(1);

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

    // But no card exists — announceTeamClosed's notify() only reaches the
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
