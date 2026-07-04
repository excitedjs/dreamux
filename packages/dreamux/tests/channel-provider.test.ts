import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RECEIVED_REACTION_EMOJI,
  createFeishuChannelProvider,
  createFakeFeishuBot,
  saveDispatcherAccess,
} from '@excitedjs/feishu-channel';
import type {
  DreamuxLogger,
  SubscribeChannelProvider,
} from '@excitedjs/dreamux-types';
import { SubscribeChannelProviderCatalog } from '../src/subscribe-channel/catalog.js';
import { subscribeChannelMcpServerDescriptors } from '../src/subscribe-channel/mcp-descriptors.js';
import { dispatcherDir } from '../src/platform/paths.js';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  parseProviderRef,
  createBuiltinProviderRegistry,
  ProviderRegistry,
} from '../src/registry/index.js';

const log = ((): DreamuxLogger => {
  const noop = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => noop,
  };
  return noop as unknown as DreamuxLogger;
})();

// Build the REAL package Feishu session over a fake bot through the neutral
// provider seam — the same path production drives. The package's `botFactory`
// test option swaps the live Lark connection for the fake bot; egress flows
// through the real reply/react wire mapping.
function feishuSession() {
  const bot = createFakeFeishuBot('app-test');
  const provider = createFeishuChannelProvider({ botFactory: () => bot });
  const session = provider.createSession({
    dispatcher_id: 'flow',
    channel_id: 'primary',
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    config: { appId: 'app-test', appSecret: 'secret-test' },
    logger: log,
    state_root: dispatcherDir('flow'),
  });
  return { bot, session };
}

function inboundEvent(messageId: string) {
  return {
    messageId,
    chatId: 'chat-1',
    chatType: 'group',
    senderId: 'sender-1',
    senderType: 'user',
    senderName: 'Ada Sender',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '<at id="fake-open-id-app-test"></at> hi' }),
    parsedText: '@bot hi',
    mentions: [
      {
        key: '@_user_1',
        id: { open_id: 'fake-open-id-app-test' },
        name: 'Bot',
      },
    ],
    createTime: '1782660000000',
    raw: {},
  };
}

