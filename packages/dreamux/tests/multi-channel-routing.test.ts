/**
 * Live multi-channel runtime routing (issue #209).
 *
 * A dispatcher may now declare more than one `builtin:feishu` channel and run a
 * live session per channel, each connecting as its own bot. These tests prove:
 *  - inbound routes by the ORIGINATING channel_id (+ provider-resolved target),
 *    so a message arriving on a secondary channel keys its binding under that
 *    channel — not a single config-derived channel;
 *  - binding on a multi-channel dispatcher requires an explicit channel_id, and
 *    a single-channel dispatcher still resolves its sole channel (legacy);
 *  - a P2P (non-bindable) target still short-circuits to the dispatcher, never a
 *    TeamLeader, regardless of channel count;
 *  - multiple channel sessions are actually live (one bot per channel), and
 *    egress (reply/react) dispatches to the selected channel's bot;
 *  - no generic Channel MCP / `list_peers` surface is introduced — egress stays
 *    on the Feishu MCP tools, channel_id-scoped.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeCreateContext,
  AgentRuntimeContextSnapshot,
  AgentRuntimeLastResult,
  AgentRuntimeProvider,
  AgentRuntimeProviderDescriptor,
  AgentRuntimeStatus,
  AgentRuntimeSystemInput,
  AgentRuntimeTurnResult,
  ChannelInboundEnvelope,
  ChannelTarget,
  InboundTurnInput,
  ProviderDescriptor,
} from '@excitedjs/dreamux-types';
import { asAgentRuntimeDescriptor } from './helpers/provider.js';
import {
  feishuChannelCatalog,
  stubChannelCatalog,
} from './helpers/fake-channel.js';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { DispatcherService } from '../src/dispatcher-service/service.js';
import {
  createFakeFeishuBot,
  feishuMcpTools,
  saveDispatcherAccess,
  type FakeFeishuBot,
  type FeishuInboundEvent,
} from '@excitedjs/feishu-channel';
import {
  BUILTIN_FEISHU_PROVIDER_REF,
  type DispatcherChannelConfig,
} from '../src/config/config.js';
import { createBuiltinProviderRegistry } from '../src/registry/index.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import type { DreamuxLogger } from '../src/platform/logger.js';
import { dispatcherDir, resetRuntimeConfig } from '../src/platform/paths.js';
import { testDispatcherConfig, testDreamuxConfig } from './helpers/config.js';

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

function feishuChannel(
  id: string,
  appId: string,
  appSecret: string,
): DispatcherChannelConfig {
  return {
    id,
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    config: { app_id: appId, app_secret: appSecret } as never,
  };
}

function groupTarget(chatId: string): ChannelTarget {
  return {
    target_type: 'group',
    target_key: chatId,
    bindable: true,
    meta: { chat_id: chatId, chat_type: 'group' },
  };
}

function p2pTarget(chatId: string): ChannelTarget {
  return {
    target_type: 'p2p',
    target_key: chatId,
    bindable: false,
    meta: { chat_id: chatId, chat_type: 'p2p' },
  };
}

function envelope(
  channelId: string,
  chatId: string,
  chatType: 'group' | 'p2p',
): ChannelInboundEnvelope {
  return {
    provider: BUILTIN_FEISHU_PROVIDER_REF,
    channel_id: channelId,
    target: chatType === 'group' ? groupTarget(chatId) : p2pTarget(chatId),
    message_id: 'm1',
  };
}

const INPUT = { kind: 'channel', text: 'hi', dedupeId: 'm1' } as unknown as InboundTurnInput;

const TWO_CHANNELS = [
  feishuChannel('primary', 'app-a', 'secret-a'),
  feishuChannel('secondary', 'app-b', 'secret-b'),
];

function buildService(channels: DispatcherChannelConfig[]): DispatcherService {
  const config = testDreamuxConfig([
    testDispatcherConfig({ cwd: '/tmp/mc-routing-cwd', channels }),
  ]);
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

describe('inbound routes by the originating channel_id (#209 live multi-channel)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeConfig();
  });

  it('keys the binding lookup on the channel the message arrived through', async () => {
    const service = buildService(TWO_CHANNELS);
    // routeChannelInput reads the channel-resolved target off the neutral
    // envelope, so no resolveChannelTarget stub is needed here.
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(dispatcherRuntime as never);
    const resolveSpy = vi.spyOn(service.teams, 'resolveChannel').mockResolvedValue(null);

    await service.routeChannelInput('flow', 'secondary', INPUT, envelope('secondary', 'chat-b', 'group'));
    await service.routeChannelInput('flow', 'primary', INPUT, envelope('primary', 'chat-a', 'group'));

    expect(resolveSpy).toHaveBeenNthCalledWith(1, {
      dispatcherId: 'flow',
      channelId: 'secondary',
      targetKey: 'chat-b',
    });
    expect(resolveSpy).toHaveBeenNthCalledWith(2, {
      dispatcherId: 'flow',
      channelId: 'primary',
      targetKey: 'chat-a',
    });
  });

  it('delivers a message on a secondary channel to that channel-bound TeamLeader', async () => {
    const service = buildService(TWO_CHANNELS);
    vi.spyOn(service.teams, 'resolveChannel').mockImplementation(async (input) =>
      input.channelId === 'secondary'
        ? ({ team_name: 'beta' } as never)
        : null,
    );
    const deliverSpy = vi
      .spyOn(service.teams, 'deliverToLeader')
      .mockResolvedValue({ status: 'submitted', turnId: 'turn-multi' });
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(dispatcherRuntime as never);

    await service.routeChannelInput('flow', 'secondary', INPUT, envelope('secondary', 'chat-b', 'group'));

    expect(deliverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcherId: 'flow', teamId: 'beta' }),
    );
    expect(dispatcherRuntime.channelInput).not.toHaveBeenCalled();
  });

  it('still short-circuits a P2P target to the dispatcher on a multi-channel dispatcher', async () => {
    const service = buildService(TWO_CHANNELS);
    const dispatcherRuntime = { channelInput: vi.fn(async () => ({ status: 'submitted' })) };
    vi.spyOn(service.dispatchers, 'getRuntime').mockReturnValue(dispatcherRuntime as never);
    const resolveSpy = vi.spyOn(service.teams, 'resolveChannel');

    await service.routeChannelInput('flow', 'secondary', INPUT, envelope('secondary', 'dm-1', 'p2p'));

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(dispatcherRuntime.channelInput).toHaveBeenCalledTimes(1);
  });
});

describe('binding requires an explicit channel on a multi-channel dispatcher (#209)', () => {
  beforeEach(() => resetRuntimeConfig());
  afterEach(() => {
    vi.restoreAllMocks();
    resetRuntimeConfig();
  });

  it('rejects a bind with no channel_id when more than one channel is configured', async () => {
    const service = buildService(TWO_CHANNELS);
    const bindSpy = vi.spyOn(service.teams, 'bindChannel');
    await expect(
      service.bindTeamChannel({ dispatcherId: 'flow', teamId: 'beta', meta: { chat_id: 'chat-b' } }),
    ).rejects.toThrow(/has 2 channels; channel_id is required/);
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('binds under the named channel', async () => {
    const service = buildService(TWO_CHANNELS);
    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(groupTarget('chat-b'));
    const bindSpy = vi
      .spyOn(service.teams, 'bindChannel')
      .mockResolvedValue({ team_name: 'beta' } as never);

    await service.bindTeamChannel({
      dispatcherId: 'flow',
      teamId: 'beta',
      channelId: 'secondary',
      meta: { chat_id: 'chat-b' },
    });

    expect(bindSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'secondary', provider: 'builtin:feishu' }),
    );
  });

  it('a single-channel dispatcher still binds without an explicit channel_id (legacy)', async () => {
    const service = buildService([feishuChannel('primary', 'app-a', 'secret-a')]);
    vi.spyOn(service.dispatchers, 'resolveChannelTarget').mockResolvedValue(groupTarget('chat-a'));
    const bindSpy = vi
      .spyOn(service.teams, 'bindChannel')
      .mockResolvedValue({ team_name: 'alpha' } as never);

    await service.bindTeamChannel({ dispatcherId: 'flow', teamId: 'alpha', meta: { chat_id: 'chat-a' } });

    expect(bindSpy).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'primary' }));
  });
});

// ── Minimal fake runtime so the dispatcher can actually start. ──────────────
const FAKE_CAPABILITIES: AgentRuntimeCapabilities = {
  resume: { supported: false },
  steer: { supported: false },
  events: { kind: 'synthesized' },
  last: { supported: false },
  context: { supported: false },
  systemPrompt: { mode: 'replace' },
  teammateCompletion: [],
};

class FakeRuntime implements AgentRuntime {
  readonly providerRef = 'builtin:codex';
  private status: AgentRuntimeStatus = 'declared';
  async start(): Promise<void> {
    this.status = 'ready';
  }
  async resume(): Promise<void> {}
  async stop(): Promise<void> {
    this.status = 'stopped';
  }
  async channelInput(): Promise<AgentRuntimeTurnResult> {
    return { status: 'submitted', turnId: 't' };
  }
  async systemInput(_n: AgentRuntimeSystemInput): Promise<AgentRuntimeTurnResult> {
    return { status: 'skipped' };
  }
  getStatus(): AgentRuntimeStatus {
    return this.status;
  }
  getThreadId(): string | null {
    return null;
  }
  wasThreadResumed(): boolean {
    return false;
  }
  async getLast(): Promise<AgentRuntimeLastResult | null> {
    return null;
  }
  async getContext(): Promise<AgentRuntimeContextSnapshot | null> {
    return null;
  }
  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }
}

class FakeProvider implements AgentRuntimeProvider {
  readonly ref = 'builtin:codex';
  readonly descriptor: AgentRuntimeProviderDescriptor;
  constructor(descriptor: ProviderDescriptor) {
    this.descriptor = asAgentRuntimeDescriptor(descriptor);
  }
  getCapabilities(): AgentRuntimeCapabilities {
    return FAKE_CAPABILITIES;
  }
  createRuntime(_context: AgentRuntimeCreateContext): AgentRuntime {
    return new FakeRuntime();
  }
}

describe('multiple channel sessions are live, one bot per channel (#209)', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dx-mc-'));
    mkdirSync(join(root, 'workspace'));
    previousHome = process.env['HOME'];
    process.env['HOME'] = join(root, 'home');
    resetRuntimeConfig();
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    resetRuntimeConfig();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function buildStartableService(channels: DispatcherChannelConfig[]): {
    service: DispatcherService;
    secrets: string[];
    bots: Map<string, FakeFeishuBot>;
  } {
    const config = testDreamuxConfig([
      testDispatcherConfig({ cwd: join(root, 'workspace'), channels }),
    ]);
    const registry = createBuiltinProviderRegistry();
    const descriptor = registry.resolve('builtin:codex');
    registry.registerImplementation(descriptor.id, new FakeProvider(descriptor));
    const secrets: string[] = [];
    const bots = new Map<string, FakeFeishuBot>();
    const service = new DispatcherService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      // One bot per channel; the per-channel app secret flows in via the
      // provider's validated config, so the recorded list proves a distinct
      // session was built for each channel and the bots map lets a test drive
      // inbound through a specific channel's bot.
      channelProviders: feishuChannelCatalog((config) => {
        secrets.push(config.appSecret);
        const bot = createFakeFeishuBot(`bot-${config.appSecret}`);
        bots.set(config.appSecret, bot);
        return bot;
      }),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });
    return { service, secrets, bots };
  }

  function inboundEvent(chatId: string, text: string, msgId: string): FeishuInboundEvent {
    return {
      messageId: msgId,
      chatId,
      chatType: 'group',
      senderId: 'sender-test',
      senderType: 'user',
      senderName: '',
      messageType: 'text',
      rawContent: JSON.stringify({ text }),
      parsedText: text,
      mentions: [],
      createTime: String(Date.now()),
      raw: { event: { message: { chat_id: chatId, message_id: msgId } } },
    } as unknown as FeishuInboundEvent;
  }

  it('starts one session per channel with its own bot identity, and egress targets a channel', async () => {
    const { service, secrets } = buildStartableService(TWO_CHANNELS);

    await service.startDispatcher('flow');

    // One bot per channel, each with its OWN per-channel secret.
    expect(secrets.sort()).toEqual(['secret-a', 'secret-b']);

    // Egress dispatches to a live channel; an unknown channel fails loud.
    await expect(
      service.callFeishuMcpTool({
        dispatcherId: 'flow',
        toolName: 'reply',
        arguments: { chat_id: 'chat-b', text: 'hi' },
        channelId: 'secondary',
      }),
    ).resolves.toBeDefined();
    await expect(
      service.callFeishuMcpTool({
        dispatcherId: 'flow',
        toolName: 'reply',
        arguments: { chat_id: 'chat-b', text: 'hi' },
        channelId: 'nope',
      }),
    ).rejects.toThrow(/no live channel 'nope'/);

    await service.stopDispatcher('flow');
  });

  it('routes inbound from a live secondary bot under that channel_id (#209)', async () => {
    const { service, bots } = buildStartableService(TWO_CHANNELS);

    // Allowlist the secondary chat so the gate delivers without a mention. The
    // access policy is per-dispatcher, shared across its channels.
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 2,
      allow_users: [],
      group: { policy: 'allowlist', allow_chats: ['chat-b'], require_mention: false },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    } as never);

    await service.startDispatcher('flow');

    // The router resolves the binding by (channel_id, target_key); capture the
    // lookup to prove the ORIGINATING session SOURCES the channel_id rather than
    // a hand-fed argument. Return null so it falls through to the dispatcher.
    const resolveSpy = vi.spyOn(service.teams, 'resolveChannel').mockResolvedValue(null);

    // Drive a real inbound message through the SECONDARY channel's live bot.
    const secondaryBot = bots.get('secret-b');
    expect(secondaryBot).toBeDefined();
    await secondaryBot!.inject(inboundEvent('chat-b', 'hi', 'm-sec-1'));

    await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalled());
    expect(resolveSpy).toHaveBeenCalledWith({
      dispatcherId: 'flow',
      channelId: 'secondary',
      targetKey: 'chat-b',
    });

    await service.stopDispatcher('flow');
  });

  it('a single-channel dispatcher starts exactly one session (legacy unchanged)', async () => {
    const { service, secrets } = buildStartableService([
      feishuChannel('primary', 'app-a', 'secret-a'),
    ]);
    await service.startDispatcher('flow');
    expect(secrets).toEqual(['secret-a']);
    await service.stopDispatcher('flow');
  });

  it('routes an inbound that arrives during session.start() instead of throwing "not running" (#209 fix #7)', async () => {
    // The bot fires an inbound from inside its own start() — i.e. while
    // doStartDispatcher is still in the channel-start loop, before the call
    // returns. Routing that inbound runs resolveChannelTarget ->
    // mustRunningSlot; the slot must already be registered (fix #7), or the
    // start aborts with "dispatcher 'flow' is not running".
    const config = testDreamuxConfig([
      testDispatcherConfig({
        cwd: join(root, 'workspace'),
        channels: [feishuChannel('primary', 'app-a', 'secret-a')],
      }),
    ]);
    const registry = createBuiltinProviderRegistry();
    const descriptor = registry.resolve('builtin:codex');
    registry.registerImplementation(descriptor.id, new FakeProvider(descriptor));
    const service = new DispatcherService({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({ registry }),
      channelProviders: feishuChannelCatalog(() => {
        const bot = createFakeFeishuBot('bot-a');
        const baseStart = bot.start.bind(bot);
        bot.start = async (r) => {
          await baseStart(r);
          await bot.inject(inboundEvent('chat-a', 'hi', 'm-start-1'));
        };
        return bot;
      }),
      channelLoggerFactory: () => noopLog(),
      log: noopLog(),
    });

    // Allowlist the chat so the inbound clears the gate and reaches submitTurn.
    await saveDispatcherAccess(dispatcherDir('flow'), {
      version: 2,
      allow_users: [],
      group: { policy: 'allowlist', allow_chats: ['chat-a'], require_mention: false },
      observed_chats: [],
      warnings: [],
      last_gate: null,
    } as never);

    // Return null so routing falls through to the dispatcher runtime; the spy
    // also proves the inbound reached routing (the slot resolved) during start.
    const resolveSpy = vi
      .spyOn(service.teams, 'resolveChannel')
      .mockResolvedValue(null);

    // Before fix #7 this rejects with 'dispatcher \'flow\' is not running'.
    await service.startDispatcher('flow');

    expect(resolveSpy).toHaveBeenCalledWith({
      dispatcherId: 'flow',
      channelId: 'primary',
      targetKey: 'chat-a',
    });

    await service.stopDispatcher('flow');
  });
});

describe('no generic Channel MCP / list_peers surface (#209)', () => {
  it('feishu egress stays on the Feishu MCP tools, with no peer-listing tool', () => {
    const names = feishuMcpTools().map((tool) => tool['name']);
    expect(names).not.toContain('list_peers');
    // The only outbound/peer tools are the Feishu-owned ones; channel_id is a
    // parameter on these, not a new generic "channel" MCP surface.
    expect(new Set(names)).toEqual(new Set(['reply', 'react', 'list_chat_bots']));
  });
});
