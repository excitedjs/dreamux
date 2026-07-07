import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelInboundEnvelope,
  ChannelSession,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';
import {
  createFakeFeishuBot,
  createFeishuChannelProvider,
  defaultDispatcherAccessState,
  saveDispatcherAccess,
  type FakeFeishuBot,
  type FeishuChannelConfig,
  type FeishuInboundEvent,
} from '../src/index.js';

function logger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

function inboundEvent(
  overrides: Partial<FeishuInboundEvent> = {},
): FeishuInboundEvent {
  return {
    messageId: 'om_source',
    chatId: 'oc_group',
    chatType: 'group',
    senderId: 'ou_allowed',
    senderType: 'user',
    senderName: '',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '<at id="fake-open-id-app"></at> hi' }),
    parsedText: '@bot hi',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app' },
        name: 'Bot',
      },
    ],
    threadId: 'om_thread',
    rootId: 'om_root',
    parentId: 'om_parent',
    createTime: '1782660000000',
    raw: {},
    ...overrides,
  };
}

function createSession(
  stateDir: string,
  bot: FakeFeishuBot,
  configOverrides: Record<string, unknown> = {},
): ChannelSession {
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const config = provider.readConfig!(
    { app_id: 'app', app_secret: 'secret', ...configOverrides },
    {
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: 'builtin:feishu',
    },
  ) as FeishuChannelConfig;
  return provider.createSession!({
    dispatcher_id: 'flow',
    channel_id: 'primary',
    provider: 'builtin:feishu',
    config,
    state_root: stateDir,
    cache_root: stateDir,
    logger: logger(),
  });
}

