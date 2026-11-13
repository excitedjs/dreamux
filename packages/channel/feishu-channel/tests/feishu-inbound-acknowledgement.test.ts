/**
 * The acknowledgement contract for the two long inbound routes.
 *
 * A chat message and a document comment are unbounded submissions — each may
 * start an agent runtime — while Feishu gives an event three seconds before it
 * considers it unhandled and re-pushes it. So those routes acknowledge the
 * event and hand their work to the session, which owns it and drains it on
 * close.
 *
 * These tests hold the work itself open and observe the route, because that is
 * the whole contract: the route resolves while its work has not finished. The
 * work is spied rather than driven through Core so the assertion is about the
 * acknowledgement boundary and nothing else.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelCorePort,
  DreamuxLogger,
  JsonValue,
} from '@excitedjs/dreamux-types';

import { FeishuChannelSession } from '../src/session/session.js';
import { FeishuTeamSubmitter } from '../src/session/submitter.js';
import { describeSubmitOutcome } from '../src/feishu-submit.js';
import { loadChatBots } from '../src/chat-bots-store.js';
import { createFeishuBot } from '../src/bot.js';
import { FeishuInboundRouter } from '../src/inbound/router.js';
import { FeishuDocumentComments } from '../src/feishu-document-comments.js';
import {
  defaultDispatcherAccessState,
  type DispatcherAccessStateV3,
} from '../src/access/state.js';
import {
  createFakeFeishuBot,
  type FakeFeishuBot,
} from './helpers/fake-feishu-bot.js';

vi.mock('../src/bot.js', () => ({ createFeishuBot: vi.fn() }));

let dir: string;
let attachDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-ack-state-'));
  attachDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-ack-attach-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  rmSync(attachDir, { recursive: true, force: true });
});

type RecordingLog = DreamuxLogger & {
  readonly errors: Array<Record<string, unknown>>;
  readonly lines: Array<{ level: string; fields: Record<string, unknown> }>;
};

function recordingLog(): RecordingLog {
  const errors: Array<Record<string, unknown>> = [];
  // Every level, not only `error`. A path that honours the classification
  // reports a stopped delivery at `info`; a test that captured only `error`
  // would pass whether the path suppressed it or reclassified it, which is the
  // difference these cases exist to pin.
  const lines: Array<{ level: string; fields: Record<string, unknown> }> = [];
  const capture =
    (level: string) => (fieldsOrMessage: Record<string, unknown> | string) => {
      if (typeof fieldsOrMessage === 'string') return;
      lines.push({ level, fields: fieldsOrMessage });
      if (level === 'error') errors.push(fieldsOrMessage);
    };
  const log = {
    errors,
    lines,
    // Both pino overloads: the channel logs fields-first, but a bare message is
    // part of the same signature and a narrower function would not type.
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    trace: capture('trace'),
    child: () => log,
  };
  return log as unknown as RecordingLog;
}

function inertPort(): ChannelCorePort {
  return {
    invoke: {
      invoke: async (): Promise<JsonValue> => ({
        status: 'submitted',
        turn_id: 'turn-1',
      }),
    },
    events: {
      subscribe() {
        return { unsubscribe: () => undefined };
      },
    },
  };
}

/**
 * One piece of inbound work a test holds open, or rejects, on demand.
 *
 * `start()` is what a spy calls when the code under test reaches this work, so
 * `entered` means "the work is in flight", not "the promise was constructed".
 * `fail()` rejects it, which is how a test drives the post-acknowledgement
 * failure path.
 */
function heldWork(): {
  readonly promise: Promise<never>;
  readonly entered: Promise<void>;
  start: () => void;
  fail: (error: Error) => void;
} {
  let fail!: (error: Error) => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const promise = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  return { promise, entered, start: () => markEntered(), fail };
}

/**
 * Poll until `predicate` is true. The route hands its work to the session, so
 * nothing observable has happened when `inject` resolves; a test that asserts
 * an effect has to wait for it rather than read it on the next line.
 */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function seedAccess(stateDir: string): Promise<void> {
  const state: DispatcherAccessStateV3 = {
    ...defaultDispatcherAccessState(),
    allow_users: ['ou_commenter'],
    group: {
      policy: 'allowlist',
      allow_chats: ['oc_ack'],
      require_mention: true,
    },
  };
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify(state));
}

