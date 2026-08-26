import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ChannelCoreEvent,
  ChannelProvider,
  ChannelProviderDescriptor,
  ChannelSession,
  ChannelTarget,
  ChannelToolContext,
} from '@excitedjs/dreamux-types';

import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import {
  createBuiltinProviderRegistry,
  parseProviderRef,
} from '../src/registry/index.js';
import { invokeDispatcherChannelTool } from '../src/service/dispatcher-service/channel-tool-invocation.js';
import { ChannelService } from '../src/service/channel-service/index.js';
import { ChannelSessions } from '../src/service/channel-service/channel-sessions.js';
import { ChannelBindingStore } from '../src/service/channel-binding/store.js';
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

function teamProjection(teamName: string, leaderName: string) {
  return {
    team_name: teamName,
    leader_name: leaderName,
    leader_agent_runtime: 'test:runtime',
    runtime_cwd: `/tmp/${teamName}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function channelProviderCatalog(
  messageBelongsToTarget: ChannelSession['messageBelongsToTarget'] = () => true,
  toolConfigReads: unknown[] = [],
  resolveTarget: ChannelSession['resolveTarget'] = async (meta) =>
    groupTarget(
      typeof (meta as { chat_id?: unknown })?.chat_id === 'string'
        ? (meta as { chat_id: string }).chat_id
        : 'chat-default',
    ),
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
      return [
        {
          name: 'reply',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ];
    },
    createSession(context) {
      return {
        provider: PROVIDER_REF,
        channel_id: context.channel_id,
        start: async () => undefined,
        close: async () => undefined,
        resolveTarget,
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
    process.env['DREAMUX_ROOT'] = join(root, 'dreamux');
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    delete process.env['DREAMUX_ROOT'];
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

    const target = await service.resolveTarget({ chat_id: 'chat-a' }, 'primary');
    await expect(service.bindResolvedTarget({
      team: teamProjection(owner.teamName, owner.leaderName),
      channelId: 'primary',
      target,
    })).resolves.toMatchObject({ team_name: 'alpha', leader_name: 'leader-a' });
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

  it('summarizes every active binding for one owner while preserving the first summary', async () => {
    const bindings = new ChannelBindingStore();
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({ id: 'dispatcher-a', channelId: 'primary' }),
      ]),
      channelProviders: channelProviderCatalog(),
      bindings,
      channelLoggerFactory: () => ({}) as never,
    });
    const owner = {
      kind: 'team' as const,
      teamName: 'alpha',
      leaderName: 'leader-a',
    };

    await bindings.bind({
      dispatcherId: 'dispatcher-a',
      channelId: 'flowx',
      provider: 'npm:@example/flowx-channel',
      target: {
        target_type: 'task',
        target_key: 'task-alpha',
        bindable: true,
      },
      teamName: owner.teamName,
      leaderName: owner.leaderName,
    });
    await bindings.bind({
      dispatcherId: 'dispatcher-a',
      channelId: 'feishu',
      provider: PROVIDER_REF,
      target: groupTarget('chat-alpha'),
      teamName: owner.teamName,
      leaderName: owner.leaderName,
    });

    const expected = [
      {
        channel_id: 'flowx',
        provider: 'npm:@example/flowx-channel',
        target_type: 'task',
        target_key: 'task-alpha',
        display: null,
        canonical_url: null,
      },
      {
        channel_id: 'feishu',
        provider: PROVIDER_REF,
        target_type: 'group',
        target_key: 'chat-alpha',
        display: null,
        canonical_url: null,
      },
    ];
    await expect(service.activeBindingSummariesForOwner(owner)).resolves.toEqual(
      expected,
    );
    await expect(service.activeBindingSummaryForOwner(owner)).resolves.toEqual(
      expected[0],
    );
  });

  it('claims and conditionally releases resolved targets for automatic routing', async () => {
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
    const alpha = {
      kind: 'team' as const,
      teamName: 'alpha',
      leaderName: 'leader-a',
    };
    const beta = {
      kind: 'team' as const,
      teamName: 'beta',
      leaderName: 'leader-b',
    };
    const target = groupTarget('chat-claim');

    await service.claimResolvedTarget({
      team: teamProjection(alpha.teamName, alpha.leaderName),
      channelId: 'primary',
      target,
      claimId: 'claim-alpha',
    });
    await expect(
      service.claimResolvedTarget({
        team: teamProjection(beta.teamName, beta.leaderName),
        channelId: 'primary',
        target,
        claimId: 'claim-beta',
      }),
    ).rejects.toThrow(/already bound to Team "alpha"/);

    await expect(
      service.releaseResolvedTargetIfOwned({
        owner: beta,
        channelId: 'primary',
        target,
      }),
    ).resolves.toBeNull();
    await expect(
      service.resolveInboundBinding({ channelId: 'primary', target }),
    ).resolves.toMatchObject({ owner: alpha });

    await expect(
      service.releaseResolvedTargetIfOwned({
        owner: alpha,
        channelId: 'primary',
        target,
      }),
    ).resolves.toMatchObject({ active: false, team_name: 'alpha' });
    await expect(
      service.resolveInboundBinding({ channelId: 'primary', target }),
    ).resolves.toBeNull();
  });

  it('publishes route binding events only for authoritative transitions', async () => {
    const events: ChannelCoreEvent[] = [];
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({ id: 'dispatcher-a', channelId: 'primary' }),
      ]),
      channelProviders: channelProviderCatalog(),
      channelLoggerFactory: () => ({}) as never,
      coreEvents: {
        publish(dispatcherId, event) {
          expect(dispatcherId).toBe('dispatcher-a');
          events.push(event);
        },
      },
    });
    const sessions = await service.build();
    service.adopt(sessions);
    const team = {
      team_name: 'alpha',
      leader_name: 'leader-a',
      leader_agent_runtime: 'test:runtime',
      runtime_cwd: '/tmp/runtime-alpha',
    };
    const publishedMeta = {
      chat_id: 'chat-a',
      routing: { message_id: 'message-before-publish' },
    };

    await service.bindResolvedTarget({
      team,
      channelId: 'primary',
      target: {
        ...groupTarget('chat-a'),
        meta: publishedMeta,
      },
    });
    await service.bindResolvedTarget({
      team,
      channelId: 'primary',
      target: {
        ...groupTarget('chat-a'),
        display: 'renamed',
        meta: { chat_id: 'chat-a', refreshed: true },
      },
    });
    await service.transferResolvedTargetBack({
      channelId: 'primary',
      target: groupTarget('chat-a'),
    });
    await service.bindResolvedTargetIfAvailableToOwner({
      team,
      channelId: 'primary',
      target: groupTarget('chat-b'),
    });
    await service.bindResolvedTargetIfAvailableToOwner({
      team,
      channelId: 'primary',
      target: groupTarget('chat-b'),
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: 'binding.route',
      action: 'bound',
      transition: 'bound',
      endpoint: {
        provider: PROVIDER_REF,
        endpoint_type: 'group',
        endpoint_key: 'chat-a',
      },
      current_team: {
        team_name: 'alpha',
        leader_agent_runtime: 'test:runtime',
        runtime_cwd: '/tmp/runtime-alpha',
      },
    });
    publishedMeta.routing.message_id = 'message-after-publish';
    const publishedEndpoint = events[0]?.kind === 'binding.route'
      ? events[0].endpoint
      : undefined;
    expect(publishedEndpoint?.meta).toMatchObject({
      routing: { message_id: 'message-before-publish' },
    });
    expect(Object.isFrozen(publishedEndpoint?.meta)).toBe(true);
    expect(Object.isFrozen(publishedEndpoint?.meta['routing'])).toBe(true);
    expect(events[1]).toMatchObject({
      kind: 'binding.route',
      action: 'unbound',
      transition: 'unbound',
      endpoint: {
        display: 'renamed',
        meta: { refreshed: true },
      },
      previous_team: {
        team_name: 'alpha',
        leader_name: 'leader-a',
      },
      current_team: null,
    });
    expect(events[2]).toMatchObject({
      kind: 'binding.route',
      action: 'bound',
      transition: 'bound',
      endpoint: {
        endpoint_key: 'chat-b',
      },
      current_team: {
        team_name: 'alpha',
        leader_agent_runtime: 'test:runtime',
        runtime_cwd: '/tmp/runtime-alpha',
      },
    });
  });

  it('requires exact message ownership before a broader binding can authorize egress', async () => {
    const exactTarget: ChannelTarget = {
      target_type: 'topic',
      target_key: 'topic-a',
      bindable: true,
      binding_fallbacks: [groupTarget('chat-a')],
    };
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({ id: 'dispatcher-a', channelId: 'primary' }),
      ]),
      channelProviders: channelProviderCatalog(
        () => true,
        [],
        async () => exactTarget,
      ),
      channelLoggerFactory: () => ({}) as never,
    });
    const sessions = await service.build();
    service.adopt(sessions);
    const owner = {
      kind: 'team' as const,
      teamName: 'group-owner',
      leaderName: 'group-leader',
    };
    await service.bindResolvedTarget({
      team: teamProjection(owner.teamName, owner.leaderName),
      channelId: 'primary',
      target: groupTarget('chat-a'),
    });

    for (const argumentsWithoutProof of [
      { target: 'topic-a' },
      { target: 'topic-a', message_id: '' },
    ]) {
      await expect(service.authorizeTeamLeaderEgress({
        owner,
        channelId: 'primary',
        arguments: argumentsWithoutProof,
      })).rejects.toThrow(/bound team channels/);
    }

    await expect(service.authorizeTeamLeaderEgress({
      owner,
      channelId: 'primary',
      arguments: { target: 'topic-a', message_id: 'observed-message' },
    })).resolves.toMatchObject({ target: exactTarget });
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

  it('uses the channel id as the MCP server name for an npm channel provider', () => {
    const providerRef = 'npm:@example/dreamux-channel';
    const descriptor: ChannelProviderDescriptor = {
      id: providerRef,
      kind: 'channel',
      ref: parseProviderRef(providerRef),
    };
    const registry = createBuiltinProviderRegistry();
    registry.register(descriptor);
    registry.registerImplementation(descriptor.id, {
      ref: providerRef,
      descriptor,
      tools: () => [
        {
          name: 'repository_report',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      createSession: () => {
        throw new Error('not used');
      },
    } satisfies ChannelProvider);
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({
          id: 'dispatcher-a',
          channelId: 'flowx',
          channelProvider: providerRef,
        }),
      ]),
      channelProviders: new ChannelProviderCatalog({ registry }),
      channelLoggerFactory: () => ({}) as never,
      adminSocketPath: '/tmp/dreamux-admin.sock',
    });

    expect(
      service.channelMcpServerDescriptorsForCaller({ callerKind: 'dispatcher' }),
    ).toEqual([
      expect.objectContaining({
        name: 'flowx',
        args: expect.arrayContaining(['--provider', providerRef]),
      }),
    ]);
  });

  it('detaches closing sessions before await so an older close cannot clear a restart', async () => {
    const release = deferred<void>();
    let oldCloseCalls = 0;
    let newCloseCalls = 0;
    const sessions = new ChannelSessions({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([testDispatcherConfig({ id: 'dispatcher-a' })]),
      channelProviders: channelProviderCatalog(),
      channelLoggerFactory: () => ({}) as never,
    });
    const oldSession = {
      provider: PROVIDER_REF,
      channel_id: 'primary',
      async start() {},
      async close() {
        oldCloseCalls += 1;
        await release.promise;
      },
      async resolveTarget() {
        return groupTarget('old');
      },
    } satisfies ChannelSession;
    const newSession = {
      provider: PROVIDER_REF,
      channel_id: 'primary',
      async start() {},
      async close() {
        newCloseCalls += 1;
      },
      async resolveTarget() {
        return groupTarget('new');
      },
    } satisfies ChannelSession;
    sessions.adopt(new Map([['primary', oldSession]]));

    const closing = sessions.closeAll({ error: () => undefined } as never);
    expect(sessions.live().size).toBe(0);
    await sessions.closeAll({ error: () => undefined } as never);
    expect(oldCloseCalls).toBe(1);
    sessions.adopt(new Map([['primary', newSession]]));
    release.resolve();
    await closing;

    expect(sessions.live().get('primary')).toBe(newSession);
    expect(newCloseCalls).toBe(0);
  });
});

describe('channel tool caller identity', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dreamux-channel-caller-'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = root;
    resetRuntimeConfig();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true });
  });

  async function serviceWithToolRecorder(): Promise<{
    service: ChannelService;
    contexts: ChannelToolContext[];
  }> {
    const contexts: ChannelToolContext[] = [];
    const service = new ChannelService({
      dispatcherId: 'dispatcher-a',
      config: testDreamuxConfig([
        testDispatcherConfig({ id: 'dispatcher-a', channelId: 'primary' }),
      ]),
      channelProviders: channelProviderCatalog(),
      channelLoggerFactory: () => ({}) as never,
    });
    const sessions = await service.build();
    const session = sessions.get('primary');
    if (session === undefined) throw new Error('expected primary session');
    session.handleTool = async (_call, context) => {
      contexts.push(context);
      return { ok: true };
    };
    service.adopt(sessions);
    return { service, contexts };
  }

  it('hands the provider a TeamLeader caller keyed by the Team store name', async () => {
    const { service, contexts } = await serviceWithToolRecorder();
    await service.bindResolvedTarget({
      team: teamProjection('alpha', 'leader-a'),
      channelId: 'primary',
      target: groupTarget('chat-a'),
    });

    await invokeDispatcherChannelTool({
      channels: service,
      channelId: 'primary',
      name: 'reply',
      arguments: { chat_id: 'chat-a' },
      caller: { kind: 'team_leader', teamId: 'alpha', leaderName: 'leader-a' },
    });

    expect(contexts).toEqual([
      {
        dispatcher_id: 'dispatcher-a',
        channel_id: 'primary',
        caller: {
          kind: 'team_leader',
          team_name: 'alpha',
          leader_name: 'leader-a',
        },
      },
    ]);
  });

  it('hands the provider an explicit dispatcher caller', async () => {
    const { service, contexts } = await serviceWithToolRecorder();

    await invokeDispatcherChannelTool({
      channels: service,
      channelId: 'primary',
      name: 'reply',
      arguments: { chat_id: 'chat-a' },
      caller: { kind: 'dispatcher' },
    });

    expect(contexts).toEqual([
      {
        dispatcher_id: 'dispatcher-a',
        channel_id: 'primary',
        caller: { kind: 'dispatcher' },
      },
    ]);
  });
});