describe('Feishu topic channel targets', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-topic-'));
    const access = defaultDispatcherAccessState();
    await saveDispatcherAccess(stateDir, {
      ...access,
      allow_users: ['ou_allowed'],
      group: {
        ...access.group,
        policy: 'follow-user',
        require_mention: true,
      },
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('routes messages in a Feishu topic to a topic-scoped target key', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatMode('oc_group', 'topic');
    const session = createSession(stateDir, bot, {
      topicContext: { enabled: true },
    });
    const delivered: Array<{
      input: InboundTurnInput;
      envelope: ChannelInboundEnvelope;
    }> = [];

    await session.start({
      deliver: async (input, envelope, hooks) => {
        delivered.push({ input, envelope });
        await hooks?.onAccepted?.(input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(inboundEvent());

    expect(delivered).toHaveLength(1);
    const { input, envelope } = delivered[0]!;
    expect(envelope.target.target_key).toBe('oc_group#thread:om_thread');
    expect(envelope.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: 'om_thread',
      root_id: 'om_root',
      parent_id: 'om_parent',
    });
    expect(envelope.metadata).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: 'om_thread',
      root_id: 'om_root',
      parent_id: 'om_parent',
    });
    expect(input.attrs).toContainEqual(['thread_id', 'om_thread']);
    expect(input.attrs).toContainEqual(['root_id', 'om_root']);
    expect(input.attrs).toContainEqual(['parent_id', 'om_parent']);

    await expect(
      session.resolveTarget({
        chat_id: 'oc_group',
        chat_type: 'group',
        message_id: 'om_source',
      }),
    ).resolves.toMatchObject({
      target_key: 'oc_group#thread:om_thread',
    });
    expect(
      await session.messageBelongsToTarget?.({
        target: envelope.target,
        message_id: 'om_source',
      }),
    ).toBe(true);
    expect(
      await session.messageBelongsToTarget?.({
        target: {
          ...envelope.target,
          target_key: 'oc_group#thread:om_other',
        },
        message_id: 'om_source',
      }),
    ).toBe(false);
  });

  it('keeps topic messages chat-scoped when topicContext is omitted', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatMode('oc_group', 'topic');
    const session = createSession(stateDir, bot);
    const delivered: ChannelInboundEnvelope[] = [];

    await session.start({
      deliver: async (_input, envelope, hooks) => {
        delivered.push(envelope);
        await hooks?.onAccepted?.(_input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(inboundEvent());

    expect(delivered[0]?.target.target_key).toBe('oc_group');
    expect(delivered[0]?.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: 'om_thread',
    });
  });

  it('disables topic-scoped target keys when topicContext.enabled is false', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatMode('oc_group', 'topic');
    const session = createSession(stateDir, bot, {
      topicContext: { enabled: false },
    });
    const delivered: ChannelInboundEnvelope[] = [];

    await session.start({
      deliver: async (_input, envelope, hooks) => {
        delivered.push(envelope);
        await hooks?.onAccepted?.(_input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(inboundEvent());

    expect(delivered[0]?.target.target_key).toBe('oc_group');
    expect(delivered[0]?.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'topic',
      thread_id: 'om_thread',
    });
    await expect(
      session.resolveTarget({
        chat_id: 'oc_group',
        chat_type: 'group',
        thread_id: 'om_thread',
      }),
    ).resolves.toMatchObject({
      target_key: 'oc_group',
    });
  });

  it('keeps plain group messages on the historical chat-scoped target key', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatMode('oc_group', 'group');
    const session = createSession(stateDir, bot);
    const delivered: ChannelInboundEnvelope[] = [];

    await session.start({
      deliver: async (_input, envelope, hooks) => {
        delivered.push(envelope);
        await hooks?.onAccepted?.(_input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(
      inboundEvent({
        threadId: undefined,
        rootId: undefined,
        parentId: undefined,
      }),
    );

    expect(delivered[0]?.target.target_key).toBe('oc_group');
    expect(delivered[0]?.target.meta).toEqual({
      chat_id: 'oc_group',
      chat_type: 'group',
    });
  });

  it('keeps threaded messages in ordinary groups on the chat target key even when topicContext is enabled', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatMode('oc_group', 'group');
    const session = createSession(stateDir, bot, {
      topicContext: { enabled: true },
    });
    const delivered: ChannelInboundEnvelope[] = [];

    await session.start({
      deliver: async (_input, envelope, hooks) => {
        delivered.push(envelope);
        await hooks?.onAccepted?.(_input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(inboundEvent());

    expect(delivered[0]?.target.target_key).toBe('oc_group');
    expect(delivered[0]?.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'group',
      thread_id: 'om_thread',
    });
    await expect(
      session.resolveTarget({
        chat_id: 'oc_group',
        chat_type: 'group',
        thread_id: 'om_thread',
      }),
    ).resolves.toMatchObject({
      target_key: 'oc_group',
    });

    bot.setChatModeError(new Error('cache would be bypassed'));
    await bot.inject(
      inboundEvent({
        messageId: 'om_source_2',
        threadId: 'om_thread_2',
        rootId: 'om_root_2',
      }),
    );

    expect(delivered[1]?.target.target_key).toBe('oc_group');
    expect(delivered[1]?.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      chat_mode: 'group',
      thread_id: 'om_thread_2',
    });
  });

  it('keeps threaded messages chat-scoped when chat mode lookup fails', async () => {
    const bot = createFakeFeishuBot('app');
    bot.setChatModeError(new Error('lookup failed'));
    const session = createSession(stateDir, bot, {
      topicContext: { enabled: true },
    });
    const delivered: ChannelInboundEnvelope[] = [];

    await session.start({
      deliver: async (_input, envelope, hooks) => {
        delivered.push(envelope);
        await hooks?.onAccepted?.(_input);
        return { status: 'submitted', turnId: 'turn-1' };
      },
    });

    await bot.inject(inboundEvent());

    expect(delivered[0]?.target.target_key).toBe('oc_group');
    expect(delivered[0]?.target.meta).toMatchObject({
      chat_id: 'oc_group',
      chat_type: 'group',
      thread_id: 'om_thread',
    });
    expect(delivered[0]?.target.meta).not.toHaveProperty('chat_mode');
  });

});
