/**
 * The Channel read model: `channelDescriptors()` and the `dispatcher.status`
 * result that carries it.
 *
 * Two things are under test here and they fail in different ways. The
 * projection decides *what* a caller is told about a Channel — and in
 * particular that "gone" and "still named" are one decision, taken from the
 * registration rather than from liveness. The Command's declared output decides
 * what may reach a caller at all: it is a closed schema precisely so an
 * undeclared field — a provider config value most of all — is a loud Core
 * defect instead of a quiet leak.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntimeProviderCatalog } from '../src/agent-runtime/index.js';
import { ChannelProviderCatalog } from '../src/channel/catalog.js';
import { CoreCommandPort } from '../src/command/port.js';
import { CoreCommands } from '../src/command/registry.js';
import type { DreamuxConfig } from '../src/config/config.js';
import { ProviderRegistry } from '../src/registry/registry.js';
import { McpLeaseRegistry } from '../src/service/mcp/leases.js';
import { Dispatchers } from '../src/service/dispatchers/index.js';
import {
  channelDescriptors,
  type ChannelDescriptor,
} from '../src/service/dispatcher-service/channel-descriptor.js';
import { DispatcherStore } from '../src/state/dispatcher-store.js';
import type { CoreCommandContext, DreamuxLogger } from '@excitedjs/dreamux-types';
import {
  adminContext,
  createCommandHarness,
  HARNESS_DISPATCHER_ID,
} from './helpers/command-harness.js';

function silentLogger(): DreamuxLogger {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

/** The five fields a descriptor is allowed to have, and nothing else. */
const DESCRIPTOR_KEYS = [
  'channel_id',
  'commands',
  'identity',
  'provider',
  'status',
];

describe('channelDescriptors(): the registration decides what a caller is told', () => {
  const configured = [
    { id: 'primary', provider: 'npm:@example/chan#create', identity: 'chat-7788' },
  ];

  it('reports a configured Channel this run never registered as closed, with no commands', () => {
    expect(
      channelDescriptors({
        configured,
        registered: () => false,
        liveStatus: () => 'stopped',
        admissionFenced: false,
        commandNames: () => ['channel.primary.ping'],
      }),
    ).toEqual([
      {
        channel_id: 'primary',
        provider: 'npm:@example/chan#create',
        identity: 'chat-7788',
        commands: [],
        status: 'closed',
      },
    ]);
  });

  it('walks closed -> starting -> ready -> closing -> closed as registration, liveness, and the fence move', () => {
    const state = {
      registered: false,
      live: 'stopped' as 'running' | 'built' | 'stopped',
      fenced: false,
    };
    const read = (): ChannelDescriptor =>
      channelDescriptors({
        configured,
        registered: () => state.registered,
        liveStatus: () => state.live,
        admissionFenced: state.fenced,
        commandNames: () => ['channel.primary.ping'],
      })[0] as ChannelDescriptor;

    const seen: Array<{ status: string; commands: readonly string[] }> = [];
    const observe = () => {
      const descriptor = read();
      seen.push({ status: descriptor.status, commands: descriptor.commands });
    };

    observe(); // nothing registered yet
    state.registered = true;
    state.live = 'built';
    observe(); // catalog registered, session not started
    state.live = 'running';
    observe(); // session started and adopted
    state.fenced = true;
    observe(); // admission fenced, still draining
    // `ChannelService.closeAll()` detaches its maps before awaiting a single
    // close, so liveness reads `stopped` here while the batch is still live —
    // and the names must still be reported for exactly that window.
    state.live = 'stopped';
    observe();
    state.registered = false;
    observe(); // batch revoked

    expect(seen).toEqual([
      { status: 'closed', commands: [] },
      { status: 'starting', commands: ['channel.primary.ping'] },
      { status: 'ready', commands: ['channel.primary.ping'] },
      { status: 'closing', commands: ['channel.primary.ping'] },
      { status: 'closing', commands: ['channel.primary.ping'] },
      { status: 'closed', commands: [] },
    ]);
  });

  it('reports the identity the provider declared, and null when it declared none', () => {
    const [declared, empty, absent] = channelDescriptors({
      configured: [
        { id: 'a', provider: 'p', identity: 'chat-7788' },
        // The config loader writes '' when a provider has no identity
        // capability; that is its "none", not a value to repeat back.
        { id: 'b', provider: 'p', identity: '' },
        { id: 'c', provider: 'p' },
      ],
      registered: () => false,
      liveStatus: () => 'stopped',
      admissionFenced: false,
      commandNames: () => [],
    });
    expect(declared?.identity).toBe('chat-7788');
    expect(empty?.identity).toBeNull();
    expect(absent?.identity).toBeNull();
  });

  it('carries nothing from the Channel config but the id, the provider ref, and the opaque identity', () => {
    // The projection input is typed to `ConfiguredChannelFacts`, but the value
    // production passes is the whole `DispatcherChannelConfig` — parsed config,
    // raw config and all. So the guarantee that matters is behavioural: what
    // comes out carries none of it.
    const [descriptor] = channelDescriptors({
      configured: [
        {
          id: 'primary',
          provider: 'npm:@example/chan#create',
          identity: 'chat-7788',
          config: { app_secret: 'sekret-value', allow_chats: ['oc_1'] },
          rawConfig: { app_secret: '${env:CHAN_SECRET}' },
        } as never,
      ],
      registered: () => true,
      liveStatus: () => 'running',
      admissionFenced: false,
      commandNames: () => ['channel.primary.bind'],
    });
    expect(Object.keys(descriptor as object).sort()).toEqual(DESCRIPTOR_KEYS);
    expect(JSON.stringify(descriptor)).not.toContain('sekret-value');
    expect(JSON.stringify(descriptor)).not.toContain('CHAN_SECRET');
    expect(JSON.stringify(descriptor)).not.toContain('oc_1');
  });
});

