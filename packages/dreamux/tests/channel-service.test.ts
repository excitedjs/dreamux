import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelSession,
  ChannelTarget,
} from '@excitedjs/dreamux-types';

import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

const PROVIDER_REF = 'builtin:feishu';

const DESCRIPTOR: ChannelProviderDescriptor = {
  id: 'feishu',
  kind: 'channel',
  ref: { source: 'builtin', id: 'feishu', raw: PROVIDER_REF },
};

function groupTarget(chatId: string): ChannelTarget {
  return {
    target_type: 'group',
    target_key: chatId,
    bindable: true,
    meta: { chat_id: chatId },
  };
}

function channelProviderCatalog(
  messageBelongsToTarget: ChannelSession['messageBelongsToTarget'] = () => true,
  toolConfigReads: unknown[] = [],
): ChannelProviderCatalog {
  const registry = createBuiltinProviderRegistry();
  const descriptor = registry.resolve(PROVIDER_REF);
  registry.registerImplementation(descriptor.id, {
    ref: PROVIDER_REF,
    descriptor: {
      ...DESCRIPTOR,
      id: descriptor.id,
      ref: descriptor.ref,
    },
    readConfig: (raw) => raw,
    tools(config) {
      toolConfigReads.push(config);
      return [{ name: 'reply' }];
    },
    createSession(context) {
      return {
        provider: PROVIDER_REF,
        channel_id: context.channel_id,
        start: async () => undefined,
        close: async () => undefined,
        resolveTarget: async (meta) =>
          groupTarget(
            typeof (meta as { chat_id?: unknown })?.chat_id === 'string'
              ? (meta as { chat_id: string }).chat_id
              : 'chat-default',
          ),
        messageBelongsToTarget,
      };
    },
  } satisfies ChannelProvider);
  return new ChannelProviderCatalog({ registry });
}

describe('ChannelService binding ownership', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-channel-service-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds, summarizes, and transfers through one owner-aware path', async () => {
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({ id: 'dispatcher-a', channelId: 'primary' }),
      ]),
      channelProviders: channelProviderCatalog(),
      channelLoggerFactory: () => ({}) as never,
    });
    const sessions = await service.build();
    service.adopt(sessions);
    const owner = { kind: 'team' as const, teamName: 'alpha', leaderName: 'leader-a' };

    await expect(
      service.bindTarget({ owner, meta: { chat_id: 'chat-a' } }),
    ).resolves.toMatchObject({ team_name: 'alpha', leader_name: 'leader-a' });
    await expect(service.activeBindingSummaryForOwner(owner)).resolves.toEqual({
      channel_id: 'primary',
      provider: PROVIDER_REF,
      target_type: 'group',
      target_key: 'chat-a',
      display: null,
      canonical_url: null,
    });

    await expect(
      service.transferBack({
        expectedOwner: { kind: 'team', teamName: 'beta', leaderName: 'leader-b' },
        meta: { chat_id: 'chat-a' },
      }),
    ).rejects.toThrow(/not Team/);

    await expect(
      service.transferBack({ expectedOwner: owner, meta: { chat_id: 'chat-a' } }),
    ).resolves.toMatchObject({ active: false, team_name: 'alpha' });
    await expect(
      service.transferBack({ expectedOwner: owner, meta: { chat_id: 'chat-a' } }),
    ).resolves.toBeNull();
  });

  it('builds provider channel MCP descriptors from configured dispatcher channels before sessions are live', () => {
    const toolConfigReads: unknown[] = [];
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({
          id: 'dispatcher-a',
          channelId: 'primary',
          feishu: { marker: 'dispatcher-a' },
        }),
        testDispatcherConfig({
          id: 'dispatcher-b',
          channelId: 'other',
          feishu: { marker: 'dispatcher-b' },
        }),
      ]),
      channelProviders: channelProviderCatalog(undefined, toolConfigReads),
      channelLoggerFactory: () => ({}) as never,
      adminSocketPath: '/tmp/dreamux-admin.sock',
    });

    expect(
      service.channelMcpServerDescriptorsForCaller({ callerKind: 'dispatcher' }),
    ).toEqual([
      {
        name: 'feishu',
        command: expect.any(String),
        args: [
          'channel-mcp',
          '--provider',
          'builtin:feishu',
          '--channel-id',
          'primary',
          '--dispatcher',
          'dispatcher-a',
          '--caller',
          'dispatcher',
          '--channel-tools-b64',
          expect.any(String),
          '--admin-socket',
          '/tmp/dreamux-admin.sock',
        ],
      },
    ]);
    expect(toolConfigReads).toEqual([
      expect.objectContaining({ marker: 'dispatcher-a' }),
    ]);
    expect(service.live().size).toBe(0);
  });
});