async function startedSession(
  bot: FakeFeishuBot,
  log: DreamuxLogger,
): Promise<FeishuChannelSession> {
  vi.mocked(createFeishuBot).mockReturnValueOnce(bot);
  const session = new FeishuChannelSession({
    dispatcherId: 'disp-ack',
    channelId: 'chan-ack',
    appId: 'app',
    appSecret: '',
    stateDir: dir,
    attachmentCacheDir: attachDir,
    log,
  });
  await seedAccess(dir);
  await session.initialize(inertPort());
  await session.start();
  return session;
}

function inboundEvent(bot: FakeFeishuBot, messageId: string) {
  return {
    messageId,
    chatId: 'oc_ack',
    chatType: 'group' as const,
    senderId: 'ou_human',
    senderType: 'user',
    senderName: 'Human',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@_user_1 hello' }),
    text: '@_user_1 hello',
    resources: [],
    mentions: [
      { key: '@_user_1', name: 'Dreamux', id: { open_id: bot.botOpenId! } },
    ],
    createTime: '1',
    raw: {},
  };
}

function docCommentEvent() {
  return {
    fileToken: 'doc_ack',
    fileType: 'docx',
    commentId: 'cmt_ack',
    replyId: '',
    commenterId: 'ou_commenter',
    mentionedBot: true,
    timestamp: 1757894400000,
  };
}

