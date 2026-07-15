import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type {
  AgentRuntimeTurnResult,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import type { FeishuInboundEvent } from '../src/bot.js';
import {
  saveDispatcherAccess,
  defaultDispatcherAccessState,
  type DmPolicy,
} from '../src/feishu-gate.js';
import { onMessage } from '../src/feishu-session-inbound.js';
import {
  IN_PROGRESS_REACTION_EMOJI,
  RECEIVED_REACTION_EMOJI,
  type FeishuInboundEnvelope,
  type FeishuInboundSubmitter,
} from '../src/feishu-channel.js';
import {
  sessionHandle,
  type FeishuChannelState,
} from '../src/feishu-session-ops.js';
import { createFakeFeishuBot } from './helpers/fake-feishu-bot.js';
import { AsyncMutex } from '../src/lib/mutex.js';
import { FeishuTargetRouter } from '../src/feishu-target-router.js';
import type { DreamuxLogger } from '@excitedjs/dreamux-types';

function noopLogger(): DreamuxLogger {
  const noop = () => {};
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
  const base: FeishuInboundEvent = {
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
  };
  return { ...base, ...overrides };
}

describe('feishu inbound submit-throw cleanup (PR #282)', () => {
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

  function buildHandle(state: FeishuChannelState, bot: ReturnType<typeof createFakeFeishuBot>) {
    const log = noopLogger();
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
      state,
      bot,
      new AsyncMutex(),
      'Dreamux bot',
      new FeishuTargetRouter({ chatModes: bot, log }),
    );
  }

  it('clears the pre-delivery `received` reaction when submitTurn throws', async () => {
    await allowSender();
    const bot = createFakeFeishuBot('fake-bot');
    const state: FeishuChannelState = {
      inboundReactions: new Map(),
      pendingReceivedReactionClears: new Set(),
    };
    const handle = buildHandle(state, bot);

    const submitter: FeishuInboundSubmitter = {
      submitTurn: async (
        _input: InboundTurnInput,
        _envelope: FeishuInboundEnvelope,
      ): Promise<AgentRuntimeTurnResult> => {
        throw new Error('boom submit failed');
      },
    };

    await onMessage(handle, makeEvent(), submitter);

    // Reaction ledger should be empty (the pre-delivery `received` was cleared).
    expect(state.inboundReactions.size).toBe(0);

    // The bot should have observed an `add` (received) followed by a `remove`.
    const ops = bot.reactionOps;
    const addOps = ops.filter((op) => op.op === 'add');
    const removeOps = ops.filter((op) => op.op === 'remove');
    expect(addOps.length).toBeGreaterThanOrEqual(1);
    expect(addOps[0]?.emoji).toBe(RECEIVED_REACTION_EMOJI);
    expect(removeOps.length).toBeGreaterThanOrEqual(1);
    // The removed reaction id matches the added reaction id (same reaction
    // cleared, not a different one).
    expect(removeOps[0]?.reactionId).toBe(addOps[0]?.reactionId);
  });

  it('upgrades received to in_progress when submitTurn returns submitted', async () => {
    await allowSender();
    const bot = createFakeFeishuBot('fake-bot');
    const state: FeishuChannelState = {
      inboundReactions: new Map(),
      pendingReceivedReactionClears: new Set(),
    };
    const handle = buildHandle(state, bot);

    const submitter: FeishuInboundSubmitter = {
      submitTurn: async (): Promise<AgentRuntimeTurnResult> => ({
        status: 'submitted',
        turnId: 'turn-1',
      }),
    };

    await onMessage(handle, makeEvent(), submitter);

    // Ledger holds the in_progress reaction, not received.
    expect(state.inboundReactions.size).toBe(1);
    const entry = state.inboundReactions.get('msg-1');
    expect(entry?.state).toBe('in_progress');

    const emojis = bot.reactionOps
      .filter((op) => op.op === 'add')
      .map((op) => op.emoji);
    expect(emojis).toContain(RECEIVED_REACTION_EMOJI);
    expect(emojis).toContain(IN_PROGRESS_REACTION_EMOJI);
  });
});
