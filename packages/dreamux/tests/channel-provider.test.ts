import { describe, expect, it } from 'vitest';

import {
  resolveChannelProvider,
  UnsupportedChannelProviderError,
} from '../src/channel/channel-providers.js';
import { builtinFeishuChannelProvider } from '../src/channel/feishu-provider.js';
import {
  CHANNEL_CAPABILITY,
  ChannelCapabilityError,
  type ChannelProvider,
} from '../src/channel/provider.js';
import { feishuMcpServerDescriptor } from '../src/codex/mcp-config.js';
import {
  defaultDispatcherAccessState,
  dreamuxFeishuGate,
  loadDispatcherAccess,
  saveDispatcherAccess,
} from '../src/channel/feishu-gate.js';
import {
  createBuiltinProviderRegistry,
  InvalidProviderRefError,
  ReservedExternalProviderError,
  UnknownBuiltinProviderError,
} from '../src/registry/index.js';
import { createFakeFeishuBot } from '../src/feishu/bot.js';

function resolveBuiltinChannelProvider(ref: string) {
  return resolveChannelProvider(ref, {
    registry: createBuiltinProviderRegistry(),
  });
}

function feishuProvider(): ChannelProvider {
  const registry = createBuiltinProviderRegistry();
  return builtinFeishuChannelProvider(registry.resolve('builtin:feishu'));
}

describe('resolveChannelProvider', () => {
  it('resolves the builtin:feishu channel provider', () => {
    const provider = resolveBuiltinChannelProvider('builtin:feishu');
    expect(provider.ref).toBe('builtin:feishu');
    expect(provider.descriptor.kind).toBe('channel');
    expect(provider.descriptor.id).toBe('feishu');
  });

  it('rejects an agentRuntime ref as a non-channel provider', () => {
    expect(() => resolveBuiltinChannelProvider('builtin:codex')).toThrow(
      UnsupportedChannelProviderError,
    );
    expect(() => resolveBuiltinChannelProvider('builtin:claude-code')).toThrow(
      UnsupportedChannelProviderError,
    );
  });

  it('refuses to load a reserved external npm ref', () => {
    expect(() =>
      resolveBuiltinChannelProvider('npm:@example/dreamux-channel'),
    ).toThrow(ReservedExternalProviderError);
    expect(() =>
      resolveBuiltinChannelProvider('npm:@example/dreamux-channel#provider'),
    ).toThrow(ReservedExternalProviderError);
  });

  it('rejects an unknown builtin ref', () => {
    expect(() => resolveBuiltinChannelProvider('builtin:matrix')).toThrow(
      UnknownBuiltinProviderError,
    );
  });

  it('surfaces a malformed ref through the parser', () => {
    expect(() => resolveBuiltinChannelProvider('not-a-ref')).toThrow(
      InvalidProviderRefError,
    );
  });
});

describe('builtin:feishu capability declaration', () => {
  it('reports each declared capability through hasCapability', () => {
    const provider = feishuProvider();
    for (const kind of Object.values(CHANNEL_CAPABILITY)) {
      expect(provider.hasCapability(kind)).toBe(true);
    }
  });
});

describe('builtin:feishu owns its MCP / access / reply / react surfaces', () => {
  it('contributes runtime-neutral MCP server descriptors (not runtime CLI args)', () => {
    const provider = feishuProvider();
    const context = { dispatcherId: 'flow', adminSocketPath: '/tmp/admin.sock' };
    expect(provider.mcpServerDescriptors(context)).toEqual([
      feishuMcpServerDescriptor(context),
    ]);
  });

  it('delegates access load/save/gate to the Feishu access module', () => {
    const provider = feishuProvider();
    // The provider owns access semantics by delegating to the Feishu gate; core
    // no longer imports these directly.
    expect(provider.access.load).toBe(loadDispatcherAccess);
    expect(provider.access.save).toBe(saveDispatcherAccess);
    expect(provider.access.gate).toBe(dreamuxFeishuGate);
  });

  it('gates a direct message from an un-allowed sender as drop', () => {
    const provider = feishuProvider();
    const result = provider.access.gate(
      { senderId: 'stranger', chatId: 'chat-dm', chatType: 'p2p' },
      defaultDispatcherAccessState(),
    );
    expect(result.action).toBe('drop');
  });

  it('translates a channel-neutral reply into the transport target', async () => {
    const provider = feishuProvider();
    const bot = createFakeFeishuBot('app-test');
    const result = await provider.reply?.(bot, {
      chatId: 'chat-1',
      text: 'hello',
      replyToMessageId: 'msg-1',
      mentionUserIds: ['user-1'],
    });
    expect(result?.messageIds).toEqual(['message-fake-1']);
    expect(bot.sentMessages).toHaveLength(1);
    expect(bot.sentMessages[0]?.target).toMatchObject({
      chatId: 'chat-1',
      replyToMessageId: 'msg-1',
      mentionUserIds: ['user-1'],
    });
    expect(bot.sentMessages[0]?.text).toBe('hello');
  });

  it('adds a reaction through the connection', async () => {
    const provider = feishuProvider();
    const bot = createFakeFeishuBot('app-test');
    const result = await provider.react?.(bot, {
      messageId: 'msg-1',
      emoji: 'OK',
    });
    expect(result?.reactionId).toBe('reaction-fake-1');
    expect(bot.reactions).toEqual([
      { messageId: 'msg-1', emoji: 'OK', reactionId: 'reaction-fake-1' },
    ]);
  });
});

describe('ChannelProvider permits inbound-only channels (reply is not core-mandatory)', () => {
  it('allows a provider to declare no reply/react capability', () => {
    const inboundOnly: ChannelProvider = {
      ref: 'builtin:inbound-only',
      descriptor: {
        id: 'inbound-only',
        kind: 'channel',
        ref: { source: 'builtin', id: 'inbound-only', raw: 'builtin:inbound-only' },
      },
      hasCapability: (kind) => kind === CHANNEL_CAPABILITY.mcpServer,
      mcpServerDescriptors: () => [],
      createConnection: () => {
        throw new Error('not used in this test');
      },
      access: {
        load: loadDispatcherAccess,
        save: saveDispatcherAccess,
        gate: dreamuxFeishuGate,
      },
    };
    expect(inboundOnly.hasCapability(CHANNEL_CAPABILITY.reply)).toBe(false);
    expect(inboundOnly.hasCapability(CHANNEL_CAPABILITY.react)).toBe(false);
    expect(inboundOnly.reply).toBeUndefined();
    expect(inboundOnly.react).toBeUndefined();
  });

  it('ChannelCapabilityError names the ref and the missing capability', () => {
    const err = new ChannelCapabilityError('builtin:inbound-only', 'reply');
    expect(err.ref).toBe('builtin:inbound-only');
    expect(err.capability).toBe('reply');
    expect(err.message).toContain('reply');
  });
});
