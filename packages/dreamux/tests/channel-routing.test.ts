/**
 * Inbound routing by `(channel_id, target_key)` (issue #209 binding store v2).
 *
 * These assert `DispatcherService.routeChannelInput` resolves the SAME
 * `(channel_id, target_key)` the bind path stores, and takes the right delivery
 * branch: a bound bindable target → the TeamLeader; an unbound bindable target →
 * the dispatcher; a non-bindable (P2P) target → the dispatcher with NO binding
 * lookup at all (P2P never routes to a TeamLeader). The channel session
 * (`resolveChannelTarget`) and the Team service are stubbed so the routing
 * decision is exercised without the Feishu gate or a live bot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChannelInboundEnvelope,
  ChannelTarget,
  InboundTurnInput,
} from '@excitedjs/dreamux-types';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { DispatcherService } from '../src/dispatcher-service/service.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import type { DreamuxLogger } from '../src/platform/logger.js';
import { resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';
import { stubChannelCatalog } from './helpers/fake-channel.js';

function noopLog(): DreamuxLogger {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => log,
  };
  return log as unknown as DreamuxLogger;
}

function feishuTarget(chatType: 'group' | 'p2p'): ChannelTarget {
  return {
    target_type: chatType,
    target_key: 'chat-x',
    bindable: chatType === 'group',
    meta: { chat_id: 'chat-x', chat_type: chatType },
  };
}

function envelope(chatType: 'group' | 'p2p'): ChannelInboundEnvelope {
  return {
    provider: 'builtin:feishu',
    channel_id: 'primary',
    target: feishuTarget(chatType),
    message_id: 'm1',
  };
}

const INPUT = { kind: 'channel', text: 'hi', dedupeId: 'm1' } as unknown as InboundTurnInput;

function buildService(): DispatcherService {
  // testDispatcherConfig defaults the channel id to 'primary'.
  const config = testDreamuxConfig([testDispatcherConfig({ cwd: '/tmp/routing-cwd' })]);
  const registry = createBuiltinProviderRegistry();
  return new DispatcherService({
    config,
    dispatchers: new DispatcherStore(config),
    agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
    channelProviders: stubChannelCatalog(),
    channelLoggerFactory: () => noopLog(),
    log: noopLog(),
  });
}

describe('routeChannelInput keys by (channel_id, target_key) (#209 binding store v2)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeConfig();
  });

  it('routes a bound group to the TeamLeader, keyed by the configured channel id', async () => {
    const service = buildService();
    // routeChannelInput reads the channel-resolved target straight off the
    // neutral envelope, so no resolveChannelTarget stub is needed here.
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(
      dispatcherRuntime as never,
    );
    const resolveSpy = vi
      .spyOn(service.teams, 'resolveChannel')
      .mockResolvedValue({ team_name: 'alpha' } as never);
    const deliverSpy = vi
      .spyOn(service.teams, 'deliverToLeader')
      .mockResolvedValue({ status: 'submitted', turnId: 'turn-channel' });

    const result = await service.routeChannelInput('flow', 'primary', INPUT, envelope('group'));

    // The originating session tags the channel_id ('primary') — the SAME id the
    // bind path stores — so the stored binding and the inbound message match.
    expect(resolveSpy).toHaveBeenCalledWith({
      dispatcherId: 'flow',
      channelId: 'primary',
      targetKey: 'chat-x',
    });
    expect(deliverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcherId: 'flow', teamId: 'alpha' }),
    );
    expect(dispatcherRuntime.channelInput).not.toHaveBeenCalled();
    expect(result.status).toBe('submitted');
  });

  it('routes an unbound group to the dispatcher', async () => {
    const service = buildService();
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(
      dispatcherRuntime as never,
    );
    vi.spyOn(service.teams, 'resolveChannel').mockResolvedValue(null);
    const deliverSpy = vi.spyOn(service.teams, 'deliverToLeader');

    await service.routeChannelInput('flow', 'primary', INPUT, envelope('group'));

    expect(deliverSpy).not.toHaveBeenCalled();
    expect(dispatcherRuntime.channelInput).toHaveBeenCalledTimes(1);
  });

  it('routes a P2P target to the dispatcher with no binding lookup (never a TeamLeader)', async () => {
    const service = buildService();
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(
      dispatcherRuntime as never,
    );
    const resolveSpy = vi.spyOn(service.teams, 'resolveChannel');
    const deliverSpy = vi.spyOn(service.teams, 'deliverToLeader');

    await service.routeChannelInput('flow', 'primary', INPUT, envelope('p2p'));

    // A non-bindable target short-circuits to the dispatcher BEFORE any binding
    // lookup — P2P can never be bound to a TeamLeader.
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(dispatcherRuntime.channelInput).toHaveBeenCalledTimes(1);
  });
});

describe('resolveChannelId guards the explicit channel_id on bind (#209 binding store v2)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeConfig();
  });

  it('passes an explicit channel_id that matches the configured channel through to the store', async () => {
    const service = buildService();
    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(
      feishuTarget('group'),
    );
    const bindSpy = vi
      .spyOn(service.teams, 'bindChannel')
      .mockResolvedValue({ team_name: 'alpha' } as never);

    await service.bindTeamChannel({
      dispatcherId: 'flow',
      teamId: 'alpha',
      channelId: 'primary',
      meta: { chat_id: 'chat-x' },
    });

    expect(bindSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherId: 'flow',
        teamId: 'alpha',
        channelId: 'primary',
        provider: 'builtin:feishu',
        target: expect.objectContaining({ target_key: 'chat-x' }),
      }),
    );
  });

  it('rejects an explicit channel_id that does not match the configured channel (fail-loud, no store write)', async () => {
    const service = buildService();
    const bindSpy = vi.spyOn(service.teams, 'bindChannel');

    await expect(
      service.bindTeamChannel({
        dispatcherId: 'flow',
        teamId: 'alpha',
        channelId: 'wrong',
        meta: { chat_id: 'chat-x' },
      }),
    ).rejects.toThrow(/unknown channel_id 'wrong'/);
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('rejects a dispatcher with no resolvable channel', async () => {
    const service = buildService();
    await expect(
      service.bindTeamChannel({
        dispatcherId: 'ghost',
        teamId: 'alpha',
        meta: { chat_id: 'chat-x' },
      }),
    ).rejects.toThrow(/no resolvable channel/);
  });
});
