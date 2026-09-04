/**
 * The COT contract at the seam where a real Feishu inbound becomes a card.
 *
 * `feishu-cot.test.ts` drives the adapter and its session seam directly. This
 * file goes one layer out, through `FeishuChannelSession` itself, because three
 * parts of the contract are only true if the *session* wires them that way:
 *
 *  - a submitted turn's anchor is the visible message that produced it,
 *  - the one proven-no-admission fallback carries that same anchor to the
 *    Dispatcher, so the operator's card appears under their own message
 *    whichever recipient ends up answering,
 *  - a Reply is outbound only: its receipt never creates, replaces, or retires
 *    an anchor and never touches an open card.
 *
 * Every identifier here is a placeholder.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ChannelCoreEvent,
  ChannelCorePort,
  ChannelEventSubscription,
  DreamuxLogger,
  JsonValue,
  TeammateActivity,
  TeammateActivityEvent,
  TeammateInputEvent,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import { FEISHU_COT_OPENING_LABELS } from '../src/feishu-cot-adapter.js';
import { chatTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  cotTerminal,
  cotTexts,
  createFakeCotClient,
  type FakeCotCard,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

function expectOpeningTexts(
  card: FakeCotCard,
  expectedAfterOpening: readonly string[],
): void {
  const texts = cotTexts(card);
  expect(FEISHU_COT_OPENING_LABELS).toContain(texts[0]);
  expect(texts.slice(1)).toEqual(expectedAfterOpening);
}

let dir: string;
let attachDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-cot-state-'));
  attachDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-cot-attach-'));
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
}

function fakePort(
  invoke: (
    command: string,
    payload: JsonValue,
    emit: (event: ChannelCoreEvent) => void,
  ) => Promise<JsonValue>,
): FakePort {
  const listeners: Array<(event: ChannelCoreEvent) => void | Promise<void>> = [];
  const emit = (event: ChannelCoreEvent): void => {
    for (const listener of listeners) void listener(event);
  };
  return {
    port: {
      invoke: {
        invoke: async (command, payload) => invoke(command, payload, emit),
      },
      events: {
        subscribe(listener): ChannelEventSubscription {
          listeners.push(listener);
          return { unsubscribe: () => undefined };
        },
      },
    },
    emit,
  };
}

function newSession(bot: FakeFeishuBot, channelId: string): FeishuChannelSession {
  return new FeishuChannelSession({
    dispatcherId: 'disp-cot',
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

function scopeOf(recipient: 'dispatcher' | 'leader') {
  return {
    schema_version: 1 as const,
    teammate_name: recipient === 'dispatcher' ? 'dispatcher-agent' : 'alpha-leader',
    role: (recipient === 'dispatcher' ? 'dispatcher' : 'team_leader') as
      'dispatcher' | 'team_leader',
    team_name: recipient === 'dispatcher' ? null : 'alpha',
  };
}

/** The `teammate.input` Core publishes while `team.submit` still runs. */
function inputEvent(
  recipient: 'dispatcher' | 'leader',
  content: string,
  sourceId: string | null = null,
  source = 'feishu',
): TeammateInputEvent {
  return {
    ...scopeOf(recipient),
    kind: 'teammate.input',
    occurred_at: 1_700_000_000_000,
    source,
    source_id: sourceId,
    content,
    redacted: false,
  };
}

function activityEvent(
  recipient: 'dispatcher' | 'leader',
  activity: TeammateActivity,
): TeammateActivityEvent {
  return {
    ...scopeOf(recipient),
    kind: 'teammate.activity',
    occurred_at: 1_700_000_000_001,
    activity,
  };
}

function assistantMessage(
  eventId: string,
  recipient: 'dispatcher' | 'leader',
  content: string,
): TeammateActivityEvent {
  return activityEvent(recipient, {
    kind: 'assistant.message',
    event_id: `event-${eventId}`,
    content,
    redacted: false,
  });
}

function sourceIdOf(payload: JsonValue): string {
  const sourceId = (payload as Record<string, unknown>)['source_id'];
  if (typeof sourceId !== 'string') throw new Error('missing fixture source_id');
  return sourceId;
}

