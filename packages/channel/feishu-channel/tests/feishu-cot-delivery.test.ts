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
  TeammateNativeTurnEndedEvent,
  TeammateTurnMessageEvent,
  TeammateTurnSubmittedEvent,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/feishu-channel.js';
import { chatTarget } from '../src/routing/target.js';
import { createFakeFeishuBot, type FakeFeishuBot } from './helpers/fake-feishu-bot.js';
import {
  cotRunStatus,
  cotTexts,
  createFakeCotClient,
  type FakeCotClient,
} from './helpers/fake-feishu-cot.js';

const RECEIPT = '已收到消息，开始处理。';

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

/** The `teammate.turn.submitted` Core publishes while `team.submit` still runs. */
function submittedEvent(
  turnId: string,
  recipient: 'dispatcher' | 'leader',
): TeammateTurnSubmittedEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.submitted',
    occurred_at: 1_700_000_000_000,
    teammate_name: recipient === 'dispatcher' ? 'dispatcher-agent' : 'alpha-leader',
    role: recipient === 'dispatcher' ? 'dispatcher' : 'team_leader',
    team_name: recipient === 'dispatcher' ? null : 'alpha',
    turn_id: turnId,
    turn_source: 'feishu',
  };
}

function assistantMessage(
  turnId: string,
  recipient: 'dispatcher' | 'leader',
  content: string,
): TeammateTurnMessageEvent {
  return {
    schema_version: 1,
    kind: 'teammate.turn.message',
    occurred_at: 1_700_000_000_001,
    teammate_name: recipient === 'dispatcher' ? 'dispatcher-agent' : 'alpha-leader',
    role: recipient === 'dispatcher' ? 'dispatcher' : 'team_leader',
    team_name: recipient === 'dispatcher' ? null : 'alpha',
    turn_id: turnId,
    event_id: `event-${turnId}`,
    message_role: 'assistant',
    content,
    content_truncated: false,
    redacted: false,
  };
}

function nativeEnd(
  recipient: 'dispatcher' | 'leader',
  status: 'completed' | 'failed' | 'interrupted' = 'completed',
): TeammateNativeTurnEndedEvent {
  return {
    schema_version: 1,
    kind: 'teammate.native_turn.ended',
    occurred_at: 1_700_000_000_002,
    teammate_name: recipient === 'dispatcher' ? 'dispatcher-agent' : 'alpha-leader',
    role: recipient === 'dispatcher' ? 'dispatcher' : 'team_leader',
    team_name: recipient === 'dispatcher' ? null : 'alpha',
    status,
  };
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
  it('opens the card under the message that produced the turn, and closes it on the native end', async () => {
    const { session, cot, port } = await harness('chan-cot-anchor', async (
      command,
      _payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      emit(submittedEvent('turn-1', 'dispatcher'));
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

    expect(cot.cards[0]!.chatId).toBe('oc_dm');
    expect(cot.cards[0]!.originMessageId).toBe('om_user_1');

    port.emit(assistantMessage('turn-1', 'dispatcher', 'the answer'));
    port.emit(nativeEnd('dispatcher'));
    await waitFor(() => cotRunStatus(cot.cards[0]!) !== null);

    expect(cotTexts(cot.cards[0]!)).toEqual([RECEIPT, 'the answer']);
    expect(cotRunStatus(cot.cards[0]!)).toBe('done');

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
      emit(submittedEvent('turn-fallback', 'dispatcher'));
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
    await waitFor(() => cot.cards.length === 1);

    // Exactly one card, under the operator's own message, owned by the
    // Dispatcher that actually answered.
    expect(cot.cards[0]!.originMessageId).toBe('om_user_1');
    port.emit(assistantMessage('turn-fallback', 'dispatcher', 'dispatcher answered'));
    await waitFor(() => cotTexts(cot.cards[0]!).length === 2);
    expect(cotTexts(cot.cards[0]!)).toEqual([RECEIPT, 'dispatcher answered']);

    // And the TeamLeader whose route was refused has no card at all.
    port.emit(assistantMessage('turn-fallback', 'leader', 'never displayed'));
    port.emit(nativeEnd('leader'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cot.cards).toHaveLength(1);

    await session.close();
  });

  it('opens no card for an ambiguous submission, which proves no recipient', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cot.cards).toHaveLength(0);

    await session.close();
  });
});

describe('FeishuChannelSession COT — a Reply never touches the anchor', () => {
  it('leaves the open card and its anchor exactly as they were', async () => {
    const { session, cot, port, bot } = await harness('chan-cot-reply', async (
      command,
      _payload,
      emit,
    ) => {
      if (command !== 'team.submit') throw new Error(`unexpected ${command}`);
      emit(submittedEvent('turn-1', 'leader'));
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
    expect(cotRunStatus(cot.cards[0]!)).toBeNull();

    port.emit(nativeEnd('leader'));
    await waitFor(() => cotRunStatus(cot.cards[0]!) !== null);
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
    const port = fakePort(async (_command, _payload, emit) => {
      emit(submittedEvent('turn-1', 'dispatcher'));
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