describe('dispatcher.status carries the Channel read model under a closed schema', () => {
  function descriptor(overrides: Partial<ChannelDescriptor> = {}): ChannelDescriptor {
    return {
      channel_id: 'primary',
      provider: 'npm:@example/chan#create',
      identity: 'chat-7788',
      commands: ['channel.primary.bind'],
      status: 'ready',
      ...overrides,
    };
  }

  async function status(
    harness: ReturnType<typeof createCommandHarness>,
    context: CoreCommandContext = adminContext(HARNESS_DISPATCHER_ID),
  ) {
    return harness.port.invoke(context, 'dispatcher.status', {});
  }

  it('returns each configured Channel with its registered command names', async () => {
    const harness = createCommandHarness({
      dispatcherChannels: () => [descriptor()],
    });
    const result = (await status(harness)) as { channel_descriptors: unknown[] };
    expect(result.channel_descriptors).toEqual([descriptor()]);
  });

  it('refuses to publish a descriptor field Core never declared, as an INTERNAL defect', async () => {
    const harness = createCommandHarness({
      // Exactly the leak the closed schema exists to stop: a future edit that
      // hands the read model the whole config object instead of the three
      // facts it is allowed to repeat.
      dispatcherChannels: () =>
        [{ ...descriptor(), config: { app_secret: 'sekret-value' } }] as never,
    });
    await expect(status(harness)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('refuses a status word outside the four a caller can act on', async () => {
    const harness = createCommandHarness({
      dispatcherChannels: () =>
        [{ ...descriptor(), status: 'draining' }] as never,
    });
    await expect(status(harness)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('is addressed by the caller context, and asks for exactly the dispatcher named', async () => {
    const asked: string[] = [];
    const harness = createCommandHarness({
      dispatcherChannels: (id) => {
        asked.push(id);
        return [];
      },
    });
    await status(harness);
    expect(asked).toEqual([HARNESS_DISPATCHER_ID]);
  });
});

describe('Dispatchers.channelDescriptors(): a read never materializes a dormant dispatcher', () => {
  let dispatchers: Dispatchers | null = null;

  afterEach(() => {
    dispatchers = null;
  });

  function build(): Dispatchers {
    const config: DreamuxConfig = {
      agents: { flow: { provider: 'builtin:codex', config: {} } },
      dispatchers: [
        {
          id: 'flow',
          cwd: null,
          enabled: true,
          workspace: { enabled: true },
          channels: [
            {
              id: 'primary',
              provider: 'npm:@example/chan#create',
              identity: 'chat-7788',
              config: { app_secret: 'sekret-value' },
              rawConfig: { app_secret: '${env:CHAN_SECRET}' },
            },
          ],
          agentRuntime: 'flow',
          runtime: { provider: 'builtin:codex', config: {} },
        },
      ],
    };
    return new Dispatchers({
      config,
      dispatchers: new DispatcherStore(config),
      agentRuntimeProviders: new AgentRuntimeProviderCatalog({
        registry: new ProviderRegistry(),
      }),
      channelProviders: new ChannelProviderCatalog({ registry: new ProviderRegistry() }),
      mcpLeases: new McpLeaseRegistry(),
      commands: new CoreCommandPort(new CoreCommands([])),
      channelCommands: new CoreCommandPort(new CoreCommands([])),
      homePathPrefixes: [],
      channelLoggerFactory: () => silentLogger(),
      log: silentLogger(),
    });
  }

  it('answers from config alone — closed, no commands, and no aggregate built', () => {
    dispatchers = build();

    expect(dispatchers.channelDescriptors('flow')).toEqual([
      {
        channel_id: 'primary',
        provider: 'npm:@example/chan#create',
        identity: 'chat-7788',
        commands: [],
        status: 'closed',
      },
    ]);

    // Proof the read built nothing: `get()` refuses to construct once the
    // collection stops accepting, so a dispatcher that answers here would have
    // to be one this read had already cached.
    dispatchers.beginShutdown();
    expect(() => dispatchers?.get('flow')).toThrow(/shutting down/);
  });

  it('repeats no config value from the dormant read either', () => {
    dispatchers = build();
    const json = JSON.stringify(dispatchers.channelDescriptors('flow'));
    expect(json).not.toContain('sekret-value');
    expect(json).not.toContain('CHAN_SECRET');
  });

  it('reports an unconfigured dispatcher as having no Channels at all', () => {
    dispatchers = build();
    expect(dispatchers.channelDescriptors('no-such-dispatcher')).toEqual([]);
  });
});