async function assertNonSubmittedDeliveryClearsReceivedReaction(
  delivery:
    | { status: 'duplicate' }
    | { status: 'stopped' }
    | { status: 'failed'; error: Error },
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), 'dreamux-feishu-ack-'));
  try {
    const bot = createFakeFeishuBot('app-test');
    const provider = createFeishuChannelProvider({ botFactory: () => bot });
    const session = provider.createSession({
      dispatcher_id: 'flow',
      channel_id: 'primary',
      provider: BUILTIN_FEISHU_PROVIDER_REF,
      config: { appId: 'app-test', appSecret: 'secret-test' },
      logger: log,
      state_root: stateDir,
    });
    await saveDispatcherAccess(stateDir, {
      version: 3,
      dm_policy: 'pairing',
      allow_users: ['sender-1'],
      group: { policy: 'follow-user', allow_chats: [], require_mention: true },
      pending: {},
      observed_chats: [],
      warnings: [],
      last_gate: { at: 0 },
    });
    await session.start({
      deliver: async () => delivery,
    });
    await bot.inject(inboundEvent(`msg-${delivery.status}`));

    expect(bot.reactions).toEqual([
      {
        messageId: `msg-${delivery.status}`,
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
    ]);
    expect(bot.removedReactions).toEqual([
      { messageId: `msg-${delivery.status}`, reactionId: 'reaction-fake-1' },
    ]);
    expect(bot.reactionOps).toEqual([
      {
        op: 'add',
        messageId: `msg-${delivery.status}`,
        emoji: RECEIVED_REACTION_EMOJI,
        reactionId: 'reaction-fake-1',
      },
      { op: 'remove', messageId: `msg-${delivery.status}`, reactionId: 'reaction-fake-1' },
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe('built-in Feishu channel', () => {
  it('handles reply MCP calls inside the channel module', async () => {
    const { bot, session } = feishuSession();
    const result = await session.handleTool!(
      {
        name: 'reply',
        arguments: {
          chat_id: 'chat-1',
          text: 'hello',
          message_id: 'msg-1',
          mention_user_ids: ['user-1'],
        },
      },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'reply sent',
      message_ids: ['message-fake-1'],
    });
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]?.target).toMatchObject({
      chatId: 'chat-1',
      replyToMessageId: 'msg-1',
      mentionUserIds: ['user-1'],
    });
    expect(bot.sentMessages[0]?.text).toBe('hello');
  });

  it('handles react MCP calls inside the channel module', async () => {
    const { bot, session } = feishuSession();
    const result = await session.handleTool!(
      { name: 'react', arguments: { message_id: 'msg-1', emoji: 'OK' } },
      { dispatcher_id: 'flow', channel_id: 'primary' },
    );

    expect(result).toEqual({
      status: 'ok',
      message: 'reaction added',
      reaction_id: 'reaction-fake-1',
    });
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });

  it.each([
    [{ status: 'duplicate' } as const],
    [{ status: 'stopped' } as const],
    [{ status: 'failed', error: new Error('boom') } as const],
  ])('clears optimistic received reaction when delivery is %s', async (delivery) => {
    await assertNonSubmittedDeliveryClearsReceivedReaction(delivery);
  });
});

describe('subscription channel plugin interface', () => {
  it('registers only the built-in feishu channel; subscription plugins stay interface-only', () => {
    // Since the multi-channel config slice (#209) the built-in feishu channel IS
    // a registry descriptor (kind `channel`); it is the only builtin channel.
    // Subscription-style channel plugins (github/jira) remain interface-only —
    // no builtin subscription channel descriptor is registered.
    const registry = createBuiltinProviderRegistry();
    expect(registry.listByKind('channel').map((d) => d.id)).toEqual(['feishu']);
    expect(registry.resolve('builtin:feishu').kind).toBe('channel');
  });

  it('reserves the shape future subscription plugins must implement', () => {
    const handled: unknown[] = [];
    const plugin: SubscribeChannelProvider = {
      ref: 'builtin:example-subscription',
      descriptor: {
        id: 'example-subscription',
        kind: 'subscribeChannel',
        ref: {
          source: 'builtin',
          id: 'example-subscription',
          raw: 'builtin:example-subscription',
        },
      },
      createSession: () => ({
        provider: 'builtin:example-subscription',
        subscription_id: 'issues',
        start: async ({ publish }) => {
          await publish({ id: 'event-1', text: 'subscribed event' });
        },
        close: async () => undefined,
      }),
      tools: () => [{ name: 'ack_issue' }],
      handleTool: async (call, context) => {
        handled.push({ call, context });
        return { ok: true };
      },
    };
    expect(plugin.ref).toBe('builtin:example-subscription');
    expect(plugin.tools?.({})).toEqual([{ name: 'ack_issue' }]);
  });

  it('core renders subscription MCP descriptors from static provider catalogs', () => {
    const registry = new ProviderRegistry();
    const descriptor = {
      id: 'example-subscription',
      kind: 'subscribeChannel' as const,
      ref: parseProviderRef('builtin:example-subscription'),
    };
    registry.register(descriptor);
    const configReads: unknown[] = [];
    const plugin: SubscribeChannelProvider = {
      ref: 'builtin:example-subscription',
      descriptor,
      readConfig: (raw) => ({ parsed: raw }),
      createSession: () => ({
        provider: 'builtin:example-subscription',
        subscription_id: 'issues',
        start: async () => undefined,
        close: async () => undefined,
      }),
      tools: (config) => {
        configReads.push(config);
        return [{ name: 'ack_issue' }];
      },
      handleTool: async () => ({ ok: true }),
    };
    registry.registerImplementation(descriptor.id, plugin);
    const catalog = new SubscribeChannelProviderCatalog({ registry });

    expect(
      subscribeChannelMcpServerDescriptors({
        dispatcherId: 'dispatcher-a',
        subscriptions: [
          {
            id: 'issues',
            dispatcher_id: 'dispatcher-a',
            provider: 'builtin:example-subscription',
            config: { repo: 'example/repo' },
          },
          {
            id: 'other',
            dispatcher_id: 'dispatcher-b',
            provider: 'builtin:example-subscription',
            config: { repo: 'other/repo' },
          },
        ],
        subscribeChannelProviders: catalog,
        adminSocketPath: '/tmp/dreamux-admin.sock',
      }),
    ).toEqual([
      {
        name: 'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz',
        command: expect.any(String),
        args: [
          'subscribe-channel-mcp',
          '--provider',
          'builtin:example-subscription',
          '--subscription-id',
          'issues',
          '--dispatcher',
          'dispatcher-a',
          '--subscription-tools-b64',
          expect.any(String),
          '--admin-socket',
          '/tmp/dreamux-admin.sock',
        ],
      },
    ]);
    expect(configReads).toEqual([{ repo: 'example/repo' }]);
  });

  it('scopes subscription MCP server names by subscription id for same-provider subscriptions', () => {
    const registry = new ProviderRegistry();
    const descriptor = {
      id: 'example-subscription',
      kind: 'subscribeChannel' as const,
      ref: parseProviderRef('builtin:example-subscription'),
    };
    registry.register(descriptor);
    const plugin: SubscribeChannelProvider = {
      ref: 'builtin:example-subscription',
      descriptor,
      readConfig: (raw) => raw,
      createSession: () => ({
        provider: 'builtin:example-subscription',
        subscription_id: 'issues',
        start: async () => undefined,
        close: async () => undefined,
      }),
      tools: () => [{ name: 'ack_issue' }],
      handleTool: async () => ({ ok: true }),
    };
    registry.registerImplementation(descriptor.id, plugin);
    const catalog = new SubscribeChannelProviderCatalog({ registry });

    const descriptors = subscribeChannelMcpServerDescriptors({
      dispatcherId: 'dispatcher-a',
      subscriptions: [
        {
          id: 'issues',
          dispatcher_id: 'dispatcher-a',
          provider: 'builtin:example-subscription',
          config: { repo: 'example/repo' },
        },
        {
          id: 'pull_requests',
          dispatcher_id: 'dispatcher-a',
          provider: 'builtin:example-subscription',
          config: { repo: 'example/repo' },
        },
      ],
      subscribeChannelProviders: catalog,
      adminSocketPath: '/tmp/dreamux-admin.sock',
    });

    expect(descriptors.map((server) => server.name)).toEqual([
      'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-aXNzdWVz',
      'subscribe-ZXhhbXBsZS1zdWJzY3JpcHRpb24-cHVsbF9yZXF1ZXN0cw',
    ]);
    expect(new Set(descriptors.map((server) => server.name)).size).toBe(2);
    expect(descriptors.map((server) => server.args)).toEqual([
      expect.arrayContaining(['--subscription-id', 'issues']),
      expect.arrayContaining(['--subscription-id', 'pull_requests']),
    ]);
  });
});