describe('Feishu inbound acknowledgement', () => {
  it('returns from the message route while its work is still running', async () => {
    const bot = createFakeFeishuBot();
    const session = await startedSession(bot, recordingLog());
    const work = heldWork();
    const delivered = vi
      .spyOn(FeishuInboundRouter.prototype, 'deliver')
      .mockImplementation(() => {
        work.start();
        return work.promise;
      });

    // Resolves even though the delivery it started never settles.
    await bot.inject(inboundEvent(bot, 'om_ack_1'));
    await work.entered;
    await waitFor(() => delivered.mock.calls.length === 1, 'delivery started');

    work.fail(new Error('the test is done holding this open'));
    await session.close();
  });

  it('returns from the document-comment route while its work is still running', async () => {
    const bot = createFakeFeishuBot();
    const session = await startedSession(bot, recordingLog());
    const work = heldWork();
    vi.spyOn(FeishuDocumentComments.prototype, 'deliver').mockImplementation(
      () => {
        work.start();
        return work.promise;
      },
    );

    await bot.injectDocComment(docCommentEvent());
    await work.entered;

    work.fail(new Error('the test is done holding this open'));
    await session.close();
  });

  it('waits for in-flight inbound work when the session closes', async () => {
    const bot = createFakeFeishuBot();
    const session = await startedSession(bot, recordingLog());
    const work = heldWork();
    vi.spyOn(FeishuInboundRouter.prototype, 'deliver').mockImplementation(
      () => {
        work.start();
        return work.promise;
      },
    );
    // Both halves of the claim are observable only through the drain: waiting
    // for the call proves teardown takes this path at all, and the bounded
    // window after it proves `close` is parked on the held work rather than
    // merely slow to arrive. A single microtask would pass either way.
    const drained = vi.spyOn(session.lifecycle, 'drain');

    await bot.inject(inboundEvent(bot, 'om_ack_2'));
    await work.entered;

    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await waitFor(
      () => drained.mock.calls.length === 1,
      'teardown reached its drain',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    work.fail(new Error('delivery gave up'));
    await closing;
    expect(closed).toBe(true);
  });

  it('reports a failure after the acknowledgement instead of letting it escape', async () => {
    const bot = createFakeFeishuBot();
    const log = recordingLog();
    const session = await startedSession(bot, log);
    const work = heldWork();
    vi.spyOn(FeishuInboundRouter.prototype, 'deliver').mockImplementation(
      () => {
        work.start();
        return work.promise;
      },
    );

    await bot.inject(inboundEvent(bot, 'om_ack_3'));
    await work.entered;
    work.fail(new Error('core is unavailable'));
    await session.lifecycle.drain();
    await waitFor(() => log.errors.length > 0, 'failure reported');

    const reported = log.errors.filter((fields) =>
      JSON.stringify(fields['err']).includes('core is unavailable'),
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]!['dispatcher_id']).toBe('disp-ack');
    // The ids are the point: this line is the only record of an event the
    // platform will not deliver again, so it has to say which one.
    expect(reported[0]!['chat_id']).toBe('oc_ack');
    expect(reported[0]!['message_id']).toBe('om_ack_3');

    await session.close();
  });

  it('reports a stopped document comment at info, not as a failure', async () => {
    const bot = createFakeFeishuBot();
    const log = recordingLog();
    const session = await startedSession(bot, log);
    // Hold the submission open until the session is closing, then answer the
    // way the real submitter does once the lifecycle is dead: `not_attempted`,
    // which is a fact the outcome carries rather than a string this path would
    // have to match.
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      vi.spyOn(FeishuTeamSubmitter.prototype, 'submit').mockImplementation(
        () => {
          resolve();
          return new Promise((settle) => {
            release = () =>
              settle({ status: 'not_attempted', reason: 'closed' });
          });
        },
      );
    });

    await bot.injectDocComment(docCommentEvent());
    await entered;

    const closing = session.close();
    release();
    await closing;

    // Nothing was attempted, so this is not a failure — but the line still has
    // to exist: the comment is gone, and its ids are how an operator finds it.
    // Both halves are asserted, because suppressing the record entirely would
    // pass an errors-only check while losing the only trace of a lost comment.
    expect(log.errors).toEqual([]);
    const stopped = log.lines.filter(
      (line) =>
        line.level === 'info' &&
        String(line.fields['comment_id'] ?? '').includes('cmt_ack') &&
        line.fields['status'] === 'not_attempted',
    );
    expect(stopped).toHaveLength(1);
  });

  it('retries the bot identity inside the work rather than before the route returns', async () => {
    const bot = createFakeFeishuBot();
    const session = await startedSession(bot, recordingLog());
    // Hold the lookup open: if it sat on the acknowledgement path the route
    // could not resolve until this settled, which is the 3-second-window
    // regression this change removed.
    const lookup = heldWork();
    vi.spyOn(bot, 'ensureSelfIdentity').mockImplementation(() => {
      lookup.start();
      return lookup.promise;
    });
    const delivered = vi.spyOn(FeishuInboundRouter.prototype, 'deliver');

    await bot.inject(inboundEvent(bot, 'om_ack_5'));
    await lookup.entered;

    // The route returned with the lookup still parked, so the platform has been
    // answered; the delivery has not started, because identity comes first
    // inside the work.
    expect(delivered).not.toHaveBeenCalled();

    lookup.fail(new Error('the test is done holding this open'));
    await session.lifecycle.drain();
  });

  it('records a redelivered bot-added event once, keyed on the id the decoder yields', async () => {
    const bot = createFakeFeishuBot();
    const session = await startedSession(bot, recordingLog());
    const event = {
      chatId: 'oc_bot_added',
      eventId: 'evt_redelivered',
    };

    await bot.injectBotMemberAdded(event);
    await bot.injectBotMemberAdded(event);
    await session.lifecycle.drain();

    // This half covers the session: the id the decoder yields has to reach the
    // store and dedupe there. The other half — that the decoder yields a
    // non-empty id for the payload the SDK actually delivers — is
    // `feishu-transport`'s `bot-member.test.ts`; neither side can cover the
    // other's half.
    const state = await loadChatBots(dir);
    expect(state.chats['oc_bot_added']?.seenEventIds).toEqual([
      'evt_redelivered',
    ]);
  });

  it('classifies a stopped session as nothing attempted, not as a failure', async () => {
    // The one fact every delivery path keys on: a teardown is not a delivery
    // that failed, so it is not reported at error level by any of them.
    const report = describeSubmitOutcome({
      status: 'not_attempted',
      reason: 'closed',
    });

    expect(report.kind).toBe('not_attempted');
    // `info`, not `debug`: a stock install keeps info and drops debug, and this
    // line is the only record of a message the platform will not redeliver.
    expect(report.level).toBe('info');
  });

  it('does not call an unsent answer delivered', async () => {
    // Every path that reports a settlement asks the classification first. A
    // path that logged its own fixed word instead would say "delivered" for an
    // answer the session stopped before sending, which is what the ask-user
    // settlement did before this classification reached it.
    for (const status of ['not_attempted', 'error', 'unsubmitted'] as const) {
      const report = describeSubmitOutcome(
        status === 'not_attempted'
          ? { status, reason: 'closed' }
          : { status, message: 'x' },
      );
      expect(report.kind).not.toBe('submitted');
      if (status === 'not_attempted') expect(report.level).not.toBe('error');
    }
  });
});