function nativeEnd(
  recipient: 'dispatcher' | 'leader',
  status: 'completed' | 'failed' | 'interrupted' = 'completed',
  reason: string | null = null,
): TeammateActivityEvent {
  return activityEvent(recipient, {
    kind: 'turn.ended',
    status,
    reason,
    redacted: false,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Harness {
  readonly bot: FakeFeishuBot;
  readonly session: FeishuChannelSession;
  readonly cot: FakeCotClient;
  readonly port: FakePort;
}

async function harness(
  channelId: string,
  invoke: (
    command: string,
    payload: JsonValue,
    emit: (event: ChannelCoreEvent) => void,
  ) => Promise<JsonValue>,
): Promise<Harness> {
  const bot = createFakeFeishuBot();
  const cot = createFakeCotClient();
  bot.setCot(cot);
  const session = newSession(bot, channelId);
  const port = fakePort(invoke);
  await session.initialize(port.port);
  return { bot, session, cot, port };
}

describe('FeishuChannelSession COT — the anchor is the visible inbound message', () => {
  it('opens normally without an unknown-outcome line, and closes on the native end', async () => {
    const { session, cot, port } = await harness('chan-cot-anchor', async (
      command,
      payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      emit(inputEvent('dispatcher', 'hello', sourceIdOf(payload)));
      return { status: 'submitted', turn_id: 'turn-1' };
    });

    await session.submit(null, {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'om_user_1',
      anchor: {
        chatId: 'oc_dm',
        messageId: 'om_user_1',
        target: chatTarget('oc_dm', 'p2p'),
      },
    });
    await waitFor(() => cot.cards.length === 1);
    await waitFor(() => cotTexts(cot.cards[0]!).length === 1);

    expect(cot.cards[0]!.chatId).toBe('oc_dm');
    expect(cot.cards[0]!.originMessageId).toBe('om_user_1');
    expectOpeningTexts(cot.cards[0]!, []);

    port.emit(assistantMessage('turn-1', 'dispatcher', 'the answer'));
    port.emit(nativeEnd('dispatcher'));
    await waitFor(() => cotTerminal(cot.cards[0]!) !== null);

    expectOpeningTexts(cot.cards[0]!, ['the answer']);
    expect(cotTerminal(cot.cards[0]!)).toBe('done');

    port.emit(inputEvent('dispatcher', 'task body', 'task-source', 'task'));
    await waitFor(() => cot.cards.length === 2);
    expect(cotTexts(cot.cards[1]!)).toEqual(['task body']);

    await session.close();
  });

  it('interrupts one predecessor and opens exactly one successor for a second inbound', async () => {
    let submissionIndex = 0;
    const { session, cot, port } = await harness('chan-cot-successor', async (
      command,
      payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      submissionIndex += 1;
      const turnId = `turn-${submissionIndex}`;
      emit(inputEvent('dispatcher', `body ${submissionIndex}`, sourceIdOf(payload)));
      return { status: 'submitted', turn_id: turnId };
    });

    await session.submit(null, {
      attrs: {},
      text: 'body 1',
      reminder: '',
      sourceId: 'message-one',
      anchor: {
        chatId: 'chat-dm',
        messageId: 'message-one',
        target: chatTarget('chat-dm', 'p2p'),
      },
    });
    await waitFor(() => cot.cards.length === 1);
    port.emit(assistantMessage('turn-1', 'dispatcher', 'first answer'));
    await waitFor(() => cotTexts(cot.cards[0]!).length === 2);

    await session.submit(null, {
      attrs: {},
      text: 'body 2',
      reminder: '',
      sourceId: 'message-two',
      anchor: {
        chatId: 'chat-dm',
        messageId: 'message-two',
        target: chatTarget('chat-dm', 'p2p'),
      },
    });
    await waitFor(() => cot.cards.length === 2);
    await waitFor(() => cotTerminal(cot.cards[0]!) === 'interrupted');

    expect(cot.cards).toHaveLength(2);
    expect(cot.cards.map((card) => card.originMessageId)).toEqual([
      'message-one',
      'message-two',
    ]);
    expect(cot.cards.map(cotTerminal)).toEqual(['interrupted', null]);
    expectOpeningTexts(cot.cards[0]!, ['first answer']);
    expectOpeningTexts(cot.cards[1]!, []);

    await session.close();
  });

  it('keeps the repeated-message anchor when Core deduplicates its submission', async () => {
    let invocation = 0;
    const { session, cot, port } = await harness('chan-cot-duplicate', async (
      command,
      payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      invocation += 1;
      if (invocation === 2) return { status: 'duplicate' };
      emit(inputEvent('dispatcher', 'hello', sourceIdOf(payload)));
      return { status: 'submitted', turn_id: 'turn-original' };
    });
    const submission = {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'message-repeat',
      anchor: {
        chatId: 'chat-dm',
        messageId: 'message-repeat',
        target: chatTarget('chat-dm', 'p2p'),
      },
    } as const;

    await session.submit(null, submission);
    await waitFor(() => cot.cards.length === 1);
    port.emit(assistantMessage('turn-original', 'dispatcher', 'before repeat'));
    await waitFor(() => cotTexts(cot.cards[0]!).length === 2);

    const outcome = await session.submit(null, submission);
    expect(outcome).toEqual({ status: 'duplicate' });
    await waitFor(() => cot.cards.length === 2);
    await waitFor(() => cotTerminal(cot.cards[0]!) === 'interrupted');
    expect(cot.cards.map((card) => card.originMessageId)).toEqual([
      'message-repeat',
      'message-repeat',
    ]);
    expect(cot.cards.map(cotTerminal)).toEqual(['interrupted', null]);
    expectOpeningTexts(cot.cards[1]!, []);

    port.emit(assistantMessage('turn-original', 'dispatcher', 'after repeat'));
    await waitFor(() => cotTexts(cot.cards[1]!).length === 2);
    expect(cot.cards).toHaveLength(2);
    expectOpeningTexts(cot.cards[1]!, ['after repeat']);

    await session.close();
  });

  it('carries the same anchor to the Dispatcher when a proven-stale route falls back', async () => {
    const { session, cot, port } = await harness('chan-cot-fallback', async (
      command,
      payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      const p = payload as Record<string, unknown>;
      // The stored route names a Team that is closed: proven no admission.
      if (p['team_name'] !== undefined) throw teamClosedError();
      emit(inputEvent('dispatcher', 'hello', sourceIdOf(payload)));
      return { status: 'submitted', turn_id: 'turn-fallback' };
    });
    await session.routing.bind({
      target: chatTarget('oc_group', 'group'),
      teamName: 'closing-team',
      display: null,
      origin: 'manual',
      spaceId: null,
    });

    const outcome = await session.deliver({
      target: chatTarget('oc_group', 'group'),
      containerChatId: null,
      submission: {
        attrs: {},
        text: 'hello',
        reminder: '',
        sourceId: 'om_user_1',
        anchor: {
          chatId: 'oc_group',
          messageId: 'om_user_1',
          target: chatTarget('oc_group', 'group'),
        },
      },
    });
    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-fallback' });
    await waitFor(() => cot.cards.length === 2);

    // The refused Team's optimistic card is retired, and the Dispatcher owns
    // the one open successor under the same visible message.
    expect(cot.cards.map((card) => card.originMessageId)).toEqual([
      'om_user_1',
      'om_user_1',
    ]);
    expect(cot.cards.map(cotTerminal)).toEqual(['interrupted', null]);
    port.emit(assistantMessage('turn-fallback', 'dispatcher', 'dispatcher answered'));
    await waitFor(() => cotTexts(cot.cards[1]!).length === 2);
    expectOpeningTexts(cot.cards[1]!, ['dispatcher answered']);

    // The TeamLeader whose route was refused cannot present anything further.
    port.emit(assistantMessage('turn-fallback', 'leader', 'never displayed'));
    port.emit(nativeEnd('leader'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cot.cards).toHaveLength(2);

    await session.close();
  });

  it.each(['rejected', 'failed', 'stopped'] as const)(
    'retires an optimistic anchor when Core proves the submission %s',
    async (failure) => {
      const { session, cot, port } = await harness(
        `chan-cot-${failure}`,
        async () => {
          if (failure === 'rejected') throw teamClosedError();
          if (failure === 'stopped') return { status: 'stopped' };
          return {
            status: 'failed',
            error: { code: 'RUNTIME_FAILED', message: 'fixture failure' },
          };
        },
      );

      const outcome = await session.submit('alpha', {
        attrs: {},
        text: 'hello',
        reminder: '',
        sourceId: `message-${failure}`,
        anchor: {
          chatId: 'chat-group',
          messageId: `message-${failure}`,
          target: chatTarget('chat-group', 'group'),
        },
      });

      expect(outcome.status).toBe(failure);
      await waitFor(() => cot.cards.length === 1);
      await waitFor(() => cotTerminal(cot.cards[0]!) === 'interrupted');
      port.emit(assistantMessage('turn-later', 'leader', 'must stay anchorless'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cot.cards).toHaveLength(1);
      expect(cotTerminal(cot.cards[0]!)).toBe('interrupted');

      await session.close();
    },
  );

  it('keeps an ambiguous submission open with only its opening flavour', async () => {
    const { session, cot } = await harness(
      'chan-cot-ambiguous-result',
      async () => ({
        status: 'ambiguous',
        error: { code: 'ADMISSION_UNKNOWN', message: 'fixture ambiguity' },
      }),
    );

    const outcome = await session.submit(null, {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'message-ambiguous',
      anchor: {
        chatId: 'chat-dm',
        messageId: 'message-ambiguous',
        target: chatTarget('chat-dm', 'p2p'),
      },
    });

    expect(outcome.status).toBe('ambiguous');
    await waitFor(() => cot.cards.length === 1);
    await waitFor(() => cotTexts(cot.cards[0]!).length === 1);
    expect(cot.cards[0]!.originMessageId).toBe('message-ambiguous');
    expect(cotTerminal(cot.cards[0]!)).toBeNull();
    expectOpeningTexts(cot.cards[0]!, []);

    await session.close();
  });

  it('keeps the optimistic anchor when an ambiguous failure proves nothing', async () => {
    const { session, cot } = await harness('chan-cot-ambiguous', async () => {
      throw new Error('unknown transport failure');
    });

    const outcome = await session.submit(null, {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'om_user_1',
      anchor: {
        chatId: 'oc_dm',
        messageId: 'om_user_1',
        target: chatTarget('oc_dm', 'p2p'),
      },
    });

    expect(outcome.status).toBe('error');
    await waitFor(() => cot.cards.length === 1);
    expect(cot.cards[0]!.originMessageId).toBe('om_user_1');
    expect(cotTerminal(cot.cards[0]!)).toBeNull();

    await session.close();
  });
});

describe('FeishuChannelSession COT — a Reply never touches the anchor', () => {
  it('leaves the open card and its anchor exactly as they were', async () => {
    const { session, cot, port, bot } = await harness('chan-cot-reply', async (
      command,
      payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      emit(inputEvent('leader', 'hello', sourceIdOf(payload)));
      return { status: 'submitted', turn_id: 'turn-1' };
    });

    await session.submit('alpha', {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'om_user_1',
      anchor: {
        chatId: 'oc_group',
        messageId: 'om_user_1',
        target: chatTarget('oc_group', 'group'),
      },
    });
    await waitFor(() => cot.cards.length === 1);

    // The TeamLeader replies into the chat mid-turn. Its receipt is a message
    // id this session now owns as an address — and nothing else.
    const reply = await session
      .toolSession({ kind: 'team_leader', team_name: 'alpha', leader_name: 'alpha-leader' })
      .sendText('oc_group', 'a visible reply');
    expect(reply.message_ids).toHaveLength(1);
    expect(bot.sentMessages).toHaveLength(1);

    port.emit(assistantMessage('turn-1', 'leader', 'still the same card'));
    await waitFor(() => cotTexts(cot.cards[0]!).length === 2);

    // No new card, no re-anchor, and the one card is still open on the
    // operator's original message.
    expect(cot.cards).toHaveLength(1);
    expect(cot.cards[0]!.originMessageId).toBe('om_user_1');
    expect(cotTerminal(cot.cards[0]!)).toBeNull();

    port.emit(nativeEnd('leader'));
    await waitFor(() => cotTerminal(cot.cards[0]!) !== null);
    expect(cot.cards).toHaveLength(1);

    await session.close();
  });

  it('does not give an anchorless Dispatcher one', async () => {
    const { session, cot, port } = await harness('chan-cot-reply-anchorless', async () => {
      throw new Error('no submit expected in this test');
    });

    await session
      .toolSession({ kind: 'dispatcher' })
      .sendText('oc_dm', 'an unprompted reply');

    port.emit(assistantMessage('turn-x', 'dispatcher', 'after the reply'));
    port.emit(nativeEnd('dispatcher'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cot.cards).toHaveLength(0);
    await session.close();
  });
});

describe('FeishuChannelSession COT — a bot without a COT surface', () => {
  it('presents nothing and breaks nothing', async () => {
    const bot = createFakeFeishuBot();
    const session = newSession(bot, 'chan-cot-absent');
    const port = fakePort(async (_command, payload, emit) => {
      emit(inputEvent('dispatcher', 'hello', sourceIdOf(payload)));
      return { status: 'submitted', turn_id: 'turn-1' };
    });
    await session.initialize(port.port);

    const outcome = await session.submit(null, {
      attrs: {},
      text: 'hello',
      reminder: '',
      sourceId: 'om_user_1',
      anchor: {
        chatId: 'oc_dm',
        messageId: 'om_user_1',
        target: chatTarget('oc_dm', 'p2p'),
      },
    });
    port.emit(assistantMessage('turn-1', 'dispatcher', 'the answer'));
    port.emit(nativeEnd('dispatcher'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcome).toEqual({ status: 'submitted', turnId: 'turn-1' });
    await session.close();
  });
});
