import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DreamuxLogger,
  InboundDeliveryResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { FeishuInboundEvent } from '../src/bot.js';
import {
  defaultDispatcherAccessState,
  saveDispatcherAccess,
  type DmPolicy,
} from '../src/feishu-gate.js';
import type {
  FeishuInboundEnvelope,
  FeishuInboundSubmitter,
} from '../src/feishu-channel.js';
import { onMessage } from '../src/feishu-session-inbound.js';
import {
  CHANNEL_REMINDER,
  sessionHandle,
} from '../src/feishu-session-ops.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import { AsyncMutex } from '../src/lib/mutex.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';

function noopLogger(): DreamuxLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => noopLogger(),
  } as unknown as DreamuxLogger;
}

function makeEvent(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou_requester',
    senderType: 'user',
    senderName: '',
    senderUnionId: '',
    messageType: 'text',
    rawContent: JSON.stringify({ text: 'hello' }),
    parsedText: 'hello',
    mentions: [],
    createTime: '1710000000000',
    raw: null,
    ...overrides,
  };
}

describe('feishu inbound delivery', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-inbound-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  async function allowSender(): Promise<void> {
    const state = defaultDispatcherAccessState();
    state.dm_policy = 'allowlist' as DmPolicy;
    state.allow_users = ['ou_requester'];
    await saveDispatcherAccess(stateDir, state);
  }

  function buildHandle(
    bot: ReturnType<typeof createFakeFeishuBot>,
    log: DreamuxLogger = noopLogger(),
  ) {
    return sessionHandle(
      {
        dispatcherId: 'dispatcher-a',
        appId: 'app-test',
        appSecret: '',
        stateDir,
        attachmentCacheDir: stateDir,
        log,
        botFactory: () => bot,
      },
      bot,
      new AsyncMutex(),
      'Dreamux bot',
      new FeishuTargetRouter({ chatModes: bot, log }),
    );
  }

  it.each([
    ['submitted', { status: 'submitted' } as const],
    ['duplicate', { status: 'duplicate' } as const],
    ['stopped', { status: 'stopped' } as const],
    ['failed', { status: 'failed', error: new Error('failed') } as const],
    ['ambiguous', { status: 'ambiguous', error: new Error('lost') } as const],
  ])('performs no automatic reaction when delivery is %s', async (_name, result) => {
    await allowSender();
    const bot = createFakeFeishuBot();
    const submitTurn = vi.fn(async (): Promise<InboundDeliveryResult> => result);

    await onMessage(buildHandle(bot), makeEvent(), { submitTurn });

    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(bot.reactionOps).toEqual([]);
  });

  it('keeps thrown admission ambiguous without replay or automatic reaction', async () => {
    await allowSender();
    const bot = createFakeFeishuBot();
    const messages: string[] = [];
    const submitTurn = vi.fn(async (
      _input: InboundTurnInput,
      _envelope: FeishuInboundEnvelope,
    ): Promise<InboundDeliveryResult> => {
      throw new Error('boom submit failed');
    });

    await onMessage(buildHandle(bot, captureLogger(messages)), makeEvent(), {
      submitTurn,
    });

    expect(submitTurn).toHaveBeenCalledTimes(1);
    expect(bot.reactionOps).toEqual([]);
    expect(messages).toContain('feishu inbound admission was ambiguous; not replaying');
  });

  it('appends one trusted channel reminder at the end of the submitted body', async () => {
    await allowSender();
    const bot = createFakeFeishuBot();
    let captured: InboundTurnInput | undefined;
    const submitter: FeishuInboundSubmitter = {
      submitTurn: async (input): Promise<InboundDeliveryResult> => {
        captured = input;
        return { status: 'submitted' };
      },
    };

    await onMessage(buildHandle(bot), makeEvent(), submitter);

    expect(captured?.body.match(/<channel-reminder>/g)).toHaveLength(1);
    expect(captured?.body.endsWith(`\n\n${CHANNEL_REMINDER}`)).toBe(true);
    expect(captured?.text).toBe(captured?.body);
  });
});

function captureLogger(messages: string[]): DreamuxLogger {
  const log = noopLogger() as DreamuxLogger & {
    error: (...args: unknown[]) => void;
  };
  log.error = (...args: unknown[]) => {
    const message = args.at(-1);
    if (typeof message === 'string') messages.push(message);
  };
  log.child = () => log;
  return log;
}
