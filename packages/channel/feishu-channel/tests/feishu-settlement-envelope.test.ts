/**
 * An ask-card answer is a channel message, and its envelope has to read like
 * one.
 *
 * The settlement envelope is built by hand in `feishu-session-ops.ts` rather
 * than by the inbound formatter, so nothing but this test keeps the two in
 * step. What matters is the `source` attribute and its position: the model
 * reads `<channel source="feishu" …>` and ties the answer to the
 * `channel-feishu` MCP server whose tools it must use to reply, exactly as it
 * does for an ordinary inbound message.
 */
import { describe, expect, it } from 'vitest';

import { createAskUserRegistry } from '../src/feishu-ask-user.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import {
  expireAskUserQuestion,
  sessionHandle,
  type SessionHandle,
} from '../src/feishu-session-ops.js';
import { CHANNEL_REMINDER } from '../src/feishu-submit.js';
import type {
  FeishuInboundDelivery,
  FeishuSubmission,
} from '../src/feishu-submit.js';
import { AsyncMutex } from '../src/lib/mutex.js';
import { topicTarget } from '../src/routing/target.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

const silent = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

function capturingDelivery(): {
  delivery: FeishuInboundDelivery;
  submissions: FeishuSubmission[];
} {
  const submissions: FeishuSubmission[] = [];
  return {
    submissions,
    delivery: {
      async deliver(input) {
        submissions.push(input.submission);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    },
  };
}

function handle(delivery: FeishuInboundDelivery): SessionHandle {
  const bot = createFakeFeishuBot();
  return sessionHandle({
    opts: {
      dispatcherId: 'dispatcher-1',
      channelId: 'channel-1',
      appId: 'app-1',
      appSecret: '',
      stateDir: '/tmp/unused-state',
      attachmentCacheDir: '/tmp/unused-cache',
      log: silent,
      botFactory: () => bot,
    },
    bot,
    accessMutex: new AsyncMutex(),
    botDisplayName: 'Dreamux bot',
    targetRouter: new FeishuTargetRouter({ chatModes: bot, log: silent }),
    delivery,
    askUser: createAskUserRegistry(),
  });
}

describe('the ask-card settlement envelope', () => {
  it('carries source="feishu" as its first attribute, ahead of the ids', async () => {
    const { delivery, submissions } = capturingDelivery();

    // Expiry is the settlement path that delivers synchronously; a click
    // detaches delivery and builds the very same submission.
    await expireAskUserQuestion(handle(delivery), {
      settlement: {
        requestId: 'req-1',
        target: topicTarget('oc_room', 'omt_thread'),
        outcome: 'expired',
        text: 'The question expired with no answer.',
        sourceId: 'ask:req-1',
        cardMessageId: 'om_card',
        operatorOpenId: 'ou_clicker',
      },
      card: {},
    });

    expect(submissions).toHaveLength(1);
    expect(Object.keys(submissions[0]?.attrs ?? {})).toEqual([
      'source',
      'chat_id',
      'thread_id',
      'message_id',
      'sender_id',
      'ask_user_request_id',
    ]);
    expect(submissions[0]?.attrs.source).toBe('feishu');
    // The same standing note an inbound message carries: an answer leaves the
    // model in the same chat, under the same consequence.
    expect(submissions[0]?.reminder).toBe(CHANNEL_REMINDER);
  });
});
